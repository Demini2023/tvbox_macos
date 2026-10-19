/**
 * worker 端：在一个独立线程里跑一个站点的 drpy2 运行时。
 *
 * 为什么需要独立线程：dr_py 规则的 `_http(url,{async:false})` 是同步阻塞的，
 * QuickJS 同步上下文无法挂起等待网络，只能真正阻塞。
 * 若放在主线程会卡死整个 HTTP 服务，故每个站点一个 worker。
 */
import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './drpyRuntime.mjs'
import { parseSiteExt } from './ruleNormalize.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 本地 dr_py 规则目录（fetch_drpy_rules.mjs 下载所得） */
const RULES_DIR = path.join(__dirname, 'data', 'drpy-rules')

let rt = null
let currentKey = null
let initPromise = null

const reply = (id, ok, data) => {
  try {
    parentPort.postMessage({ id, ok, data })
  } catch {
    /* worker 已退出 */
  }
}

/**
 * 站点 ext 形态与 drpy2 init(ext) 的对应关系：
 *   - 内联 JSON / 整段 JS 源码  -> 原样传，drpy2 会 eval
 *   - http(s):// 远程规则      -> 原样传，drpy2 内部 request 拉取
 *   - ./xxx.js 本地文件路径    -> 这里读出文件内容再传，等价于内联
 *
 * 第三种是本服务自建配置（data/drpy-rules/）的形态：dr_py 官方仓库的
 * 规则每个都是独立 .js 文件，按路径引用时不能让 drpy2 自己去读。
 */
function resolveExtSource(site) {
  const ext = String(site?.ext || '')
  if (!ext) return null

  // 形态一：整段 JS 源码（内联）。dr_py 规则文件的内容直接放进 ext 时走这条。
  // 必须原样交给 drpy2 的 init 走 eval 分支；若在这里当对象解析，
  // drpy2 会执行 js.replace('var rule','rule') 把 `var rule = {` 截断，
  // 结果 rule 变成 {"var rule":"{", ...} 这种垃圾。
  if (/var\s+rule\s*=/.test(ext) || /^\s*muban\./.test(ext)) {
    return ext
  }

  // 形态二：本地文件路径 -> 读出内容，同样走 eval 分支
  const looksLikePath =
    /^\.{0,2}\//.test(ext) ||
    (!/^https?:/i.test(ext) && !ext.trimStart().startsWith('{') && ext.endsWith('.js'))
  if (!looksLikePath) return null
  // 防目录穿越
  const safe = path.basename(ext)
  const file = path.join(RULES_DIR, safe)
  if (!fs.existsSync(file)) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 把站点配置转换为 drpy2 规则对象 */
function buildRule(site) {
  const local = resolveExtSource(site)
  if (local) {
    // 本地 JS 规则：把源码交给 drpy2 的 init，走它的 eval 分支。
    // 不能传对象，否则规则开头的 muban.xxx 会找不到闭包里的 muban。
    return { title: site.name, extSource: local }
  }
  const { rule, remoteUrl } = parseSiteExt(site)
  rule.title = rule.title || site.name
  if (remoteUrl) {
    // ext 是远程规则地址：drpy2 支持 spider 字段加载远程规则
    rule.spider = remoteUrl
  }
  if (site.header && typeof site.header === 'object') {
    rule.headers = Object.assign({}, rule.headers, site.header)
  }
  return rule
}

async function ensureRuntime(site, opts) {
  if (rt && currentKey === site.key) return rt
  if (rt) {
    rt.dispose()
    rt = null
    currentKey = null
  }
  rt = await createRuntime({
    proxyUrl: opts.proxyUrl || '',
    rkey: site.key || '',
    extend: site.ext || '',
    version: opts.version,
    evalTimeoutMs: opts.evalTimeoutMs || 30000,
  })
  // 初始化规则。buildRule 对本地 JS 规则会返回 { title, extSource }，
  // 这种必须把源码字符串直接交给 drpy2 的 init —— 它内部会包成
  // eval("(function(){" + js.replace('var rule','rule') + "})()")，
  // 闭包里才有 muban，规则开头的 muban.xxx 修改才有效。
  const built = buildRule(site)
  if (built && typeof built.extSource === 'string') {
    rt.initRule(built.extSource)
  } else {
    rt.initRule(built)
  }

  // hostJs 是运行时求值的，parseSiteExt 阶段 rule.host 还是空串，
  // 导致 url/searchUrl/detailUrl 这些相对路径没被拼上主机，
  // category() 里就会拼出 "/xxx/page/1" 这种无法请求的地址。
  // 这里回读 init 后的 rule（此时 hostJs 已求出真实 host）再补一次拼接。
  try {
    const finalRule = rt.getRule()
    if (finalRule && finalRule.host) {
      const host = String(finalRule.host).replace(/\/+$/, '')
      const patch = {}
      for (const key of ['url', 'searchUrl', 'detailUrl']) {
        const v = finalRule[key]
        if (typeof v !== 'string' || !v) continue
        if (/^https?:/i.test(v)) continue
        if (/^js:/i.test(v)) continue
        patch[key] = host + (v.startsWith('/') ? v : '/' + v)
      }
      if (!finalRule.homeUrl) patch.homeUrl = host
      if (Object.keys(patch).length) rt.patchRule(patch)
    }
  } catch {
    /* 修正失败不致命，保留原规则继续跑 */
  }

  currentKey = site.key
  return rt
}

parentPort.on('message', async (msg) => {
  const { id, op, site, opts, args } = msg
  try {
    if (!site || !site.key) throw new Error('site is required')
    const r = await ensureRuntime(site, opts || {})
    let result = null
    switch (op) {
      case 'home':
        result = r.home(false, (args && args.html) || '')
        break
      case 'homeVod':
        result = r.homeVod({})
        break
      case 'category':
        result = r.category(args.tid, args.pg, false, {})
        break
      case 'detail':
        result = r.detail(args.id)
        break
      case 'play':
        result = r.play(args.flag, args.id)
        break
      case 'search':
        result = r.search(args.wd, !!args.quick, args.pg || 1)
        break
      case 'proxy':
        result = r.proxy(args.params || {})
        break
      case 'logs':
        result = r.logs.join('\n')
        break
      case 'ping':
        result = 'pong'
        break
      default:
        throw new Error('unknown op: ' + op)
    }
    reply(id, true, result)
  } catch (e) {
    reply(id, false, {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? String(e.stack).slice(0, 800) : '',
    })
  }
})

// 启动即初始化
if (workerData && workerData.site) {
  ensureRuntime(workerData.site, workerData.opts || {})
    .then(() => {
      reply('ready', true, 'ready')
    })
    .catch((e) => {
      reply('ready', false, { message: e && e.message ? e.message : String(e) })
    })
}

void __dirname
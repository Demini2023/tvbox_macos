/**
 * worker 端：在一个独立线程里跑一个站点的 drpy2 运行时。
 *
 * 为什么需要独立线程：dr_py 规则的 `_http(url,{async:false})` 是同步阻塞的，
 * QuickJS 同步上下文无法挂起等待网络，只能真正阻塞。
 * 若放在主线程会卡死整个 HTTP 服务，故每个站点一个 worker。
 */
import { parentPort, workerData } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './drpyRuntime.mjs'
import { parseSiteExt } from './ruleNormalize.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

/** 把站点配置转换为 drpy2 规则对象 */
function buildRule(site) {
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
  // 初始化规则（drpy2.init 接收规则对象）
  rt.initRule(buildRule(site))
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
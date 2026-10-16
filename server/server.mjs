/**
 * 影视仓复刻服务：TVBox/影视仓协议兼容后端。
 *
 * 对 iOS 客户端暴露 REST 接口，接口形态参考 TVBox 的 API：
 *   GET  /api/config                 获取配置（含站点列表）
 *   POST /api/config/import          导入远程配置（URL 或直接 JSON）
 *   GET  /api/site/:key/home         首页分类 + 推荐
 *   GET  /api/site/:key/category     分类列表
 *   GET  /api/site/:key/detail       影片详情
 *   GET  /api/site/:key/play         播放地址解析
 *   GET  /api/site/:key/search       搜索
 *   GET  /api/site/:key/logs         采集器日志（调试用）
 *   GET  /api/health                 健康检查
 *
 * 同时兼容 TVBox 的 ?ac= 风格接口，方便直接用现成播放器接入。
 */
import express from 'express'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  loadConfig,
  saveConfig,
  fetchRemoteConfig,
  getSite,
  publicConfig,
  normalizeConfig,
} from './configStore.mjs'
import { withSite, shutdownAll, sessionStats } from './spiderManager.mjs'
import { httpFetchAsync, checkCurl } from './httpBridge.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 9527)
const HOST = process.env.HOST || '0.0.0.0'

const app = express()
app.use(express.json({ limit: '8mb' }))
app.use(express.text({ type: 'text/plain', limit: '8mb' }))

/* ---------- CORS（iOS 客户端与Safari 调试都需要） ---------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Token')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

/* ---------- 日志 ---------- */
app.use((req, res, next) => {
  const t0 = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - t0
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`)
  })
  next()
})

/* ---------- 工具 ---------- */
/**
 * 归一化分类数据。
 *
 * drpy2 的 home() 有三种返回形态，客户端期望的却只有一种：
 *   1. { class: [{type_id,type_name}, ...] }   标准形态
 *   2. [{type_id,type_name}, ...]              部分源直接给数组
 *   3. 字符串 / null                            解析失败或无分类
 * 这里统一转成 { class: [...] }，并过滤掉缺 type_id 的脏数据，
 * 否则客户端会因为形状不匹配而整包解码失败。
 */
function normalizeClasses(raw) {
  const fallback = { class: [] }
  const data = parseJson(raw, fallback)
  if (data === null || typeof data !== 'object') return fallback

  // 形态 2：直接是数组
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data.class)
      ? data.class
      : Array.isArray(data.classes)
        ? data.classes
        : null
  if (!arr) return fallback

  const list = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const id = it.type_id ?? it.typeId ?? it.id
    const name = it.type_name ?? it.typeName ?? it.name
    if (id === undefined || id === null || id === '') continue
    list.push({ type_id: String(id), type_name: String(name ?? id) })
  }
  return { class: list }
}

/**
 * 归一化影片列表：保证 list 一定是数组，剔除缺 vod_id 的项。
 * drpy2 各源字段名略有出入（vod_name/vodName 等），这里做一次兼容。
 */
function normalizeVodList(raw, extra = {}) {
  const data = parseJson(raw, { list: [] })
  const out = { ...extra }
  const src = Array.isArray(data) ? data : Array.isArray(data.list) ? data.list : []
  const list = []
  for (const it of src) {
    if (!it || typeof it !== 'object') continue
    const id = it.vod_id ?? it.vodId ?? it.id
    if (id === undefined || id === null || id === '') continue
    const name = it.vod_name ?? it.vodName ?? it.name ?? ''
    const pic = it.vod_pic ?? it.vodPic ?? it.pic ?? ''
    list.push({
      ...it,
      vod_id: String(id),
      vod_name: String(name),
      vod_pic: String(pic),
      vod_remarks: String(it.vod_remarks ?? it.vodRemarks ?? it.remarks ?? ''),
    })
  }
  out.list = list
  return out
}

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback
  if (typeof text === 'object') return text
  const s = String(text).trim()
  try {
    return JSON.parse(s)
  } catch {
    // dr_py 有时返回带前后缀的内容
    const i = s.indexOf('{')
    const j = s.lastIndexOf('}')
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1))
      } catch {
        /* fallthrough */
      }
    }
    return fallback
  }
}

const runtimeOpts = () => ({
  proxyUrl: `http://127.0.0.1:${PORT}`,
  version: '3.9.51',
  evalTimeoutMs: 30000,
})

/** 取站点，找不到则 404 */
function requireSite(req, res) {
  const key = req.params.key || req.query.key || req.body?.key
  const cfg = loadConfig()
  const site = getSite(cfg, key)
  if (!site) {
    res.status(404).json({ error: 'site not found: ' + key })
    return null
  }
  // 不支持的站点明确拒绝，别让它跑到 worker 里报一堆看不懂的错
  if (site.supported === false) {
    const why =
      site.kindLabel === '需外部规则'
        ? `它的规则文件（${site.ext || '未知'}）指向 TVBox 客户端的私有资源目录，` +
          `不随 JSON 配置分发，本服务拿不到。`
        : `它是 ${site.kindLabel || 'CSP'} 类型，属于 Android 原生插件，` +
          `本服务基于 Node/QuickJS，无法执行。`
    res.status(400).json({
      error: `站点「${site.name}」无法运行：${why}`,
      unsupported: true,
      kind: site.kind,
    })
    return null
  }
  return { site, cfg }
}

/* ================= 配置接口 ================= */
app.get('/api/config', (req, res) => {
  const cfg = loadConfig()
  res.json({ ok: true, data: publicConfig(cfg) })
})

/** 完整配置（含 ext，供高级用法） */
app.get('/api/config/full', (req, res) => {
  res.json({ ok: true, data: loadConfig() })
})

app.post('/api/config/import', async (req, res) => {
  const { url, json, text } = req.body || {}
  try {
    let cfg
    if (url) {
      cfg = await fetchRemoteConfig(url)
    } else if (json) {
      cfg = saveConfig(json)
    } else if (text) {
      cfg = saveConfig(JSON.parse(text))
    } else {
      return res.status(400).json({ error: '需要提供 url / json / text 之一' })
    }
    // 导入成功不等于可用：全是 CSP 插件或依赖外部规则文件时，
    // 用户点进去仍然是空的。必须把真实可用数量回报给客户端。
    const pub = publicConfig(cfg)
    const total = pub.sites?.length ?? 0
    const usable = pub.sites?.filter((s) => s.supported !== false).length ?? 0
    const countLabel = (label) =>
      pub.sites?.filter((s) => s.supported === false && s.kindLabel === label).length ?? 0
    const cspCount = countLabel('CSP插件')
    const fileCount = countLabel('需外部规则')

    if (total > 0 && usable === 0) {
      return res.status(400).json({
        error:
          `配置里有 ${total} 个站点，但没有一个能在本服务运行：` +
          `${cspCount} 个是 CSP 插件（Android 原生 Java 插件），` +
          `${fileCount} 个依赖 TVBox 客户端私有规则文件（不随配置分发）。` +
          `请换一个提供 dr_py 内联规则或接口地址的配置。`,
        data: pub,
        total,
        usable,
      })
    }
    const skipped = total - usable
    res.json({
      ok: true,
      data: pub,
      total,
      usable,
      message:
        usable === total
          ? `配置导入成功，共 ${total} 个站点`
          : `配置导入成功：${total} 个站点中 ${usable} 个可用` +
            (cspCount ? `，${cspCount} 个 CSP 插件` : '') +
            (fileCount ? `，${fileCount} 个需外部规则文件` : '') +
            '（均不支持）',
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** 直接覆盖保存配置 */
app.post('/api/config/save', (req, res) => {
  try {
    const cfg = saveConfig(req.body?.config || req.body)
    res.json({ ok: true, data: publicConfig(cfg) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/* ================= 站点内容接口 ================= */
app.get('/api/site/:key/home', async (req, res) => {
  const s = requireSite(req, res)
  if (!s) return
  const { site } = s
  try {
    const classes = await withSite(site, runtimeOpts(), 'home', {})
    const homeVod = await withSite(site, runtimeOpts(), 'homeVod', {})
    res.json({
      ok: true,
      data: {
        classes: normalizeClasses(classes),
        list: normalizeVodList(homeVod, { page: 1 }),
      },
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/site/:key/category', async (req, res) => {
  const s = requireSite(req, res)
  if (!s) return
  const tid = req.query.tid || req.query.t
  const pg = Number(req.query.pg || req.query.page || 1)
  if (!tid) return res.status(400).json({ error: 'missing tid' })
  try {
    const raw = await withSite(s.site, runtimeOpts(), 'category', { tid, pg })
    res.json({ ok: true, data: normalizeVodList(raw, { page: pg, pagecount: 0, limit: 0, total: 0 }) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/site/:key/detail', async (req, res) => {
  const s = requireSite(req, res)
  if (!s) return
  const id = req.query.id || req.query.vod_id || req.query.url
  if (!id) return res.status(400).json({ error: 'missing id' })
  try {
    const raw = await withSite(s.site, runtimeOpts(), 'detail', { id })
    // drpy2 的 detail 返回 { list: [单个 vod] }；客户端按 list[0] 取值。
    // 影片字段补空串，避免客户端解码时因缺字段整包失败。
    const d = normalizeVodList(raw, {})
    const first = d.list[0] ?? {}
    d.list = [{
      ...first,
      vod_id: String(first.vod_id ?? id),
      vod_name: String(first.vod_name ?? ''),
      vod_pic: String(first.vod_pic ?? ''),
      vod_remarks: String(first.vod_remarks ?? ''),
      vod_year: String(first.vod_year ?? ''),
      vod_area: String(first.vod_area ?? ''),
      vod_actor: String(first.vod_actor ?? ''),
      vod_director: String(first.vod_director ?? ''),
      vod_content: String(first.vod_content ?? ''),
      vod_play_from: String(first.vod_play_from ?? ''),
      vod_play_url: String(first.vod_play_url ?? ''),
    }]
    res.json({ ok: true, data: d })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/site/:key/play', async (req, res) => {
  const s = requireSite(req, res)
  if (!s) return
  const flag = req.query.flag || ''
  const id = req.query.id || req.query.url
  if (!id) return res.status(400).json({ error: 'missing id' })
  try {
    const raw = await withSite(s.site, runtimeOpts(), 'play', { flag, id })
    const p = parseJson(raw, {})
    res.json({
      ok: true,
      data: {
        parse: Number.isFinite(p.parse) ? p.parse : 0,
        url: String(p.url ?? ''),
        flag: String(p.flag ?? flag),
        header: p.header ?? {},
      },
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/site/:key/search', async (req, res) => {
  const s = requireSite(req, res)
  if (!s) return
  const wd = req.query.wd || ''
  if (!wd) return res.status(400).json({ error: 'missing wd' })
  const pg = Number(req.query.pg || 1)
  const quick = req.query.quick === '1' || req.query.quick === 'true'
  try {
    const raw = await withSite(s.site, runtimeOpts(), 'search', { wd, pg, quick })
    res.json({ ok: true, data: normalizeVodList(raw, { page: pg, pagecount: 0, limit: 0, total: 0 }) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/site/:key/logs', async (req, res) => {
  const s = requireSite(req, res)
  if (!s) return
  try {
    const logs = await withSite(s.site, runtimeOpts(), 'logs', {})
    res.json({ ok: true, data: { logs } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/** 手动执行 JS（高级/调试用）：POST /api/eval { site, code } */
app.post('/api/eval', async (req, res) => {
  const { site: siteKey, code } = req.body || {}
  const cfg = loadConfig()
  const site = getSite(cfg, siteKey)
  if (!site) return res.status(404).json({ error: 'site not found' })
  if (!code) return res.status(400).json({ error: 'missing code' })
  try {
    // 用 proxy 通道：js: 前缀由 drpy2 处理
    const raw = await withSite(site, runtimeOpts(), 'proxy', {
      params: { do: 'js', url: 'data:text/plain;base64,' + Buffer.from(String(code)).toString('base64') },
    })
    res.json({ ok: true, data: parseJson(raw, { raw }) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ================= 嗅探/代理 ================= */
/** 通用代理：GET /proxy?url=... 供播放地址抓取与嗅探使用 */
app.get('/proxy', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).send('missing url')
  try {
    const r = await httpFetchAsync(url, { timeoutMs: 20000 })
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (!r.ok) {
      return res.status(r.status || 502).send(r.body || 'fetch failed')
    }
    res.send(r.body)
  } catch (e) {
    res.status(502).send('proxy error: ' + e.message)
  }
})

/** 远程脚本服务：把 ?extend=xxx.js 指到本服务，避免客户端直连失败 */
app.get('/website/remote/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name)
  const url = name
  if (!/^https?:\/\//i.test(url)) return res.status(400).send('bad url')
  const r = await httpFetchAsync(url, { timeoutMs: 20000 })
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.send(r.body || '')
})

/* ================= TVBox 风格兼容接口 ================= */
/**
 * 兼容常见 TVBox 客户端的调用方式：
 *   /api.php/provide/vod?ac=list|detail|vodsearch&...
 * 通过 site 参数选择采集器。
 */
app.all('/api.php/provide/vod', async (req, res) => {
  const src = req.method === 'POST' ? req.body || {} : req.query
  const siteKey = src.site || src.ext
  const cfg = loadConfig()
  const site = getSite(cfg, siteKey)
  if (!site) return res.status(404).json({ error: 'site not found' })
  const ac = src.ac || 'detail'
  try {
    let raw
    if (ac === 'list') raw = await withSite(site, runtimeOpts(), 'home', {})
    else if (ac === 'detail') raw = await withSite(site, runtimeOpts(), 'category', {
      tid: src.t,
      pg: src.pg || 1,
    })
    else if (ac === 'vodsearch') raw = await withSite(site, runtimeOpts(), 'search', {
      wd: src.wd,
      pg: src.pg || 1,
      quick: false,
    })
    else return res.status(400).json({ error: 'unsupported ac: ' + ac })
    res.json(parseJson(raw, {}))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ================= 运行状态 ================= */
app.get('/api/health', (req, res) => {
  const cfg = loadConfig()
  res.json({
    ok: true,
    sites: cfg.sites.length,
    sessions: sessionStats(),
    uptime: Math.round(process.uptime()),
    node: process.version,
  })
})

/** 列出所有可用站点及连通性 */
app.get('/api/sites', async (req, res) => {
  const cfg = loadConfig()
  const items = []
  for (const site of cfg.sites) {
    let status = 'unknown'
    let ms = 0
    const t0 = Date.now()
    try {
      await withSite(site, runtimeOpts(), 'home', {})
      status = 'ok'
      ms = Date.now() - t0
    } catch (e) {
      status = 'error: ' + e.message.slice(0, 80)
    }
    items.push({ key: site.key, name: site.name, type: site.type, status, ms })
  }
  res.json({ ok: true, data: items })
})

/* ================= 静态资源（规则脚本管理页） ================= */
app.use('/static', express.static(path.join(__dirname, 'public')))
app.use('/libs', express.static(path.join(__dirname, 'libs')))

app.get('/', (req, res) => {
  res.type('text/plain').send(
    [
      '影视仓复刻服务已启动',
      '',
      '接口：',
      '  GET  /api/health',
      '  GET  /api/config',
      '  GET  /api/sites',
      '  GET  /api/site/:key/home',
      '  GET  /api/site/:key/category?tid=&pg=',
      '  GET  /api/site/:key/detail?id=',
      '  GET  /api/site/:key/play?flag=&id=',
      '  GET  /api/site/:key/search?wd=',
      '  GET  /api/site/:key/logs',
      '  POST /api/config/import   {url}',
      '  GET  /proxy?url=',
      '',
      `站点数：${loadConfig().sites.length}`,
    ].join('\n')
  )
})

/* ================= 启动 ================= */
const server = app.listen(PORT, HOST, () => {
  const nets = getLocalIPs()
  console.log('='.repeat(60))
  console.log('  影视仓复刻服务')
  console.log(`  本机:http://127.0.0.1:${PORT}`)
  for (const ip of nets) console.log(`  局域网: http://${ip}:${PORT}   <- iPhone 用这个`)
  console.log(`  站点数: ${loadConfig().sites.length}`)
  const curl = checkCurl()
  if (curl.ok) {
    console.log(`  curl: ${curl.version}`)
  } else {
    console.log('  [警告] 未找到 curl —— 采集器的同步 _http 会全部失败！')
    console.log('         macOS/Linux 自带 curl；若异常请执行: brew install curl')
  }
  console.log('='.repeat(60))
})

/** 列出本机局域网 IP，方便在 iPhone 上填写 */
function getLocalIPs() {
  try {
    const out = []
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
      }
    }
    return out
  } catch {
    return []
  }
}

process.on('SIGINT', () => {
  console.log('\n正在关闭...')
  shutdownAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
})
process.on('SIGTERM', () => {
  shutdownAll()
  process.exit(0)
})

export { app }
void normalizeConfig
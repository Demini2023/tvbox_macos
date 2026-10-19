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
import fs from 'node:fs'
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
      // 站点 API（/api/site/*）消费方是本项目的 iOS App，其 Vod 模型把
      // vod_id 定义为 String（drpy 源的 id 常含非数字字符）。
      // TVBox 代理路径（toVodPage）另有自己的 Number 规整，互不影响。
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
  const site = resolveSite(key)
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
  return { site }
}

/* ================= 配置接口 ================= */
app.get('/api/config', (req, res) => {
  const cfg = loadConfig()
  res.json({ ok: true, data: publicConfig(cfg) })
})

/**
 * 读取实测可用的 CMS 站点清单（data/cms-config.json，scan_cms_sources.mjs 扫描产物）。
 * 这些站点 type=3、api 直接指向外部 CMS 站，本机已 HTTP 实测列表/详情/播放串三项通过。
 */
function readCmsSites() {
  const file = path.join(__dirname, 'data', 'cms-config.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 站点解析：先看活动配置 config.json，再看实测 CMS 清单 cms-config.json。
 *
 * 关键坑：/api/config/drpc|proxy 生成的「指向本服务」的代理配置，被客户端导入后
 * 它的 api 形如 http://<本机IP>:9527/api.php/provide/vod?site=cms_00 —— 若这份配置
 * 又被写进了本服务的 config.json（比如通过 /api/config/save），那么 resolveSite 从这里
 * 取到的是一个「自引用」站点：本服务收到请求后又去请求自己，而自身 provide/vod 返回的是
 * 不含 code:1 的空包，于是 cmsHome 判空、首页永远「无数据」。
 *
 * 因此：一旦从 config.json 取到的站点 api 指向「本服务自身的 /api.php/provide/vod」，
 * 就跳过它，改从权威外部清单 cms-config.json（含真实外链 api.ffzyapi.com 等）解析。
 */
const SELF_PROXY_RE = /\/api\.php\/provide\/vod/
function resolveSite(key) {
  const cfg = loadConfig()
  const fromCfg = getSite(cfg, key)
  if (fromCfg && !SELF_PROXY_RE.test(String(fromCfg.api || ''))) return fromCfg
  const cms = readCmsSites()
  if (cms && Array.isArray(cms.sites)) {
    const found = cms.sites.find((x) => x.key === key)
    if (found) return normalizeConfig({ sites: [found] }).sites[0]
  }
  // 兜底：config.json 里确实只有自引用站点、且外部清单也没有，则返回原站点
  // （上层会按 unsupported 处理，避免无意义的自循环）
  return fromCfg || null
}

/**
 * 生成「站点 api 指向本服务」的代理配置。
 *
 * 核心思路：让 iPhone 上的标准影视仓把「本服务」当成 type=3 的 CMS 接口源。
 * 配置里每个站点的 api 都写成：
 *   http://<本机IP>:9527/api.php/provide/vod?site=<key>
 * 影视仓随后按标准 provide/vod 协议不断请求 ?ac=list|videolist|detail|vodsearch，
 * 本服务在内部统一分发到 CMS-HTTP 或 drpy/QuickJS 采集器。
 *
 * 好处：
 *   1) iPhone 不需要自带 drpy 运行时（这正是原 apk 靠壳 + 外部规则才能跑的原因）；
 *   2) 所有请求都经过本服务，日志可读（用户要求「这样你能直接读 log」）；
 *   3) 以后 drpy 规则在本机跑通了，直接把站点加进 cms-config.json 风格的清单即可，
 *      同一套接口继续工作。
 *
 * host 取自请求的 Host 头，这样无需硬编码 IP，iPhone 用什么地址导入就用什么地址回源。
 */
function buildProxyConfig(req) {
  const cms = readCmsSites()
  const base = cms || { sites: [], parses: [] }
  const host = req.headers.host || `127.0.0.1:${PORT}`
  const proto = req.headers['x-forwarded-proto'] || 'http'
  const sites = (base.sites || []).map((s) => ({
    key: String(s.key),
    name: String(s.name),
    type: 3,
    api: `${proto}://${host}/api.php/provide/vod?site=${encodeURIComponent(s.key)}`,
    searchable: Number(s.searchable ?? 2),
    quickSearch: Number(s.quickSearch ?? 1),
    filterable: Number(s.filterable ?? 0),
  }))
  return {
    spider: '',
    wallpaper: '',
    sites,
    parses: base.parses || [],
    flags: [],
    lives: [],
    _meta: {
      generatedBy: 'nicewatcher/ysc/server',
      note:
        '所有站点的 api 均指向本服务 /api.php/provide/vod（影视仓复刻服务）。' +
        '由服务内部统一分发到 CMS 接口或 drpy/QuickJS 采集器，iPhone 无需自带 drpy 运行时，' +
        '且全部请求经过本服务、日志可读。',
    },
  }
}

/** 实测可用的 CMS 接口源配置（type=3，api 直接指向外部 CMS 站，iPhone 可直连，不依赖本服务） */
app.get('/api/config/cms', (req, res) => {
  const file = path.join(__dirname, 'data', 'cms-config.json')
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'cms-config.json 不存在，请先运行 scan_cms_sources.mjs' })
  }
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')))
})

/** 代理配置：站点 api 指向本服务（推荐，日志可读、无需 iPhone 自带 drpy 运行时） */
app.get('/api/config/proxy', (req, res) => {
  res.json(buildProxyConfig(req))
})

/**
 * 老链接兼容：/api/config/drpc 原本返回 79 个 drpy 站点（在本机/手机上全部「无数据」）。
 * 现改为返回「指向本服务」的代理配置，复用同一导入地址即可让首页立刻出数据、
 * 采集器变为本服务的 CMS 兼容接口（不再依赖手机端 drpy 运行时）。
 */
app.get('/api/config/drpc', (req, res) => {
  res.json(buildProxyConfig(req))
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
    // proxyBase：详情里的每个播放地址改写为本服务 /api.php/play 代理，
    // 否则 feifan 这类「HTML 分享页」线路在 iOS App 里点了没反应。
    const raw = await withSite(s.site, runtimeOpts(), 'detail', {
      id,
      proxyBase: buildPlayProxyBase(req),
    })
    // drpy2 的 detail 返回 { list: [单个 vod] }；客户端按 list[0] 取值。
    // 影片字段补空串，避免客户端解码时因缺字段整包失败。
    const d = normalizeVodList(raw, {})
    const first = d.list[0] ?? {}
    // 播放串适配：采集器输出是 TVBox 约定（$$$ 分线路、每组带「线路名$」前缀），
    // iOS 客户端 VodDetail 按 $$ 分线路、每段直接是「集名$地址」。这里转换。
    const lineGroups = (s2) => String(s2 ?? '').split('$$$')
    const iosPlayUrl = lineGroups(first.vod_play_url)
      .map((g) => {
        const i = g.indexOf('$')
        return i >= 0 ? g.slice(i + 1) : g
      })
      .filter((g) => g.trim())
      .join('$$')
    const iosPlayFrom = lineGroups(first.vod_play_from)
      .map((x) => x.trim())
      .filter(Boolean)
      .join('$$')
    // VodDetail 模型的 vod_id 是 Int（数字型 CMS id），保持数字
    const numId = Number(first.vod_id ?? id)
    d.list = [{
      ...first,
      vod_id: Number.isFinite(numId) && numId !== 0 ? numId : first.vod_id ?? id,
      vod_name: String(first.vod_name ?? ''),
      vod_pic: String(first.vod_pic ?? ''),
      vod_remarks: String(first.vod_remarks ?? ''),
      vod_year: String(first.vod_year ?? ''),
      vod_area: String(first.vod_area ?? ''),
      vod_actor: String(first.vod_actor ?? ''),
      vod_director: String(first.vod_director ?? ''),
      vod_content: String(first.vod_content ?? ''),
      vod_play_from: iosPlayFrom,
      vod_play_url: iosPlayUrl,
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

/* ================= TVBox 风格兼容接口（影视仓直连入口） =================
 * 让 iPhone 上的标准影视仓把「本服务」当成 type=3 的 CMS 接口源来调用。
 * 配置里把站点 api 指向 http://<本机IP>:9527/api.php/provide/vod?site=<key> 后，
 * 影视仓会按标准 provide/vod 协议不断请求 ?ac=list|videolist|detail|vodsearch，
 * 本服务内部再分发给 CMS-HTTP 或 drpy/QuickJS 采集器。
 *
 * 注意：返回的是「裸」TVBox JSON（没有 {ok,data} 信封），影视仓才能解析。
 */
/** 把采集器输出规整成影视仓期望的影片分页结构，并保留源站的分页信息 */
function toVodPage(raw, pg = 1) {
  const data = parseJson(raw, { list: [] })
  const arr = Array.isArray(data) ? data : Array.isArray(data.list) ? data.list : []
  const list = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const id = it.vod_id ?? it.vodId ?? it.id
    if (id === undefined || id === null || id === '') continue
    const name = it.vod_name ?? it.vodName ?? it.name ?? ''
    const pic = it.vod_pic ?? it.vodPic ?? it.pic ?? ''
    list.push({
      ...it,
      vod_id: Number(id),
      vod_name: String(name),
      vod_pic: String(pic),
      vod_remarks: String(it.vod_remarks ?? it.vodRemarks ?? it.remarks ?? ''),
    })
  }
  return {
    page: Number(data.page) || pg,
    pagecount: Number(data.pagecount) || 1,
    total: Number(data.total) || list.length,
    limit: Number(data.limit) || 20,
    list,
  }
}

/** detail 结果补空白字段，避免影视仓因缺字段整包解码失败 */
function enrichDetailList(raw) {
  const d = normalizeVodList(raw, {})
  return (d.list || []).map((first) => ({
    vod_id: Number(first.vod_id ?? ''),
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
  }))
}

/**
 * 根据客户端请求 host 拼出「本服务播放代理」前缀。
 * 详情里的每个播放地址都会被改写成 `${prefix}<encodeURIComponent(原地址)>`，
 * 让 iPhone 把请求发回本服务，由 /api.php/play 解析/转发。
 */
function buildPlayProxyBase(req) {
  const host = req.headers.host || (req.get && req.get('host')) || `127.0.0.1:${PORT}`
  return `http://${host}/api.php/play?u=`
}

/**
 * 播放代理：影视仓点播时实际请求这里（地址已由详情改写为 ?u=<encoded>）。
 *   - 直链媒体（m3u8/mp4/ts/m3u）：直接 302 给播放器；
 *   - HTML 分享页：抓页提取 index.m3u8 直链再 302。
 * 这样 feifan 这种「分享页线路」也能在 iPhone 上播，且 CDN 无需 Referer。
 */
app.get('/api.php/play', async (req, res) => {
  const u = req.query.u
  if (!u || !/^https?:\/\//i.test(u)) return res.status(400).send('bad u')
  try {
    // 上游 CDN 偶发「200 但空 body」（实测 ffzy 出现过一次，重试即恢复），
    // 故这里重试一次；两次都失败才放弃
    const fetchOnce = () =>
      httpFetchAsync(u, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
            '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          Referer: new URL(u).origin + '/',
          Accept: '*/*',
        },
        timeoutMs: 20000,
      })
    let r = await fetchOnce()
    if (!r || !r.ok || !r.body) {
      await new Promise((resolve) => setTimeout(resolve, 800))
      r = await fetchOnce()
    }
    if (!r || !r.ok || !r.body) {
      return res
        .status(502)
        .send('fetch failed: ' + (r && r.status ? r.status : 'no body') +
              ' bodyLen=' + (r && r.body ? r.body.length : 0))
    }
    const ct = String((r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '').toLowerCase()
    const isHtml = ct.includes('html') || (!ct && r.body.trimStart().startsWith('<'))
    if (isHtml) {
      // 优先匹配绝对地址；否则匹配带完整目录的相对路径（含 /2026.../ 前缀）
      const m = r.body.match(
        /(https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?)|(\/[\w.\-/=]+\.m3u8(?:\?[^\s"'<>]*)?)/i,
      )
      const origin = new URL(u).origin
      let m3u8 = null
      if (m) {
        const p = m[1] || m[2]
        m3u8 = p.startsWith('http') ? p : origin + p
      }
      if (m3u8) return res.redirect(302, m3u8)
      return res.status(502).send('无法从页面解析出播放地址')
    }
    // 直链媒体：直接 302 给播放器（已验证该 CDN 无需 Referer）
    res.redirect(302, u)
  } catch (e) {
    res.status(502).send('play proxy error: ' + e.message)
  }
})

app.all('/api.php/provide/vod', async (req, res) => {
  const src = req.method === 'POST' ? req.body || {} : req.query
  const siteKey = src.site || src.ext
  const ac = String(src.ac || 'detail')
  const site = resolveSite(siteKey)
  // 不支持的站点返回空列表，避免客户端整包解码失败
  if (!site || site.supported === false) {
    return res.json({ class: [], list: [], page: 1, pagecount: 1, total: 0, limit: 20 })
  }
  const t = src.t || src.type_id || src.tid
  const pg = Number(src.pg || src.page || 1) || 1
  const wd = src.wd || src.keyword || ''
  const ids = src.ids || src.id || src.vod_id
  try {
    let body
    if (ac === 'list') {
      const classes = normalizeClasses(await withSite(site, runtimeOpts(), 'home', {}))
      const homeVod = await withSite(site, runtimeOpts(), 'homeVod', {})
      body = { class: classes.class, list: toVodPage(homeVod, 1).list, filters: {} }
    } else if (ac === 'videolist') {
      if (wd) {
        body = toVodPage(await withSite(site, runtimeOpts(), 'search', { wd, pg, quick: false }), pg)
      } else if (ids) {
        // 部分客户端用 ac=videolist&ids= 取详情，统一转 detail
        const proxyBase = buildPlayProxyBase(req)
        body = { list: enrichDetailList(await withSite(site, runtimeOpts(), 'detail', { id: ids, proxyBase })) }
      } else if (t) {
        body = toVodPage(await withSite(site, runtimeOpts(), 'category', { tid: t, pg }), pg)
      } else {
        body = { class: [], list: [], page: 1, pagecount: 1, total: 0, limit: 20 }
      }
    } else if (ac === 'detail' || ac === 'vod') {
      const proxyBase = buildPlayProxyBase(req)
      body = { list: enrichDetailList(await withSite(site, runtimeOpts(), 'detail', { id: ids, proxyBase })) }
    } else if (ac === 'vodsearch') {
      body = toVodPage(await withSite(site, runtimeOpts(), 'search', { wd, pg, quick: false }), pg)
    } else {
      body = { class: [], list: [] }
    }
    res.json(body)
  } catch (e) {
    console.error(`[provide/vod] site=${siteKey} ac=${ac} 失败: ${e.message}`)
    res.json({ class: [], list: [], page: 1, pagecount: 1, total: 0, limit: 20, error: e.message })
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
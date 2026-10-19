/**
 * 配置管理：TVBox/影视仓配置文件读写与归一化。
 *
 * 配置文件是一段 JSON，形如：
 * {
 *   "spider": "./libs/drpy2.min.js;md5;...",
 *   "wallpaper": "https://...jpg",
 *   "sites": [
 *     { "key": "drpy1", "name": "DrPy", "type": 1,
 *       "api": "./csp/drpy.js", "ext": "..." },
 *     { "key": "xpath1", "name": "普通接口", "type": 3,
 *       "api": "https://host/api.php/provide/vod", "ext": "...",
 *       "categories": [...], "header": {...} }
 *   ],
 *   "parses": [ { "name": "JSON", "url": "..." } ],
 *   "flags": [...], "lives": [...]
 * }
 *
 * 本服务聚焦 type=1（drpy JS 采集器）与 type=3（XPath/Cat 接口），
 * 其余类型原样透传。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpFetchAsync } from './httpBridge.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

fs.mkdirSync(DATA_DIR, { recursive: true })

/** 内置兜底配置：可用的公共drpy 源（用户可在 App 内替换） */
const BUILTIN_CONFIG = {
  spider: 'https://raw.githubusercontent.com/hjdhnx/dr_py/main/js/drpy2.min.js',
  wall_sao: '',
  wallpaper: '',
  sites: [
    {
      key: 'drpy_base',
      name: 'DrPy 采集器',
      type: 1,
      api: 'https://raw.githubusercontent.com/hjdhnx/dr_py/main/js/drpy2.min.js',
      ext: '',
      searchable: 2,
      quickSearch: 1,
    },
  ],
  parses: [{ name: 'JSON', url: 'https://jx.xmflv.com/?url=' }],
  flags: [
    { name: '快播', show: '呀 draining' },
  ],
  lives: [],
}

/** 读取本地配置 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
      return normalizeConfig(raw)
    }
  } catch (e) {
    console.error('[config] 本地配置解析失败，使用内置配置:', e.message)
  }
  return normalizeConfig(BUILTIN_CONFIG)
}

/** 保存配置到本地 */
export function saveConfig(cfg) {
  const norm = normalizeConfig(cfg)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(norm, null, 2), 'utf8')
  return norm
}

/** 从远程拉取配置（支持 JSON 与被包裹的 base64 形式） */
export async function fetchRemoteConfig(url, depth = 0) {
  const r = await httpFetchAsync(url, { timeoutMs: 20000 })
  if (!r.body) throw new Error('远程配置为空: ' + (r.error || r.status))
  let text = String(r.body).trim()
  // 去掉可能的 JSONP 包裹
  text = text.replace(/^\s*\w+\s*\(/, '').replace(/\)\s*;?\s*$/, '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 尝试 base64
    try {
      parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
    } catch (e) {
      throw new Error('配置格式无法解析（既不是 JSON 也不是 base64 JSON）')
    }
  }

  // ---- 仓列表间接层 ----
  // 聚合仓常是多层间接的：顶层只有 storeHouse / urls 字段，真正的配置
  // 在下一层。例如：
  //   wx.json  { "storeHouse": [ {sourceName, sourceUrl}, ... ] }
  //     -> yx.txt { "urls": [ {name, url}, ... ] }
  //        -> 真正的 TVBox 配置 { spider, sites: [...] }
  if (depth < 4) {
    const indirect = pickIndirectConfig(parsed)
    if (indirect) {
      const { kind, list } = indirect
      const ok = []
      const failed = []
      for (const item of list) {
        const u = item.url
        if (!u || typeof u !== 'string') continue
        try {
          const sub = await fetchRemoteConfig(u, depth + 1)
          if (sub && Array.isArray(sub.sites) && sub.sites.length) {
            ok.push({ name: item.name || u, cfg: sub })
          }
        } catch (e) {
          failed.push({ name: item.name || u, reason: e.message })
        }
      }
      if (!ok.length) {
        throw new Error(
          `已识别为${kind}仓（共 ${list.length} 个链接），但没有一个能拉到可用配置。` +
          `失败：${failed.slice(0, 3).map((f) => `${f.name}(${f.reason})`).join('; ')}`
        )
      }
      // 合并所有成功分支的 sites
      const merged = mergeConfigs(ok.map((x) => x.cfg))
      merged.sources = ok.map((x) => ({ name: x.name, sites: x.cfg.sites.length }))
      console.log(
        `[config] ${kind}仓展开成功：${ok.length}/${list.length} 个分支，` +
        `共 ${merged.sites.length} 个站点`
      )
      return saveConfig(merged)
    }
  }

  // ---- 导入校验：避免"成功但空列表"的误导 ----
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.sites)) {
    const keys = Object.keys(parsed).slice(0, 8).join(', ')
    throw new Error(
      `这不是 TVBox 配置文件：顶层没有 sites 字段。实际字段为 [${keys}]。` +
      `请确认地址是否指向真正的配置 JSON，而不是仓列表或网页。`
    )
  }

  return saveConfig(parsed)
}

/**
 * 识别「仓列表」形态并取出其中的链接。
 * 支持三种常见字段名：storeHouse（仓列表）、urls（订阅列表）。
 */
function pickIndirectConfig(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (Array.isArray(obj.storeHouse) && obj.storeHouse.length) {
    return {
      kind: 'storeHouse',
      list: obj.storeHouse.map((x) => ({ name: x?.sourceName, url: x?.sourceUrl })),
    }
  }
  if (Array.isArray(obj.urls) && obj.urls.length) {
    return {
      kind: 'urls',
      list: obj.urls.map((x) => ({ name: x?.name, url: x?.url })),
    }
  }
  return null
}

/** 合并多份配置：spider 取第一个非空，sites 拼接并去重 key */
function mergeConfigs(cfgs) {
  const out = { spider: '', wallpaper: '', parses: [], flags: [], lives: [], sites: [] }
  const seen = new Set()
  for (const c of cfgs) {
    if (!c) continue
    if (!out.spider && c.spider) out.spider = c.spider
    if (!out.wallpaper && c.wallpaper) out.wallpaper = c.wallpaper
    if (Array.isArray(c.parses)) out.parses.push(...c.parses)
    if (Array.isArray(c.flags)) out.flags.push(...c.flags)
    if (Array.isArray(c.lives)) out.lives.push(...c.lives)
    if (!Array.isArray(c.sites)) continue
    for (const s of c.sites) {
      if (!s || !s.key) continue
      if (seen.has(s.key)) continue
      seen.add(s.key)
      out.sites.push(s)
    }
  }
  return out
}

/**
 * 站点能力判定。
 *
 * TVBox 配置里的站点分三大类，本服务只能处理前两类：
 *   type 1 / 无 type + ext   dr_py JS 采集器  -> 支持（本服务的核心能力）
 *   type 3 + http(s):// api   Cat/XPath 接口   -> 支持（走 spider 转发）
 *   type 3 + csp_XXX / jar    CSP 插件         -> 不支持
 *
 * 最后一类是 Android 原生/Java 插件，本服务跑不了。若不提前标记，
 * 用户点进去只会看到空白页加一句莫名其妙的错误。
 */
export function siteCapability(site) {
  const api = String(site?.api || '')
  const ext = String(site?.ext || '')
  const type = Number(site?.type ?? 1)
  // csp_ 前缀 或 jar 字段 => Android 插件
  if (api.startsWith('csp_') || site?.jar) {
    return { supported: false, reason: 'csp', label: 'CSP插件' }
  }

  // ---- dr_py 采集器 ----
  // ext 有四种形态，可用性差别极大：
  //   a) 内联 JSON      —— 规则就在配置里            -> 可跑
  //   b) http(s)://     —— 远程规则文件              -> 可跑（运行时现拉）
  //   c) 整段 JS 源码   —— 含 var rule = {...}       -> 可跑
  //   d) ./x.js 之类    —— 指向 TVBox 客户端私有资源目录 -> 跑不了，
  //                         那些规则文件不随 JSON 配置分发
  // 实测主流聚合仓里的 dr_py 站点绝大多数是 (d)，点进去必然空白。
  if (ext) {
    if (ext.startsWith('{') || ext.startsWith('[')) {
      return { supported: true, kind: 'drpy', label: 'DrPy采集器', extKind: 'inline' }
    }
    if (/^https?:\/\//.test(ext)) {
      return { supported: true, kind: 'drpy', label: 'DrPy采集器', extKind: 'remote' }
    }
    // 整段 JS 源码：drpy2 的 init 对字符串走
    //   eval("(function(){" + js.replace('var rule','rule') + "})()")
    // 规则文件开头的 muban.xxx 修改依赖 init() 的闭包局部变量，所以这条必须成立
    if (/var\s+rule\s*=/.test(ext) || /^\s*muban\./.test(ext)) {
      return { supported: true, kind: 'drpy', label: 'DrPy采集器', extKind: 'script' }
    }
    // 相对路径：文件不在包里
    if (ext.endsWith('.js') || ext.startsWith('./') || ext.startsWith('../')) {
      return { supported: false, reason: 'ext_file', label: '需外部规则' }
    }
    return { supported: true, kind: 'drpy', label: 'DrPy采集器', extKind: 'opaque' }
  }

  if (api.startsWith('assets://') || api.startsWith('file://') || api.startsWith('./')) {
    return { supported: true, kind: 'drpy', label: 'DrPy采集器', extKind: 'none' }
  }
  if (type === 3 || api.startsWith('http://') || api.startsWith('https://')) {
    return { supported: true, kind: 'xpath', label: '接口源' }
  }
  return { supported: false, reason: 'unknown', label: '不支持' }
}

/** 归一化：补齐缺失字段、统一类型 */
export function normalizeConfig(cfg) {
  const c = Object.assign({}, BUILTIN_CONFIG, cfg || {})
  c.sites = Array.isArray(c.sites) ? c.sites : []
  c.sites = c.sites
    .filter((s) => s && (s.key || s.name))
    .map((s, i) => {
      const cap = siteCapability(s)
      return {
        key: String(s.key || 'site_' + i),
        name: String(s.name || s.key || '未命名'),
        type: Number(s.type ?? 1),
        api: String(s.api || ''),
        ext: s.ext === undefined || s.ext === null ? '' : String(s.ext),
        searchable: Number(s.searchable ?? 2),
        quickSearch: Number(s.quickSearch ?? 1),
        header: s.header && typeof s.header === 'object' ? s.header : undefined,
        categories: Array.isArray(s.categories) ? s.categories : undefined,
        playerType: s.playerType ?? -1,
        style: s.style,
        jar: s.jar,
        supported: cap.supported,
        kind: cap.kind || cap.reason,
        kindLabel: cap.label,
      }
    })
  c.parses = Array.isArray(c.parses) ? c.parses : []
  c.flags = Array.isArray(c.flags) ? c.flags : []
  c.lives = Array.isArray(c.lives) ? c.lives : []
  // 统计可用站点数，便于导入后立即判断"有没有东西可用"
  c.totalSites = c.sites.length
  c.usableSites = c.sites.filter((s) => s.supported).length
  return c
}

/** 按 key 取站点 */
export function getSite(cfg, key) {
  return (cfg.sites || []).find((s) => s.key === key) || null
}

/** 供前端使用的精简配置（隐藏 ext 等敏感字段） */
export function publicConfig(cfg) {
  return {
    spider: cfg.spider,
    wallpaper: cfg.wallpaper,
    sites: (cfg.sites || []).map((s) => ({
      key: s.key,
      name: s.name,
      type: s.type,
      searchable: s.searchable,
      quickSearch: s.quickSearch,
      categories: s.categories || null,
      // 客户端据此过滤掉跑不了的 CSP 插件
      supported: s.supported !== false,
      kind: s.kind || '',
      kindLabel: s.kindLabel || '',
    })),
    parses: (cfg.parses || []).map((p) => ({ name: p.name })),
    flags: (cfg.flags || []).map((f) => ({ name: f.name })),
    lives: (cfg.lives || []).map((l) => ({ name: l.name, channels: (l.channels || []).length })),
  }
}
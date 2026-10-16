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
export async function fetchRemoteConfig(url) {
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
  return saveConfig(parsed)
}

/** 归一化：补齐缺失字段、统一类型 */
export function normalizeConfig(cfg) {
  const c = Object.assign({}, BUILTIN_CONFIG, cfg || {})
  c.sites = Array.isArray(c.sites) ? c.sites : []
  c.sites = c.sites
    .filter((s) => s && (s.key || s.name))
    .map((s, i) => ({
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
    }))
  c.parses = Array.isArray(c.parses) ? c.parses : []
  c.flags = Array.isArray(c.flags) ? c.flags : []
  c.lives = Array.isArray(c.lives) ? c.lives : []
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
    })),
    parses: (cfg.parses || []).map((p) => ({ name: p.name })),
    flags: (cfg.flags || []).map((f) => ({ name: f.name })),
    lives: (cfg.lives || []).map((l) => ({ name: l.name, channels: (l.channels || []).length })),
  }
}
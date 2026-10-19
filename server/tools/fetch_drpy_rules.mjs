/**
 * 扫描 dr_py 官方规则仓库，筛选出真实可用的配置。
 *
 * 背景：主流聚合仓的站点几乎都是 type=3（CSP 插件，Android Java 实现），
 * 本服务跑不了。但 dr_py 官方仓库 js/ 目录下有 188 个纯 JS 规则，
 * 每个文件都是一段能被 init(ext) 直接 eval 的源码。
 *
 * 用法：
 *   node tools/fetch_drpy_rules.mjs              # 只扫描不下载
 *   node tools/fetch_drpy_rules.mjs --fetch      # 扫描并下载规则文件
 *   node tools/fetch_drpy_rules.mjs --fetch 20   # 只下前 20 个（试水）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'data', 'drpy-rules')
const CACHE = path.join(OUT_DIR, 'manifest.json')

const REPO = 'hjdhnx/dr_py'
const BRANCH = 'main'
// gh-proxy 是 raw.githubusercontent 的国内代理，直连基本不可用
const PROXY = 'https://gh-proxy.com/https://'
const API = `${PROXY}https://api.github.com/repos/${REPO}/contents/js`
const RAW = `${PROXY}https://raw.githubusercontent.com/${REPO}/${BRANCH}/js/`

const args = process.argv.slice(2)
const wantFetch = args.includes('--fetch')
const limitArg = args.find((a) => /^\d+$/.test(a))
const limit = limitArg ? Number(limitArg) : Infinity

async function getJson(url, timeoutMs = 30000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json' } })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function getText(url, timeoutMs = 30000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) return null
    return await r.text()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 从规则源码里粗提 title/host，用于列表展示 */
function peek(src) {
  const title = src.match(/title\s*:\s*['"]([^'"]{1,40})['"]/)?.[1] || ''
  const host = src.match(/host\s*:\s*['"]([^'"]{1,80})['"]/)?.[1] || ''
  // 依赖模板（muban）的规则无法独立运行，需要 drpy2 的模板支持，
  // 但我们复刻的 drpy2.js 原生支持模板，所以保留
  const needsTemplate = /\bmuban\./.test(src)
  return { title, host, needsTemplate }
}

console.log(`扫描 ${REPO} 的 js/ 目录…`)
const list = await getJson(API)
if (!list || !Array.isArray(list)) {
  console.error('无法获取目录列表（代理可能失效）')
  process.exit(1)
}

const jsFiles = list.filter((x) => x.type === 'file' && x.name.endsWith('.js'))
console.log(`共 ${jsFiles.length} 个 .js 规则文件\n`)

if (!wantFetch) {
  console.log('加 --fetch 参数可下载规则并生成配置')
  process.exit(0)
}

fs.mkdirSync(OUT_DIR, { recursive: true })

const manifest = []
let done = 0
const CONCURRENCY = 6

async function worker() {
  while (manifest.length + done < jsFiles.length && done < limit) {
    const idx = done++
    if (idx >= jsFiles.length || idx >= limit) return
    const item = jsFiles[idx]
    const enc = encodeURIComponent(item.name)
    const src = await getText(`${RAW}${enc}`)
    if (!src || src.length < 40) continue
    const info = peek(src)
    const file = `${String(idx).padStart(3, '0')}_${item.name}`
    fs.writeFileSync(path.join(OUT_DIR, file), src, 'utf8')
    manifest.push({
      key: file.replace(/\.js$/, ''),
      name: info.title || item.name.replace(/\.js$/, ''),
      file,
      host: info.host,
      needsTemplate: info.needsTemplate,
      bytes: src.length,
      remote: `${RAW}${enc}`,
    })
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

manifest.sort((a, b) => a.name.localeCompare(b.name))
fs.writeFileSync(CACHE, JSON.stringify(manifest, null, 2), 'utf8')

console.log(`下载完成：${manifest.length} 个规则存于 data/drpy-rules/`)
const withHost = manifest.filter((m) => m.host).length
console.log(`含 host 的：${withHost}（其余可能走默认或已失效）`)
console.log(`清单：${path.relative(process.cwd(), CACHE)}`)

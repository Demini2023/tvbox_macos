/**
 * 实测 dr_py 规则可用性，筛出真正能返回数据的源。
 *
 * 背景：主流聚合仓的站点几乎都是 type=3（CSP 插件），本服务跑不了。
 * dr_py 官方仓库 js/ 下有 188 个纯 JS 规则，但作者仓库里的规则
 * 大多已经过时（host 失效、解析表达式对不上改版后的页面）。
 * 这里逐个真跑一遍 home()/detail()，只有拿到数据的才留下。
 *
 * 用法：
 *   node tools/probe_rules.mjs            # 测前 20 个
 *   node tools/probe_rules.mjs 188        # 全测
 *   node tools/probe_rules.mjs 188 4      # 全测，并发 4
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../drpyRuntime.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RULES_DIR = path.join(__dirname, '..', 'data', 'drpy-rules')
const RESULT = path.join(__dirname, '..', 'data', 'probe-result.json')

const limit = Number(process.argv[2] || 20)
// QuickJS 运行时共享底层资源，并发会串状态（muban 未定义等），必须串行
const concurrency = 1

const files = fs
  .readdirSync(RULES_DIR)
  .filter((f) => f.endsWith('.js'))
  .slice(0, limit)

if (!files.length) {
  console.error('规则目录为空，先跑 fetch_drpy_rules.mjs')
  process.exit(1)
}

console.log(`开始实测 ${files.length} 个规则（并发 ${concurrency}）\n`)

let done = 0
const results = []

async function probe(file) {
  const src = fs.readFileSync(path.join(RULES_DIR, file), 'utf8')
  const title = src.match(/title\s*:\s*['"]([^'"]{1,40})['"]/)?.[1] || file.replace(/\.js$/, '')
  const host = src.match(/host\s*:\s*['"]([^'"]+)['"]/)?.[1] || ''

  const rec = { file, title, host, ok: false, classes: 0, vods: 0, error: '' }
  done++
  process.stdout.write(`[${String(done).padStart(3)}/${files.length}] ${title.padEnd(18).slice(0, 18)} `)

  try {
    const rt = await createRuntime({ verbose: false })
    try {
      // init 后调 home 拿分类，再调 homeVod 拿推荐
      // drpy2 的 init 对字符串 ext 会走
      //   eval("(function(){" + js.replace('var rule','rule') + "})()")
      // 这条路：闭包能拿到 init() 的局部变量 muban，
      // 规则文件开头的 muban.xxx 修改才有效。
      // 若传对象则 rule 直接被替换，muban 会 undefined。
      rt.initRule(src)
      // drpy2 的 home()/homeVod() 返回的是 JSON 字符串而非对象，
      // 必须先 parse 再判断，否则会把有数据的站点误判成空。
      const parseMaybe = (v) => {
        if (v && typeof v === 'object') return v
        if (typeof v !== 'string' || !v.trim()) return null
        try { return JSON.parse(v) } catch { return null }
      }
      const home = parseMaybe(rt.home({}))
      const classes = Array.isArray(home?.class) ? home.class.length
        : Array.isArray(home) ? home.length : 0
      let vods = 0
      try {
        const hv = parseMaybe(rt.homeVod({}))
        vods = Array.isArray(hv?.list) ? hv.list.length : 0
      } catch { /* homeVod 失败不影响分类判定 */ }
      rec.ok = classes > 0 || vods > 0
      rec.classes = classes
      rec.vods = vods
    } finally {
      rt.dispose()
    }
    console.log(rec.ok ? `OK  分类${rec.classes} 推荐${rec.vods}` : '空  (无数据)')
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 90)
    console.log(`ERR ${rec.error}`)
  }
  results.push(rec)
}

async function run() {
  const queue = [...files]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift()
      await probe(f)
    }
  })
  await Promise.all(workers)
}

const t0 = Date.now()
await run()

const okList = results.filter((r) => r.ok).sort((a, b) => b.vods - a.vods || b.classes - a.classes)
fs.writeFileSync(RESULT, JSON.stringify(results, null, 2), 'utf8')

console.log(`\n${'='.repeat(60)}`)
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`可用: ${okList.length} / ${results.length}`)
if (okList.length) {
  console.log('\n可用规则（按推荐数排序）:')
  for (const r of okList.slice(0, 30)) {
    console.log(`  ${r.title.padEnd(20).slice(0, 20)} 分类${String(r.classes).padStart(3)} 推荐${String(r.vods).padStart(3)}  ${r.file}`)
  }
}
console.log(`\n明细: ${path.relative(process.cwd(), RESULT)}`)

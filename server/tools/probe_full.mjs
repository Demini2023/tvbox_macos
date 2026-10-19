/**
 * 端到端探测：跑完 home -> category -> detail -> play 全链路，
 * 确认每个站点是否真的能出数据、能播。
 *
 * 与 probe_rules.mjs 的区别：那个只测 home()/homeVod()，
 * 而很多源 home 能出分类、点进去却是空的（分类页才是真正的工作量）。
 *
 * 用法：
 *   node tools/probe_full.mjs            # 测全部
 *   node tools/probe_full.mjs 20         # 只测前 20
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../drpyRuntime.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RULES_DIR = path.join(__dirname, '..', 'data', 'drpy-rules')
const PROBE = path.join(__dirname, '..', 'data', 'probe-result.json')
const OUT = path.join(__dirname, '..', 'data', 'probe-full.json')

const limit = Number(process.argv[2] || Infinity)

const probed = JSON.parse(fs.readFileSync(PROBE, 'utf8'))
const candidates = probed.filter((x) => x.ok).slice(0, limit)

console.log(`端到端探测 ${candidates.length} 个站点（串行，约 ${Math.ceil(candidates.length / 12)} 分钟）\n`)

let done = 0
const results = []

for (const c of candidates) {
  const src = fs.readFileSync(path.join(RULES_DIR, c.file), 'utf8')
  const rec = {
    file: c.file,
    title: c.title,
    host: c.host,
    classes: 0,
    category: 0,
    detail: 0,
    play: 0,
    playUrl: '',
    score: 0,
    error: '',
  }
  done++
  process.stdout.write(`[${String(done).padStart(3)}/${candidates.length}] ${c.title.padEnd(16).slice(0, 16)} `)

  let rt = null
  try {
    rt = await createRuntime({ verbose: false, evalTimeoutMs: 25000 })
    rt.initRule(src)

    // 1. home -> 分类
    const home = JSON.parse(rt.home({}))
    const classes = Array.isArray(home.class) ? home.class : []
    rec.classes = classes.length

    if (!classes.length) {
      console.log('无分类')
      results.push(rec)
      continue
    }

    // 2. category -> 影片列表
    let vods = []
    for (const cl of classes.slice(0, 3)) {
      try {
        const d = JSON.parse(rt.category(cl.type_id, 1))
        const L = Array.isArray(d.list) ? d.list : []
        if (L[0] && L[0].vod_id === 'no_data') continue
        if (L.length) {
          vods = L
          break
        }
      } catch {
        /* 该分类失败就换下一个 */
      }
    }
    rec.category = vods.length
    if (!vods.length) {
      console.log(`分类${rec.classes} 列表空`)
      results.push(rec)
      continue
    }

    // 3. detail -> 选集
    let eps = ''
    try {
      const dt = JSON.parse(rt.detail(vods[0].vod_id))
      const v = Array.isArray(dt.list) ? dt.list[0] : null
      if (v && v.vod_play_url) {
        const line = String(v.vod_play_url).split('$$')[0]
        eps = line.split('#')[0] || ''
        rec.detail = 1
      }
    } catch {
      /* detail 失败不影响评分 */
    }

    // 4. play -> 真实播放地址
    if (eps) {
      const seg = eps.split('$')
      if (seg.length >= 2) {
        try {
          const p = JSON.parse(rt.play('', seg[1]))
          const u = String(p.url || '')
          if (u && u !== 'undefined') {
            rec.play = 1
            rec.playUrl = u.slice(0, 80)
          }
        } catch {
          /* play 失败 */
        }
      }
    }

    // 综合评分：能出列表最重要
    rec.score = (rec.category > 0 ? 4 : 0) + (rec.detail ? 2 : 0) + (rec.play ? 1 : 0)
    const flags = []
    if (rec.category) flags.push(`列表${rec.category}`)
    if (rec.detail) flags.push('详情✓')
    if (rec.play) flags.push('播放✓')
    console.log(flags.length ? flags.join(' ') : `分类${rec.classes} 列表空`)
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 100)
    console.log('ERR ' + rec.error.slice(0, 50))
  } finally {
    if (rt) {
      try {
        rt.dispose()
      } catch {
        /* noop */
      }
    }
    results.push(rec)
  }
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')

const good = results.filter((r) => r.category > 0)
const full = results.filter((r) => r.score >= 5)
const listOnly = results.filter((r) => r.category > 0 && r.score < 5)

console.log('\n' + '='.repeat(64))
console.log(`总测 ${results.length}`)
console.log(`  分类可出列表: ${good.length}`)
console.log(`  列表+详情:    ${listOnly.length}`)
console.log(`  全链路(含播放): ${full.length}`)

const ranked = [...results].sort((a, b) => b.score - a.score || b.category - a.category)
console.log('\n可用站点（按评分排序）:')
for (const r of ranked.filter((x) => x.category > 0)) {
  const tag = r.score >= 7 ? '★' : r.score >= 5 ? '√' : '·'
  console.log(
    `  ${tag} ${r.title.padEnd(16).slice(0, 16)} 列表${String(r.category).padStart(3)} ` +
      `${r.detail ? '详情✓' : '详情✗'} ${r.play ? '播放✓' : '播放✗'} ${r.playUrl.slice(0, 50)}`
  )
}
console.log(`\n明细: ${path.relative(process.cwd(), OUT)}`)
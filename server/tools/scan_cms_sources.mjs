/**
 * 扫描 CatVod（CMS 接口）源，找出真正能用的并生成配置。
 *
 * 为什么需要这个：dr_py 规则的源站大量失效（实测 403/000），
 * 而 CMS 接口源（type=3）结构固定、老牌接口大多还活着。
 *
 * 判定标准（每条都真发请求）：
 *   1. 列表接口   code=1 且 list 非空
 *   2. 详情接口   必须带 ac=detail，否则只有列表字段没有封面和播放串
 *   3. 播放串     能解析出「集名$地址」的条目
 *
 * 用法：node tools/scan_cms_sources.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'data', 'cms-config.json')
const REPORT = path.join(__dirname, '..', 'data', 'cms-scan.json')

/** 候选 CMS 接口源（都是常见的 Apple CMS 采集站） */
const CANDIDATES = [
  { name: '非凡资源', api: 'https://api.ffzyapi.com/api.php/provide/vod', ver: '2026-10-19 实测可用' },
  { name: '量子资源', api: 'https://cj.lziapi.com/api.php/provide/vod', ver: '' },
  { name: '海纳TV', api: 'https://caiji.dyttzyapi.com/api.php/provide/vod', ver: '' },
  { name: '非凡2', api: 'https://cj.ffzyapi.com/api.php/provide/vod', ver: '' },
  { name: '弹幕资源', api: 'https://api.dmswzz.com/api.php/provide/vod', ver: '' },
  { name: '天天资源', api: 'https://api.ttyys.com/api.php/provide/vod', ver: '' },
  { name: '玩视资源', api: 'https://api.wszxgm.com/api.php/provide/vod', ver: '' },
  { name: '雷霆资源', api: 'https://api.leitingnb.com/api.php/provide/vod', ver: '' },
  { name: '米星资源', api: 'https://api.xiaomizy.com/api.php/provide/vod', ver: '' },
  { name: '红牛资源', api: 'https://api.hongniuzy.com/api.php/provide/vod', ver: '' },
]

const TIMEOUT = 15000

async function getJson(url) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'okhttp/3.12.1' },
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 探测单个源：列表 -> 详情 -> 播放串 */
async function probe(src) {
  const rec = {
    name: src.name,
    api: src.api,
    classes: 0,
    vods: 0,
    hasPic: false,
    hasPlay: false,
    eps: 0,
    ok: false,
    note: '',
  }

  // 1. 列表
  const list = await getJson(src.api)
  if (!list) {
    rec.note = '列表接口不可达'
    return rec
  }
  if (list.code !== 1) {
    rec.note = 'code=' + list.code + ' ' + (list.msg || '')
    return rec
  }
  const classes = Array.isArray(list.class) ? list.class : []
  const vods = Array.isArray(list.list) ? list.list : []
  rec.classes = classes.length
  rec.vods = vods.length
  if (!classes.length || !vods.length) {
    rec.note = '分类或列表为空'
    return rec
  }

  // 2. 详情 —— 关键：不带 ac=detail 只返回列表字段
  //    vod_pic / vod_play_url 都不给
  const detailUrl = `${src.api}?ac=detail&ids=${vods[0].vod_id}`
  const det = await getJson(detailUrl)
  if (!det || !Array.isArray(det.list) || !det.list.length) {
    rec.note = '详情接口失败'
    return rec
  }
  const v = det.list[0]
  rec.hasPic = !!v.vod_pic && v.vod_pic.startsWith('http')
  const playRaw = v.vod_play_url || ''
  // 格式：集名$地址#集名$地址$$$另一个来源
  const firstSeg = playRaw.split('$$$')[0] || ''
  const items = firstSeg.split('#').filter(Boolean)
  rec.eps = items.length
  rec.hasPlay = items.some((it) => it.includes('$') && it.split('$')[1]?.startsWith('http'))

  if (!rec.hasPic) rec.note = '详情无封面'
  else if (!rec.hasPlay) rec.note = '详情无播放串'
  else rec.ok = true

  return rec
}

console.log(`探测 ${CANDIDATES.length} 个 CMS 接口源…\n`)
const results = []
for (const src of CANDIDATES) {
  process.stdout.write(`  ${src.name.padEnd(12).slice(0, 12)} `)
  const r = await probe(src)
  results.push(r)
  console.log(
    r.ok
      ? `可用  分类${r.classes} 影片${r.vods} ${r.eps}集`
      : `不可用  ${r.note}`
  )
}

const ok = results.filter((r) => r.ok)

// 生成配置
const sites = ok.map((r, i) => ({
  key: 'cms_' + String(i).padStart(2, '0'),
  name: r.name,
  type: 3,
  api: r.api,
  searchable: 2,
  quickSearch: 1,
  filterable: 1,
}))

const cfg = {
  spider: '',
  wallpaper: '',
  sites,
  parses: [
    {
      name: 'Json并发',
      type: 2,
      url: 'Parallel',
      ext: {
        token: '',
        urlencode: 0,
        players: [],
      },
    },
  ],
  flags: [],
  lives: [],
  _meta: {
    source: 'scan_cms_sources.mjs 实测',
    probedAt: new Date().toISOString(),
    total: CANDIDATES.length,
    usable: sites.length,
    note:
      '全部为 type=3 的 CMS 接口源，实测列表/详情/播放串三项均通过。' +
      '详情接口需带 ac=detail 参数，否则不返回封面与播放地址。',
  },
}

fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2), 'utf8')
fs.writeFileSync(REPORT, JSON.stringify(results, null, 2), 'utf8')

console.log('\n' + '='.repeat(58))
console.log(`可用 ${sites.length} / ${CANDIDATES.length}`)
for (const r of ok) {
  console.log(`  ${r.name.padEnd(12).slice(0, 12)} ${r.api}`)
}
console.log(`\n配置: ${path.relative(process.cwd(), OUT)}`)
console.log(`明细: ${path.relative(process.cwd(), REPORT)}`)
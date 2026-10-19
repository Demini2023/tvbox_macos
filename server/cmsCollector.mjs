/**
 * CatVod（CMS）接口源采集器 —— 对应 TVBox 配置里的 type:3 / api 为 http 地址。
 *
 * 为什么需要它：影视仓这类配置里接口源占绝大多数（比 dr_py 多得多），
 * 且 CMS 接口结构固定、老牌接口大多还活着，而 dr_py 规则大量失效。
 *
 * CMS 接口约定（Apple CMS / MacCMS 通用）：
 *   列表  {api}?ac=list            -> {code, class[], list[], page, pagecount}
 *   分类  {api}?ac=videolist&t={分类id}&pg={页}
 *   详情  {api}?ac=detail&ids={id}  -> {list:[{vod_play_url:"集$地址#集$地址"}]}
 *   搜索  {api}?wd={关键词}
 *
 * 关键坑：详情**必须**带 ac=detail，否则只返回列表字段，
 * vod_pic / vod_play_url 都是缺失的。
 */
import { httpFetchAsync } from './httpBridge.mjs'

/** 判断站点是否为 CMS 接口源 */
export function isCmsSite(site) {
  const api = String(site?.api || '')
  const type = Number(site?.type ?? 1)
  if (!/^https?:\/\//i.test(api)) return false
  // dr_py 站点也可能带 http api，但它们有 ext（规则）
  if (site?.ext && String(site.ext).trim()) return false
  return type === 3 || type === 1 || /provide\/vod|api\.php|\/api\/vod/.test(api)
}

async function getJson(url) {
  const res = await httpFetchAsync(url, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
    },
    timeoutMs: 15000,
  })
  // httpFetchAsync 返回 {ok, status, body}，不是 {code}
  if (!res || !res.ok || !res.body) return null
  const text = String(res.body).trim()
  if (!text.startsWith('{')) return null
  try {
    const j = JSON.parse(text)
    return j && j.code === 1 ? j : null
  } catch {
    return null
  }
}

/** 首页：分类 + 推荐 */
async function cmsHome(site) {
  const j = await getJson(site.api)
  if (!j) return { class: [], filters: {} }
  const classes = (j.class || []).map((c) => ({
    type_id: String(c.type_id),
    type_name: c.type_name,
  }))
  // 列表接口不返回 vod_pic，首页推荐仅用于占位，卡片图会空
  const list = (j.list || []).slice(0, 20).map((v) => ({
    vod_id: String(v.vod_id),
    vod_name: v.vod_name,
    vod_pic: v.vod_pic || '',
    vod_remarks: v.vod_remarks || '',
  }))
  return { class: classes, filters: {}, list }
}

/** 分类页影片列表 */
async function cmsCategory(site, tid, pg = 1) {
  const url = `${site.api}?ac=videolist&t=${encodeURIComponent(tid)}&pg=${pg}`
  const j = await getJson(url)
  if (!j) return { page: pg, pagecount: 1, limit: 20, total: 0, list: [] }
  const list = (j.list || []).map((v) => ({
    vod_id: String(v.vod_id),
    vod_name: v.vod_name,
    vod_pic: v.vod_pic || '',
    vod_remarks: v.vod_remarks || '',
  }))
  return {
    page: Number(j.page) || pg,
    pagecount: Number(j.pagecount) || 1,
    limit: Number(j.limit) || 20,
    total: Number(j.total) || list.length,
    list,
  }
}

/**
 * 规范 CMS 的播放串为 TVBox 的两段式。
 *
 * CMS 源格式：
 *   vod_play_from = "feifan$$$ffm3u8"          线路名，$$$ 分隔
 *   vod_play_url  = "第01集$url#第02集$url$$$第01集$url2..."  集名$地址，$$$ 分线路
 *
 * TVBox 期望：
 *   vod_play_from = "线路名1$$$线路名2"
 *   vod_play_url  = "线路名1$第01集$url#...$$$线路名2$第01集$url2..."
 *
 * 保留真实地址很重要：客户端有些会直接拿 vod_play_url 里的地址去播。
 */
function splitPlayUrl(raw, sourceNames) {
  // 线路名用 $$$ 分隔，不是逗号 —— 这是最容易踩的坑
  const names = String(sourceNames || '')
    .split('$$$')
    .map((s) => s.trim())
    .filter(Boolean)
  const groups = String(raw || '').split('$$$')
  return groups
    .map((g, gi) => {
      const srcName = names[gi] || `线路${gi + 1}`
      const eps = g.split('#').filter(Boolean).join('#')
      return `${srcName}$${eps}`
    })
    .join('$$$')
}

/** 详情：必须带 ac=detail，否则没有封面和播放地址 */
async function cmsDetail(site, id) {
  const url = `${site.api}?ac=detail&ids=${encodeURIComponent(id)}`
  const j = await getJson(url)
  if (!j || !Array.isArray(j.list) || !j.list.length) return { list: [] }
  const v = j.list[0]
  // TVBox 约定：vod_play_from 是线路名列表（$$$ 分隔），
  // vod_play_url 是与之一一对应的 "集名$地址" 串。
  const plays = splitPlayUrl(v.vod_play_url, v.vod_play_from)
  const fromNames = plays
    .split('$$$')
    .map((seg) => seg.split('$')[0] || '')
    .join('$$$')
  return {
    list: [
      {
        vod_id: String(v.vod_id),
        vod_name: v.vod_name || '',
        vod_pic: v.vod_pic || '',
        type_name: v.type_name || '',
        vod_year: v.vod_year || '',
        vod_area: v.vod_area || '',
        vod_remarks: v.vod_remarks || '',
        vod_content: v.vod_content || v.vod_blurb || '',
        vod_play_from: fromNames,
        vod_play_url: plays,
      },
    ],
  }
}

/**
 * 播放：客户端传来的 id 形如 "第01集$https://..."（集名$地址），
 * 取最后一段作为播放地址。flag 是线路名，这里不参与解析。
 */
async function cmsPlay(site, flag, id) {
  const raw = String(id || '')
  const url = raw.includes('$') ? raw.slice(raw.lastIndexOf('$') + 1) : raw
  if (!url) return { url: '', parse: 0 }
  return { url, parse: 0, header: { 'User-Agent': 'okhttp/3.12.1' } }
}

/** 搜索 */
async function cmsSearch(site, wd, quick = false) {
  const url = `${site.api}?wd=${encodeURIComponent(wd)}`
  const j = await getJson(url)
  if (!j) return { list: [] }
  return {
    list: (j.list || []).slice(0, 60).map((v) => ({
      vod_id: String(v.vod_id),
      vod_name: v.vod_name,
      vod_pic: v.vod_pic || '',
      vod_remarks: v.vod_remarks || '',
    })),
  }
}

/**
 * 统一入口。返回 null 表示「不是 CMS 源，交给别的采集器」。
 *
 * 注意返回结构必须和 QuickJS worker 一致（不做 {data:...} 包装），
 * 因为上层路由 normalizeClasses / normalizeVodList 直接消费它。
 */
export async function dispatchCms(site, op, args = {}) {
  if (!isCmsSite(site)) return null
  switch (op) {
    case 'home':
      return await cmsHome(site)
    case 'homeVod': {
      const h = await cmsHome(site)
      return { page: 1, pagecount: 1, limit: 20, total: 0, list: h.list || [] }
    }
    case 'category':
      return await cmsCategory(site, args.tid ?? args.tId, Number(args.pg) || 1)
    case 'detail':
      return await cmsDetail(site, args.id)
    case 'play':
      return await cmsPlay(site, args.flag, args.id)
    case 'search':
      return await cmsSearch(site, args.wd, args.quick)
    default:
      return null
  }
}
/**
 * 规则字段标准化：TVBox/影视仓 中文（或旧版）字段名 -> drpy2 期望的字段名。
 *
 * 依据 APK 内 drpy2.js 的静态分析，各函数读取的 rule 字段为：
 *   home()      : url, 一级, 二级, 二级访问前, class_parse, class_name, class_url,
 *                 homeUrl, detailUrl, 推荐, double, filter, cate_exclude, tab_exclude
 *   homeVod()   : homeUrl, detailUrl, url, 一级, 二级, 推荐, double
 *   category()  : url, 一级, detailUrl
 *   detail()    : homeUrl, detailUrl, 搜索, 二级, 二级访问前
 *   play()      : 搜索, proxy_rule, sniffer, isVideo
 *   search()    : searchUrl, 搜索, proxy_rule, sniffer, isVideo
 *
 * 而社区里常见的写法是中文键名（分类/一级分类/详情/播放/搜索二级/名称/图片...），
 * 这里做双向兼容，上层只需关心一种写法。
 */

/** 中文/旧字段名 -> drpy2 字段名 */
const FIELD_ALIASES = {
  // 分类
  '分类': 'class_parse',
  '分类Parse': 'class_parse',
  '分类解析': 'class_parse',
  '一级分类': '推荐',
  'homeVod': '推荐',
  '推荐Parse': '推荐',
  // 列表：drpy2 的 category() 读的是「一级」
  '二级分类': '一级',
  'list_parse': '一级',
  'listParse': '一级',
  '列表': '一级',
  '名称': 'titleParse',
  'titleParse': 'titleParse',
  '名称Parse': 'titleParse',
  '图片': '图片Parse',
  '图片Parse': '图片Parse',
  '图片解析': '图片Parse',
  '描述': 'descParse',
  'descParse': 'descParse',
  '描述Parse': 'descParse',
  // 搜索：drpy2 原生字段名就是「搜索」，不要改写；
  // searchParse 是 TVBox 老配置里的别名，需映射到「搜索」
  '搜索': '搜索',
  'searchParse': '搜索',
  '搜索解析': '搜索',
  '搜索二级': '搜索',
  '搜索二级Parse': '搜索',
  // 详情：drpy2 用「二级」承载二级/详情解析，detailParse 是别名
  '详情': '二级',
  'detailParse': '二级',
  '详情解析': '二级',
  '播放': 'lazy',
  '播放解析': 'lazy',
  'play': 'lazy',
  '懒加载': 'lazy',
  // 编码
  '编码': 'encoding',
  '搜索编码': 'search_encoding',
  // 过滤
  '过滤': 'filter',
  '筛选': 'filter',
  'filter_url': 'filter_url',
  '分类过滤': 'cate_exclude',
  '标签过滤': 'tab_exclude',
  '分类排除': 'cate_exclude',
  '标签排除': 'tab_exclude',
  // 选集
  '二级': '二级',
  '选集': '二级',
  '排序': 'tab_order',
  '重命名': 'tab_rename',
  '移除': 'tab_remove',
  // 其他
  '预热': 'lazy',
  '首页缓存': 'lazy',
  '禁止': 'tab_remove',
  'post数据': 'post_data',
  'postData': 'post_data',
  'js爬虫': 'proxy_rule',
  '静态': 'proxy_rule',
}

/**
 * 标准化规则对象：补齐默认值 + 字段名映射。
 * @param {object} input 用户/配置里的规则
 * @returns {object} drpy2 可直接消费��规则
 */
export function normalizeRule(input) {
  const src = input && typeof input === 'object' ? input : {}

  // 先做字段名映射
  const out = {}
  for (const [k, v] of Object.entries(src)) {
    const key = FIELD_ALIASES[k] || k
    // 已存在的标准字段优先保留（避免别名覆盖显式字段）
    if (!(key in out) || out[key] === undefined) out[key] = v
  }

  // 主机拼接：host + url
  if (out.host && typeof out.url === 'string' && out.url && !/^https?:/i.test(out.url)) {
    out.url = joinHost(out.host, out.url)
  }
  if (out.host && typeof out.searchUrl === 'string' && out.searchUrl && !/^https?:/i.test(out.searchUrl)) {
    out.searchUrl = joinHost(out.host, out.searchUrl)
  }
  if (out.host && !out.homeUrl) out.homeUrl = out.host
  if (out.host && !out.detailUrl) out.detailUrl = out.host

  // drpy2 的 playParse 里lazy 分支要求 play_parse 与 lazy 同时非空才执行，
  // 社区配置通常只写「播放」，这里补一个占位让 lazy 真正生效
  if (out.lazy && !out.play_parse) out.play_parse = 'lazy'

  // 默认值（对齐 drpy2 的内置默认）
  const defaults = {
    searchable: 2,
    quickSearch: 1,
    filter: '',
    headers: {},
    一级: '',
    二级: '*',
    二级访问前: '',
    推荐: '*',
    double: false,
    homeUrl: '',
    detailUrl: '',
    class_parse: '',
    play_parse: '',
    搜索: '',
    lazy: '',
    proxy_rule: '',
    sniffer: false,
    isVideo: '',
    encoding: 'utf-8',
    search_encoding: '',
    timeout: 5000,
    play_json: [],
    cate_exclude: '首页|留言|APP|下载|资讯|新闻|动态',
    tab_exclude: '猜你|喜欢|下载|剧情|榜|评论',
    tab_remove: [],
    tab_order: [],
    tab_rename: {},
    pagecount: {},
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') {
      // 空字符串只在原值不存在时才填默认
      if (out[k] === undefined) out[k] = v
    }
  }

  return out
}

function joinHost(host, p) {
  const h = String(host).replace(/\/+$/, '')
  const path = String(p).replace(/^\/+/, '')
  return `${h}/${path}`
}

/**
 * 解析站点的 ext 字段，产出标准规则。
 * ext 支持：
 *   - JSON 对象（可能嵌套在 { siteKey: {...} } 或 { siteName: {...} } 里）
 *   - 直接就是规则对象
 *   - URL（字符串）—— 远程规则，返回 url 字段供后续加载
 */
export function parseSiteExt(site) {
  const ext = site.ext
  if (!ext) return { rule: {}, remoteUrl: null }

  if (typeof ext === 'object') {
    const inner = ext[site.key] || ext[site.name] || ext
    return { rule: normalizeRule(inner), remoteUrl: null }
  }

  const text = String(ext).trim()

  // 纯 URL
  if (/^https?:\/\//i.test(text)) {
    return { rule: normalizeRule({ spider: text }), remoteUrl: text }
  }

  // JSON
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const inner = parsed[site.key] || parsed[site.name] || parsed
      return { rule: normalizeRule(inner), remoteUrl: null }
    }
  } catch {
    /* 不是 JSON */
  }

  // 多行 key=value 形式（部分老配置）
  if (text.includes('=')) {
    const obj = {}
    for (const line of text.split('\n')) {
      const i = line.indexOf('=')
      if (i <= 0) continue
      obj[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    if (Object.keys(obj).length) return { rule: normalizeRule(obj), remoteUrl: null }
  }

  return { rule: {}, remoteUrl: null }
}
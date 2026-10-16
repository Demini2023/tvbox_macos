/**
 * dr_py 解析表达式引擎：pdfh / pdfa / pd。
 *
 * 表达式语法（影视仓/dr_py 社区通用）：
 *   "div@class=content"            取第一个匹配元素的文本
 *   "a&&href"                      取第一个 a 元素的 href 属性
 *   "div@id=xx&&title"             属性 + 文本
 *   "&&data-src"                   取第一个匹配元素的 data-src
 *   "@class=vod"                   从结果自身取属性
 *   "script@src:regex(...)"        正则提取
 *   "@href&&re:(https?://.*)"      正则替换/截取
 *   "div@style&&url(...)"          style 里的图片地址
 *   "js:xxx"                       直接执行 JS（由 drpy2 处理）
 *   "||"                           多规则依次尝试，取第一个非空
 */

import { createDOM } from './hostApi.mjs'

/** 取节点集合（支持 && 分段的定位与属性选择） */
function selectNodes(html, selector) {
  const dom = createDOM(html)
  return dom.find(selector)
}

/**
 * 核心：执行一条解析表达式
 * @param {string} html
 * @param {string} parse
 * @returns {string}
 */
export function parseExpr(html, parse) {
  let expr = String(parse || '').trim()
  if (!expr) return ''

  // js: 前缀由 drpy2 处理，这里不接管
  if (expr.startsWith('js:')) return ''

  // || 分隔的多规则：逐个尝试，取第一个非空
  if (expr.includes('||')) {
    for (const part of expr.split('||')) {
      const v = parseSingle(html, part.trim())
      if (v !== '' && v !== null && v !== undefined) return String(v)
    }
    return ''
  }
  return parseSingle(html, expr)
}

function parseSingle(html, expr) {
  let e = expr.trim()
  if (!e) return ''

  // js: 前缀由 drpy2 处理，这里不接管
  if (e.startsWith('js:')) return ''

  // || 分隔的多规则：逐个尝试，取第一个非空
  if (e.includes('||')) {
    for (const part of e.split('||')) {
      const v = parseSingle(html, part.trim())
      if (v !== '' && v !== null && v !== undefined) return String(v)
    }
    return ''
  }

  /* ---------- 情况 1：div@class=vod&&href  —— 定位 + 取值 ---------- */
  if (e.includes('&&')) {
    const idx = e.indexOf('&&')
    const locator = e.slice(0, idx).trim()
    const accessor = e.slice(idx + 2).trim()
    const sel = stripAttr(locator)
    const nodes = selectNodes(html, sel)
    if (!nodes.length) return ''

    // accessor 形如 re:xxx 时，对文本做正则
    if (accessor.startsWith('re:')) {
      const out = applyRegex(nodes[0].text(), accessor.slice(3))
      if (out !== '') return out
    }
    // accessor 形如 @attr / attr
    // accessor 形如 @attr / attr
    // attr:re:xxx 形式 -> 对属性值做正则
    const attrRe = accessor.match(/^@?([A-Za-z0-9_\-:]+)\s*:\s*re:(.*)$/)
    if (attrRe) {
      const raw = nodes[0].attr(attrRe[1])
      return raw === undefined ? '' : applyRegex(String(raw), attrRe[2])
    }
    const out = nodes.map((n) => extract(n, accessor)).find((v) => v !== '' && v != null)
    if (out !== undefined) return postProcess(out, accessor, nodes[0])
    const la = attrFromLocator(locator)
    if (la) {
      const v = nodes[0].attr(la.name)
      if (v !== undefined && v !== '') return String(v)
    }
    return ''
  }

  /* ---------- 情况 2：@attr —— 从第一个匹配元素取属性 ---------- */
  if (e.startsWith('@')) {
    let acc = e.slice(1).trim()
    const nodes = createDOM(html).find('*')
    const target = nodes[0]
    if (!target) return ''
    // 支持 @a@href 形式：跳过选择器段
    if (acc.startsWith('@')) acc = acc.slice(1)
    const rem = acc.match(/^([A-Za-z0-9_\-:]+)\s*:\s*re:(.*)$/)
    if (rem) {
      const raw = target.attr(rem[1])
      return raw === undefined ? '' : applyRegex(String(raw), rem[2])
    }
    const v = target.attr(acc)
    return v === undefined ? '' : String(v)
  }

  /* ---------- 情况 3：div@class=x —— 定位元素，取属性（若声明）或文本 ---------- */
  if (e.includes('@')) {
    const sel = stripAttr(e)
    const la = attrFromLocator(e)
    const nodes = selectNodes(html, sel)
    if (!nodes.length) return ''
    if (la) {
      const v = nodes[0].attr(la.name)
      return v === undefined ? '' : String(v)
    }
    return nodes[0].text()
  }

  /* ---------- 情况 4：纯选择器 —— 取文本 ---------- */
  if (e.startsWith('re:')) {
    return applyRegex(createDOM(html).text(), e.slice(3))
  }
  const nodes = selectNodes(html, e)
  return nodes.length ? nodes[0].text() : ''
}

/** 去掉选择器里的 @attr 部分 */
function stripAttr(sel) {
  const i = sel.indexOf('@')
  return (i >= 0 ? sel.slice(0, i) : sel).trim() || '*'
}

/** 从 "div@class=x" 取出属性名 */
function attrFromLocator(sel) {
  const m = sel.match(/@([A-Za-z0-9_\-:]+)/)
  return m ? { name: m[1] } : null
}

/** 从节点按 accessor 表达式取值 */
function extract(node, accessor) {
  let acc = accessor.trim()
  if (!acc) acc = 'text'

  // @attr
  if (acc.startsWith('@')) {
    let a = acc.slice(1).trim()
    // 处理 re: / 正则
    const rem = a.match(/^([A-Za-z0-9_\-:]+)\s*:\s*re:(.*)$/)
    if (rem) {
      const raw = node.attr(rem[1])
      return raw === undefined ? '' : applyRegex(String(raw), rem[2])
    }
    const v = node.attr(a)
    return v === undefined ? '' : String(v)
  }

  // text
  if (acc === 'text' || acc === 'html' || acc === 'outerHTML') {
    return acc === 'html' || acc === 'outerHTML' ? node.html() : node.text()
  }

  // re:xxx 从文本正则提取
  if (acc.startsWith('re:')) {
    return applyRegex(node.text(), acc.slice(3))
  }

  // 其他情况当作属性名
  const v = node.attr(acc)
  if (v !== undefined) return String(v)
  return node.text()
}

/** 应用正则：取第 n 个捕获组或整体匹配 */
function applyRegex(text, pattern) {
  const src = String(pattern || '').trim()
  if (!src) return text
  try {
    const re = new RegExp(src)
    const m = text.match(re)
    if (!m) return ''
    if (m.length > 1) {
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined) return m[i]
      }
    }
    return m[0]
  } catch {
    return text
  }
}

/** 取值后的加工：style 里的 url(...) 提取 */
function postProcess(value, accessor, node) {
  void node
  let out = String(value)
  if (/style/i.test(accessor || '') && /url\(/.test(out)) {
    const m = out.match(/url\((.*?)\)/)
    if (m) out = m[1].replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** pdfa：返回所有匹配（数组的文本），dr_py 里返回字符串 */
export function parseAll(html, parse) {
  const expr = String(parse || '').trim()
  if (!expr || expr.startsWith('js:')) return ''
  let locator = expr
  let accessor = 'text'
  if (expr.includes('&&')) {
    const i = expr.indexOf('&&')
    locator = expr.slice(0, i).trim()
    accessor = expr.slice(i + 2).trim()
  }
  const nodes = selectNodes(html, stripAttr(locator))
  return nodes
    .map((n) => extract(n, accessor))
    .filter((v) => v !== '')
    .join('\n')
}
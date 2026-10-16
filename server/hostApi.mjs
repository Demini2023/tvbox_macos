/**
 * 影视仓 / dr_py 采集器宿主 API 实现。
 *
 * 依赖清单来自对 APK 内 drpy2.js 的静态扫描（缺失的宿主调用）：
 *   getProxy, getPrivateKey, getPublicKey, getParse, joinUrl, fixKey,
 *   pd / pdfa / pdfl（极简 DOM 解析）, req, http
 * 常量：MOBILE_UA / PC_UA / UC_UA / IOS_UA / RKEY / VERSION / KEY / RSA /
 *       NODERSA / OCR_API / SPECIAL_URL / SELECT_REGEX 等。
 */
import { URL } from 'node:url'
import crypto from 'node:crypto'

/* ================= UA ================= */
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
export const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const UC_UA =
  'Mozilla/5.0 (Linux; U; Android 12; zh-CN) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.5.2 Chrome/107.0.5304.141 Mobile Safari/537.36 UCBrowser/13.4.0.1306'
export const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/* ================= URL ================= */
export function joinUrl(base, rel) {
  if (!rel) return base || ''
  if (/^(https?:)?\/\//i.test(rel)) {
    return rel.startsWith('//') ? 'https:' + rel : rel
  }
  const b = String(base || '')
  if (/^https?:\/\//i.test(b)) {
    try {
      return new URL(String(rel).replace(/^\/+/, ''), b).href
    } catch {
      /* fallthrough */
    }
  }
  return b.replace(/\/+$/, '') + '/' + String(rel).replace(/^\/+/, '')
}

export function getQuery(url) {
  const u = String(url || '')
  const hashIdx = u.indexOf('#')
  const clean = hashIdx >= 0 ? u.slice(0, hashIdx) : u
  const qIdx = clean.indexOf('?')
  const query = qIdx >= 0 ? clean.slice(qIdx + 1) : ''
  const bare = qIdx >= 0 ? clean.slice(0, qIdx) : clean
  const params = {}
  for (const kv of query.split('&')) {
    if (!kv) continue
    const i = kv.indexOf('=')
    const k = i >= 0 ? kv.slice(0, i) : kv
    const v = i >= 0 ? kv.slice(i + 1) : ''
    params[decodeURIComponent(k)] = decodeURIComponent(v)
  }
  return { url: bare, params }
}

/* ================= 密钥 ================= */
export function getPublicKey() {
  return ''
}
export function getPrivateKey() {
  return ''
}
export function fixKey(k) {
  return String(k || '').replace(/\s+/g, '')
}

/** md5，供规则内部使用 */
export function md5(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex')
}

/* ================= 迷你 DOM ================= */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
}

/** HTML 节点 */
class Node {
  constructor(type, tag, attrs, classes) {
    this.type = type // 'element' | 'text'
    this.tag = tag
    this.attrs = attrs || {}
    this.classes = classes || []
    this.children = []
  }

  get textContent() {
    if (this.type === 'text') return this.text
    return this.children.map((c) => c.textContent).join('')
  }

  get outerHTML() {
    if (this.type === 'text') return this.text
    const a = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join('')
    if (VOID_TAGS.has(this.tag)) return `<${this.tag}${a}>`
    return `<${this.tag}${a}>${this.children.map((c) => c.outerHTML).join('')}</${this.tag}>`
  }

  /** 自身 + 所有后代（元素） */
  descendants() {
    const out = []
    const walk = (n) => {
      for (const c of n.children) {
        if (c.type === 'element') {
          out.push(c)
          walk(c)
        }
      }
    }
    walk(this)
    return out
  }

  /** 给节点挂上查询方法 */
  api() {
    return {
      find: (sel) => queryAll(this.children, sel),
      findOne: (sel) => queryAll(this.children, sel)[0] || null,
      text: () => this.textContent,
      html: () => this.outerHTML,
      attr: (k) => this.attrs[String(k).toLowerCase()],
      children: this.children,
      eq: (i) => {
        const n = this.children[i]
        if (!n) return { find: () => [], findOne: () => null, text: () => '', html: () => '', attr: () => undefined }
        return n.api()
      },
    }
  }
}

function parseHTML(html) {
  const root = new Node('element', '#root', {}, [])
  const stack = [root]
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z0-9:-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html)) !== null) {
    const [full, closing, tag, attrStr, selfClose, text] = m
    if (text !== undefined) {
      if (text) {
        const t = new Node('text', null, {}, [])
        t.text = text
        stack[stack.length - 1].children.push(t)
      }
      continue
    }
    if (full.startsWith('<!')) continue
    if (closing) {
      const lower = tag.toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === lower) {
          stack.length = i
          break
        }
      }
      continue
    }
    const attrs = {}
    const classes = []
    for (const a of (attrStr || '').matchAll(
      /([A-Za-z0-9_:@\-\.]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
    )) {
      const key = a[1].toLowerCase()
      const val = a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : a[5] !== undefined ? a[5] : ''
      attrs[key] = decodeEntities(val)
      if (key === 'class') for (const c of String(val).split(/\s+/)) if (c) classes.push(c)
    }
    const node = new Node('element', tag.toLowerCase(), attrs, classes)
    stack[stack.length - 1].children.push(node)
    if (selfClose !== '/' && !VOID_TAGS.has(node.tag)) stack.push(node)
  }
  return root.children
}

/** 简单选择器匹配：tag / .class / #id / [attr=val] / 后代空格 */
function matches(node, sel) {
  const tagM = sel.match(/^([a-zA-Z0-9*]+)/)
  const tag = tagM && tagM[1] ? tagM[1].toLowerCase() : null
  if (tag && tag !== '*' && node.tag !== tag) return false
  for (const m of sel.matchAll(/\.([A-Za-z0-9_\-]+)/g)) {
    if (!node.classes.includes(m[1])) return false
  }
  for (const m of sel.matchAll(/#([A-Za-z0-9_\-]+)/g)) {
    if (node.attrs.id !== m[1]) return false
  }
  for (const m of sel.matchAll(/\[([A-Za-z0-9_\-:]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]/g)) {
    const [, k, op, v] = m
    const val = node.attrs[k]
    if (val === undefined) return false
    if (op === '=' && val !== v) return false
  }
  return true
}

function queryAll(rootChildren, sel) {
  const parts = String(sel || '').trim().split(/\s+/).filter(Boolean)
  let current = rootChildren.filter((n) => n.type === 'element')
  for (const part of parts) {
    const next = []
    for (const n of current) {
      next.push(n)
      next.push(...n.descendants())
    }
    current = next.filter((n) => matches(n, part))
  }
  return current.map((n) => n.api())
}

/**
 * dr_py 的 pd(code, html)：返回带 find/text/html 的查询器。
 * 兼容两种调用：pd(html) 与 pd(code, html)。
 */
export function createDOM(html) {
  const nodes = parseHTML(html)
  const api = {
    find: (sel) => queryAll(nodes, sel),
    findOne: (sel) => queryAll(nodes, sel)[0] || null,
    text: () => nodes.map((n) => n.textContent).join(''),
    html: () => nodes.map((n) => n.outerHTML).join(''),
    children: nodes,
  }
  return api
}
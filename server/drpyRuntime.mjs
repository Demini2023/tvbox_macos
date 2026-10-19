/**
 * 影视仓 / dr_py 规则执行器（标准 drpy2 驱动模式）。
 *
 * 协议确认（来自 APK 内 drpy2.js 静态分析）：
 *  - drpy2.js 是「驱动层」，导出 init/home/homeVod/category/detail/play/search/proxy...
 *  - init(ext) 接受规则对象（ext 为 object 时直接 rule = ext）
 *  - 规则里 `js:` 前缀的字段（分类/详情/播放/搜索）由 drpy2 内部 eval() 执行，
 *    隐式变量为 code / input / tid / pg / wd / extend 等
 *  - 宿主需提供：_http/request/http/req、pd/pdfa/pdfl、joinUrl、getQuery、
 *    getProxyUrl、RKEY、MOBILE_UA、md5、base64 等
 *
 * 因此本模块的职责：
 *   1. 在 QuickJS 中加载 libs/drpy2.js（模块化，使用其自带 libs 依赖）
 *   2. 注入宿主 API
 *   3. 载入规则对象（从规则 JS 提取 var rule = {...}）
 *   4. 调用 drpy2.init(rule)，再调用 home/category/... 转发请求
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { newQuickJSWASMModule } from 'quickjs-emscripten'
import { LIBS_DIR, CACHE_DIR, normalizeModuleName, isRemoteModule } from './modulePaths.mjs'

/** TVBox 本地存储落盘位置 */
const STORAGE_FILE = path.join(CACHE_DIR, 'storage.json')
import { httpFetchSync } from './httpBridge.mjs'
import * as host from './hostApi.mjs'
import * as parseEngine from './parseEngine.mjs'

/* ================= 模块来源 ================= */
function cachePathFor(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex')
  return path.join(CACHE_DIR, h.slice(0, 2), h.slice(2) + '.js')
}

function readRemoteModule(url) {
  const file = cachePathFor(url)
  try {
    if (fs.existsSync(file)) {
      const age = Date.now() - fs.statSync(file).mtimeMs
      if (age < 12 * 3600 * 1000) return fs.readFileSync(file, 'utf8')
    }
  } catch {
    /* noop */
  }
  const r = httpFetchSync(url, { headers: { 'User-Agent': host.MOBILE_UA } })
  if (r && r.body) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, r.body, 'utf8')
    } catch {
      /* noop */
    }
    return r.body
  }
  throw new Error('remote module load failed: ' + url)
}

/**
 * 把源码里的 import 说明符重写为 QuickJS 可接受的形式。
 *   assets://js/lib/x.js  -> ./x.js
 *   ./x.js                -> ./x.js（保持）
 *   https://.../x.js      -> 原样
 */
export function rewriteImports(src) {
  return src.replace(
    /((?:^|\n)\s*import\s+(?:[^'";]*?\sfrom\s*)?)(['"])([^'"]+)\2/g,
    (full, head, q, spec) => {
      if (/^https?:\/\//i.test(spec)) return full
      const base = spec.replace(/^assets:\/\/(?:js\/lib\/)?/i, '').replace(/^\.\//, '')
      return `${head}${q}./${base}${q}`
    }
  )
}

/** 宿主值 -> QuickJS 值（调用方负责 dispose） */
function toJs(ctx, value) {
  if (value === undefined) return ctx.undefined
  if (value === null) return ctx.null
  const t = typeof value
  if (t === 'boolean') return value ? ctx.true : ctx.false
  if (t === 'number') return ctx.newNumber(value)
  if (t === 'bigint') return ctx.newString(value.toString())
  if (t === 'string') return ctx.newString(value)
  if (Array.isArray(value)) {
    const arr = ctx.newArray()
    for (let i = 0; i < value.length; i++) {
      const h = toJs(ctx, value[i])
      ctx.setProp(arr, i, h)
      h.dispose()
    }
    return arr
  }
  if (t === 'object') {
    const obj = ctx.newObject()
    for (const [k, v] of Object.entries(value)) {
      const h = toJs(ctx, v)
      ctx.setProp(obj, k, h)
      h.dispose()
    }
    return obj
  }
  return ctx.undefined
}

/**
 * 把「单个对象」形式的调用摊平成位置参数。
 *
 * drpy2 导出的都是位置参数签名，如 category(tid, pg, filter, extend)。
 * 若调用方只传一个对象，tid 会变成整个对象，
 * categoryParse 里 url.replaceAll('fyclass', cateObj.tid) 就会
 * 拼出 "https://host/[object Object]/page/1" —— 不报错，静默失败。
 * 这里按 names 顺序展开，让两种写法都安全。
 */
function normalizePositional(args, names) {
  if (args.length !== 1) return args
  const only = args[0]
  if (!only || typeof only !== 'object' || Array.isArray(only)) return args
  return names.map((n) => only[n])
}

/** 安全 JSON 序列化 */
function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/* ================= 运行时 ================= */
export async function createRuntime(opts = {}) {
  const logs = []
  const log = (...a) => {
    const line = a
      .map((x) => {
        if (typeof x === 'string') return x
        try {
          return JSON.stringify(x)
        } catch {
          return String(x)
        }
      })
      .join(' ')
    logs.push(line)
    if (logs.length > 1000) logs.shift()
    if (process.env.YSC_DEBUG) console.log('[drpy]', line)
  }

  const moduleSources = new Map()
  for (const f of fs.readdirSync(LIBS_DIR)) {
    moduleSources.set(f, fs.readFileSync(path.join(LIBS_DIR, f), 'utf8'))
  }

  const proxyUrl = opts.proxyUrl || ''
  const rkey = opts.rkey || ''
  const version = opts.version || '3.9.51'

  // 每次求值前重置的超时基准（供 interruptHandler 使用）
  let evalDeadline = Date.now()

// 必须自建 runtime：共享单例getQuickJS() 无法注册 moduleLoader
  const wasm = await newQuickJSWASMModule()
  const jsRuntime = wasm.newRuntime({
    memoryLimitBytes: 256 * 1024 * 1024,
    // 注意：不要设置 maxStackSizeBytes —— wasm32 下会破坏 ES 模块链式加载
    //（表现为编译期空错误 drpy2.js:1:1）。超时保护改用 interruptHandler。
    interruptHandler: () => Date.now() - evalDeadline > (opts.evalTimeoutMs || 30000),
    // QuickJS 会把 './x.js' 归一化成 'x.js' 后交给 loader
    moduleLoader: (moduleName) => {
      const spec = String(moduleName)
      if (isRemoteModule(spec)) {
        const url = spec
        const key = 'remote:' + url
        if (!moduleSources.has(key)) moduleSources.set(key, readRemoteModule(url))
        return moduleSources.get(key)
      }
      const base = spec.replace(/^\.\//, '')
      if (process.env.YSC_DEBUG) console.log('[mod]', JSON.stringify(base))
      if (moduleSources.has(base)) return moduleSources.get(base)
      const abs = path.join(LIBS_DIR, base)
      if (fs.existsSync(abs)) {
        const src = fs.readFileSync(abs, 'utf8')
        moduleSources.set(base, src)
        return src
      }
      throw new Error('module not found: ' + moduleName)
    },
  })
  const ctx = jsRuntime.newContext()

  const g = ctx.global
  const def = (name, fn) => {
    const h = ctx.newFunction(name, fn)
    ctx.setProp(g, name, h)
    h.dispose()
  }
  /** 注入对象（非函数）到全局，如解析器桥 __hostBridge */
  const defObj = (name, obj) => {
    ctx.setProp(g, name, obj)
    obj.dispose()
  }
  const setStr = (key, value) => {
    const h = ctx.newString(String(value))
    ctx.setProp(g, key, h)
    h.dispose()
  }

  /* ---------- 常量 ---------- */
  setStr('MOBILE_UA', host.MOBILE_UA)
  setStr('PC_UA', host.PC_UA)
  setStr('UC_UA', host.UC_UA)
  setStr('IOS_UA', host.IOS_UA)
  setStr('RKEY', rkey)
  setStr('VERSION', version)
  setStr('KEY', rkey)
  setStr('NODERSA', 'true')

  /* ---------- console（QuickJS 不自带，drpy2 大量使用） ---------- */
  const consoleObj = ctx.newObject()
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const h = ctx.newFunction(level, (arg) => {
      const v = ctx.dump(arg)
      const text = typeof v === 'string' ? v : safeJson(v)
      log('[' + level + '] ' + text)
    })
    ctx.setProp(consoleObj, level, h)
    h.dispose()
  }
  ctx.setProp(g, 'console', consoleObj)
  consoleObj.dispose()

  /* ---------- 日志 ---------- */
  const dumpAll = (h) => {
    const n = ctx.getLength(h)
    const out = []
    for (let i = 0; i < n; i++) out.push(ctx.dump(ctx.getProp(h, i)))
    return out
  }
  def('log', (h) => log(...dumpAll(h)))
  def('print', (h) => log(...dumpAll(h)))
  def('println', (h) => log(...dumpAll(h)))

  /* ---------- 配置 ---------- */
  def('getProxyUrl', () => ctx.newString(proxyUrl))
  def('getProxy', () => ctx.newString(proxyUrl))
  def('getExtendUrl', () => ctx.newString(opts.extend || ''))
  def('getExtend', () => ctx.newString(opts.extend || ''))
  def('getRKEY', () => ctx.newString(rkey))
  def('getUserAgent', () => ctx.newString(host.MOBILE_UA))
  def('getPublicKey', () => ctx.newString(host.getPublicKey()))
  def('getPrivateKey', () => ctx.newString(host.getPrivateKey()))
  def('fixKey', (h) => ctx.newString(host.fixKey(ctx.getString(h))))
  def('joinUrl', (a, b) => ctx.newString(host.joinUrl(ctx.getString(a), ctx.getString(b))))
  def('getQuery', (h) => toJs(ctx, host.getQuery(ctx.getString(h))))
  def('getUrlParam', (h) => toJs(ctx, host.getQuery(ctx.getString(h))))
  def('getParse', () => ctx.newString(proxyUrl))
  def('getMd5', (h) => ctx.newString(host.md5(ctx.getString(h))))
  def('md5', (h) => ctx.newString(host.md5(ctx.getString(h))))
  def('base64Encode', (h) => ctx.newString(Buffer.from(ctx.getString(h), 'utf8').toString('base64')))
  def('base64Decode', (h) => ctx.newString(Buffer.from(ctx.getString(h), 'base64').toString('utf8')))

  /* ---------- 网络 ---------- */
  const netCall = (urlHandle, optHandle) => {
    const url = ctx.getString(urlHandle)
    const opt = optHandle ? ctx.dump(optHandle) || {} : {}
    const headers = Object.assign({ 'User-Agent': host.MOBILE_UA }, opt.headers || {})
    const r = httpFetchSync(url, {
      method: opt.method || 'GET',
      headers,
      body: opt.body,
      timeoutMs: opt.timeout || 20000,
    })
    return toJs(ctx, r)
  }
  def('_http', netCall)
  def('request', netCall)
  def('req', netCall)
  def('http', netCall)

  /* ---------- DOM ---------- */
  const nodeApi = (n) => {
    const obj = ctx.newObject()
    const t = ctx.newFunction('text', () => ctx.newString(n.text()))
    ctx.setProp(obj, 'text', t)
    t.dispose()
    const hF = ctx.newFunction('html', () => ctx.newString(n.html()))
    ctx.setProp(obj, 'html', hF)
    hF.dispose()
    const aF = ctx.newFunction('attr', (h2) => {
      const v = n.attr(ctx.getString(h2))
      return v === undefined ? ctx.undefined : ctx.newString(v)
    })
    ctx.setProp(obj, 'attr', aF)
    aF.dispose()
    const fF = ctx.newFunction('find', (h3) => findNodes(n.find(ctx.getString(h3))))
    ctx.setProp(obj, 'find', fF)
    fF.dispose()
    return obj
  }
  const findNodes = (list) => {
    const arr = ctx.newArray()
    for (let i = 0; i < list.length; i++) {
      const h = nodeApi(list[i])
      ctx.setProp(arr, i, h)
      h.dispose()
    }
    return arr
  }
  // pd() 需要返回字符串值而非 DOM 对象，真正实现在下方「解析表达式」段。
  // 这里只保留 pdfl（dr_py 里用于返回 DocumentFragment 的变体）。
  const domObjImpl = (a, b) => {
    // 两参形态 pdfl(html, sel)；单参时把 a 当 html
    const html = ctx.typeof(b) === 'string' ? ctx.getString(b) : ctx.getString(a)
    const dom = host.createDOM(html)
    const obj = ctx.newObject()
    const fF = ctx.newFunction('find', (sh) => findNodes(dom.find(sh ? ctx.getString(sh) : '')))
    ctx.setProp(obj, 'find', fF)
    fF.dispose()
    const foF = ctx.newFunction('findOne', (sh) => {
      const r = dom.find(sh ? ctx.getString(sh) : '')[0]
      return r ? nodeApi(r) : ctx.null
    })
    ctx.setProp(obj, 'findOne', foF)
    foF.dispose()
    const tF = ctx.newFunction('text', () => ctx.newString(dom.text()))
    ctx.setProp(obj, 'text', tF)
    tF.dispose()
    const hF = ctx.newFunction('html', () => ctx.newString(dom.html()))
    ctx.setProp(obj, 'html', hF)
    hF.dispose()
    return obj
  }
  def('pdfl', domObjImpl)

  /* ---------- 本地存储 setItem/getItem/removeItem/local ---------- */
  const storage = new Map()
  const readStorage = () => {
    try {
      const f = STORAGE_FILE
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
        for (const [k, v] of Object.entries(raw || {})) storage.set(k, v)
      }
    } catch {
      /* noop */
    }
  }
  const writeStorage = () => {
    try {
      const f = STORAGE_FILE
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify(Object.fromEntries(storage)), 'utf8')
    } catch {
      /* noop */
    }
  }
  readStorage()

  def('setItem', (k, v) => {
    storage.set(ctx.getString(k), ctx.dump(v))
    writeStorage()
  })
  def('getItem', (k) => {
    const v = storage.get(ctx.getString(k))
    return v === undefined ? ctx.newString('') : toJs(ctx, v)
  })
  def('removeItem', (k) => {
    storage.delete(ctx.getString(k))
    writeStorage()
  })
  def('hasItem', (k) => {
    const v = storage.get(ctx.getString(k))
    return v === undefined ? ctx.false : ctx.true
  })
  def('clearItems', () => {
    storage.clear()
    writeStorage()
  })
  // 兼容 local.getItem / local.setItem / local.load / local.save 形式
  const localObj = ctx.newObject()
  const push = (obj, name, fn) => {
    const h = ctx.newFunction(name, fn)
    ctx.setProp(obj, name, h)
    h.dispose()
  }
  push(localObj, 'setItem', (k, v) => {
    storage.set(ctx.getString(k), ctx.dump(v))
    writeStorage()
    return ctx.undefined
  })
  push(localObj, 'getItem', (k) => {
    const v = storage.get(ctx.getString(k))
    return v === undefined ? ctx.newString('') : toJs(ctx, v)
  })
  push(localObj, 'remove', (k) => {
    storage.delete(ctx.getString(k))
    writeStorage()
    return ctx.undefined
  })
  push(localObj, 'load', () => {
    readStorage()
    return ctx.undefined
  })
  push(localObj, 'save', () => {
    writeStorage()
    return ctx.undefined
  })
  push(localObj, 'get', (k) => {
    const v = storage.get(ctx.getString(k))
    return v === undefined ? ctx.newString('') : toJs(ctx, v)
  })
  ctx.setProp(g, 'local', localObj)
  localObj.dispose()

  /* ---------- 其他工具 ---------- */
  def('stringify', (h) => ctx.newString(safeJson(ctx.dump(h))))
  def('getUrlParams', (h) => toJs(ctx, host.getQuery(ctx.getString(h))))
  def('urljoin', (a, b) => ctx.newString(host.joinUrl(ctx.getString(a), ctx.getString(b))))
  def('encodeStr', (h, enc) => {
    const s = ctx.getString(h)
    const e = String(ctx.dump(enc) || 'utf-8').toLowerCase()
    if (e === 'utf-8') return ctx.newString(s)
    try {
      return ctx.newString(Buffer.from(s, e === 'gbk' ? 'latin1' : 'utf8').toString('binary'))
    } catch {
      return ctx.newString(s)
    }
  })

  /* ---------- 解析表达式 pdfh / pdfa / pd ---------- */
  // drpy2.js 内部通过 defaultParser.{pdfh,pdfa,pd} 做实际解析，
  // 而 pdfh2/pdfa2/pd2 是它的包装层（负责把节点对象转成字符串）。
  // 签名统一是 (html, parse)，返回值语义各不相同：
  //   pdfh  -> string   取第一个匹配项的文本/属性
  //   pdfa  -> string[] 批量取值（换行拼接的字符串数组）
  //   pd    -> string   带 baseUrl 自动 urljoin
  // drpy2 的包装层：入参可能是节点对象，需先转字符串。
  // 注意 ctx.getProp(handle, key) 直接返回新的 handle（无 value/error 包装），
  // 若按 {value,error} 解构会拿到 undefined，导致取值静默为空。
  const toHtml = (h) => {
    if (!h) return ''
    const t = ctx.typeof(h)
    if (t === 'string') return ctx.getString(h)
    if (t === 'undefined' || t === 'null') return ''
    for (const key of ['__html', 'ele', 'html']) {
      const v = ctx.getProp(h, key)
      if (ctx.typeof(v) === 'string' && ctx.getString(v)) {
        const s = ctx.getString(v)
        v.dispose()
        return s
      }
      if (ctx.typeof(v) === 'undefined') v.dispose()
    }
    return ''
  }

  /**
   * 把 HTML 片段包成带 __html 属性的对象，供 pdfh2/pd2 二次取值。
   *
   * 注意：setProp 会把字符串值复制进运行时，所以不能在这里 dispose 掉
   * s —— 早前版本 dispose 了，导致 __html 变成悬空 handle，
   * pdfh2/pd2 取值全为空（不报错，静默失败）。
   */
  const fragObj = (htmlStr) => {
    const o = ctx.newObject()
    ctx.setProp(o, '__html', ctx.newString(htmlStr))
    return o
  }

  def('pdfh', (h1, h2) => {
    const html = ctx.getString(h1)
    const parse = ctx.getString(h2)
    return ctx.newString(parseEngine.parseExpr(html, parse))
  })
  def('pdfa', (h1, h2) => {
    const html = ctx.getString(h1)
    const parse = ctx.getString(h2)
    const arr = parseEngine.parseAll(html, parse)
    const ja = ctx.newArray()
    arr.forEach((h, i) => {
      const o = fragObj(h)
      ctx.setProp(ja, i, o)
      o.dispose()
    })
    return ja
  })
  def('pd', (h1, h2, h3) => {
    // pd(html, parse, baseUrl)
    const html = ctx.getString(h1)
    const parse = ctx.getString(h2)
    const base = ctx.typeof(h3) === 'string' ? ctx.getString(h3) : ''
    return ctx.newString(parseEngine.parseExpr(html, parse, base))
  })
  def('pdfh2', (h1, h2) => {
    return ctx.newString(parseEngine.parseExpr(toHtml(h1), ctx.getString(h2)))
  })
  def('pdfa2', (h1, h2) => {
    const html = toHtml(h1)
    const arr = parseEngine.parseAll(html, ctx.getString(h2))
    const ja = ctx.newArray()
    arr.forEach((h, i) => {
      const o = fragObj(h)
      ctx.setProp(ja, i, o)
      o.dispose()
    })
    return ja
  })
  def('pd2', (h1, h2, h3) => {
    // ctx.getLength 对字符串返回 0，不能用来判断可选参数是否存在，
    // 一律用 ctx.typeof 判断。
    const base = ctx.typeof(h3) === 'string' ? ctx.getString(h3) : ''
    return ctx.newString(parseEngine.parseExpr(toHtml(h1), ctx.getString(h2), base))
  })

  /* ---------- 加载 drpy2 驱动 ---------- */
  // drpy2.js 内部使用 Android 特有路径：
  //   import cheerio from 'assets://js/lib/cheerio.min.js'
  //   import './模板.js'
  // QuickJS 解析器只接受 './xxx.js' 或 http(s)，故加载前重写 import 说明符。
  //
  // __hostBridge 是解析器桥：drpy2 的 const defaultParser 被替换成读它，
  // 这样 jsp.pdfh / jq.pdfa / parseTags.* 全都会走宿主实现。
  {
    const b = ctx.newObject()
    const fPdfh = ctx.newFunction('pdfh', (h1, h2) => {
      return ctx.newString(parseEngine.parseExpr(toHtml(h1), ctx.getString(h2)))
    })
    const fPdfa = ctx.newFunction('pdfa', (h1, h2) => {
      const arr = parseEngine.parseAll(toHtml(h1), ctx.getString(h2))
      const ja = ctx.newArray()
      arr.forEach((x, i) => {
        const o = fragObj(x)
        ctx.setProp(ja, i, o)
        o.dispose()
      })
      return ja
    })
    const fPd = ctx.newFunction('pd', (h1, h2, h3) => {
      const base = ctx.typeof(h3) === 'string' ? ctx.getString(h3) : ''
      return ctx.newString(parseEngine.parseExpr(toHtml(h1), ctx.getString(h2), base))
    })
    ctx.setProp(b, 'pdfh', fPdfh)
    ctx.setProp(b, 'pdfa', fPdfa)
    ctx.setProp(b, 'pd', fPd)
    fPdfh.dispose()
    fPdfa.dispose()
    fPd.dispose()
    defObj('__hostBridge', b)
  }

  const drpySrc = moduleSources.get('drpy2.js')
  if (!drpySrc) throw new Error('libs/drpy2.js not found')
  const drpyRewritten = rewriteImports(drpySrc)
  // 把 drpy2 内置的 pdfh/pdfa/pd 换成宿主注入的实现。
  //
  // 为什么要换：drpy2 里 const defaultParser = {pdfh, pdfa, pd}，
  // const jsp = parseTags.jsp —— 都是模块级 const，外部无法覆盖。
  // 而它们内部的 pdfh 依赖 cheerio 的对象形态（html.rr/html.ele），
  // 本宿主的 DOM 实现没有这套 API，导致 hostJs 里
  // `jsp.pdfh(html, ".go:eq(0)&&a&&href")` 返回 undefined，
  // 继而 HOST 为空、后续相对路径请求全崩。
  // 改写函数声明为读取全局桥接变量，即可让整条解析链路走宿主实现。
  //
  // 另外两处改写：
  // 1) __setRule：drpy2 只有 getRule 没有 setter，而 hostJs 是运行时求值的，
  //    init 后才知道真实 host，需要把补齐过主机的字段写回同一份 rule。
  // 2) cheerio.jinja2：去掉 fallback。drpy2 原写法是
  //      try { return jinja.render(t,o) } catch { return _jinja2(t,o) }
  //    而 _jinja2（cheerio 内置那个）对缺失键会渲染成 [object Object]，
  //    并且会把 fyclass 这类普通文本吃掉，实测拼出
  //    "https://host/[object Object]/page/NaN"。宿主提供的 jinja 实现
  //    缺失键渲染为空串且保留其它文本，是正确行为，因此直接去掉 fallback。
  const drpyPatched = drpyRewritten
    .replace(
      /export\s+default\s*\{/,
      'export function __setRule(patch){if(patch){for(var k in patch){rule[k]=patch[k]}}return true}\nexport default {__setRule,'
    )
    .replace(
      /cheerio\.jinja2\s*=\s*function\s*\([\s\S]{0,400}?return\s+_jinja2\(template,\s*obj\)\s*\n?\};/,
      'cheerio.jinja2 = function (template, obj) {\n' +
        '    try {\n' +
        '        return jinja.render(template, obj);\n' +
        '    } catch (e) {\n' +
        "        log('jinja渲染失败:' + e.message);\n" +
        "        return String(template).replace(/\\{\\{[^}]*\\}\\}/g, '');\n" +
        '    }\n' +
        '};'
    )
    .replace(
      /const\s+defaultParser\s*=\s*\{\s*pdfh:\s*pdfh\s*,\s*pdfa:\s*pdfa\s*,\s*pd:\s*pd\s*,?\s*\}/,
      'const defaultParser = { pdfh: (__h)=>__hostBridge.pdfh(__h), pdfa: (__h)=>__hostBridge.pdfa(__h), pd: (__h,__p,__b)=>__hostBridge.pd(__h,__p,__b) }'
    )
  evalDeadline = Date.now()
  const mod = ctx.evalCode(drpyPatched, 'drpy2.js', { type: 'module' })
  if (mod.error) {
    const e = ctx.dump(mod.error)
    const msg = e && e.message ? e.message : JSON.stringify(e)
    if (process.env.YSC_DEBUG) {
      console.error('[drpy2 raw error]', JSON.stringify(e))
      try {
        const st = ctx.getProp(mod.error, 'stack')
        console.error('[stack]', ctx.dump(st))
        st.dispose()
      } catch {}
    }
    mod.dispose()
    ctx.dispose()
    throw new Error('drpy2 load failed: ' + msg)
  }
  const ns = mod.value
  void mod

  const defH = ctx.getProp(ns, 'default')
  const resolve = (name) => {
    let fn = ctx.getProp(defH, name)
    if (ctx.typeof(fn) === 'undefined') {
      const drpy = ctx.getProp(defH, 'DRPY')
      fn = ctx.getProp(drpy, name)
      drpy.dispose()
    }
    return fn
  }

  /** 调用 drpy2 导出的函数 */
  const call = (name, args = []) => {
    evalDeadline = Date.now()
    const fn = resolve(name)
    if (ctx.typeof(fn) !== 'function') {
      fn.dispose()
      throw new Error('drpy2 export not found: ' + name)
    }
    const handles = args.map((a) => toJs(ctx, a))
    const res = ctx.callFunction(fn, ctx.undefined, ...handles)
    handles.forEach((h) => h.dispose())
    if (res.error) {
      const e = ctx.dump(res.error)
      const msg = e && e.message ? e.message : JSON.stringify(e)
      res.dispose()
      fn.dispose()
      throw new Error(name + '() failed: ' + msg)
    }
    const out = ctx.dump(res.value)
    res.dispose()
    fn.dispose()
    return out
  }

  return {
    logs,
    context: ctx,
    call,
    hasExport: (name) => {
      const fn = resolve(name)
      const ok = ctx.typeof(fn) === 'function'
      fn.dispose()
      return ok
    },
    /** 初始化规则：传入规则对象（来自 JSON 配置的 spider/meta） */
    initRule: (ruleObj) => call('init', [ruleObj]),
    /** 调试用：在运行时里执行任意表达式，返回 JSON 化结果 */
    evalJs: (code) => {
      const r = ctx.evalCode(code, 'probe.js')
      if (r.error) {
        const msg = ctx.dump(r.error)?.message || 'eval error'
        r.dispose()
        throw new Error(msg)
      }
      const out = ctx.dump(r.value)
      r.dispose()
      return out
    },
    /**
     * 读回 init 后的 rule 对象（drpy2 自身导出了 getRule）。
     *
     * 用途：hostJs 是运行时求值的，parseSiteExt 阶段拿不到真实 host，
     * 导致 url/searchUrl/detailUrl 这些相对路径没被拼上主机。
     * init 完成后回读一次才能拿到最终 rule。
     */
    getRule: () => {
      const fn = resolve('getRule')
      if (ctx.typeof(fn) !== 'function') {
        fn.dispose()
        return null
      }
      const res = ctx.callFunction(fn, ctx.undefined)
      fn.dispose()
      if (res.error) {
        res.dispose()
        return null
      }
      const out = ctx.dump(res.value)
      res.dispose()
      return out
    },
    /**
     * 回写 rule 字段（用于 init 后补齐 host 拼接等修正）。
     * drpy2 原始导出没有 setter，这里通过在模块作用域内执行的
     * 补丁函数写入（__setRule 由源码改写阶段注入，能访问闭包里的 rule）。
     */
    patchRule: (patch) => {
      if (!patch || typeof patch !== 'object') return false
      const setter = resolve('__setRule')
      if (ctx.typeof(setter) !== 'function') {
        setter.dispose()
        return false
      }
      const js = ctx.newString(JSON.stringify(patch))
      const res = ctx.callFunction(setter, ctx.undefined, js)
      js.dispose()
      setter.dispose()
      const ok = !res.error
      res.dispose()
      return ok
    },
    home: (...a) => call('home', a),
    homeVod: (...a) => call('homeVod', a),
    // drpy2 导出的是位置参数签名 category(tid, pg, filter, extend)。
    // 误传单个对象会把整个对象当成 tid，导致 replaceAll('fyclass', obj)
    // 拼出 "[object Object]"。这里显式摊平对象形式，避免这类静默错误。
    category: (...a) => call('category', normalizePositional(a, ['tid', 'pg', 'filter', 'extend'])),
    detail: (...a) => call('detail', normalizePositional(a, ['id'])),
    play: (...a) => call('play', normalizePositional(a, ['flag', 'id'])),
    search: (...a) =>
      call('search', normalizePositional(a, ['wd', 'quick', 'pg'])),
    proxy: (...a) => call('proxy', a),
    dispose() {
      try {
        defH.dispose()
      } catch {
        /* noop */
      }
      try {
        ns.dispose()
      } catch {
        /* noop */
      }
      try {
        ctx.dispose()
      } catch {
        /* noop */
      }
    },
  }
}
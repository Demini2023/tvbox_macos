/**
 * 同步 HTTP（子进程方式）。
 *
 * 影视仓/dr_py 规则大量使用 `_http(url, {async:false})` 同步取数，
 * 而 QuickJS 同步上下文无法挂起等待网络 I/O。
 * 因此在「每个请求一个 worker 线程」的架构下，用 spawnSync 调 curl 实现真阻塞，
 * 阻塞只发生在该worker 内，不影响主服务的事件循环。
 */
import { spawnSync } from 'node:child_process'

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/**
 * 检查系统 curl 是否可用。
 * macOS/Linux 自带 curl；Windows 10 1803+ 也自带 curl.exe。
 * 若缺失，所有同步 `_http` 调用都会失败，故启动时先探测一次。
 * @returns {{ok:boolean, path?:string, version?:string}}
 */
export function checkCurl() {
  const r = spawnSync('curl', ['--version'], { encoding: 'utf8' })
  if (r.error) {
    return { ok: false }
  }
  const first = String(r.stdout || '').split('\n')[0] || ''
  return { ok: true, path: 'curl', version: first.trim() }
}

/**
 * @returns {{ok:boolean,status:number,url:string,headers:object,body:string,error?:string}}
 */
export function httpFetchSync(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const timeoutMs = options.timeoutMs || 15000
  const headers = Object.assign({ 'User-Agent': DEFAULT_UA, Accept: '*/*' }, options.headers || {})

  const args = ['-sS', '-L', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000))]
  args.push('-X', method)
  args.push('-w', '\n__YSC_STATUS__%{http_code}__YSC_URL__%{url_effective}', '--url', url)
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue
    args.push('-H', `${k}: ${v}`)
  }
  if (options.body !== undefined && options.body !== null && options.body !== '') {
    args.push('--data-binary', String(options.body))
  }

  const r = spawnSync('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
  if (r.error) {
    return { ok: false, status: 0, url, headers: {}, body: '', error: String(r.error.message) }
  }
  const raw = r.stdout == null ? '' : String(r.stdout)
  const marker = raw.lastIndexOf('\n__YSC_STATUS__')
  if (marker < 0) {
    return { ok: false, status: 0, url, headers: {}, body: raw, error: r.stderr || 'no status' }
  }
  const body = raw.slice(0, marker)
  const tail = raw.slice(marker + 1)
  const m = tail.match(/^__YSC_STATUS__(\d+)__YSC_URL__(.*)$/s)
  const status = m ? parseInt(m[1], 10) : 0
  const finalUrl = m && m[2] ? m[2] : url
  return { ok: status >= 200 && status < 400, status, url: finalUrl, headers: {}, body }
}

/** 异步 HTTP（走原生 fetch） */
export async function httpFetchAsync(url, options = {}) {
  const ctrl = new AbortController()
  const timeoutMs = options.timeoutMs || 15000
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({ 'User-Agent': DEFAULT_UA, Accept: '*/*' }, options.headers || {}),
      body: options.body === undefined || options.body === null ? undefined : options.body,
      redirect: options.followRedirect === false ? 'manual' : 'follow',
      signal: ctrl.signal,
    })
    const text = new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer()))
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      headers: Object.fromEntries(res.headers.entries()),
      body: text,
    }
  } catch (e) {
    return { ok: false, status: 0, url, headers: {}, body: '', error: String(e && e.message) }
  } finally {
    clearTimeout(t)
  }
}
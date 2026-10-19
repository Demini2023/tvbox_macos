/**
 * 站点会话管理：每个站点一个 worker 线程，带空闲回收与并发上限。
 */
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileURLToPath as _ } from 'node:url'
import { dispatchCms } from './cmsCollector.mjs'

void _
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_FILE = path.join(__dirname, 'spiderWorker.mjs')

const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟无请求则回收 worker
const REQUEST_TIMEOUT_MS = 90 * 1000
const MAX_SESSIONS = 8

/** key -> session */
const sessions = new Map()
let seq = 0

class Session {
  constructor(site, opts) {
    this.site = site
    this.opts = opts
    this.pending = new Map()
    this.lastUsed = Date.now()
    this.ready = null
    this.idleTimer = null

    this.worker = new Worker(WORKER_FILE, {
      workerData: { site, opts },
    })
    this.worker.on('message', (msg) => this._onMessage(msg))
    this.worker.on('error', (err) => {
      console.error(`[session ${site.key}] worker error:`, err.message)
      this._failAll(err.message)
    })
    this.worker.on('exit', (code) => {
      if (code !== 0) console.warn(`[session ${site.key}] worker exit code=${code}`)
      this._failAll('worker exited')
      sessions.delete(site.key)
    })

    this.ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
    })
  }

  _onMessage(msg) {
    if (msg.id === 'ready') {
      if (msg.ok) this._readyResolve(true)
      else this._readyReject(new Error((msg.data && msg.data.message) || 'worker init failed'))
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.data)
    else p.reject(new Error((msg.data && msg.data.message) || 'worker error'))
  }

  _failAll(message) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
  }

  async call(op, args = {}) {
    await this.ready
    this.lastUsed = Date.now()
    this._resetIdle()
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时直接销毁 worker，避免卡死
        this.destroy()
        reject(new Error(`请求超时(${REQUEST_TIMEOUT_MS / 1000}s): ${op}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, op, site: this.site, opts: this.opts, args })
    })
  }

  _resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (Date.now() - this.lastUsed >= IDLE_TIMEOUT_MS) {
        console.log(`[session ${this.site.key}] idle timeout, recycling`)
        this.destroy()
        sessions.delete(this.site.key)
      }
    }, IDLE_TIMEOUT_MS)
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  destroy() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this._failAll('session destroyed')
    try {
      this.worker.terminate()
    } catch {
      /* noop */
    }
  }
}

function getSession(site, opts) {
  const existing = sessions.get(site.key)
  if (existing) {
    // 站点配置变更则重建
    if (JSON.stringify(existing.site) !== JSON.stringify(site)) {
      existing.destroy()
      sessions.delete(site.key)
    } else {
      return existing
    }
  }
  // 并发上限：回收最久未用的
  if (sessions.size >= MAX_SESSIONS) {
    let oldestKey = null
    let oldest = Infinity
    for (const [k, s] of sessions) {
      if (s.lastUsed < oldest) {
        oldest = s.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey) {
      const s = sessions.get(oldestKey)
      s.destroy()
      sessions.delete(oldestKey)
    }
  }
  const s = new Session(site, opts)
  sessions.set(site.key, s)
  return s
}

/**
 * 在站点上下文中执行一个操作。
 *
 * 接口源（type:3 / api 为 http 且无 ext）不走 QuickJS worker ——
 * 它们是 CMS 采集器，纯 HTTP 转发即可。硬塞给 drpy2 会得到空规则，
 * 而且日志里会出现一个名字对不上的 "drpy_xxx" 采集器，很误导。
 */
export async function withSite(site, opts, op, args) {
  const cms = await dispatchCms(site, op, args)
  if (cms) return cms
  const session = getSession(site, opts)
  return session.call(op, args)
}

/** 关闭全部 worker（进程退出时调用） */
export function shutdownAll() {
  for (const [, s] of sessions) s.destroy()
  sessions.clear()
}

export function sessionStats() {
  return {
    count: sessions.size,
    keys: [...sessions.keys()],
    pending: [...sessions.values()].reduce((a, s) => a + s.pending.size, 0),
  }
}
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 本地 libs 目录（存放从 APK assets/js/lib 抽取的脚本） */
export const LIBS_DIR = path.join(__dirname, 'libs')

/** 远程脚本本地缓存目录 */
export const CACHE_DIR = path.join(__dirname, '.cache')

/** 是否是 http(s) 远程脚本 */
export function isRemoteModule(name) {
  return /^https?:\/\//i.test(String(name || '').trim())
}

/** 去掉 ./ ../ 前缀，得到纯文件名 */
function basenameOf(spec) {
  const i = Math.max(spec.lastIndexOf('/'), spec.lastIndexOf('\\'))
  return i >= 0 ? spec.slice(i + 1) : spec
}

/**
 * 归一化模块名。
 *
 * APK 内drpy2.js 用的是 Android 特有路径：
 *   import cheerio from 'assets://js/lib/cheerio.min.js'
 *   import './模板.js'
 *   import {gbkTool} from './gbk.js'
 * QuickJS 的模块解析要求 './' 或 '../' 前缀（bare specifier 会被拒绝），
 * 因此统一归一化为 './xxx.js'。
 */
export function normalizeModuleName(name) {
  let spec = String(name || '').trim()
  if (!spec) return spec
  if (isRemoteModule(spec)) return spec
  if (spec.startsWith('assets://')) {
    spec = spec.replace(/^assets:\/\/(js\/lib\/)?/, '')
  }
  if (spec.startsWith('file://')) {
    spec = spec.replace(/^file:\/\/.*\//, '')
  }
  const base = basenameOf(spec)
  return './' + base
}
/**
 * 把 probe_rules.mjs 实测通过的规则打包成一份可直接导入的配置。
 *
 * 为什么内联整段 JS 源码而不是引用文件路径：
 * drpy2 的 init(ext) 对字符串走
 *   eval("(function(){" + js.replace('var rule','rule') + "})()")
 * 这条路能拿到 init() 闭包里的 muban 局部变量，规则开头的
 * muban.xxx 修改才有效。若把源码当对象传入，
 * js.replace('var rule','rule') 会把 `var rule = {` 截断，
 * rule 变成 {"var rule":"{", ...} 这种垃圾。
 *
 * 用法：先跑 probe_rules.mjs，再跑本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const RULES_DIR = path.join(ROOT, 'data', 'drpy-rules')
const PROBE = path.join(ROOT, 'data', 'probe-result.json')
const OUT = path.join(ROOT, 'data', 'drpy-config.json')

if (!fs.existsSync(PROBE)) {
  console.error('未找到 data/probe-result.json，先运行: node tools/probe_rules.mjs 188')
  process.exit(1)
}

const probed = JSON.parse(fs.readFileSync(PROBE, 'utf8'))
const ok = probed
  .filter((x) => x.ok)
  .sort((a, b) => b.classes - a.classes || a.title.localeCompare(b.title))

const sites = ok.map((x, i) => {
  const src = fs.readFileSync(path.join(RULES_DIR, x.file), 'utf8')
  return {
    key: 'drpy_' + String(i).padStart(3, '0'),
    name: x.title,
    type: 1,
    api: './libs/drpy2.min.js',
    ext: src,
    searchable: 2,
    quickSearch: 1,
    _classes: x.classes,
  }
})

const cfg = {
  spider: './libs/drpy2.min.js',
  wallpaper: '',
  sites,
  parses: [],
  flags: [],
  lives: [],
  _meta: {
    source: 'hjdhnx/dr_py 官方规则库 js/ 目录',
    probed: probed.length,
    usable: sites.length,
    generatedAt: new Date().toISOString(),
    note:
      '全部为实测可返回数据的 dr_py 规则（ext 内联 JS 源码）。' +
      '因源站会改版，个别站点的分类列表可能为空，属正常现象。',
  },
}

fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2), 'utf8')

console.log(`已生成 ${path.relative(process.cwd(), OUT)}`)
console.log(`实测 ${probed.length} 个，可用 ${sites.length} 个`)
console.log(`文件大小 ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`)
console.log('\n分类最多的前 10 个:')
for (const s of sites.slice(0, 10)) {
  console.log(`  ${s.name.padEnd(16).slice(0, 16)} 分类 ${s._classes}`)
}
// _classes 只是生成时的排序依据，不该出现在最终配置里
for (const s of sites) delete s._classes
fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2), 'utf8')

import { createRuntime } from './drpyRuntime.mjs'
import fs from 'node:fs'
const rt = await createRuntime({ verbose: true })
// 注入探针：在 category 打印收到的 pg
const src = fs.readFileSync('data/drpy-rules/素白白.js','utf8')
rt.initRule(src)
const d = JSON.parse(rt.category({ tid:'new-movie', pg:2 }))
console.log('pg=2 结果:', (d.list||[]).length)
rt.dispose()

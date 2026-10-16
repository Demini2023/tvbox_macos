/**
 * 端到端自测：用真实 drpy 规则协议跑通全链路。
 *
 * 规则以「对象」形式传给 drpy2.init()，字段里的 js: 表达式由 drpy2 内部 eval 执行，
 * 其余字段（URL + 解析表达式）由宿主的 pdfh/pd 解析。
 */
import { createRuntime } from './drpyRuntime.mjs'

const rule = {
  title: '本地测试源',
  host: 'https://example.com',
  url: '/list?class=fyclass&page=fypage',
  searchUrl: '/search?wd=**',
  searchable: 2,
  quickDebug: 1,
  headers: { 'User-Agent': 'YSC-Test' },
  一级: '电影&电视剧&综艺',
  二级: '*',
  名称: 'div.vod@@name##h3&&text',
  图片: 'div.vod@data-original',
  描述: 'div.vod@title',
  搜索: 'div.vod;name;pic;;',
  search: 'div.vod;name;pic;;',
  分类: 'js:let d=[];for(let i=1;i<=4;i++)d.push({type_id:i,type_name:"分类"+i});JSON.stringify(d);',
  一级分类: 'js:input=input;let d=[];for(let i=1;i<=3;i++)d.push({type_id:i,type_name:"推荐"+i,vod_name:"热播"+i,vod_pic:"http://img/"+i+".jpg"});JSON.stringify({class:d});',
  二级分类: 'js:let id=input;let pg=Number(input.split("#")[1]||1);JSON.stringify({list:[{vod_id:id+"#"+pg,vod_name:"影片"+pg,vod_pic:"http://img/"+pg+".jpg",vod_remarks:"HD"}],page:pg,pagecount:20,limit:20,total:500});',
  详情: 'js:let a=input.split("@@");JSON.stringify({vod_id:a[0],vod_name:"详情影片",vod_pic:"http://img/big.jpg",vod_year:"2024",vod_area:"中国大陆",vod_remarks:"更新至"+(a[1]||1),vod_director:"某导演",vod_content:"这是简介内容。"});',
  播放: 'js:let a=input.split("@@");JSON.stringify({parse:0,playUrl:a[0].replace("#","-")+"-"+(a[1]||0)+".m3u8"});',
  搜索二级: 'js:JSON.stringify({list:[{vod_id:wd,vod_name:wd+" - 搜索结果",vod_pic:"http://img/s.jpg"}]});',
  筛选: '',
}

const rt = await createRuntime({ proxyUrl: 'http://127.0.0.1:9527', rkey: 'rk-test' })

const step = (label, fn) => {
  process.stdout.write(label.padEnd(14))
  try {
    const raw = fn()
    let out = raw
    try {
      out = JSON.parse(raw)
    } catch {
      /* keep raw */
    }
    console.log(JSON.stringify(out).slice(0, 260))
    return out
  } catch (e) {
    console.log('ERROR:', e.message.slice(0, 200))
    return null
  }
}

console.log('=== 1. init(rule) ===')
step('init', () => rt.initRule(rule) || '')

console.log('\n=== 2. home() 分类 ===')
const home = step('home', () => rt.home(false, ''))

console.log('\n=== 3. homeVod() 推荐 ===')
step('homeVod', () => rt.homeVod({}))

console.log('\n=== 4. category(1, 1) 列表 ===')
const cat = step('category', () => rt.category(1, 1, false, {}))
const vodId = cat && cat.list && cat.list[0] ? cat.list[0].vod_id : '1#1'

console.log('\n=== 5. detail() 详情 ===')
step('detail', () => rt.detail(vodId))

console.log('\n=== 6. play() 播放地址 ===')
step('play', () => rt.play('线路A', vodId + '@@0'))

console.log('\n=== 7. search() 搜索 ===')
step('search', () => rt.search('庆余年', false, 1))

console.log('\n=== 8. 宿主 API ===')
const probe = ctx => {
  const r = ctx.evalCode(
    `JSON.stringify({ua:MOBILE_UA.slice(0,10),rkey:RKEY,j:joinUrl('https://a.com/x/','../y'),m:getMd5('abc'),pdfh:pdfh('<a href=\"/p/1\">N</a>','a&&href')})`,
    'p.js'
  )
  if (r.error) return 'probe error: ' + JSON.stringify(ctx.dump(r.error))
  const v = ctx.dump(r.value)
  r.dispose()
  return v
}
console.log('probe        ', probe(rt.context))

rt.dispose()
console.log('\nDISPOSED CLEAN')
console.log('\n--- runtime logs (last 12) ---')
console.log(rt.logs.slice(-12).join('\n'))
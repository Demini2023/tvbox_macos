"""保存一份本地测试规则到服务端配置（用于端到端验证）。

drpy2 的 js: 规则约定（读自 libs/drpy2.js）：
  class_parse -> eval 后读取局部变量 `input`（必须是数组）
  推荐/一级    -> eval 后读取全局 `VODS`（数组）  TYPE='home' | 'cate'
  二级        -> eval 后读取全局 `VOD` （对象）  TYPE='detail'
  搜索        -> eval 后读取全局 `VODS`（数组）  TYPE='search'
  lazy        -> eval 后读取局部变量 `input`（播放地址对象）
eval 的返回值一律被丢弃，所以 js 必须给上述变量赋值。
"""
import json
import os
import urllib.request

BASE = os.environ.get('YSC_BASE', 'http://127.0.0.1:9527')

rule = {
    "host": "https://example.com",
    "url": "https://example.com/list?class=fyclass&page=fypage",
    "searchUrl": "https://example.com/search?wd=**",
    "searchable": 2,
    "一级": (
        "js:if(TYPE=='home'){"
        "VODS=[{vod_id:'rec_1',vod_name:'热播A',vod_pic:'http://img/a.jpg',vod_remarks:'更新至3集'},"
        "{vod_id:'rec_2',vod_name:'热播B',vod_pic:'http://img/b.jpg',vod_remarks:'HD'}];"
        "}else{"
        "let pg=MY_PAGE||1;let tid=MY_CATE;let l=[];"
        "for(let i=1;i<=6;i++){let n=pg*10+i;"
        "l.push({vod_id:'v_'+tid+'_'+(pg*10+i),vod_name:'影片'+n,"
        "vod_pic:'http://img/v'+n+'.jpg',vod_remarks:(i%2?'更新至'+n:'HD')});}"
        "VODS=l;"
        "}"
    ),
    "二级": (
        "js:var vid=orId.split('@@')[0];var parts=vid.split('_');"
        "VOD={vod_id:vid,vod_name:'测试影片 · '+(parts[2]||vid),"
        "vod_pic:'http://img/big.jpg',vod_year:'2025',vod_area:'中国大陆',"
        "vod_remarks:'更新至12集',vod_actor:'主演甲',vod_director:'测试导演',"
        "vod_content:'这是影片简介，用于验证详情接口。',"
        "vod_play_from:'线路1',"
        "vod_play_url:'第1集$https://cdn.example.com/1.m3u8#"
        "第2集$https://cdn.example.com/2.m3u8#第3集$https://cdn.example.com/3.m3u8'};"
    ),
    "搜索": (
        "js:var wd=KEY;"
        "VODS=[{vod_id:wd,vod_name:wd+' - 结果一',vod_pic:'http://img/s1.jpg',vod_remarks:'HD'},"
        "{vod_id:wd,vod_name:wd+' - 结果二',vod_pic:'http://img/s2.jpg',vod_remarks:'更新至9集'}];"
    ),
    "分类": (
        "js:input=[{type_id:'1',type_name:'电影'},{type_id:'2',type_name:'剧集'},"
        "{type_id:'3',type_name:'综艺'}];"
    ),
    "lazy": (
        "js:var a=input.split('@@');var seg=a[0].split('$');"
        "var u=seg.length>1?seg[1]:a[0];"
        "input={parse:0,url:u,flag:'',jx:false};"
    ),
}

cfg = {
    "sites": [
        {
            "key": "local_test",
            "name": "本地测试源",
            "type": 1,
            "api": "",
            "ext": json.dumps(rule, ensure_ascii=False),
            "searchable": 2,
            "quickSearch": 1,
        }
    ],
    "parses": [],
    "flags": [],
    "lives": [],
}

req = urllib.request.Request(
    BASE + "/api/config/save",
    data=json.dumps({"config": cfg}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
res = json.loads(urllib.request.urlopen(req, timeout=15).read())
print("saved:", res["ok"], "sites:", len(res["data"]["sites"]))
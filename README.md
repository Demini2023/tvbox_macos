# 影视仓 iOS 复刻版

原生 SwiftUI iPhone 客户端 + 局域网 Node 后端，复刻 `影视仓-手机平板-64位-3.3.8_opt.apk` 的影视聚合与 PakyJS/采集器能力。

## 架构

```
iPhone (YSCFilm, SwiftUI + AVPlayer)
   │  HTTP/JSON（局域网）
   ▼
Mac/PC 上的 Node 服务 (ysc/server, 端口 9527)
   │  quickjs-emscripten (WASM)
   ▼
APK 原生采集器运行时 libs/drpy2.js + 23 个依赖模块
```

后端负责跑 drpy2 采集器（同步阻塞的 `_http` 需要 QuickJS 运行时 +每站点独立 worker），
iPhone 端只做 UI 与 HLS 播放。

## 目录

```
ysc/
├── server/                Node 后端（采集器运行时）
│   ├── libs/              从 APK 抽取的 23 个原始 JS 模块
│   ├── drpyRuntime.mjs    QuickJS 运行时封装
│   ├── hostApi.mjs        宿主 API（pdfh/pdfa/_http/require/存储…）
│   ├── parseEngine.mjs    dr_py 解析表达式引擎
│   ├── ruleNormalize.mjs  规则字段名标准化（中文键 -> drpy2 字段）
│   ├── spiderWorker.mjs   单站点 worker
│   ├── spiderManager.mjs  会话管理（5min 空闲回收）
│   └── server.mjs         Express REST API
└── ios/YSCFilm/           iOS 客户端（SwiftUI）
    ├── project.yml        XcodeGen 工程定义
    └── YSCFilm/
        ├── App/           入口 + 全局状态
        ├── Models/        数据模型
        ├── Networking/    REST 客户端
        ├── Player/        AVPlayer 播放
        └── Views/         首页/详情/播放/搜索/收藏/历史/设置
```

## 零、克隆仓库（macOS）

```bash
git clone git@github.com:Demini2023/tvbox_macos.git
cd tvbox_macos
```

### Mac 首次使用需先生成 SSH key

SSH 私钥**不随仓库分发**，每台机器要各配一次：

```bash
# 1. 检查是否已有公钥
ls ~/.ssh/id_ed25519.pub 2>/dev/null || ssh-keygen -t ed25519 -C "ysc@$(hostname)" -N ""

# 2. 复制公钥，贴到 https://github.com/settings/ssh_keys/new
pbcopy < ~/.ssh/id_ed25519.pub
```

GitHub 页面填法：Title 随意（如 `ysc-mac`），Key 粘贴刚复制的 `ssh-ed25519 AAAA...`，
Authentication type 选 **Authentication key**，保存。

验证（看到 `Hi Demini2023!` 就算成功）：

```bash
ssh -T git@github.com
```

> 如果报 `Host key verification failed`，先执行 `ssh-keyscan github.com >> ~/.ssh/known_hosts`。
> 同一 GitHub 账号可挂多把公钥，Windows/Mac 各自的 key 分别添加即可。

## 一、启动后端（Mac / PC）

```bash
cd server
npm install
node server.mjs
```

启动后终端会打印局域网地址，例如 `http://192.168.20.103:9527`。
监听 `0.0.0.0`，CORS 全开，iPhone 可直接访问。

自检（无需网络）：

```bash
node selftest.mjs
```

导入配置（TVBox JSON 地址或本地 JSON 文本）：

```bash
curl -X POST http://127.0.0.1:9527/api/config/import \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/tvbox.json"}'
```

## 二、构建 iOS App（必须在 macOS + Xcode）

本工程用 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 定义，避免手写 `.pbxproj` 出错。

```bash
# 安装 XcodeGen（首次）
brew install xcodegen

cd ios/YSCFilm
xcodegen generate
open YSCFilm.xcodeproj
```

在 Xcode 中：
1. 选中 `YSCFilm` target → Signing & Capabilities → 勾选 Automatically manage signing，
   选自己的 Team（个人 Apple ID 也可）
2. Bundle ID 默认 `com.ysc.film`，冲突就改成你自己的
3. 连上 iPhone，⌘R 运行
4. 首次启动弹「本地网络」权限 → 允许

### 不用 XcodeGen 的替代方案

手动新建 iOS App 工程，把 `YSCFilm/` 目录下的所有 `.swift` 文件拖进 target，
再把 `YSCFilm/Resources/Info.plist` 设为 Info.plist 文件（勾选 Don't Copy）。

## 三、iPhone 上配置

打开 App → 「设置」页：

| 字段 | 值 |
|---|---|
| 服务器 | `http://<电脑局域网IP>:9527`（默认已填 `192.168.20.103:9527`）|
| 导入配置 | 可选，TVBox 配置地址 |

点「测试连接」应显示**连接成功**，再点「保存并加载配置」。
随后「设置 → 站点」会列出可用站点，回到首页即可浏览。

## 已知限制

- **必须与电脑同一 WiFi**，未做公网穿透
- **需要 macOS/Xcode 编译**。Windows/Linux 上只能改代码，无法产出 App
- **出网受限环境下**内置兜底配置拉不到（GitHub raw 不可达），必须自己导入可达的配置地址
- 部分站点需要嗅探（`parse:1`），客户端会尝试走后端 `/proxy` 转发；对强鉴权站点仍可能失败
- 未做证书固定，HTTPS 站点走系统默认校验

## drpy2 规则字段速查

写配置时最容易踩的坑——`js:` 前缀规则的 eval **返回值被丢弃**，必须给约定变量赋值：

| 规则字段 | 由谁消费 | js 里要赋值给|
|---|---|---|
| `class_parse` | `home()` 分类 | 局部变量 `input`（必须是数组）|
| `推荐` | `homeVod()`，`TYPE='home'` | 全局 `VODS`（数组）|
| `一级` | `category()`，`TYPE='cate'` | 全局 `VODS`（数组）|
| `二级` | `detail()`，`TYPE='detail'` | 全局 `VOD`（**单个对象**）|
| `搜索` | `search()`，`TYPE='search'` | 全局 `VODS`（数组）|
| `lazy` | `play()` 免嗅| 局部变量 `input`（播放地址对象）|

可用上下文变量：`input`（MY_URL）、`MY_PAGE`、`MY_CATE`、`KEY`（搜索词）、`detailUrl`、`MY_FL`、`orId`（详情 id）。

`lazy` 需与 `play_parse` 同时非空才生效，`ruleNormalize.mjs` 已自动补占位。

示例：

```json
{
  "host": "https://example.com",
  "url": "/list?class=fyclass&page=fypage",
  "分类": "js:input=[{type_id:'1',type_name:'电影'}]",
  "推荐": "js:VODS=[{vod_id:'1',vod_name:'热播A'}]",
  "一级": "js:VODS=[{vod_id:'2',vod_name:'影片'+MY_PAGE}]",
  "二级": "js:VOD={vod_id:orId,vod_name:'详情',vod_play_from:'线路1',vod_play_url:'第1集$https://a.com/1.m3u8'}",
  "搜索": "js:VODS=[{vod_id:KEY,vod_name:KEY+' 结果'}]"
}
```
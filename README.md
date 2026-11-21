# 共读批注

爸爸和孩子分开读同一本书，各自在页边写批注，最后都挂回原文段落旁边——左边是作者，右边是你们俩。

最早是鲁迅《朝花夕拾》的单页 MVP，用来验证"句级批注 + 双向联动"这套前端方案。现在扩展成了一个完整的本地阅读批注应用：可以导入自己的 txt / epub，书、批注、回复、进度都存在后端数据库里，AI 问答也由后端代理。

## 功能

- **书架** —— 内置《朝花夕拾》全文；支持导入 txt / epub（可多选、可拖拽），自动拆章节和段落。
- **句级批注** —— 在原文里划选任意一句即可批注；被批注的句子就地高亮（爸爸蓝、孩子橙、同句重叠琥珀、AI 紫），带编号小签，与右侧卡片对位。
- **双向悬停联动** —— 悬停原文高亮，对应卡片浮起；悬停卡片，原文句子加深。
- **划选工具栏** —— 批注 / 查字词（内置词表 + 模型兜底）/ 问 AI。
- **批注可回复** —— 父子在同一句话下你来我往。
- **问 AI 流式回答** —— 后端调用 OpenAI 兼容接口，前端逐字显示；没配 key 时回退到示例回答。
- **身份切换** —— 顶栏切换爸爸 / 孩子，新建内容默认记在当前身份下。
- **阅读进度** —— 按用户、按书记住读到哪一段，下次打开自动回到那里。
- **管理台** —— 书库管理、全量批注查看与删除、模型配置与连通测试、称呼修改、旧数据迁移、备份。
- **长期归档** —— 每天自动把「书全文 + 批注 + 回复」导出成一份 JSON，保留 30 天；也可随时手动导出。

## 架构

```
浏览器（原生 ES Modules，无构建）
   │  REST / SSE
   ▼
Node 后端（Express，一个进程同时托管静态文件与 API）
   │
   ├── SQLite（data/library.db）：书、段落、批注、回复、进度
   ├── data/exports/：每日 JSON 归档
   └── LLM API（OpenAI 兼容，key 只在后端）
```

前端不依赖框架、不需要打包，改完刷新即生效。后端只依赖 `express`，SQLite 用 Node 24 自带的 `node:sqlite`。

## 运行

```bash
npm install
npm start          # http://localhost:8787
```

首次启动会自动建库，并把 `seed/texts.js`（《朝花夕拾》全文）灌进数据库；批注从零开始记。

### 作为常驻服务

仓库外已经配置了 systemd 用户服务（按需自行复制）：

```ini
# ~/.config/systemd/user/reading-together.service
[Unit]
Description=reading-together 共读批注
After=network-online.target

[Service]
WorkingDirectory=/home/ri7er/code/reading-together
EnvironmentFile=%h/.config/reading-together.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
StandardOutput=append:/home/ri7er/code/reading-together/data/server.log
StandardError=append:/home/ri7er/code/reading-together/data/server.log

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger $USER          # 注销后也继续运行
systemctl --user daemon-reload
systemctl --user enable --now reading-together
```

`~/.config/reading-together.env` 里放模型 key（`ZAI_API_KEY=...`，权限 600）。也可以不写环境变量，直接在管理台「设置」里填。

### 访问

- 家里：`http://192.168.1.186:8787`
- 出门：`http://100.122.38.53:8787`（tailscale）
- 服务监听 `0.0.0.0:8787`，端口可用 `PORT` 环境变量改。

> 目前没有登录和鉴权，只适合放在家里 / tailscale 内网。不要直接映射到公网；要给外人看之前先加一层认证或走 Cloudflare Tunnel + Access。

## 目录

| 路径 | 作用 |
| --- | --- |
| `server/index.js` | HTTP 路由：书籍、批注、回复、进度、AI、字典、设置、备份 |
| `server/importers.js` | txt / epub 解析，统一成 `{title, chapters:[{title, paras}]}` |
| `server/library.js` | 书籍与批注的数据库读写、导出、旧数据迁移 |
| `server/llm.js` | OpenAI 兼容的流式 / 非流式调用，示例回答兜底 |
| `server/db.js` | SQLite 连接、建表、设置读写、事务 |
| `server/seed.js` | 首次启动灌入内置书和示例批注 |
| `server/dict.json` | 内置词表（32 条《朝花夕拾》常见词） |
| `public/` | 前端：书架、阅读器、管理台、样式 |
| `seed/texts.js` | 内置书全文（维基文库公版，繁体转简体） |
| `data/` | 运行时数据（**不入库**）：`library.db`、`exports/`、`server.log` |
| `tmp_fetch/` | 抓取的原始 wikitext 与 `build_texts.py`，用于重新生成 `seed/texts.js` |

## 导入规则

- **TXT** —— 自动识别 `第X章/回/节/卷/篇`、`序言`、`后记` 等标题行；有空行按空行分段，无空行按行分段；单段过长会在句末标点处切开。
- **EPUB** —— 解析 zip → `container.xml` → OPF 清单 → spine 顺序 → 每章 XHTML 转纯文本段落；章节名优先取 epub3 目录，其次 `h1~h3`、`<title>`。
- 两者最终都写进同一套 `books / chapters / paragraphs`，所以阅读、批注、导出只有一条代码路径。

> 只取文字，不保留 epub 原版排版和插图。这是刻意的：批注要锚定在稳定的段落文本上，翻页器和自定义高亮很难共存。

### 批注锚点

每条批注存 `para_idx + quote + offset + qlen + para_hash`。创建时后端在段落里定位摘录（逐字 → 去首尾引号 → 忽略空白差异），定位不到也照样保存，只是不做划词高亮，卡片仍在段落旁。管理台的「批注」页会标出「未定位」，方便以后修复。

## API 速览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 用户、书架、统计、模型状态 |
| GET | `/api/books/:id` | 书 + 章节 + 段落 + 批注 + 进度 |
| POST | `/api/books/import` | 原始文件体 + `X-Filename` 头 |
| DELETE | `/api/books/:id` | 删书（连带批注） |
| POST | `/api/notes` | 新建批注（后端定位锚点） |
| PATCH/DELETE | `/api/notes/:id` | 编辑 / 墓碑删除 |
| POST | `/api/notes/:id/replies` | 回复 |
| DELETE | `/api/replies/:id` | 删回复 |
| POST | `/api/ai/ask` | SSE 流式问答，同时落一条 AI 批注 |
| POST | `/api/ai/retry/:id` | 重试未答完的 AI 批注 |
| GET | `/api/dict?w=` | 查字词（内置词表 → 模型 → 缓存） |
| GET/POST | `/api/progress` | 阅读进度 |
| GET | `/api/export` | 下载完整归档 JSON |
| POST | `/api/migrate-local` | 导入旧版 localStorage 数据 |
| PATCH | `/api/settings` | 模型地址 / 模型名 / key |

请求头 `X-User: dad|son` 表示当前身份（家内可信网络，没做鉴权）。

## 数据与备份

- 正本是 `data/library.db`。它不进 git，所以**备份很重要**：
  - 每天首次启动或每 6 小时检查一次，把完整 JSON 写到 `data/exports/archive-YYYY-MM-DD.json`；
  - 手动：管理台「备份」页或顶栏「导出」。
- 导出的 JSON 里包含每本书的章节、全文和全部批注，不依赖数据库结构，换一台机器也能读。
- 想留很多年：把 `data/exports/` 再同步到 git 远端或另一台机器（3-2-1 里至少留两份异机）。

### 从旧版网页迁移

旧版的批注存在浏览器 localStorage（`rtz_local_v1` / `rtz_replies_v1` / `rtz_hidden_v1` / `rtz_names_v1`）。用**曾经打开过旧版的那台电脑和浏览器**进入管理台 → 设置 → 「读取本机旧数据并导入」。

## 模型配置

支持任何 OpenAI Chat Completions 兼容接口。优先级：

1. 管理台「设置」里保存的 `base / model / key`（存数据库，所有设备共用）；
2. 环境变量 `ZAI_API_KEY`（默认接 z.ai，模型 `glm-4.5-flash`）；
3. 都没有时使用内置示例回答，功能仍可走通。

不要把 key 提交进仓库。后台保存的 key 只写在本机 `data/library.db`，接口返回时始终打码。

## 已知限制 / 下一步

- 没有账号体系，靠 tailscale / 局域网隔离。
- 导入只取文字，不保留 epub 插图与版式。
- 不支持 PDF（版面提取太脏，暂不做）。
- 批注还不能附手写照片；孩子的纸质批注仍走外部 OCR 再录入。
- 全文搜索、按篇阅读报告、导出成离线可读的静态 HTML 归档包，还没做。

## 文本来源

鲁迅（1881—1936），作品已进入公有领域。内置文本取自中文维基文库，由 `tmp_fetch/build_texts.py` 清洗（去除模板、内链标记，繁体转简体）。

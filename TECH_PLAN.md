# solgrid canvas 技术方案

> 版本 v0.2（草案）· 依据 `REQUIREMENTS.md` 需求 + 上游 `basketikun/infinite-canvas` v0.20.0（commit `9cd3dea`）基线 + 平台实测契约
> **基线已切换**：放弃 solgrid fork，直接从上游拉代码。fork 相对上游只多两个 commit（solgrid 渠道预设/脚本、拉片插件），二者都不继承；有价值的是**实测知识**，已移植到 `notes/`（`solgrid-findings.md`、`lapian-methodology.md`）。
> 结论先行，细节在后。所有"实测"结论都有出处（`notes/solgrid-findings.md`、CLI `tools list/categories` / `inspect` 实跑、源码核对）。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 从零写还是基于现有 fork | **以上游 `basketikun/infinite-canvas` v0.20.0（`9cd3dea`）为基线**（画布引擎 / 插件 SDK / 文档站已具备，MIT）；放弃 solgrid fork。调研了 8 个备选开源项目（§3.4），**没有能整体替换的** |
| 存储与资产 | **项目 = 一个目录**：`canvas.json` 用 JSON Canvas 1.0 开放格式 + `assets/<sha256>` 内容寻址 + `runs.sqlite` 账本。节点只存 `assetId`，**不再把 dataURL 塞进节点**（这是"项目一大就卡"的第一根因） |
| 功能差距怎么补 | 不靠换项目：提示词优化（ACP 短 turn）、局部重绘（平台无 mask 端点 → bbox 局部编辑 + 羽化回贴）、非破坏性编辑栈、片段级重生成（时间线 + videoedit/i2v）。见 §5.9 |
| 进程模型 | **本地 daemon + 浏览器 UI**（不是纯前端，也不是云服务）。`npx solgrid-canvas` → 起本机服务 → 开画布 |
| solgrid 调用放哪 | **只在 daemon 里**，通过本机已装的 `solgrid` CLI。浏览器不碰 API Key，不碰生成请求 |
| 并发的唯一真相 | **全局单队列（默认 in-flight=1）**。平台账号级只允许 1 个在途 run，这是硬约束，必须有一个中心化执行点 |
| 模型接入方式 | **目录驱动（tools list/categories + inspect → JSON Schema → 参数表单）+ provider family 归一化器**，取代现在"每个模型一份调用脚本" |
| 与 solgrid 的耦合点 | 只有两个 CLI 命令：`solgrid run -f body.json --idempotency-key K -j`（不带 `--wait`）+ `solgrid runs get -r R -j`。节点里存 `{provider, endpoint, params}`（§5.3.1），不把 solgrid 伪装成 OpenAI 渠道；平台加模型/改参数，画布不用发版 |
| 复杂度 | 只保留三件不可砍的：单点串行、自带幂等键、runId 落盘（§5.2.1）。估价拦截、僵尸自愈、并发分道、成本报表**先砍**，极简版 150–200 行 |
| 与本地 Agent 的关系 | **ACP 进、MCP 出**：画布作为 ACP client 驱动本地 Agent（借用它的模型/凭证/技能），同时作为 MCP server 供 Agent 操作画布；ACP `session/new` 的 `mcpServers` 把两者缝在一次连接里 |
| 长视频 | 新增 **composition（时间线）** 模块，图与时间线分离；预览走「播放头附近按需解码」，导出走 ffmpeg / OTIO |
| 最大新增工程 | ① 运行引擎（单点串行 + 幂等 + runId 落盘，极简版 150–200 行）② 资产落地层 ③ 时间线与导出。这三块是上游没有的 |

分期粗估（1 人全职）：M0 骨架 1 周 / M1 单节点闭环（含存储迁移）2 周 / M2 Agent 闭环 2 周 / M3 技能 2 周 / M3b 编辑层 2 周 / M4 时间线成片 3 周 / M5 打包发布 1–2 周。

---

## 1. 需求 ↔ 技术含义

README 的四步使用流程，翻译成工程要求：

| README 要求 | 技术含义 | 影响面 |
|---|---|---|
| ① 用户注册充值拿 api key | 复用平台账号体系，画布不自建账号 | daemon 读取本机 `solgrid` CLI 凭证，不落浏览器 |
| ② Agent 装平台 skill，自动装 CLI 并引导配置 | 画布安装器要做同样的事：检测 CLI → 检测 key → 给指引 | `solgrid-canvas install` 子命令 |
| ③ 画布**复用本地 Agent 的语言模型配置**、复用已配置的 solgrid 信息，无额外配置 | 不要求用户在画布设置里再填一遍 baseUrl/key/model | ACP client 借模型（§5.6）+ 复用 `solgrid` CLI 凭证（§5.4） |
| ④ 通过对话操作画布；画布上可调用本地 Agent 的 skill（例：拉片） | 画布必须对 Agent **可读写、可观察、可批量落地产物** | MCP 工具契约 + 技能运行模型 + 自动布局 |
| Canvas 对标 libtv / 即梦，面向长视频与专业用户 | 需要时间线、多轨、剪辑点、成片导出 | composition 模块（上游无） |

**隐含但关键的第五条**：每次真实生成都要花钱。平台规则要求"每次调用前给出价格估算并由用户确认"，所以画布必须有 **成本可见 + 显式确认** 的第一等公民设计，否则 Agent 一失控就是烧钱。

---

## 2. 平台硬约束（全部实测，不是推测）

这些约束决定了架构，逐条列出：

1. **账号级只允许 1 个在途 run**。同一个 key、不同 endpoint 并发同样撞车：3 并发 → 1 个 `tool_service_unavailable`、2 个 `HTTP 500 code 99999`，并留下僵尸 RUNNING 占死槽位，后续每个请求都等不到空槽。
   → 结论：并发控制必须是**进程级、单点**的。浏览器多标签页、多个 Agent 会话、多个画布项目，全部共享同一个队列。
2. **文生图是同步接口，阻塞 46–60s**，偶发 Cloudflare `504/520`（~20 次 1 次）。
   → 结论：daemon 提交后**立即返回 runId**，之后用 `runs get` 轮询，永不持有长连接。
3. **提交失败不等于没创建**。必须用同一个 `Idempotency-Key` 调 `runs get-by-idempotency-key` 找回；只有 404 才是真没建成，此时才能重提。
   → 结论：幂等键在**入队时生成并落盘**，早于任何网络请求。重试永远复用同一个键。
4. **视频 run 状态只在服务端**；上游/旧 fork 把视频任务放在浏览器内存 Map，刷新页面就 `pluginVideoExpired`，节点报废。
   → 结论：run 账本必须持久化（SQLite），保证刷新/重启/崩溃后都能续上。
5. **产物 URL 是 OSS 签名地址，约 24h 过期，且不带 CORS 头**。浏览器拿不到 blob 时只能引用远端 URL，过期即失效。
   → 结论：**资产必须由 daemon 下载落地**（服务端无 CORS 限制），本地内容寻址存储 + 自己的 HTTP 提供 Range 请求。同时保留 `fileAssetId`，过期后可用 `files url` 重新签名。
6. **`422 daily_budget_exceeded`** 是"日预算/在途预留"不足，不是钱包余额（钱包 $98 也可能触发）。它是**可重试**的，需要等 + 退避，而不是判死。
7. **价格有三种结构**：`PER_CALL` / `PER_UNIT`（如 Kling 视频按 Unit）/ `METERED`（按秒 + 分辨率分档，如 wan2.7：720P 13 Spark/秒、1080P 19.5 Spark/秒）。`unitPriceUsd = unitPrice / 100`。reservation（默认 100 Spark）不是费用。
8. **API 有 `access-control-allow-origin: *`**，浏览器直连"能通"——但那是妥协方案，代价是上面 2/4/5 三条全中。daemon 方案不是"为了绕 CORS"，是为了拿到执行权。
9. **平台没有图像局部重绘（mask inpaint）端点**。实测：`/v1/image/qwen-image-3.0` 等 edit 类模型的 body 只有 `image/prompt/size/n`，**无 mask 字段**；全目录 `discover -q inpaint` 只命中 stability 的**音频** inpaint。→ 结论：局部重绘要自己实现（蒙版 bbox 局部编辑 + 羽化回贴，见 §5.9），或推动平台接入带 mask 的 edit 端点。

---

## 3. 现状盘点：上游 `basketikun/infinite-canvas` v0.20.0（基线 commit `9cd3dea`）

> 本仓库已建立在该基线上（`git remote` 的 `upstream` 指向 GitHub；`git log` 第一条是我们的文档提交）。**不再从 solgrid fork 起步。**

### 3.1 上游已具备、直接继承

| 能力 | 位置 | 价值 |
|---|---|---|
| 无限画布引擎（拖拽/缩放/连线/小地图/撤销/导入导出） | `web/src/components/canvas/*` | 数月工作量，别重写 |
| 节点体系（text/image/video/audio/config）+ 生成参数面板 / 裁剪 / 拆分 / 放大 / 蒙版 / 反推提示词 | 同上 + `web/src/pages/canvas/` | 直接继承（§5.9 已按源码核对） |
| **节点插件 SDK + 远程插件安装**（渲染/检查器/序列化/迁移/工具栏/AI 能力） | `plugins/canvas/sdk`、`web/src/lib/canvas/plugin-loader.ts` | 时间线、分镜表、字幕等新能力做成插件，不进核心 |
| 官方节点插件（html / markdown / panorama / sticky-note / svg / template） | `plugins/canvas/*` | 插件写法有现成范本 |
| 本地 Agent 雏形（HTTP+SSE，127.0.0.1，token + Origin 钉住，MCP tools，Codex app-server） | `canvas-agent/` | 安全模型可复用；**Codex 私有协议那层要换成 ACP** |
| Codex app 插件（marketplace） | `plugins/infinite-canvas` | 分发形态样板 |
| 文档站（fumadocs）、Docker、CI 配置 | `docs/`、`.github/`、`Dockerfile` | 可用则用；`AGENTS.md` 不继承，已按本项目重写 |

### 3.2 我们放弃的两块（fork 相对上游多出的 2 个 commit）

| 放弃的内容 | 位置（fork 仓库，仅参考） | 为什么放弃 | 有价值的沉淀 |
|---|---|---|---|
| `solgrid` 渠道预设 + 每模型调用脚本 + 自检脚手架 | `web/src/lib/solgrid-preset.ts`、`scripts/solgrid/` | 它把 solgrid 伪装成 OpenAI 渠道，15 个模型硬编码 + 每模型一份脚本，正是"平台改模型画布要跟着改"的根源（§5.3.1） | **契约与坑位实测**已移植到 `notes/solgrid-findings.md`（幂等找回、in-flight=1、504、URL 24h、日预算 422、数量 N 语义） |
| 逐帧拉片插件 | `plugins/canvas/lapian/` | 写死在插件里，与"复用 Agent 已装技能"冲突；且要求宿主 SDK 打补丁（`GenerateTextOptions.images`） | **方法论与提示词框架**已移植到 `notes/lapian-methodology.md`（抽帧、连环画拼图、三轮 vision、产出布点） |

> 结论：两块代码都不进新仓库，但两条知识链都留下了。`D:\data\github\infinite-canvas` 从此只是参考资料，不再参与构建。

### 3.3 上游必须改造的部分（否则达不到 `REQUIREMENTS.md`）

| 上游现状 | 问题 | 替换为 |
|---|---|---|
| 纯前端，前端直连 OpenAI 兼容渠道，key 在浏览器 | 违反"复用已配置 solgrid 信息"；刷新即丢状态；无法集中并发；无法落地资产 | daemon + `solgrid` CLI |
| 图片/视频以 dataURL 存在 `node.metadata.content`，整文档写 localforage | 项目一大就卡；Agent 读不到资产 | 项目目录 + `assetId`（§5.4） |
| 生成任务态在内存 / 浏览器 | 刷新、关页、崩溃即废（旧 fork 的 `pluginVideoExpired` 就是这个） | SQLite run 账本 + 启动恢复 |
| 只有图，没有时间线 | 无法做长视频 | composition 模块（§5.5） |
| Agent 只接 Codex（Claude 未开） | 需求明确要 dsh / codex 等 | ACP 适配器矩阵（§5.6） |
| 没有平台任务概念（只有"渠道/模型"） | 无法表达 `{provider, endpoint, params}` | 「平台任务」一等公民（§5.3.1） |

**判断**：这是**架构改造 + 四个新子系统**（运行引擎、资产落地、时间线、Agent 桥），不是小修；但改造成本远低于重写画布 UI。

> ✅ **治理项已落地**：仓库 `AGENTS.md` 已**按本项目重写**，不再继承上游规则。上游那条"外部服务请求放 `web/src/services/api/`、浏览器前端直连、不假设项目后端"已删除，替换为本项目的九条架构铁律（项目目录即事实源、节点只存 `assetId`、只有 daemon 花钱、生成只走 CLI、默认单点串行、模型=调用坐标、ACP 进 MCP 出、图与时间线分离、付费必须确认）。**上游的其他规范同样不再作为约束**：可以大改、删功能、改数据结构，只保留代码起点与许可证义务。

---

### 3.4 备选底座调研（2026-11，star 数为检索时快照）

结论先说：**没有能在"功能 + 架构"上整体替换上游的开源项目，但有两类项目值得借鉴，且其中两个同源 fork 证明"服务端化"这条路是对的。**

| 项目 | ★ | 架构 | 对 solgrid 的适配度 | 判断 |
|---|---|---|---|---|
| **basketikun/infinite-canvas**（本仓库基线） | 10.5k | 纯前端 + 浏览器存储，OpenAI 兼容直连 | 已知短板：storage 在浏览器、无服务端 | **作为基线**（UI 打磨最好、MIT、生态最大） |
| **tigerowo/infinite-canvas** | 1.7k | **Go(Gin) 后端** + Next.js 前端；导演台（Three.js 3D 场景）、全景图、ComfyUI Bridge、工作流参数 | 架构方向正是我们要的（服务端状态 + 后台任务调度） | 同源 fork，功能超前；**只借鉴，不合并**（合并代价 > 重写服务端） |
| **hero8152/Infinite-Canvas** | 3.2k | **Python FastAPI 后端**（`main.py`）+ 前端；provider 设置、ComfyUI/ModelScope | 同为"前端 + 执行后端"结构 | 同上，作架构参考 |
| **jtydhr88/ComfyArt** | 584 | 画布跑在**本地 ComfyUI** 上；**MCP server 一等公民**（`POST /comfyart/mcp`，agent 直接看画布/操作） | 与"让 Agent 直接处理资产"高度同构 | **借鉴其 MCP 工具面设计**；不能当底座（绑本地 GPU） |
| **InvokeAI** | 29.1k | Python 后端 + React 前端；统一画布（图层/蒙版/局部重绘/outpaint）、本地画廊、工作流 | 图像编辑交互的成熟度远超我们，但本地模型、无 API 网关概念 | **借鉴统一画布交互**；不做底座 |
| **ComfyUI**（+ 官方 Comfy MCP） | ~100k | 节点图执行 + 本地文件系统 + MCP 让 agent 驱动 | 节点生态最强、资产天然在磁盘；但要求本地 GPU | **借鉴节点图/工具面**；不作为运行时（solgrid 是云 API） |
| **tldraw** | 51.5k | 画布 SDK（source-available，**非 MIT，生产需商业授权**，可能带水印） | 引擎极强，但要重写节点/媒体/编辑器面板，还要付授权费 | 引擎升级的备选，**现在不动** |
| **obsidianmd/jsoncanvas** | 3.8k | 只是一份**开放文件格式**（JSON Canvas 1.0，可自由实现） | 天作之合：画布文档落盘 + Agent/编辑器都能直接读（Obsidian 生态已有 skill） | **采用为落盘格式**（见 §5.4） |
| **OpenCut / Remotion / Etro** | — | 时间线视频编辑器 / 代码化视频 | 解决成片渲染，不解决画布 | 只作为导出侧的参考 |

三条可复用的结论：
1. **"画布 + 本地文件资产 + MCP/Agent 一等公民"已被 ComfyArt 验证**；它和我们要做的是同一件事，只是它把执行层放在本地 ComfyUI，我们放在 solgrid 云端。
2. **同源 fork 里已经有人把后端补上了**（Go / FastAPI）——说明"纯前端"是上游的取舍，不是这条路线的必然。我们的 daemon（§4）与它们同构，但多了"solgrid 队列/幂等/成本账本"这层平台特化。
3. **前端交互不缺底座，缺的是编辑层与时间线**（§5.9）。

> 不建议的选项：把 tigerowo 或 hero8152 的仓库拿来合。它们与上游已经分叉（各自加了 Go/FastAPI 后端与大量自有功能），合并冲突成本高于自己写服务端，且要继承别人的 roadmap 与品牌条款。正确姿势是**以上游为基线，把它们的后端当作架构参考**。

---

## 4. 目标架构

```
┌─────────────────────────────────────────────────────────────────┐
│  浏览器（Vite/React/antd/Tailwind/Zustand，来自上游 web/）       │
│  画布 / 节点 / 时间线 / 成本面板 / 运行列表 / 「在 Agent 中运行」 │
└───────────────▲───────────────────────────────┬─────────────────┘
                │ SSE: doc patch / run 状态 / 成本  │ HTTP: ops / run / stop / export
                │（token 鉴权，Origin 白名单）      │
┌───────────────┴───────────────────────────────▼─────────────────┐
│  canvas daemon（Node ≥22，仅监听 127.0.0.1）                      │
│  ┌──────────────┬──────────────┬──────────────┬───────────────┐ │
│  │ Doc Store    │ Run Engine   │ Asset Store  │ Composition   │ │
│  │ 文档+op log  │ 单队列+幂等  │ 内容寻址落地 │ 时间线/导出   │ │
│  └──────────────┴──────┬───────┴──────┬───────┴───────────────┘ │
│  ┌─────────────────────▼──────────────▼───────────────────────┐ │
│  │ Gateway 适配层：catalog 缓存(inspect) / family 归一化 / CLI │ │
│  └─────────────────────┬──────────────────────────────────────┘ │
│  ┌─────────────────────▼──────────────────────────────────────┐ │
│  │ Agent Bridge：ACP client（@agentclientprotocol/sdk）        │ │
│  │   + MCP server（canvas-mcp 注入 ACP session）               │ │
│  └─────────────────────┬──────────────────────────────────────┘ │
└──────┬───────────────────────────────────┬──────────────────────┘
       │ 子进程（复用本机已配置凭证）        │ ACP / stdio JSON-RPC
┌──────▼─────────────┐          ┌──────────▼──────────────────────┐
│ solgrid CLI        │          │ ACP 适配器                       │
│ ~/.config/solgrid  │          │ dsh --profile acp               │
│                    │          │ claude-code-acp / codex-acp     │
└──────┬─────────────┘          └──────────┬──────────────────────┘
       │ HTTPS                             │ 同一会话内反向调 MCP
┌──────▼───────────────────────────────────▼──────────────────────┐
│ api.solgrid.ai（runs / files / tool catalog）                    │
└─────────────────────────────────────────────────────────────────┘
```

> 凭证只存在于两个地方：`solgrid` CLI 进程（媒体生成）与 ACP 适配器进程（语言模型）。daemon 与浏览器都不持有。

**三条铁律**

1. **文档单一事实源在 daemon**。UI 与 Agent 都是客户端，都走同一套 op 接口，都有 revision 检查。这样"用户在画布上拖一下"和"Agent apply_ops 建 20 个节点"是同一件事，SSE 广播给所有端。
2. **只有 daemon 能发起付费调用**。Agent 想生成，必须调 `canvas_run_nodes`，由队列统一排队、估价、确认、执行、记账。
3. **产物先落地再进画布**。节点永远引用本地 `asset://<sha256>`，远端 URL 只作为 provenance 记录。

**三条主数据流**

- **用户点 Run**：UI `POST /runs` → 队列估价 →（超阈值则弹确认）→ 排队 → 提交 CLI → 轮询 → 下载落地 → 更新节点 + 广播。
- **Agent 操作**：Agent 调 MCP `canvas_apply_ops`（建节点/连线）→ daemon 校验 revision → 落库 + 广播 → Agent 调 `canvas_run_nodes`（带预算上限）→ 同上排队。
- **技能运行**（拉片）：UI 选中视频节点 →「在 Agent 中运行 skill」→ daemon 用 ACP `session/prompt` 把任务说明（节点上下文 + 技能 slug + 产出契约）送进 Agent 会话（`mcpServers` 已注入 canvas-mcp）→ Agent 自己抽帧/分析（产物写进项目 workspace）→ 用 `canvas_import_local` + `canvas_place_artifacts` 把产物落回画布 → 流式过程回显在侧栏。

---

## 5. 子系统设计

### 5.1 文档与操作模型

不复用 WebDAV、不做 CRDT（单机单用户，CRDT 是纯成本）。

```ts
// packages/shared/src/doc.ts（zod）
Node = {
  id, projectId, type: 'text'|'image'|'video'|'audio'|'gen'|'skill'|'timeline'|'group',
  x, y, w, h, z, parentId?,
  title?, text?,            // text 节点
  assetId?,                 // image/video/audio 节点
  gen?: { provider, endpoint, model, params, inputs: EdgeRef[] },  // 生成节点
  meta?: Record<string, unknown>,  // 插件的自由区（拉片结果、播放头等）
  rev
}
Edge = { id, from: nodeId, to: nodeId, role: 'prompt'|'image'|'first_frame'|'last_frame'|'reference'|'audio'|'video' }
Doc  = { id, title, nodes, edges, viewport, rev, updatedAt }

Op =
  | { type:'add_node', node } | { type:'update_node', id, patch }
  | { type:'remove_nodes', ids } | { type:'add_edge', edge } | { type:'remove_edges', ids }
  | { type:'move_nodes', ids, dx, dy }                    // 批量位移
  | { type:'group', ids, title }                          // 打组，技能产出用
  | { type:'set_viewport', viewport }
```

- **op 原子批量 + `expectRev`**：Agent 一次 apply 一批 op，要么全成要么全不成；rev 不匹配返回 `REV_CONFLICT` + 最新 rev，Agent 重读再改。
- **Agent 的 op 归为一个 transaction**，撤销时一次撤掉（"撤销 Agent 这一步"比"撤销 20 次"符合直觉）。
- **undo**：op log 存逆操作，保留最近 200 步；不做多端协同合并。
- **多标签页**：SSE 按 `projectId` 订阅，其他页只读更新；编辑页独占 `editorToken`（上游 `canvas-agent` 已有 tab 隔离经验）。
- **插件状态**放 `meta`，核心 schema 不认识也不丢（序列化原样带回）。

### 5.2 运行引擎（本方案的核心）

```
enqueue(nodeIds, {budgetSpark, confirmToken})
  → 估价（inspect 价格 × 参数，见 5.3）
  → 校验确认（估价 > 免确认阈值 → 必须先有 confirmToken）
  → 生成 idempotencyKey 并写 runs 表（status=queued）   ← 落盘先于任何网络
  → 全局队列（默认单 worker）
     → 取队首 → status=submitting
     → `solgrid run -p P -e E -i body.json --json`（不加 --wait）
        · 网络层/5xx/504/429 → `solgrid runs get --idempotency-key K`
          - 命中 → 复用该 runId
          - 404  → 才允许重提（同 K）
     → status=running，按 2s→8s 退避轮询 `solgrid runs get -r R --json`
     → COMPLETED：下载产物 → 资产落地 → 更新节点 → 记账 cost → 广播
     → FAILED/BLOCKED/TIMED_OUT/STOPPED：记 error，节点置失败（可手动重试，新 K）
     → UNCONFIRMED/automaticPollingStopped：标记"结果未知"，不自动重提；给用户"查这个 run / 换 key 重跑"两个按钮
  → 队列空 → 退出 worker
```

关键实现点：

- **单 worker 是默认，不是写死**：`maxInflight` 可配（默认 1，遵循账号级约束）。未来平台放开，改成 `maxInflight=N` + provider 分道即可，队列语义不变。
- **提交前 jitter**（借鉴旧 fork 脚本的 0–2s 抖动，见 `notes/`），避免多画布同时唤醒撞车。
- **僵尸 run 自愈**：`running` 超过阈值且队列仍有等待项 → 若 run 可 stop 则 `runs stop -r`，标记 `zombie` 后放行队列；不可 stop 则报错让人决定。
- **取消**：`POST /runs/:id/cancel` → 可 stop 则 stop；网页关掉不取消（daemon 继续），符合"长视频慢慢跑"。
- **成本记账**：每 run 存 `estimatedSpark / reservedSpark / costSpark / billingStatus`，画布右下角常驻"本项目累计花费 + 在途预留"。这是产品的差异化卖点：**可审计的生成账本**。
- **预算护栏**：`balance` 缓存 60s；提交前若 `estimated > balance - inflightReserved` 直接拒；`422 daily_budget_exceeded` 不是失败而是 `status=parked, retryAfter=60s±jitter`，最多 N 次后转 `failed` 并给出人话解释（日预算、预留、剩余）。
- **崩溃恢复**：启动扫描 `status ∈ {submitting, running}` → 有 `remoteRunId` 就续轮询，只有 `idempotencyKey` 就 lookup，都没有就重提（幂等）。

#### 5.2.1 最小实现：哪些能砍，哪些不能

"能不能不搞这么复杂"是合理质疑。答案是**能砍掉一半，但有三件事砍不掉**——它们不是设计洁癖，是 `solgrid run` 这两条命令的固有语义。

**不可砍（各一行代码量级，砍了必出事故）**

| 项 | 为什么砍不掉 | 证据 |
|---|---|---|
| **单点串行** | `solgrid run` 是"提交即返回 runId"，只要两个节点同时提交就是两个并发 run；平台账号级只允许 1 个在途 | 旧 fork 实测（`notes/solgrid-findings.md`）：3 并发 → 1 个 `tool_service_unavailable` + 2 个 `500 code 99999`，并留僵尸 RUNNING 占死槽位 |
| **自己的 `--idempotency-key`** | 进程崩溃/超时后，stdout 里的 runId 丢了；只有自己生成的 key 能在重启后用 `runs get --idempotency-key` 找回那一笔（钱已经花了） | CLI 支持 `--idempotency-key`；错误返回里也带 key |
| **runId 落盘 + 不带 `--wait`** | 图片同步 46–60s、视频可达 30 分钟；`--wait` 会把连接挂住，且刷页面就丢 | 旧 fork 的直接后果：`pluginVideoExpired`，节点报废只能重跑 |

**可砍（先不做，不影响正确性）**

| 项 | 极简替代 | 什么时候补 |
|---|---|---|
| `maxInflight` 配置 / provider 分道 | 写死串行 | 平台放开并发时（先用两次最便宜 run 探测，约 $0.07） |
| 估价拦截 / 预算护栏 | 只显示参考价 + 事后记 `cost` | Agent 开始批量跑的时候（平台规则要求 agent 每次确认） |
| 僵尸自愈策略 | "超过 30 分钟标红 + 一键 stop" | 用户抱怨卡住时 |
| catalog 全量缓存 | 只缓存最近用过的 20 个 endpoint | 模型多起来之后 |
| 成本面板 / 报表 | 先只存 `cost` 字段 | M1 之后 |

极简版核心（约 150–200 行）：

```ts
// 提交：注意 Windows 上绝不要内联 JSON（cmd/PowerShell 引号会炸），一律 -f
const out = await exec("solgrid", ["run", "-p", r.provider, "-e", r.endpoint,
  "-f", bodyPath, "--idempotency-key", r.key, "-j"]);   // 不带 --wait
r.remoteId = pickRunId(out);   // 拿到 runId 就返回，别等结果
await save(r);                 // 先落盘，再轮询
// 轮询
const res = await exec("solgrid", ["runs", "get", "-r", r.remoteId, "-j"]);
// COMPLETED → 下载产物 → assetId；FAILED/uncertain → 标记，不自动重提
```

> 复杂度总量是守恒的：旧 fork 把这段逻辑塞在浏览器里（jitter 排队、让路、stop 自救、内存 Map），代码更脏且刷新即废。搬到 daemon 反而是**减法**。但"极简版"确实可以只做上面三件不可砍的事。

### 5.3 模型适配层（取代 per-model 脚本）

**目录驱动**：

1. `solgrid tools list -q <关键词> --json` 建立候选表；`solgrid inspect -p <provider> -e <endpoint> --json` 拿到 `input.body/queryParams/pathParams` 的 JSON Schema + `price`。
2. 结果按 `(provider, endpoint)` 缓存进 SQLite，TTL 24h，`--force` 可刷；缓存未命中时 UI 显示"加载中"而不是报错。
3. 参数表单由 schema 驱动（体积小、模型自增无需发版）。

**family 归一化器**（把画布语义映射到 provider 契约，按 provider family 写 5–8 个，不按模型写）：

| family | 端点特征 | 映射要点 |
|---|---|---|
| `alibaba-dashscope` | `/v1/image/*`、`/v1/video/wan*` | body `{input:{prompt, media[]}, parameters}`；首尾帧 ratio 必须 `adaptive`；`prompt_extend` 不要显式 false |
| `bytedance-seedance` | `/v1/video/seedance-*` | content 数组；`frames`→first/last_frame；`reference`→reference_image；ratio 保持用户值 |
| `kling` | `/image-to-video/kling-*` | 按 Unit 计费，motion control 需图+视频；规则见 inspect 的 oneOf |
| `minimax` | `/v1/t2a_v2`、image | TTS 返回 hex → decode 成音频文件；`voice_setting.voice_id` |
| `openai-compatible` | 自定义中转 | 走上游原有的"自定义调用脚本"逃生舱 |

画布节点统一语义（`prompt / 参考图[] / 首帧 / 尾帧 / 参考视频 / 参考音频 / 时长 / 分辨率 / 比例 / 数量 / 生成音频`），归一化器负责"能不能表达 + 不能就明确报错说明换哪个模型"，**绝不静默丢素材**（沿用旧 fork 确立的纪律）。

**数量语义修正**：画布"数量 N" = 入队 N 个 run（不是并发 N 个请求），排队解决，天然不再撞车。

#### 5.3.1 不要把它伪装成 OpenAI 渠道

旧 fork 的做法是（`web/src/lib/solgrid-preset.ts`，已不在本仓库）：造一个 "Solgrid 渠道"，把 15 个模型名硬编码进去，每个模型再绑一份调用脚本做翻译。这才是"平台改模型列表画布要跟着改"的根源——**不是画布需要知道模型，而是它被迫把 solgrid 塞进"OpenAI 兼容渠道"这个抽象里**。

正确做法：给画布引入一等公民「平台任务」，节点里存的是**调用坐标**，不是模型名：

```jsonc
// node.gen —— 没有渠道、没有 baseUrl、没有 API key
{
  "provider": "alibaba",
  "endpoint": "/v1/image/qwen-image-3.0",
  "params": { "prompt": "…", "size": "1024*1024", "n": 1 },
  "refs":  { "image": ["asset:sha256-…"] }
}
```

`{provider, endpoint}` + `params` 就是 `solgrid run -p … -e … -f …` 的全部输入，画布只是把这些字段收集起来。于是：

- **模型清单不用发版**：UI 的模型选择器读 catalog 缓存（`tools`/`inspect`），平台新增模型，刷新即出现。
- **参数表单不用手写**：`inspect` 的 JSON Schema 直接驱动表单。
- **不需要渠道配置**：key 在 CLI 里，画布凭 "solgrid CLI 已登录" 就能跑。

**解耦的边界（诚实版）**：语义映射没法做到 100% 自动。

| 平台变化 | 画布要不要改 | 机制 |
|---|---|---|
| 已有家族加新模型 | 不改 | catalog 缓存 + schema 表单 |
| 已有家族改参数/加字段 | 不改 | schema 驱动 |
| 新增一个陌生家族（body 结构不同） | 不改（降级） | 走 **raw JSON 模式**：UI 给一个 body 编辑器，Agent 直接写 `params`；能跑，只是不友好 |
| 想让陌生家族有友好表单 | 加一条 family 映射（半天） | 标 `x-solgrid-family`；映射是"锦上添花"，不是"能不能用"的前提 |

这条边界很重要：**任何新模型从第一天起就能跑（raw JSON 兜底），画布永远不会因为平台发新模型而阻塞**。

### 5.4 资产层

**项目 = 一个目录**，这是解决"浏览器存储慢 + Agent 处理不了资产"的根本办法：

```
<workspace>/projects/<projectId>/
├── project.json          # 项目元信息（标题、画布列表、默认模型、创建时间）
├── canvas.json           # 画布文档，JSON Canvas 1.0（nodes/edges 开放格式，agent 直接读写）
├── assets/
│   ├── <sha256>.png      # 内容寻址，去重
│   ├── <sha256>.mp4
│   └── <sha256>.json     # 资产元信息（来源 provider/endpoint/model/prompt/cost、尺寸、时长、remote_file_id）
├── thumbs/<sha256>.jpg   # 缩略图 / 视频 poster / 音频 peaks
├── runs.sqlite           # run 账本（队列/幂等/成本/恢复）
├── timeline.json         # 时间线（composition）
├── exports/              # 成片、OTIO、manifest.json
└── skills/               # 项目级技能（可选，Agent 从这里加载）
```

- **为什么用 JSON Canvas 1.0**：开放格式（MIT，Obsidian 生态），`{nodes:[{id,type,x,y,width,height,file|text}],edges:[...]}` 语义与我们 90% 重合；Agent 与外部编辑器都能直接读，还能被 Obsidian 打开做人工整理。solgrid 的扩展字段（`gen`、`meta`）放在 `x-solgrid` 命名空间里，保证兼容。
- **不做迁移，一次改到位**：按仓库 `AGENTS.md` 的规则（"项目尚未上线，不需要兼容旧数据；存储结构调整时直接按新设计修改，不写旧字段兼容或数据迁移兜底"），直接把 `node.metadata.content` 的 dataURL 换成 `assetId`，旧的浏览器项目不兼容、不迁移。这既省掉一层迁移代码，也顺手解决了性能根因：文档体积从几十 MB 降到几十 KB。
- 落盘：`assets/<sha256>.<ext>`，元数据进 SQLite + 同名 `.json`；缩略图（图片 /thumb、视频 poster 帧、音频 waveform peaks）按需 ffmpeg 生成并缓存。
- 下载：daemon 服务端拉 OSS 签名 URL（无 CORS 问题），校验 mime/大小/file magic，失败重试 3 次；成功即写入 `asset.remote` 记录 `fileAssetId` + `expiresAt`。
- 续签：`asset` 过期且被引用（导出/再次上传）时 `solgrid files url -i <id>` 刷新，不阻塞 UI。
- 服务：`GET /assets/:id` 支持 `Range`（视频拖进度必需）、`ETag`、`immutable` 缓存头。
- 上传：本地文件 → `solgrid files upload` 拿 `downloadUrl` → 作为生成输入；上传按内容 hash 去重 + 同次调用内并发（旧 fork 实测：9 张串行几分钟，并发后 3~4s），**上传并发数单独限流**（默认 3），不与生成队列抢槽。
- 导入外部素材：拖文件进画布、Agent 产出的本机文件（`canvas_import_local`，路径白名单 = 用户显式选择的文件 + 项目 workspace）。
- **Agent 友好性**：Agent 不需要走画布 API 也能"看资产"——`canvas.json` + `assets/` 就是可读的文件树；反过来 Agent 产的图/帧直接写进 `assets/`，画布 `canvas_import_local` 只是登记一下。这是"Agent 直接处理资产"的落地形态。

### 5.5 时间线与成片（新增）

**模型**：时间线是独立文档（`compositions` 表），不是节点图的子集。

```ts
Composition = {
  id, projectId, title, fps: 30, size: {w,h},
  tracks: [
    { id, kind:'video'|'overlay'|'text'|'audio', clips: [
        { id, assetId, inMs, outMs, startMs, speed, transitionIn?: {type:'cut'|'fade', ms} }
    ]}
  ],
  subtitleTrack?: { id, cues: [{ startMs, endMs, text }] }
}
```

- **图 → 时间线**是显式动作（"把选中的视频节点铺到时间线"），不做全自动猜测；生成节点永远可以"重抽一版"后替换 clip。
- **预览**：HTML5 `<video>` + 播放头；只解码播放头附近片段（LRU 3 个 video 元素），转场处双元素交叉淡化。**不做**浏览器全片解码（长视频必卡）。
- **导出**（daemon，需 ffmpeg，检测不到就降级）：
  - 同规格单轨 → concat demuxer（最快，无重编码）
  - 有转场/混合规格 → `filter_complex`（xfade/scale/fps 统一 + amix）
  - 字幕 → 生成 ASS 烧录，或作为软字幕轨道
  - 同时导出 **EDL / OTIO / FCPXML** 给 DaVinci / Premiere（专业用户的真实去向）
  - 每次导出产出 `manifest.json`（素材来源、模型、prompt、cost），随片交付
- ffmpeg 是**可选依赖**：无 ffmpeg 时禁用时间线导出与视频 poster，明确提示安装命令，不静默降级。

**片段重新生成（clip-level regen）**——这是"视频节点可以片段重新生成"的落地方式：

```
时间线切片(assetId + inMs/outMs, ±0.5s 上下文)
  → 生成方式三选一：
     a. 首尾帧续拍：抽 in/out 两帧 → wan2.7-i2v（first_clip / 首尾帧）
     b. 视频编辑：整段送 wan2.7-videoedit（恰好 1 个待编辑视频 + ≤4 参考图，2–10s）只改这一段
     c. 关键帧重绘 + 图生视频：先改帧，再 i2v
  → 新 clip 落 assets/，保留原 clip 作"上一版"（可对比、可回退）
  → 时间线标记 clip.version，导出取当前版本
```

不做"整片重生成再对齐"——长视频那是灾难。片段级重生成必须**保持时间码不变**，因此预览用双 clip 替换 + 音轨不动。

### 5.6 Agent 与技能

**两条方向，两个协议**——这是"复用本地 Agent"的真正答案：

| 方向 | 协议 | 画布的角色 | 解决的问题 |
|---|---|---|---|
| 画布 → Agent | **ACP**（Agent Client Protocol） | **client** | 借 Agent 的模型、凭证、工具、技能，**不读任何配置** |
| Agent → 画布 | **MCP** | **server** | Agent 读写节点、估价、跑生成、落产物 |

两个方向由 ACP 的一个机制缝合：**`session/new` 接受 `mcpServers` 参数**，画布在建立 ACP 会话时把自己的 `canvas-mcp`（stdio 或 Streamable HTTP）注入进去。于是 Agent 一进会话就同时拥有"自己的模型"和"画布工具"，画布不需要给任何 Agent 写定制适配层。

- `solgrid-canvas`：起 daemon + 打开画布；同时是 ACP client 宿主（拉起适配器进程）。
- `solgrid-canvas mcp`：stdio MCP server（薄壳，转发给运行中的 daemon；daemon 没起来就先拉起来）。
- `solgrid-canvas` CLI：`sc state / sc ops -f / sc run / sc wait / sc place`，给不支持 ACP/MCP 的 Agent 或脚本兜底。
- 安装器：`solgrid-canvas install --agent claude|codex|dsh|gemini` 只做两件事——把 ACP 适配器命令写进配置、装 canvas 技能包（`skills/solgrid-canvas/SKILL.md`）。**不写 baseUrl、不碰 key**。

**MCP 工具清单**（控制在 12 个以内，批量优先；旧 fork 的教训是工具太多会污染上下文）：

| 工具 | 作用 | 要点 |
|---|---|---|
| `canvas_get_state` | 读当前画布 | 支持 `selectionOnly` / `depth` / `includeParams`，默认精简 |
| `canvas_get_node` | 读单节点详情 | 含上游连线与生成历史 |
| `canvas_apply_ops` | 批量改画布 | `expectRev`；返回新 rev + 变更摘要 |
| `canvas_place_artifacts` | 批量落地产物 | `anchor + layout: right-cols / grid / row`，自动避让、自动连线、自动打组（拉片核心） |
| `canvas_import_local` | 本机文件 → 节点 | 路径白名单；返回 assetId |
| `canvas_estimate` | 估价 | 返回 Spark/USD/计费口径，**不花钱** |
| `canvas_run_nodes` | 入队生成 | 声明有副作用 → 走 ACP `request_permission`；非 ACP 通道用 `confirmToken`；`maxCostSpark` 超限直接拒 |
| `canvas_watch` | 等结果 | 长轮询到超时，返回状态/成本/产物 |
| `canvas_cancel` | 取消 | 复用 run stop 语义 |
| `canvas_compose` | 图 → 时间线 | 选节点、顺序、转场 |
| `canvas_export` | 导出 | `png / zip / mp4 / otio / fcpxml / manifest` |
| `canvas_skill_context` | 生成技能运行上下文 | 给 Agent 一段结构化任务说明（节点 + 技能 slug + 产出契约 + 布点规则） |

**技能运行模型**（这是与上游"把能力写进插件"最大的差别）：

- **Agent 执行态（唯一形态，v1）**：技能 = 用户 Agent 里已有的 `SKILL.md`。画布只提供 `canvas_skill_context`（把视频节点、产物清单、布点约束整理成一段可执行上下文）+ `canvas_import_local` + `canvas_place_artifacts`。跑法有两种：① 用户在画布点「在 Agent 中运行」→ daemon 直接用 ACP `session/prompt` 把上下文送进会话，流式回显在侧栏；② 用户在 dsh / codex 里说"对画布上那个视频拉片"→ Agent 通过自己已有的 canvas MCP 工具读画布再执行。
  → 直接满足"复用本地 Agent 已配置好的 skill"，技能升级不需要画布发版。
- **不做内置管道（至少 v1 不做）**：放弃 fork 的 lapian 插件代码后，拉片能力完全由技能承担。若后续要"不想开 Agent 也能拉片"，按 `notes/lapian-methodology.md` 重做成一个**轻量插件**（抽帧 + 拼图在浏览器、分析走 ACP 短 turn），而不是搬回旧代码——旧代码依赖宿主 SDK 打补丁（`GenerateTextOptions.images`），不划算。

**产出契约**（技能声明的产物，画布负责落地与布点）：`{ kind: image|text|video|audio, role: keyframe|subject|overview|style|motion|shotlist|prompt, title, payload }` → `canvas_place_artifacts` 按 `role` 决定列位（图列在左、文本列在右），与源节点连线，整体打组。

**LLM 配置复用（README ③）**——三级，默认零配置：

| 级别 | 做法 | 说明 |
|---|---|---|
| **① ACP 借模型（默认）** | 凭证、路由、模型清单全部留在 Agent 进程里；画布只发 prompt、收流 | 连配置文件都不用读。"复用"是结构性的：Claude 订阅、Codex ChatGPT 登录、DSH 的 provider 配置都天然生效 |
| **② ACP 短 turn 借结构化能力** | 需要一次小调用（提示词优化、图片打标、参数建议）也走一个短 ACP turn，约定 JSON 输出 | 不为微调用单独接一套 API；代价是延迟与 token 略高，可接受 |
| **③ 降级：openai-compatible 直连** | 仅当用户显式配置时启用 | 给"不想起 Agent"的用户，以及批量高并发微调用 |

**明确不做**：读 `~/.codex/config.toml` / `~/.claude/settings.json` / `~/.dsh/profiles/*` 反推模型与凭证。理由：拿得到 baseUrl 与模型名，**拿不到 OAuth / 订阅凭证**（那才是用户真正"已配置好"的东西）；格式私有且随版本变；而 ACP 已经把这件事标准化了。上一版方案写"能读就读"，是错的方向，已删除。

> 原则升级：**画布不持有任何模型凭证，只持有 ACP 会话。** 模型的增删、切档、额度，全部由 Agent 侧决定，画布 UI 只是把 Agent 公布的选项渲染出来。

**ACP ↔ 画布概念映射**：

| ACP 调用 | 画布里的用法 |
|---|---|
| `initialize` | 握手，读 Agent 声明的能力（图片提示词、HTTP MCP、`session/list` 等），据此决定功能降级 |
| `authenticate` | 无需（凭证在 Agent 进程内） |
| `session/new { cwd, mcpServers }` | `cwd` = 项目 workspace（单 workspace，见下）；注入 `canvas-mcp`；返回的 `sessionId` 存进项目行 |
| `session/set_config_option` | `model` / `reasoning_effort`：画布模型下拉的选项**来自 Agent 的模型目录**，切档不回落画布 |
| `session/prompt` | 「在 Agent 中运行技能」与侧栏对话的提交入口；图片按附件传，能力不支持时退化为 `resource_link` |
| `session/update` | 映射为画布 SSE：`agent.message` / `agent.thought` / `agent.tool` / `agent.usage`，侧栏渲染过程时间线 |
| `session/request_permission` | **映射为花费确认弹窗**：`canvas_run_nodes` 声明有副作用 → Agent 触发审批 → 用户点「允许本次 ≤ N Spark」→ 回 granted |
| `session/cancel` | 停止按钮（与 run 取消分开：取消 Agent 的 turn ≠ 取消已提交的生成） |
| `session/list` / `resume` / `close` | 项目级会话生命周期；重启画布后可 resume 同一个 Agent 会话 |
| （不实现）客户端 fs / terminal / elicitation | 画布不提供，Agent 用自己的工具在工作区里操作；产物用 `resource_link` + `canvas_import_local` 交换路径 |

**适配器矩阵**（2026-11 实况）：

| Agent | ACP 入口 | 状态 |
|---|---|---|
| **DSH** | `dsh --profile acp`（包 `@deepseek-ai/dsh-acp`） | **官方已具备**，标准 ACP v1；桌面版调起方式待实测（见 §9 风险表） |
| Claude Code | `npx -y @zed-industries/claude-code-acp` | 公开 npm（v0.16.x），复用 Claude 登录/订阅 |
| Codex | `npx -y @agentclientprotocol/codex-acp`（`@zed-industries/codex-acp` 已弃用并迁移） | 亦可回退上游 `canvas-agent` 已验证的 `codex app-server --stdio` |
| Gemini CLI / Goose / Qwen Code / Cursor CLI | 各自 `--acp` 或对应 ACP 包 | 逐个探测；`initialize` 自描述能力，画布按能力降级 |
| 无 ACP 的 Agent | — | CLI + MCP + 剪贴板上下文兜底（保证"MCP 那条腿"永远可用） |

DSH 的 ACP 能力（读自安装包内 `@deepseek-ai/dsh-acp/README`）：标准 ACP v1，外加 `session/list` / `resume` / `close`、`session/set_config_option`（`model`、`reasoning_effort`，选项来自实时 LLM 目录）、stdio 与 Streamable HTTP 两种 MCP 注入、`request_permission`、光栅图片提示词（受持久附件存储与确切路由能力约束）。**已知边界**：不实现 ACP 客户端文件系统/终端/elicitation，不支持 `session/load`、fork、附加目录、SSE 传输 MCP —— 所以画布**不能依赖 ACP fs 能力**，一个项目只能对应一个 workspace 目录。

**代码形态**：daemon 只实现一个 ACP client（`@agentclientprotocol/sdk`，Apache-2.0，v1.x），新增一种 Agent = 配置里加一行命令；不再为每个 Agent 手写 JSON-RPC 适配（上游 `canvas-agent` 就是反面教材：为 Codex 写了一套 app-server 事件映射）。旧的 `codex app-server` 路径保留为 legacy runtime，跑通 ACP 后即可下线。

### 5.7 安全与隐私

- 只监听 `127.0.0.1`；随机端口；每次启动生成一次性 `connectToken`，写 `~/.solgrid-canvas/agent.json`（0600）。
- Origin 白名单：首次带 token 连接后钉住 Origin（上游 `canvas-agent` 已验证该策略），其他页面复用需用户手动清。
- **API Key 永不进浏览器、永不进日志、永不进画布项目文件**；daemon 只通过 CLI 进程使用凭证，且日志脱敏（token/key/dataURL 全遮）。
- `canvas_import_local` 只允许：用户在 UI 显式选择过的路径 + 项目 workspace 目录；拒绝 `~/.ssh`、`~/.config` 等敏感根。
- 每次付费调用必须过 `confirmToken`（用户在画布点过"允许 ≤ N Spark"）或 CLI 显式 `--yes`；Agent 无 token 时只能估价。
- 导出/上报不含 key；`manifest.json` 只含 provider/endpoint/model/params/cost。

### 5.9 功能补齐清单（你提的两类问题落在这里）

先纠正一个事实：**"原地裁剪/缩放"上游里其实已经有了**——`web/src/components/canvas/canvas-node-crop-dialog.tsx`（拖拽 + 8 手柄 + 比例预设 + 缩放）、`canvas-node-split-dialog.tsx`（切分）、`canvas-node-upscale-dialog.tsx`、`canvas-node-angle-dialog.tsx`、`canvas-image-toolbar-tools.tsx`（含**反推提示词** `reversePrompt`）。真正缺的是下面四项：

| 需求 | 现状（源码级核对） | 方案 | 依赖 | 估时 |
|---|---|---|---|---|
| **提示词优化** | 全仓无实现（只有反推提示词） | 节点面板加「优化」按钮 → ACP 短 turn（把节点 prompt + 上游参考图 + 模型能力作为上下文，返回 1–3 个候选 + 直方图式差异说明）；批量优化走一个 turn 处理多节点 | ACP（§5.6） | 3–5 天 |
| **局部重绘（真 inpaint）** | 有蒙版绘制对话框，但实现是"把蒙版当**第二张参考图** + 提示词让它只改蒙版区"（`project.tsx` `maskEditImageNode`），伪 inpaint，效果不可控 | **方案 A（今天就能做）**：mask → bbox → 扩边上下文裁剪 → edit 模型只对这块重绘 → 与原图羽化回贴 → 生成新 asset（保留原始 asset 与 edit 栈，非破坏性）。**方案 B（更好）**：平台接带 mask 的 edit 端点，我们只透传 | 平台无 mask 端点（§2 第 9 条） | A：1 周；B：等平台 |
| **原地编辑体验** | 有对话框，但都是"弹窗模态 + 生成新节点"，不是"画布内非破坏编辑" | 改成非破坏性编辑栈：`asset + edits[]`（crop/scale/rotate/upscale/paint），随时可回退、可导出；画布内浮动工具条直接改，不弹大模态 | — | 1.5 周 |
| **视频片段重生成** | 无时间线，无从谈起 | 先有 §5.5 的 composition，再做 clip 级重生成（三条生成路径见 §5.5）；保留 `clip.version` 可对比可回退 | 时间线 + `wan2.7-videoedit` / `i2v` | 1 周（含在 M4） |

另外两项"看起来像功能缺失、其实是架构问题"的：

| 症状 | 真实原因 | 修法 |
|---|---|---|
| 项目一大就卡 | ① 图片/视频以 **dataURL 内联在 `node.metadata.content`**，整个文档随每次 `setNodes` 序列化写 localforage；② 无视口裁剪，几千节点全量渲染 | ① `assetId` 引用（§5.4）；② 视口虚拟化 + 增量 op（§5.1）；③ 缩略图分级（低清先出） |
| Agent 处理不了资产 | 资产在浏览器 IndexedDB 里，Agent 拿不到 | 项目 = 目录 + JSON Canvas（§5.4），Agent 直接读写文件 |

---

## 6. 技术栈与仓库结构

**栈**：Node ≥22（对齐 solgrid-cli 要求，本机 v24）· TypeScript · pnpm workspace · 前端沿用上游（Vite + React 19 + antd 6 + Tailwind 4 + Zustand + localforage）· daemon：Hono（轻、SSE 友好）+ better-sqlite3（WAL）· MCP：`@modelcontextprotocol/sdk` + zod · 媒体：ffmpeg（可选，本机已有 9.0.2）· 测试：vitest + 假网关（录制 fixtures）。

```
solgrid-canvas/            # = 上游 v0.20.0 基线 + 我们的增量
├── web/                   # 上游：画布、节点、面板；本项目改造存储与模型解耦
├── canvas-agent/          # 上游：本地 Agent 雏形；改造成 ACP client + canvas-mcp
├── plugins/canvas/        # 上游：sdk / registry / 官方插件；新增时间线节点、分镜表
├── daemon/                # 新增（本方案核心，独立于 web 构建）
│   ├── src/server.ts      # HTTP + SSE + token/origin
│   ├── src/doc-store.ts   # 文档 + op log + undo
│   ├── src/run-engine/    # 串行队列、幂等、恢复、记账
│   ├── src/assets/        # 落地、缩略图、Range 服务
│   ├── src/compose/       # 时间线、ffmpeg 导出、OTIO
│   ├── src/agent/         # ACP client + MCP server 注入 + 会话管理
│   └── migrations/*.sql
├── packages/              # 新增
│   ├── shared/            # zod：doc/op/run/compose/api 契约（前后端唯一真相）
│   ├── gateway/           # solgrid CLI 封装 + catalog 缓存 + family 归一化器
│   └── mcp/               # stdio MCP server（薄壳）
├── skills/solgrid-canvas/ # 随包分发的 Agent 技能包（拉片等技能包装）
├── notes/                 # 从 fork 移植的实测知识（不参与构建）
│   ├── solgrid-findings.md
│   └── lapian-methodology.md
├── docs/                  # 上游 fumadocs 文档站（保留可用，内容按本项目管理）
├── AGENTS.md              # **本项目自有的开发约束**（九条架构铁律 + 前端/daemon/文档规范，已不继承上游）
└── REQUIREMENTS.md / TECH_PLAN.md
```

**工程纪律**：以本项目 `AGENTS.md` 为准——最小改动、不写兼容层、不改无关文件、改边界值先确认、"写完不代为构建"、`CHANGELOG` 流程。上游原有规范不再约束本项目；只保留 MIT 许可证义务（署名与许可声明）。

---

## 7. 接口契约（草案）

### 7.1 REST（daemon）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 版本、solgrid CLI 状态、ffmpeg 状态、队列深度 |
| GET | `/projects` / `/projects/:id` | 项目与文档 |
| POST | `/projects/:id/ops` | `{ops[], expectRev, origin}` → `{rev, applied}` |
| GET | `/projects/:id/events` | SSE：`doc.patch` / `run.update` / `cost.update` / `agent.event` |
| POST | `/runs/estimate` | `{nodeId, overrides}` → Spark/USD/口径 |
| POST | `/runs` | `{nodeIds[], maxCostSpark, confirmToken}` → runIds |
| GET | `/runs?projectId=` | 运行列表（含成本、状态、错误） |
| POST | `/runs/:id/cancel` | 可 stop 则 stop |
| GET/POST | `/assets/:id`、`/assets/upload` | Range 服务 / 本机文件导入 |
| POST | `/compose`、`/export` | 图 → 时间线；导出（异步 job + SSE 进度） |
| POST | `/agent/sessions`、`/agent/sessions/:id/turns` | 嵌入面板（可选） |

### 7.2 SQL（要点）

```sql
CREATE TABLE projects(id TEXT PK, title TEXT, doc_json TEXT, rev INT, updated_at INT);
CREATE TABLE ops(seq INTEGER PK AUTOINCREMENT, project_id TEXT, ts INT, origin TEXT, payload TEXT);
CREATE TABLE assets(id TEXT PK, sha256 TEXT UNIQUE, kind TEXT, mime TEXT, bytes INT,
                    w INT, h INT, duration_ms INT, remote_file_id TEXT,
                    remote_expires_at INT, created_at INT);
CREATE TABLE runs(id TEXT PK, project_id TEXT, node_id TEXT, provider TEXT, endpoint TEXT,
                  model TEXT, input_json TEXT, idempotency_key TEXT UNIQUE,
                  remote_run_id TEXT, status TEXT, estimated_spark REAL,
                  reserved_spark REAL, cost_spark REAL, billing_status TEXT,
                  error_code TEXT, error_msg TEXT, retry_after INT,
                  created_at INT, started_at INT, finished_at INT);
CREATE TABLE compositions(id TEXT PK, project_id TEXT, json TEXT, updated_at INT);
```

`runs.idempotency_key` 唯一索引是防重复扣费的最后一道闸。

### 7.3 `canvas_place_artifacts` 布局规则

```jsonc
{
  "anchorNodeId": "n_video_1",
  "layout": "right-cols",
  "items": [
    { "role": "keyframe", "kind": "image", "path": "C:/…/frame_01.jpg", "title": "关键帧 1" },
    { "role": "shotlist", "kind": "text", "text": "分镜表…", "title": "分镜表" }
  ]
}
```

规则：列宽 = 320 / 640（文本/图片），列间距 80，行间距 40；以 anchor 右边缘 + 120 为第一列起点；与已有节点 bbox 冲突时整体下移一档；每个产物与 anchor 连线（`reference`），整组 `group`；返回 `{ nodeIds, groupId, rev }`。**布点必须由 daemon 算**，不能靠 Agent 猜坐标（Agent 猜坐标 = 重叠灾难）。

---

## 8. 里程碑

| 期 | 内容 | 验收标准 |
|---|---|---|
| **M0 骨架**（1w） | `AGENTS.md` 已重写为本项目约束；daemon 骨架 + pnpm workspace；web 接上 daemon；doc store + op + SSE；token/Origin；**存储重构为项目目录 + `assetId`（不做数据迁移）** | 两个标签页同步编辑同一画布；刷新不丢；非法 Origin 被拒；项目目录可用文件管理器/Agent 直接看 |
| **M1 单节点闭环**（2w） | 极简运行引擎（§5.2.1 三件不可砍）；catalog 缓存 + schema 表单 + **raw JSON 兜底**；资产落地；成本字段 | 画布点 Run 出图出视频；生成中刷新/重启 daemon 不丢任务；断网重试不重复扣费；**平台上任意一个 endpoint（包括完全陌生的、只填 raw JSON 参数的）都能跑通且不改代码**；500 节点 + 200 资产的项目打开/拖拽不掉帧 |
| **M2 Agent 闭环**（2w） | ACP client + MCP server（12 工具，经 `session/new.mcpServers` 注入）；`install --agent`；codex / claude / dsh 三路走同一个 ACP 实现；`canvas_place_artifacts`；花费确认挂在 `request_permission` 上 | 在 dsh 里说"在这画布上出一个 3 帧分镜"Agent 能建节点并生成；画布侧栏能看 ACP 流式过程；Agent 未经审批无法花钱（permission 弹窗挡住）；画布不持有任何模型凭证 |
| **M3 技能**（2w） | 技能上下文契约；拉片技能包（**仅 Agent 执行态**，不搬旧插件）；随包 SKILL.md | 画布点"在 Agent 中运行拉片"→ 产出自动成组布点；换一个用户自建技能（如"拆解竞品广告"）无需改画布 |
| **M3b 编辑层**（2w） | 提示词优化（ACP 短 turn）；非破坏性编辑栈（crop/scale/rotate/upscale）；局部重绘（bbox 裁剪 + 羽化回贴）；原地浮动工具条替换模态框 | 优化按钮 3 秒内出候选；裁剪/缩放可无限回退；局部重绘效果在一个区域内可接受且不破坏周边；全程不产生重复上传的资产 |
| **M4 时间线成片**（3w） | composition + 预览 + ffmpeg 导出 + OTIO/EDL + manifest；**clip 级片段重生成 + `clip.version`** | 5 分钟多片段成片导出成功；转场正确；DaVinci 能导入 OTIO；导出进度可见可取消；单片段重生成不动其他片段与时间码 |
| **M5 打包发布**（1–2w） | npm 包 `solgrid-canvas`；安装向导；Codex/Claude/DSH 插件与 marketplace；文档与示例项目 | 全新机器：`npx solgrid-canvas` → 三分钟出第一张图；`install --agent` 一键接通 |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 平台 in-flight=1 长期不变 | 批量出图慢（25 帧 × 60s ≈ 25 分钟） | 队列透明化 + 进度可见 + "先低价草稿后精修"策略 + 向平台申请提高并发（架构已可切换 `maxInflight=N`） |
| 同步图片接口 504/520 | 用户以为失败 | 幂等找回 + 状态机 `uncertain` 明确展示，绝不二次扣费 |
| 签名 URL 24h 过期 | 老项目裂图 | 强制落地 + `files url` 续签 + UI 标注"远端引用"的节点 |
| 目录/schema 变更 | 参数表单错乱 | inspect 缓存 TTL + CI 契约测试（复用 `selftest.mjs` 思路，对 fixtures 跑） |
| ffmpeg 不存在 | 时间线导出不可用 | 显式检测 + 安装指引；核心画布不受影响 |
| Agent 烧钱 | 用户流失 | 估价接口 + confirmToken + 单次/单日上限 + 账本可见 |
| 桌面版 DSH 的 ACP 调起方式未验证（`dsh --profile acp` 存在于安装包，bin 在 asar 内） | 嵌入面板对 DSH 暂时不可用 | 先用 MCP 那条腿（DSH 连接器连 canvas-mcp，用户在 DSH 里对话）；M0 期间实测三种调起方式（Electron 跑 `lib/bin.js` / 桌面版是否暴露 ACP 入口 / 让 DSH 侧加 ACP 客户端）；失败则 DSH 走"外部会话 + `canvas_skill_context` 剪贴板"，不影响其他 Agent |
| ACP 协议仍在演进（SDK v1.4，已有 v2 目录） | 适配器行为漂移 | 锁 v1；`initialize` 按能力降级而不是按版本硬编码；CI 里对 `dsh-acp` / `claude-code-acp` 做握手冒烟测试 |
| 只在 ACP 会话里"借模型" → 画布自己的微调用要绕一次 Agent turn | 延迟高、token 贵 | 微调用合并成一次批量 turn + 严格 JSON 输出；高频场景才启用降级直连 |
| 上游 MIT + 二次开发条款（"二次开发与 PR 请保留原作者信息和前端页面标识"） | 合规 | 保留 `LICENSE` 与作者信息；README 致谢；前端页面标识保留或替换为"基于 infinite-canvas"声明，产品名用 solgrid canvas |
| 拉片等 skill 质量依赖 Agent 能力 | 不同 Agent 效果不一 | 技能包内固化方法论（`notes/lapian-methodology.md`）+ 产出契约；v1 不承诺内置管道 |
| 长视频内存/解码 | 预览卡死 | 播放头按需解码；不做全片落地解码；导出在 daemon |
| 平台没有图像 mask inpaint 端点 | "局部重绘"只能做近似 | 客户端 bbox 局部编辑 + 羽化回贴（§5.9 方案 A）先把体验做出来；同时向平台提带 mask 的 edit 端点需求 |
| 存储重构（dataURL → assetId）一次到位、不做迁移 | 旧浏览器项目打不开 | 符合 `AGENTS.md`"未上线不写兼容层"的规则；提前告知使用者"新仓库不兼容旧项目"，需要旧画的自己截图/导出 |
| 上游继续演进（10.5k 星，活跃） | 分叉后无法自动合入上游改进 | **明确不合并**（本项目是 solgrid 特化分支）：需要上游的单个修复时 `git cherry-pick`；`upstream` remote 保留用于取代码。**不为"将来好合并"而牺牲设计** |
| 同源 fork 功能更超前（导演台/全景/Go 后端） | 用户会觉得"为什么不直接用" | 已评估（§3.4）：合并成本高于自建服务端，且要继承他人 roadmap；按需把单个节点能力做成插件补上 |

---

## 10. 需要拍板的三件事

1. **底座（已定）**：以上游 `basketikun/infinite-canvas` v0.20.0（`9cd3dea`）为基线，本仓库已切好（`upstream` remote 已指向 GitHub）。放弃 solgrid fork，其两块改动（solgrid 渠道脚本、拉片插件）都不继承，知识已移植到 `notes/`。已调研 8 个备选（§3.4）：同源 fork 里 tigerowo（Go 后端）/ hero8152（FastAPI 后端）架构更接近目标，但合并成本高于自建服务端；ComfyArt/InvokeAI/ComfyUI 绑本地 GPU，不符合云端 API 的产品模型；tldraw 商业授权；JSON Canvas 只采用为文件格式。
2. **Agent 交互面**：默认"ACP 决定能力上限，MCP 保证下限"。装了 ACP 适配器（dsh / claude / codex）→ 画布内嵌对话面板可用（`session/prompt`，M2 内建）；没装 → 用户在 Agent 侧说话、画布只提供工具与上下文。不再是二选一。
3. **成片导出的下限**：默认"ffmpeg 硬需求 + OTIO/EDL 交付专业用户"。若要求"零依赖也能导出"，需要再加一套 WebCodecs 方案（不建议，长视频不可靠）。

---

## 附：基线与同步

```
上游   https://github.com/basketikun/infinite-canvas.git
基线   v0.20.0 / 9cd3dea（2026-10-25）
本仓库 9cd3dea + 文档提交（REQUIREMENTS.md / TECH_PLAN.md / notes/）
同步   **不合并**；需要上游某个修复时 git cherry-pick <sha>；upstream remote 保留作为代码来源
```

- 旧 fork（`D:\data\github\infinite-canvas`，remote 指向 solgrid GitLab）不再参与构建，仅作参考：其两块增量已在本方案 §3.2 判定放弃，知识落到 `notes/`。
- 本方案的脚本工具 `scripts/asar-read.mjs` 用于从 DSH 安装包里读文档，纯本地、无副作用。

## 附：关键实测依据索引

- 账号级 in-flight=1 / 504 幂等找回 / 数量 N 语义 / 日预算 422 / URL 24h 过期 / 参考图上传并发：`notes/solgrid-findings.md`（移植自 fork 的 `scripts/solgrid/README.md`）
- 抽帧与三轮 vision 流水线、产出布点、刷新不续跑：`notes/lapian-methodology.md`（移植自 fork 的 `plugins/canvas/lapian/SUMMARY.md`）
- 本地 Agent 雏形与 Origin 钉住策略：`canvas-agent/README.md`（上游，基线内）
- 平台命令与凭证位置（`~/.config/solgrid/cli/`）与每次调用价格确认规则：本机 solgrid skill（`C:\Users\rink1\.agents\skills\solgrid`）
- 价格结构实测样例：`solgrid discover -q "video generation" --json`（alibaba wan2.7 METERED 13/19.5 Spark 每秒）
- **ACP 协议与 DSH 侧实现**：安装包内 `@deepseek-ai/dsh-acp`（`dsh --profile acp`，标准 ACP v1 表面、`session/new` 的 `mcpServers` 注入、`set_config_option` 的 model/reasoning_effort、`request_permission`、已知不支持项）；SDK 为 `@agentclientprotocol/sdk@1.4.0`（Apache-2.0）
- ACP 适配器：`@zed-industries/claude-code-acp`（v0.16.x 活跃）、`@agentclientprotocol/codex-acp`（由 `@zed-industries/codex-acp` 迁移而来，旧包已弃用）
- 提取 asar 内文档的小工具：`scripts/asar-read.mjs`（`node scripts/asar-read.mjs <app.asar> --list <kw>` / `--get <path>`）

### 备选底座调研（§3.4）的快照依据

- `basketikun/infinite-canvas` 10,479★（**本仓库基线**）；`tigerowo/infinite-canvas` 1,724★（Go/Gin 后端 + 导演台）；`hero8152/Infinite-Canvas` 3,194★（FastAPI `main.py` 后端）；`jtydhr88/ComfyArt` 584★（本地 ComfyUI + `POST /comfyart/mcp`）；`invoke-ai/InvokeAI` 29,120★（统一画布/局部重绘/本地画廊）；`tldraw/tldraw` 51,487★（**source-available，生产需商业授权**）；`obsidianmd/jsoncanvas` 3,829★（JSON Canvas 1.0 开放格式）。
- star 数为检索时快照，会变；判断依据是架构与许可证，不是星数。

### 功能现状的源码级核对（§5.9）

- 已有：`canvas-node-crop-dialog.tsx`（裁剪/缩放/比例预设）、`canvas-node-split-dialog.tsx`、`canvas-node-upscale-dialog.tsx`、`canvas-node-angle-dialog.tsx`、`canvas-image-toolbar-tools.tsx`（含 `reversePrompt` 反推提示词）。
- 缺失：全仓无"提示词优化"实现；局部重绘是"蒙版当第二张参考图 + 提示词约束"（`pages/canvas/project.tsx` `maskEditImageNode`）。
- 性能根因：图片/视频以 dataURL 存在 `node.metadata.content`，每次 `setNodes` 整文档序列化写 localforage。
- 平台侧：`solgrid inspect -p alibaba -e /v1/image/qwen-image-3.0 --json` 的 body 只有 `image/prompt/size/n`（无 mask）；`solgrid discover -q inpaint` 仅命中 stability 音频 inpaint。

## 11. 实施进度

| 期 | 状态 | 说明 |
|---|---|---|
| **M0** | 基本完成 | daemon（零依赖）+ 项目目录存储（JSON Canvas 1.0）+ 鉴权/Origin 白名单 + 剥离 data/blob + web 双向同步 + `smoke.mjs` 20 项。<br>剩余：视口虚拟化（并入 M1）。 |
| **M1** | 完成 | 已完成：**画布生成闭环**（节点选 provider/endpoint → daemon 按 family 转请求体 → 参考素材 `files upload` → 排队 → 产物落 assets → 节点回填）＋确认弹窗；**资产层**（上传→`assets/<sha256>`、Range 读取、内容去重，web 侧图片/视频/音频全部改走 daemon）＋**run 引擎**（`solgrid run` 提交、`runs get` 轮询、幂等键落盘、启动恢复、产物自动落地、记账）＋**工具目录缓存**（tools/inspect 24h）＋ `smoke-runs.mjs` 11 项（假 CLI，不花钱）。＋**raw JSON 与 schema 兜底**（节点面板显示请求体字段/参考价，可整段覆写 body，陌生 family 也可跑）＋**Solgrid 内置渠道**（渠道页只读展示，catalog 驱动）＋**偏好设置里的默认模型**（生图/生视频/声音）＋ `/image` `/video` 工作台下线。＋**运行历史面板**（列表/汇总/详情/取消/重试/删除，落盘实际请求体）＋**增量 op 同步**（`POST /projects/:id/ops` + op 日志 + rev 冲突回退，替代整份 PUT）。<br>可靠性收尾：run 完成回填节点（daemon 为唯一写入方，含多产物建节点）、刷新时有活跃 run 保持 loading 并轮询对齐、停止即取消远端。已删除本地代理（`canvas-proxy` / 设置页 / `withLocalProxy`）、`/image` `/video` 工作台文件、渠道编辑器组件。遗留（非阻塞）：`use-config-store` 的 channels/models 数据结构仍在（agent 站点工具引用）；文本生成不接入（LLM 复用本地 Agent）。 |
| **M2** | 完成 | MCP server（11 个工具）+ 布点引擎 + 生成审批（画布确认）+ CLI + 技能包；**ACP 内嵌对话**：daemon 拉起 DSH ACP（`ELECTRON_RUN_AS_NODE` 跑 app.asar 内 CLI）、`session/new` 注入 canvas MCP、SSE 流转发、权限确认、模型切换。适配器可由 `CANVAS_ACP_COMMAND/ARGS` 覆盖；`sync-config` 同步桌面 provider/默认模型到 ACP profile。 |
| M3 / M3b / M4 / M5 | 未开始 | 技能 / 编辑层 / 时间线 / 发布 |

> 代码进展以 `git log` 为准；本表只记录相对方案的偏差与剩余项。

# canvas daemon（M0 + M1 后端）

本地 daemon 是 solgrid canvas 的执行与存储中心：画布项目与资产生成物落在本机文件系统，生成任务走这里的队列。

零运行时依赖：只用 Node 内置模块（`http` / `fs` / `crypto`），**不需要 npm install**。

## 运行

```bash
node daemon/server.mjs          # 或 npm run daemon（仓库根新增脚本后）
```

启动后打印：

```
[daemon] listening http://127.0.0.1:17371
[daemon] projects: C:\Users\<you>\.solgrid-canvas\projects
[daemon] token file: C:\Users\<you>\.solgrid-canvas\daemon.json
```

首次启动会生成访问令牌，写在 `~/.solgrid-canvas/daemon.json`（Linux/macOS 为 0600）。把令牌填进 `web/.env.local`：

```bash
CANVAS_DAEMON_URL=http://127.0.0.1:17371
CANVAS_TOKEN=<daemon.json 里的 token>
```

> token 只被 Vite dev server 读取（`loadEnv`），由代理注入 `x-canvas-token` 请求头，**不进浏览器 bundle**。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CANVAS_PORT` | `17371` | 监听端口；只绑定 `127.0.0.1` |
| `CANVAS_HOME` | `~/.solgrid-canvas` | 数据根目录（测试时指向临时目录） |
| `CANVAS_TOKEN` | 自动生成 | 覆盖令牌（CI / 临时实例用） |

## 数据布局

```
~/.solgrid-canvas/
├── daemon.json                 # { token }
├── canvas.db                   # run 账本 + 工具目录缓存（node:sqlite）
├── tmp/                        # 提交给 CLI 的 body 临时文件
└── projects/<id>/
    ├── project.json            # 元信息：标题/时间/背景/视口/rev
    ├── canvas.json             # JSON Canvas 1.0：nodes + edges，扩展字段在 x-solgrid
    └── assets/                 # 内容寻址资产：<sha256>.<ext> + <sha256>.json
```

`canvas.json` 是标准 **JSON Canvas 1.0**：节点用 `id/type/x/y/width/height/text/file`，连线用 `fromNode/toNode`；solgrid 的原始节点类型、标题、生成参数放在 `x-solgrid` 里。**Agent 与 Obsidian 都能直接读写这个文件。**

## 接口（M0）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查（免 token） |
| GET | `/api/projects` | 项目列表（含完整文档） |
| GET | `/api/projects/:id` | 单项目 |
| POST | `/api/projects/:id/ops` | 增量 op（add_node / update_node / remove_nodes / add_edge / remove_edges / update_meta / move_nodes），带 `expectRev` |
| GET | `/api/projects/:id/ops` | op 日志（最近 N 条） |
| PUT | `/api/projects/:id` | 保存项目（body: `{project}`），返回 `rev` |
| DELETE | `/api/projects/:id` | 删除项目目录 |
| GET | `/api/events?client=<id>` | SSE：`project.updated` / `project.deleted` / `run.updated` |
| POST | `/api/projects/:id/assets?mime=…` | 上传二进制，返回 `{assetId,file,bytes}` |
| GET | `/api/projects/:id/assets/:file` | 读取资产（支持 Range） |
| GET | `/api/tools?q=…` | `solgrid discover` 结果（缓存 24h） |
| GET | `/api/tools/detail?provider=&endpoint=` | `solgrid inspect` 契约（缓存 24h） |
| POST | `/api/runs` | 入队生成：`{projectId,nodeId?,provider,endpoint,params}`；`params` 是画布语义（prompt/size/references/seconds/resolution…），`params.rawBody` 可直接给请求体 |
| GET | `/api/runs?projectId=` | run 列表摘要（不含 body） |
| GET | `/api/runs/:id` | 单个 run |
| POST | `/api/runs/:id/cancel` | 取消（可 stop 则 stop 远端） |
| POST | `/api/runs/:id/retry` | 用同样参数重新入队 |
| DELETE | `/api/runs/:id` | 删除记录 |

所有 `/api/*` 都需要 `x-canvas-token`。写入时 **`data:` / `blob:` 地址会被剥离**（画布文档只允许 `assetId` / `storageKey`），资产层在 M1 接管。`blob:` 只在创建它的标签页存活，写进文档就是死链。

## Agent 接入（MCP）

```bash
node bin/solgrid-canvas.mjs install --agent codex|claude|dsh
```

注册的是 stdio MCP：`node daemon/mcp.mjs`。它不重复实现业务，全部转发给 daemon；daemon 没起时会自动拉起。工具包括 `canvas_get_state` / `canvas_apply_ops` / `canvas_place_artifacts` / `canvas_import_local` / `canvas_run_nodes` / `canvas_watch_run` / `canvas_cancel_run` 等。

## rawBody 契约

- 画布文档里 `metadata.rawBody` 是 **JSON 字符串**（编辑器文本）；daemon 的 `params.rawBody` 是 **对象**。
- `POST /api/runs` 接受对象或 JSON 字符串；非法 JSON / 非对象返回 400 `invalid_raw_body`。
- rawBody 里的 `data:` URL 会落成项目资产；`asset:` 引用会经 `files upload` 转公网 URL 后再提交。
- `GET /api/tools/detail` 额外返回 `skeleton`（按 body schema 生成），可直接改后作为 rawBody。

## 视频片段重生成

```
POST /api/video-edits   {projectId,sourceNodeId,start,end,prompt,mode:"flf"|"videoedit",resolution,replace}
GET  /api/video-edits/:id
POST /api/video-edits/:id/cancel
```

- `flf`：ffmpeg 抽首尾帧 → `wan2.7-i2v`（duration=片段秒数）→ 拼接
- `videoedit`：ffmpeg 裁片段（带 0.3s 把手）→ `wan2.7-videoedit` → 裁回精确区间 → 拼接
- 拼接用原视频完整音轨；产物落 assets 后新建子节点（或替换原节点）
- 依赖本机 `ffmpeg` / `ffprobe`；测试可用 `CANVAS_VIDEO_EDIT_FAKE=1` 跳过平台生成

## 画布 → Agent（ACP）

```bash
curl -XPOST /api/agent/start   -d '{"projectId":"…"}'   # 建会话（注入 canvas MCP）
curl -XPOST /api/agent/prompt  -d '{"projectId":"…","text":"…"}'
curl      /api/agent/transcript?projectId=…
curl -XPOST /api/agent/cancel  -d '{"projectId":"…"}'
curl -XPOST /api/agent/model   -d '{"projectId":"…","configId":"model","value":"…"}'
curl -XPOST /api/agent/permissions/:id -d '{"allow":true}'
```

- 默认适配器：本机 DSH 桌面版（`ELECTRON_RUN_AS_NODE=1 <exe> resources/app.asar/.../bin.js --profile acp`）
- 自定义：`CANVAS_ACP_COMMAND` + `CANVAS_ACP_ARGS`（JSON 数组）
- 会话持久化在项目目录 `agent-session.json`，daemon 重启后自动 resume（历史消息不重放）；模型/凭证来自 Agent 自身
- 桌面版与 ACP 的配置默认隔离：`solgrid-canvas sync-config` 可把 desktop profile 的 `agent-default-model` / `llm-pi-ai.providers`（不含凭证）同步到 ACP profile，并映射成 `acp` 行的默认模型

## 生成审批

```
POST /api/approvals              {projectId,nodeId,provider,endpoint,params} → {id,status}
GET  /api/approvals?projectId=   待审批列表
GET  /api/approvals/:id          状态（pending/approved/denied/expired）
POST /api/approvals/:id/decision {allow:true|false}
```

审批默认只存在内存、5 分钟过期。`CANVAS_AUTO_APPROVE=1` 仅用于测试。

## 自测

```bash
node daemon/smoke.mjs       # 存储 / 鉴权 / 资产（20 项）
node daemon/smoke-runs.mjs  # run 队列 / 产物落地 / 记账（用假 CLI，11 项，不花钱）
```

`smoke-runs.mjs` 通过 `CANVAS_SOLGRID_BIN` 指向 `daemon/test/fake-solgrid.mjs`，不联网、不扣费。
真实 CLI 路径由 `CANVAS_SOLGRID_BIN` 默认值 `solgrid` 使用；Windows 上经 shell 执行 `.cmd`，进入命令行的参数都会先做字符白名单校验。

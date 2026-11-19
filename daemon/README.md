# canvas daemon（M0）

本地 daemon 是 solgrid canvas 的执行与存储中心：画布项目落地在本机文件系统，后续的 run 队列、资产落地、ACP/MCP 桥都挂在这里。

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
└── projects/<id>/
    ├── project.json            # 元信息：标题/时间/背景/视口/rev
    ├── canvas.json             # JSON Canvas 1.0：nodes + edges，扩展字段在 x-solgrid
    └── assets/                 # 内容寻址资产（M1 接入）
```

`canvas.json` 是标准 **JSON Canvas 1.0**：节点用 `id/type/x/y/width/height/text/file`，连线用 `fromNode/toNode`；solgrid 的原始节点类型、标题、生成参数放在 `x-solgrid` 里。**Agent 与 Obsidian 都能直接读写这个文件。**

## 接口（M0）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查（免 token） |
| GET | `/api/projects` | 项目列表（含完整文档） |
| GET | `/api/projects/:id` | 单项目 |
| PUT | `/api/projects/:id` | 保存项目（body: `{project}`），返回 `rev` |
| DELETE | `/api/projects/:id` | 删除项目目录 |
| GET | `/api/events?client=<id>` | SSE：`project.updated` / `project.deleted` |

所有 `/api/*` 都需要 `x-canvas-token`。写入时 **dataURL 会被剥离**（画布文档只允许 `assetId`），资产层在 M1 接管。

## 自测

```bash
node daemon/smoke.mjs
```

起临时实例 → 鉴权 / 读写 / JSON Canvas 结构 / dataURL 剥离 / 路径穿越 → 清理，14 项检查。

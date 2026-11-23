# AI_SETUP — 让本地 Agent 自动装好 solgrid-canvas

> 把这篇文档整篇发给你的本地 Agent（Claude Code / Codex / DSH / 其他带终端与 MCP 的 Agent），它应当能：
> 安装画布与依赖、启动 daemon、**自动识别自己并注册 MCP**、配好画布 ↔ Agent 的连接，最后做一轮验证。
>
> 仓库：`git@github.com:rink1969/solgrid-canvas.git`

---

## 0. 你的任务（Agent 读这段）

你要在这台机器上完成一次本地安装：

1. 检查并安装前置依赖（Node ≥ 22、git、ffmpeg/ffprobe、solgrid CLI）
2. 克隆/更新仓库，安装 web 依赖并构建
3. 启动本地 daemon，确认健康检查通过
4. **判断你自己是哪种 Agent**，把 canvas MCP 注册进你自己的配置
5. 若你是 DSH：额外检查 ACP profile 与默认模型（画布调用 Agent 的方向）
6. 按第 7 节逐项验证，并汇报结果

约束：

- 不要向用户索要 solgrid API Key，也不要写进任何文件；密钥只由 `solgrid` CLI 自己管理。
- 不要把 `~/.solgrid-canvas/daemon.json` 里的 token 发到聊天里或提交进仓库。
- 不要修改与本安装无关的仓库文件。
- 每一步都先检查、再执行；命令失败时按第 8 节排查，不要跳过。

---

## 1. 前置依赖

| 依赖 | 检查命令 | 要求 |
|---|---|---|
| Node.js | `node -v` | ≥ 22（本机推荐 24） |
| npm | `npm -v` | 随 Node 安装 |
| git | `git --version` | 任意版本 |
| ffmpeg / ffprobe | `ffmpeg -version`、`ffprobe -version` | 视频片段重生成需要 |
| solgrid CLI | `solgrid --version` | ≥ 0.4，且已登录 |

安装参考：

```bash
# macOS
brew install ffmpeg
npm i -g @solgridai/cli

# Windows（PowerShell）
winget install Gyan.FFmpeg
npm i -g @solgridai/cli
```

solgrid 登录：如果 `solgrid --version` 正常但调用工具时报未登录，请让**用户本人**在其终端完成 `solgrid` 登录（不要代填凭据）。

> 没有 ffmpeg 也能启动画布，但「视频片段重生成」不可用；`doctor` 会把这一项标红。

---

## 2. 获取代码

```bash
git clone git@github.com:rink1969/solgrid-canvas.git
cd solgrid-canvas
```

如果目录已存在：

```bash
cd solgrid-canvas && git pull --ff-only
```

---

## 3. 安装与构建

```bash
# 安装 web 依赖（daemon 零依赖）
npm --prefix web install

# 构建前端（生产模式由 daemon 直接托管）
npm run build
```

> Windows 上如果 `npm run build` 因 esbuild 临时目录权限报错，把 `TMP`/`TEMP` 指向仓库内目录再构建：
> PowerShell：`$env:TMP="$PWD\.tmp-build"; $env:TEMP="$PWD\.tmp-build"; npm run build`

---

## 4. 启动 daemon

```bash
npm run daemon
# 或：node bin/solgrid-canvas.mjs daemon
```

首次启动会生成：

- `~/.solgrid-canvas/daemon.json`：端口与访问 token（`0600`）
- `~/.solgrid-canvas/projects/`：画布项目目录
- `~/.solgrid-canvas/canvas.db`：run 账本与 op 日志

确认：

```bash
curl http://127.0.0.1:17371/health
# {"ok":true,"version":"0.1.0","root":"..."}
```

> daemon 只监听 `127.0.0.1`。不要把端口暴露到公网。

也可以一步完成「依赖 + 构建 + 启动 + 开发环境变量」：

```bash
node bin/solgrid-canvas.mjs setup
```

---

## 5. 注册 MCP（Agent → 画布）

先判断你是哪种 Agent：

| 你的身份 | 判断方式 | 注册命令 |
|---|---|---|
| Claude Code | `claude --version` 可用 | `node bin/solgrid-canvas.mjs install --agent claude` |
| Codex CLI | `codex --version` 可用 | `node bin/solgrid-canvas.mjs install --agent codex` |
| DeepSeek Harness（DSH） | 环境变量 `DSH_PROFILE` 存在，或 `~/.dsh/profiles/` 有内容 | `node bin/solgrid-canvas.mjs install --agent dsh --profile <你的 profile>` |
| WorkBuddy / CodeBuddy | `codebuddy --version` 或 `cbc --version` 可用 | 在 WorkBuddy/CodeBuddy 的 MCP 设置里添加下方通用配置 |
| 其他 MCP 客户端 | 在设置里手写 JSON | 见下方通用配置 |

注册后**重启你自己**（或新开会话），使 MCP 工具生效。工具名前缀为 `mcp__solgrid_canvas__canvas_*`。

### 通用 MCP 配置（stdio）

```json
{
  "name": "solgrid_canvas",
  "command": "<node 绝对路径，如 C:\\Program Files\\nodejs\\node.exe>",
  "args": ["<仓库绝对路径>/daemon/mcp.mjs"],
  "env": [
    { "name": "CANVAS_HOME", "value": "<用户主目录>/.solgrid-canvas" }
  ]
}
```

> Windows 下路径用 `\\` 转义；`command` 必须是绝对路径，避免 Agent 进程 PATH 不完整。

### DSH 额外步骤（先确认你用的是哪个 profile）

DSH 可以是桌面版（`desktop` profile），也可以是用 `dsh web` / `dsh tui` / `dsh headless` 启动的其他 profile。**MCP 必须写进你正在使用的那个 profile**，否则工具不会出现。

在 DSH 的 Agent 终端里探测：

```bash
# bash
echo "$DSH_PROFILE"
echo "$DSH_PROFILE_DIR"

# PowerShell
$env:DSH_PROFILE
$env:DSH_PROFILE_DIR
```

如果环境变量为空（例如你在 DSH 外部终端操作），列出已有 profile 并让用户确认：

```bash
ls ~/.dsh/profiles        # Windows: dir %USERPROFILE%\.dsh\profiles
```

然后执行（把 `<profile>` 换成探测到的名字，例如 `desktop` 或 `web`）：

```bash
node bin/solgrid-canvas.mjs install --agent dsh --profile <profile>
```

该命令会写入 `~/.dsh/profiles/<profile>/cordis.patch.yml`（自动备份），并安装技能包到 `~/.agents/skills/solgrid-canvas/`。

如果这个 profile 改过模型/渠道，同步给画布用的 ACP profile：

```bash
node bin/solgrid-canvas.mjs sync-config --from <profile> --profile acp
```

重启 DSH 后，会话里应能看到 `mcp__solgrid_canvas__*` 工具。

> `install --agent dsh` 不带 `--profile` 时：优先用 `DSH_PROFILE`；只有一个 profile 时自动选；有多个且无法判断时会报错并列出可用值。

---

## 6. 画布调用 Agent（ACP 方向）

画布右侧的「Agent」面板通过 ACP 调用本地 Agent。

- **DSH**：daemon 会自动选择启动方式：
  1. PATH 里的 `dsh` CLI（`dsh --profile acp`，适合 `dsh web` / npm 安装的用户）
  2. 当前进程环境里的 DSH 可执行文件（从 DSH 内部启动 daemon 时）
  3. DSH 桌面版默认安装路径（Electron node 模式）

  都不匹配时可用 `CANVAS_DSH_EXE` 指定桌面版可执行文件。
- **WorkBuddy**：WorkBuddy 桌面版本身不提供独立的 ACP 命令，ACP 能力由 **CodeBuddy Code CLI** 提供（参考 [WorkBuddy ACP 文档](https://www.workbuddy.ai/docs/enterprise/222639541005807616) / [CodeBuddy ACP 文档](https://www.codebuddy.ai/docs/zh/cli/acp)）。daemon 会按顺序探测：
  1. `codebuddy --acp`
  2. `cbc --acp`（部分安装的别名）

  探测到后直接用，不需要额外配置。若 `codebuddy` 不在 PATH（例如未安装 CodeBuddy CLI），可手动指定：

  ```bash
  CANVAS_ACP_COMMAND="C:\\path\\to\\codebuddy.cmd"
  CANVAS_ACP_ARGS='["--acp"]'
  ```

  > 部分 ACP 实现不接受 `session/new` 里的 MCP 注入；daemon 会自动去掉 MCP 重试。这种情况下 WorkBuddy 仍能对话，但看不到 `canvas_*` 工具（Agent 操作画布请用支持 MCP 的客户端，或改用 DSH）。
- **其他 Agent**：需要对应的 ACP 适配器，通过环境变量指定（启动 daemon 前设置）：
  ```bash
  # 示例（以实际安装的适配器为准）
  CANVAS_ACP_COMMAND=npx
  CANVAS_ACP_ARGS=["-y","@zed-industries/claude-code-acp"]
  ```
  未配置时画布面板会提示「没有找到可用的 ACP Agent」，但 MCP 方向（Agent 操作画布）仍然可用。

检查：

```bash
node -e "const fs=require('fs'),os=require('os');const t=JSON.parse(fs.readFileSync(os.homedir()+'/.solgrid-canvas/daemon.json')).token;fetch('http://127.0.0.1:17371/api/agent/status',{headers:{'x-canvas-token':t}}).then(r=>r.text()).then(console.log)"
```

（或直接打开画布 → Agent 面板，看适配器标签是否为 `dsh`。）

---

## 7. 验收清单

Agent 完成后请逐项确认并汇报：

- [ ] `curl http://127.0.0.1:17371/health` 返回 `ok: true`
- [ ] `node bin/solgrid-canvas.mjs doctor` 全绿（或说明哪项缺失、影响什么）
- [ ] 浏览器打开 `http://127.0.0.1:17371/`，能看到画布列表并新建/打开一个画布
- [ ] 你的工具列表里出现 `mcp__solgrid_canvas__canvas_list_projects`
- [ ] 实际调用一次 `canvas_list_projects`，返回数组（空数组也算通过）
- [ ] 在画布里创建一个图片节点，选中模型；点击生成时弹出费用确认，取消后不产生费用
- [ ] （可选，会产生费用）生成一张图，确认结果节点落回画布
- [ ] （DSH）画布右侧 Agent 面板能建立会话并回复一句话
- [ ] （有视频素材时，可选）视频节点「片段重生成」能弹出窗口

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `health` 连不上 | daemon 没启动或端口被占；`npm run daemon` 看日志；端口可用 `CANVAS_PORT` 覆盖 |
| 浏览器打开 401 / API 全 401 | 生产模式：先访问 `/`（会下发 HttpOnly cookie）；开发模式：检查 `web/.env.local` 里的 `CANVAS_TOKEN` 是否与 `~/.solgrid-canvas/daemon.json` 一致 |
| 打开页面提示「前端还没构建」 | 在仓库根目录执行 `npm run build` |
| MCP 工具不出现 | 注册后没重启 Agent；DSH 用户先确认写进了**当前使用的 profile**（`install --agent dsh --profile <name>`）；再检查配置里的 node 绝对路径与 `mcp.mjs` 路径 |
| 生成报 `solgrid_unavailable` / 未登录 | 让用户在其终端登录 solgrid；`solgrid --version` 只能证明已安装 |
| 生成报「没有默认模型」 | 设置 → 渠道里选默认生图/生视频模型；或在节点上单独选模型 |
| 视频片段重生成失败 | 检查 `ffmpeg`/`ffprobe` 是否在 PATH；`doctor` 有对应项 |
| 画布 Agent 面板显示不可用 | WorkBuddy：确认 `codebuddy --version` 可用，否则安装 CodeBuddy Code CLI 或配置 `CANVAS_ACP_COMMAND/ARGS`；DSH：确认桌面版路径存在 |
| WorkBuddy 对话可用但没有画布工具 | 该 ACP 实现可能不支持 `mcpServers` 注入；检查 daemon 日志是否有「改为不带 MCP 重试」 |
| Windows 上 build 权限报错 | 把 `TMP`/`TEMP` 指到仓库内目录（见第 3 节） |

日志位置：

- daemon 前台日志：启动它的终端
- 项目数据：`~/.solgrid-canvas/projects/<id>/`
- run 记录：`~/.solgrid-canvas/canvas.db`

---

## 9. 运行方式

**生产（推荐给客户）**

```bash
npm start
# 打开 http://127.0.0.1:17371
```

daemon 同时托管构建好的前端、API 与 SSE，首次访问自动下发鉴权 cookie。

**开发**

```bash
npm run daemon      # 终端 1
npm run dev         # 终端 2，http://localhost:3000
```

`install` 命令会把 token 写进 `web/.env.local` 供 Vite 代理使用。

---

## 10. 安全与范围

- 画布只监听本机回环地址，token 存于 `~/.solgrid-canvas/daemon.json`（0600）。
- 所有付费调用只由 daemon 通过 `solgrid` CLI 发起；浏览器不持有 API Key。
- Agent 通过 MCP 改画布受 `expectRev` 乐观锁保护；生成花费需用户在画布确认（MCP 调用会弹审批）。
- 不要把 `~/.solgrid-canvas/` 或 `web/.env.local` 提交到仓库。

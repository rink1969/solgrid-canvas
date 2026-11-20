# DSH ACP 调研（画布 → Agent）

> 日期：2026-11-20　范围：让画布作为 ACP client 调用本地 DeepSeek Harness（DSH）Agent，并复用其模型配置。
> 结论来自本机实测（DSH 0.2.2-rc.5，Windows），不是纯读文档。

## 1. 结论速览

| 问题 | 结论 |
|---|---|
| DSH 能作为 ACP server 吗 | 能，`dsh --profile acp`，stdio + NDJSON JSON-RPC |
| 桌面版能拉起吗 | 能，用 Electron 的 node 模式跑 app.asar 内的 CLI |
| ACP 会话独立吗 | 是，每次 `session/new` 独立持久会话，`cwd` 由调用方指定 |
| 能注入 MCP 吗 | 能，`session/new.mcpServers`；`env` 数组必填，否则静默丢弃 |
| 能加载 skill 吗 | 能，ACP profile 挂了 `skill` / `skill-filesystem` / `tool-skill` |
| 配置和桌面共享吗 | 凭据共享；provider 定义与默认模型按 profile 隔离 |
| 会话能跨进程恢复吗 | DSH 支持 `session/list` / `resume`；画布 daemon 目前未接 |

## 2. 启动方式

DSH 的 CLI 在 `resources/app.asar` 里，普通 `node` 读不了 asar。用 Electron 二进制以 node 模式启动即可：

```bash
ELECTRON_RUN_AS_NODE=1 \
  "C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" \
  "…/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --version
# → 0.2.2-rc.5
```

ACP 服务：

```bash
ELECTRON_RUN_AS_NODE=1 "<exe>" "<asar>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile acp
```

画布 daemon 里由 `daemon/acp.mjs` 的 `resolveAdapter()` 自动发现这条路径；也可以覆盖：

```bash
CANVAS_ACP_COMMAND=<executable>
CANVAS_ACP_ARGS=["--profile","acp"]
```

## 3. Profile 模型

`dsh --profile <name>` 启动 `$DSH_HOME/profiles/<name>` 下的 profile：一组按顺序叠加的 plugin-bundle patch 层 + 用户层 `cordis.patch.yml`。

| | 桌面版 | ACP |
|---|---|---|
| profile 目录 | `~/.dsh/profiles/desktop` | `~/.dsh/profiles/acp` |
| bundles | dsh-base、dsh-web-app、doyourweb、ops、free-search、context | **dsh-base + dsh-acp-app** |
| 默认模型来源 | `agent-default-model` 行（桌面 patch） | `acp` 行的 `provider`/`model` |
| 用户层 patch | 桌面配置 | 默认 `[]` |

要点：

- `acp` profile 目录是 **DSH 首次执行 `--profile acp` 时按出厂模板自动生成的**，不是 DSH 安装包里预置的目录，也不是手工创建。
- `dsh --from-default-profile acp` 可以用出厂模板重建这个 profile。
- 可以自建 profile（任意名字），只要 bundle 栈里含 `@deepseek-ai/dsh-acp-app`；也可用 `--patch` 叠加临时层。
- **不建议**把 acp-app 挂进 desktop/web profile：acp-app 的前提是"stdout 全部属于 ACP"，和交互式 App 同进程属于未支持组合。

## 4. 配置共享矩阵

| 内容 | 共享？ | 位置 |
|---|---|---|
| 登录态 / API key（credentials） | ✅ 全局 | `~/.dsh/.credentials.yaml`（`ctx.credentials`） |
| 技能（skills） | ✅ 全局 | `~/.agents/skills/<name>/SKILL.md`（需 YAML frontmatter） |
| provider 定义（`llm-pi-ai.providers`） | ❌ 按 profile | 各自 `cordis.patch.yml` |
| 默认模型 | ❌ 按 profile | 桌面 `agent-default-model`；ACP `acp` 行 |
| MCP 服务器 | ❌ 按 profile | 桌面由 mcp-manager 管理；ACP 由 `session/new.mcpServers` 注入 |

自定义 provider 的正确写法（desktop patch 示例，抄到 acp profile 即可用）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-openai:
        type: openai
        baseURL: https://example.com/v1
        models: [gpt-x]
        # 密钥用凭据引用，不落明文
        # apiKey: "${credential:MY_OPENAI_KEY}"
```

注意默认模型在 ACP 下有**两处**：

1. `agent-default-model`：影响 DSH 会话的默认模型（桌面 app 使用）
2. `acp` 行的 `config.provider` / `config.model`：ACP 服务在 `session/new` 里回报的 `configOptions.currentValue`

`solgrid-canvas sync-config` 会把桌面 `agent-default-model` 同时映射到这两处。

## 5. 会话模型

- `session/new` 参数：`{ cwd, mcpServers, ... }`。`cwd` 是每会话工作目录——**工作区隔离靠它，不靠 profile**。
- 每次 `session/new` 都是独立、可持久化的 agent 会话；同一 ACP 连接可并存多个。
- `session/list` / `session/resume` / `session/close` 支持；`session/load`、分叉、transcript replay、额外目录不支持。
- 画布 daemon 会把 sessionId 写入项目目录 `agent-session.json`，daemon 重启后先 `session/resume`，失败再新建。
- 注意：resume 恢复的是 Agent 的上下文，**不会重放历史消息**（ACP 不支持 transcript replay），画布面板的历史记录只保留本次 daemon 生命周期内的。

## 6. 协议要点（实测）

| 项 | 结论 |
|---|---|
| 传输 | stdio，NDJSON（每行一个 JSON-RPC） |
| `initialize.protocolVersion` | **数字**（1），传字符串会 `Invalid params` |
| `session/new.mcpServers`（stdio） | `{ name, command, args, env: [{name, value}] }`；**缺 `env` 会被静默忽略** |
| 切模型 | `session/set_config_option { sessionId, configId:"model", value }`，value 是 JSON 字符串，如 `["deepseek-account","deepseek-flash"]` |
| 流式更新 | `session/update` 通知：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`usage_update` 等 |
| 权限 | `session/request_permission` 请求 → 回复 `{ outcome: { outcome: "selected", optionId } }`；拒绝选 reject 类 option |
| 取消 | `session/cancel` 通知（无响应） |
| 客户端能力 | 本实现不提供 `fs/*`、`terminal/*`，Agent 用自己的文件工具（cwd 内） |

## 7. 踩过的坑

1. **asar 路径不能用 `fs.existsSync` 判断**：普通 node 看不到 asar 内部，检查 bin 会误判为不存在；只检查 exe 是否存在即可。
2. **ACP 默认模型 `deepseek-official` 没有 key**：子进程里没有该 route 的凭据，prompt 直接失败。解决：profile 里把默认模型改成 `deepseek-account`（本机登录态），或会话里 `set_config_option`。
3. **`mcpServers` 静默丢条目**：不带 `env` 数组时，条目被接受但不生效，Agent 会去仓库里瞎找工具。加 `env: []` 或真实键值后正常。
4. **stdout 归属**：ACP 独占 stdout；不要在同进程再挂其他 App 输出。
5. **技能发现需要 frontmatter**：`SKILL.md` 必须有 `name` + `description`，否则技能目录不收录（画布 skill 曾因此不可见）。
6. **默认模型两处**：只改 `agent-default-model` 不会改 ACP 服务的默认模型。

## 8. 画布侧实现（M2d）

- `daemon/acp.mjs`
  - `resolveAdapter()`：自动发现 DSH，或读 `CANVAS_ACP_COMMAND/ARGS`
  - `createConnection()`：NDJSON JSON-RPC、pending map、通知分发
  - `createAgentManager()`：会话表（projectId → session）、prompt/cancel/permission、transcript、SSE 广播
- daemon 路由：`/api/agent/{status,start,transcript,prompt,cancel,model}`、`/api/agent/permissions/:id`
- SSE 事件：`agent.event`（kind: update / user / done / permission / model）
- 前端：画布右下角「Agent」抽屉（消息流、工具状态、模型选择、停止、权限弹窗）
- 注入的画布 MCP：`name: solgrid_canvas`，`command: <node>`，`args: [daemon/mcp.mjs]`，`env: CANVAS_HOME/CANVAS_PORT`

## 9. 配置同步（A 方案）

```bash
solgrid-canvas sync-config [--from desktop] [--profile acp] [--dry-run]
```

- 从 desktop 的 `cordis.patch.yml` 提取 `agent-default-model`、`llm-pi-ai`（providers 非空时）
- 目标是 ACP profile 时，额外把默认模型映射成 `acp` 行的 `provider`/`model`
- 按 id 合并、保留其余条目；内容一致则跳过（幂等）；写入前自动备份
- 生效方式：重启 daemon 或结束当前 ACP 会话

限制：纯文本块级合并，不解析 `!!js` 表达式的内容；`providers: {}` 视为"无自定义 provider"跳过。

## 10. 后续可做

- transcript 持久化（daemon 侧落盘）以配合 resume 展示历史
- 适配器扩展：`codex-acp`、`claude-code-acp`（`CANVAS_ACP_COMMAND/ARGS` 即可，无需改代码）
- 按项目/技能目录隔离 skills（需确认 skill-filesystem 是否扫描 cwd）
- 把 ACP 会话的模型选择持久化到项目设置

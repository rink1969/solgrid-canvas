# solgrid-canvas 问题跟踪

> 单一事实源：所有已确认问题、架构补全项、验证证据都登记在这里。
> 规则：修复 → 测试/真实 E2E 验证 → 才能标记「完成」；发现新问题继续追加。
> 顺序：能通过架构补全消除同类问题的，优先做架构项（A 系列），再做单点修复（D 系列）。

## 状态说明

| 状态 | 含义 |
|---|---|
| 待处理 | 已确认，尚未开始 |
| 进行中 | 正在改 |
| 待验证 | 代码已改，缺测试或真实 E2E |
| 完成 | 已修复并有验证证据 |
| 部分完成 | 主路径已修，仍有明确子项未完成 |
| 不适用 | 已确认不是本仓库缺陷 |

## 一、架构优先队列（A）

| ID | 问题 | 优先级 | 状态 | 验证方式/备注 |
|---|---|---|---|---|
| A1 | run completed 后 `applyDocOps` 回填画布失败只打日志，无重试/补偿，node 可能永远不更新 | P0 | 完成 | `doc_ops` SQLite 队列 + 5s 重试 + 启动恢复；smoke：先跑 ghost 节点失败，再补节点后自动 success |
| A2 | 审批没有本地成本预估、`maxCostSpark`、批量上限；只依赖平台每日额度 | P1 | 完成 | 服务端/UI 都显示 catalog 估算；单次 50 节点上限；`canvas_run_nodes` / `/api/approvals` 支持 `maxCostSpark`，超限 400；smoke 通过 |
| A3 | catalog 首次未命中时多标签/多入口并发重复执行 `tools categories + list`；`tools:q` 缓存 key 无清理 | P1 | 完成 | 并发冷启动测试：categories 调用 1 次、第二个请求 cached=true；并清理超过 24h 的 `tools:q:v2:` 缓存 |
| A4 | 资产上传无大小上限；失败 ops/run 留下孤儿资产 | P1 | 完成 | 已有 1GB 上传上限并拒绝 AVIF/SVG；新增 `POST /api/projects/:id/assets/gc`，按画布/聊天/timeline 引用和默认 7 天保护清理孤儿；smoke 通过 |
| A5 | 浏览器 E2E 只存在于 workspace 临时脚本，未纳入仓库回归 | P1 | 完成 | 新增 `daemon/e2e-browser.mjs`，已对真实项目跑通图片渲染；无异常 |
| A6 | MCP `canvas_apply_ops` 等 schema 仍是宽松 `array of object`，缺 `oneOf` 结构化校验 | P0 | 完成 | `canvas_apply_ops` 7 种 op 与 `canvas_place_artifacts` 的 oneOf schema 已落地；`smoke-mcp` 校验通过 |
| A7 | 浏览器顶部显示「本地 Agent 已连接」，右侧 Agent 面板显示「本地 Agent 未连接」，状态来源不一致 | P2 | 完成 | 面板 Tag 改为 `检测中 / 已连接 / 未连接`，并挂载时查询 ACP 状态；通用浏览器 harness 复验显示 `dsh` |

## 二、反馈缺陷清单（D1–D24 + S01）

### 已完成（有验证）

| ID | 问题 | 状态 | 验证 |
|---|---|---|---|
| D1 | `canvas_run_nodes` 的 `nodeIds` 批量是假的，只取第一个 | 完成 | 异步批量审批 smoke；真实图片/视频 E2E |
| D2 | `canvas_run_nodes` 同步阻塞等审批，撞 MCP 传输超时 | 完成 | 改为立即返回 `approvalId`；smoke + 真实 MCP E2E |
| D3 | `add_edge` 字段未文档化 | 完成 | MCP 描述补齐；`smoke.mjs` |
| D4 | op 判别字段与描述不一致 | 完成 | 描述改为 `op.type`，服务端校验；A6 继续收紧 schema |
| D7 | 审批 UI 无队列深度，一次只显示一个 | 完成 | 浏览器 E2E：标题「待审批 1 个」；轮询 |
| D8 | run 串行执行，画布不显示排队位次 | 完成 | `/api/runs` 返回 `queuePosition`；run history 显示 |
| D9 | config 节点与图片节点产物渲染不对称 | 完成 | 配置节点增加产物预览；代码/类型检查 |
| D10 | `place_artifacts` 缺布局参数 | 完成 | 支持 `auto/row/column/grid`；布局单测 |
| D11 | `canvas_import_local` 的 inbox 在容器里不存在 | 完成 | 自动创建 inbox；`smoke-mcp` |
| D12 | `POST /api/runs` 可绕过审批 | 完成（本地威胁模型内） | 纯 token 请求 403；retry 同保护；浏览器 E2E |
| D14 | 节点几何字段无类型校验，字符串坐标静默毁掉渲染 | 完成 | `ops` 与全量 PUT 共用 `validateProjectPayload`；坏几何 400 |
| D15 | 任意图片格式不转码直接转发 | 完成（采用拒绝策略） | AVIF/SVG 上传直接 400 并提示转码 |
| D16 | 并发 prompt 被硬拒，没有排队语义 | 完成（采用 409 + Retry-After） | 服务端返回 409/5s |
| D18 | Agent 响应期间输入框完全不可编辑 | 完成 | 输入框仅禁发送；类型检查 |
| D19 | 思考/工具调用逐条平铺，不折叠、无耗时 | 完成 | transcript 时间戳 + 过程折叠 + 单条耗时；`smoke-agent` |
| D20 | 视频节点没有「查看大图」 | 完成 | 浏览器 E2E：`<video>` 1280×720、readyState 4；工具栏/侧栏预览代码 |
| D21 | 审批请求可能不弹窗 | 完成 | 审批 3s 轮询；浏览器 E2E 实际拉起弹窗 |
| D22 | 浮动 Agent 窗口不能整体缩放，顶部拖动行占空间 | 完成 | 浏览器 E2E 打开 Agent → 悬浮，面板 440×720，旧「拖动窗口」行不存在；高度调整/把手代码 |
| D23 | `update_meta/viewport` 无文档、无回读 | 完成 | MCP 描述 + `get_state` 返回 viewport |
| D24 | 新对话没有模型选择器 | 完成 | `prepareConversation` + 前端 prepare；`smoke-agent` 已验证 prepare 返回 configOptions |

### 部分完成 / 待处理

| ID | 问题 | 状态 | 剩余 |
|---|---|---|---|
| D6 | 端点故障不可见，没有降级建议 | 完成 | `invocationEnabled` / `unavailableReason` + 运行详情按额度/登录/超时/不可用/参数分类给出操作提示 |
| D17 | ACP 会话恢复失败 `persistence.stat is not a function` | 不适用 | DSH/ACP 侧错误；画布已回退新建会话，丢上下文 |
| S01 | 文件夹节点（组强化版） | 不适用 | 功能建议，不是缺陷 |

### 已撤回

| ID | 问题 | 状态 | 说明 |
|---|---|---|---|
| D5 | 画布 Agent 读图能力 | 不适用 | 取决于所选模型，不是画布缺陷 |

## 三、真实 E2E 发现的问题（E）

| ID | 问题 | 状态 | 验证/提交 |
|---|---|---|---|
| E1 | `solgrid runs get -j` 返回 `cost:{value,currency}`，原 `pickCost` 只接受 number，导致 `costSpark=null` | 完成 | `1188a8f`；单元 smoke + 真实重跑 costSpark=3.9 |
| E2 | 顶部「本地 Agent 已连接」与面板「本地 Agent 未连接」不一致 | 完成 | 由 A7 修复并浏览器复验 |
| E3 | 视频真实成本 26 Spark 未在修复后的 daemon 再跑一次完整回读 | 完成 | 重跑真实视频，daemon 回读 `costSpark=26`；平台 `runs list` 一致 |
| E4 | 浏览器 E2E 只跑临时脚本，不在仓库 | 完成 | A5；`daemon/e2e-browser.mjs` |

## 四、真实 E2E 记录

### 2026-11-26 真实图片

- 路径：MCP `canvas_run_nodes` → 自动审批 → `canvas_watch_run` → 节点回填 → `canvas_place_artifacts`
- 模型：`alibaba /v1/image/qwen-image-3.0`
- 结果：1024×1024 PNG，1,129,007 bytes，costSpark=3.9（cost 修复后重跑）
- 验证：asset 文件存在、节点 status=success、storageKey 正确、artifact 再落点成功

### 2026-11-26 真实视频

- 模型：`alibaba /v1/video/wan2.7-t2v`
- 参数：2s / 720p
- 结果：MP4 1,030,431 bytes；H.264 1280×720 / 2.00s；AAC 2.02s
- 费用：首次平台 `runs list` 26 Spark；cost 修复后重跑 daemon 回读 `costSpark=26`

### 2026-11-26 浮动面板

- Chrome Headless 点击 Agent → 悬浮：面板 440×720，`拖动窗口` 文本不存在，无异常

### 2026-11-26 并发目录冷启动

- 两个并发 `/api/tools/catalog`：`tools categories` 只调用 1 次，第二个请求 `cached=true`

### 2026-11-26 浏览器 E2E

- Chrome Headless + CDP，真实 daemon + 生产构建
- 图片节点 `naturalWidth=1024`
- 视频节点 `readyState=4`、1280×720、2.02s
- 审批弹窗真实可见，标题「Agent 请求生成（待审批 1 个）」
- 设置页开关可点击，API `agentAutoApprove` true→false
- 无 `Runtime.exceptionThrown`

### 2026-11-26 重启恢复

- 创建 pending approval → 杀 daemon → 重启 → pending 仍可查询 → 拒绝成功

## 五、当前验证基线

- `npm --prefix web run typecheck`：通过
- `node daemon/smoke.mjs`：通过
- `node daemon/smoke-runs.mjs`：通过
- `node daemon/smoke-mcp.mjs`：通过
- `node daemon/smoke-agent.mjs`：通过
- 真实图片 / 视频 / 浏览器 E2E：通过
- 待补：无（D5/D17/S01 已标注不适用）

# solgrid-canvas v0.2.0

面向 solgrid 平台的本地无限画布：节点式生成图片、视频、音频，支持本地 Agent 通过 MCP 操作画布、通过 ACP 在画布内对话。

## 0.2.0 更新

### Agent 工作流

- `canvas_run_nodes` 改为异步批量：立即返回 `approvalId`，不再同步阻塞导致 MCP 超时；`nodeIds` 真正批量。
- 新增 `canvas_get_approval` / `canvas_wait_approval`；审批通过后返回 `runs` / `runIds`。
- 审批弹窗增加轮询兜底、待审批队列数量、批量节点数量。
- 审批状态持久化到 `~/.solgrid-canvas/approvals.json`，daemon 重启后可恢复 pending / expired。
- 偏好设置新增「允许 Agent 自动发起生成」；默认仍逐次人工确认，费用上限由 solgrid 平台控制。
- 审批支持服务端成本估算与 `maxCostSpark`，单次审批最多 50 个节点。
- ACP 权限增加查询接口与前端轮询，决策只允许画布 UI。
- ACP 会话创建 single-flight；transcript 在 done/error 时立即落盘。

### 画布数据与安全

- 全量 PUT 与 ops 共用 `validateProjectPayload`：节点/连线/几何/metadata 校验；已有画布 PUT 必须带 `expectRev`。
- 节点几何支持顶层 x/y，统一归一化为数字；非法值直接报错。
- `add_edge` 校验端点存在、禁止自连；节点 id 不允许重复/修改。
- `/api/runs`、retry、审批决策只接受画布 UI 请求，普通 MCP token 不能绕过。
- MCP `canvas_apply_ops` / `canvas_place_artifacts` schema 改为 `oneOf`。
- 资产上传拒绝 AVIF/SVG；新增孤儿资产 GC 端点 `POST /api/projects/:id/assets/gc`（默认 7 天保护）。
- 平台 cost 对象 `{value,currency}` 正确回读为 `costSpark`。

### UI

- 配置节点生成后显示产物预览。
- 视频节点支持「查看视频」与侧栏预览。
- 浮动 Agent 面板支持高度调整，小把手替代整行拖动条。
- 新对话预启动 ACP 会话，首轮发送前可选模型。
- 思考/工具调用折叠为「过程」，显示总耗时与单条耗时。
- Agent 运行期间输入框可编辑；并发 prompt 返回 409 + Retry-After。
- 运行历史显示排队位次；运行详情按额度/登录/超时/不可用/参数给出降级提示。

## 升级说明

- daemon：重启 `npm start` / `npm run daemon`。
- Web：使用本包内 `web/dist` 或重新 `npm run build`，刷新页面。
- 已有画布通过 API 全量覆盖时现在必须带 `expectRev`；正常画布 UI 增量保存不受影响。
- 默认仍需要人工审批；要允许 Agent 自动生成，请到「设置 → 偏好设置」显式开启。

## 验证

- `tsc --noEmit` 通过。
- `smoke.mjs` / `smoke-runs.mjs` / `smoke-mcp.mjs` / `smoke-agent.mjs` 通过。
- 真实图片、视频生成；浏览器审批弹窗、设置开关、浮动面板；daemon 重启审批恢复；并发 catalog 冷启动均通过。

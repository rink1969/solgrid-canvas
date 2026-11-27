# solgrid-canvas v0.2.3

这一版集中修复第四轮反馈确认的问题（视频节点、发送到对话、画布写入校验），并解决了编辑框输入法与光标问题。

## 修复

### 视频节点
- 「查看视频」弹窗关闭后不再继续播放（补 `destroyOnHidden`，关闭即卸载播放器）。
- 点击视频节点只选中/移动，不再触发原生播放；工具栏可切「交互」态用原生控件播放，双击节点打开查看弹窗。

### 发送到对话
- 右键「发送到对话」连续发送多个节点时，不再只有第一个能插入：引用 label 改为按整张画布编号（与 @ 提及一致），marker 不再撞名。

### 画布写入与几何
- `update_node` / `add_node` / `update_meta` 含未知字段直接报错（不再静默丢弃）；改节点标题必须用顶层 `title`，写 `metadata.title` 会报错并提示。
- 节点坐标与 `move_nodes` / 新增的 `place_nodes` 统一取整，存量小数坐标随下一次写入归一。
- 新增 `place_nodes{placements}` 绝对定位、`set_viewport`（与前端 op 方言对齐）。

### Agent 与工具
- 新增 `canvas_fit_group`：按成员与 24/52 内边距重算分组框。
- `canvas_get_state` 支持 `mode:"summary"`、`types` / `bbox` 过滤与 `limit` / `offset` 分页，大画布不再一次性返回全量。
- Agent 每轮返回 `turnId`，`/api/agent/status` 可按会话查本轮状态；忙时 409 带当前 `turnId`。
- 修复 `/api/agent/permissions` 一直 500：ACP manager 缺少 `listPermissions`，权限轮询兜底实际失效，已补齐。
- 工具描述补充：`viewport` 是项目级单值，改动会影响正在看画布的人。

### 编辑框输入
- 便签 / Markdown / HTML / 文本节点 / 提示词输入框：编辑期以本地草稿为准，输入法组字期间不回写宿主，拼音不再落字。
- contentEditable 编辑器（提示词、Agent 输入框）编辑中不再重建 DOM，光标不再被重置。
- 节点标题框 / 输入框的 Enter 在组字中或组字结束后 120ms 内不再当作提交，选词不会误关闭编辑。
- 节点标题悬停回调改为稳定引用，修复 `CanvasNode` 的 memo 被击穿导致的每次按键全量重渲染（大画布输入延迟）。

## 验证

- `smoke.mjs` / `smoke-runs.mjs` / `smoke-mcp.mjs` / `smoke-agent.mjs` 全部通过；新增断言覆盖未知字段拒绝、`place_nodes`/`set_viewport`、坐标取整、`fit_group`、`get_state` summary、`turnId` 查询。
- 官方插件（便签 / Markdown / HTML）已重新构建。

## 升级说明

- daemon：重启 `npm start` / `npm run daemon`（写入校验、工具、权限查询、视频与编辑框的 daemon 侧改动都在这边）。
- Web：刷新页面；插件在页面启动时加载，刷新即用新产物。
- 行为变化：写错字段名现在会报错；`canvas_get_state` 默认最多返回 200 个节点（带 `total` / `truncated`，可用 `limit` / `offset` 翻页）。

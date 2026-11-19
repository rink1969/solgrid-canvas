# solgrid-canvas

操作本地 solgrid 画布的 Agent 技能。用户说“在画布上…”“帮我把这些图放上去”“生成/重生成这个节点”“读一下画布”时使用本技能。

## 工具

全部通过 `solgrid-canvas` MCP 提供：

| 工具 | 用途 |
|---|---|
| `canvas_list_projects` | 列出本机画布，拿到 `projectId` |
| `canvas_get_state` | 读画布节点摘要与连线（先读再改） |
| `canvas_get_node` | 读单个节点及其上下游 |
| `canvas_apply_ops` | 批量改画布（原子，带 revision） |
| `canvas_place_artifacts` | 把产物放到画布并自动布点 |
| `canvas_import_local` | 本机文件导入项目资产 |
| `canvas_list_tools` / `canvas_inspect_tool` | 查平台模型与请求体契约 |
| `canvas_run_nodes` | 发起生成（需要用户在画布上点允许） |
| `canvas_watch_run` | 等生成结束 |
| `canvas_cancel_run` | 取消生成 |

## 规则

1. **先读后改**：改之前先 `canvas_get_state` 或 `canvas_get_node`，拿到真实节点 id 与 `rev`。
2. **不要自己算坐标**：需要往画布上放东西时用 `canvas_place_artifacts`（图片一列、文本一列，自动避让）。只有明确要求时才用 `canvas_apply_ops` 手动定位。
3. **生成前先确认模型**：节点上没选模型时先 `canvas_list_tools` + `canvas_inspect_tool` 确认 provider/endpoint 和参数，再 `canvas_run_nodes`。
4. **生成一定会请求用户审批**：`canvas_run_nodes` 会阻塞等待用户在画布上点“允许”。用户不点或拒绝就不要重试，先把情况告诉用户。
5. **参考素材**：上游连线节点的资产会自动作为参考图；不要把本地路径硬塞进 params。
6. **产物获取**：`canvas_watch_run` 返回 `outputs[].storageKey`（形如 `asset:<projectId>/<sha256>.<ext>`），需要再放到画布上用 `canvas_place_artifacts` 的 `storageKey` 字段。
7. **失败不静默**：run 状态为 `failed` / `uncertain` 时，把 `error` 转述给用户；`uncertain` 不要自动重跑。
8. **凭证**：不要读取或传递 solgrid API Key；一切生成由本地 daemon 完成。

## 典型流程

```
canvas_list_projects → 拿到 projectId
canvas_get_state(projectId) → 看节点
canvas_run_nodes(projectId, nodeId) → 等用户审批 → runId
canvas_watch_run(runId) → outputs
（可选）canvas_place_artifacts(projectId, anchorNodeId, items)
```

拉片这类多步骤任务：先在 Agent 侧完成抽帧与分析，产出文件写到本机，再用 `canvas_place_artifacts` 一次性放到视频节点右侧。

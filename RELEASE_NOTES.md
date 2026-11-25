# solgrid-canvas v0.1.3

solgrid 平台特化的本地无限画布：节点式生成图片/视频/音频，支持本地 Agent 通过 MCP 操作画布、通过 ACP 在画布内对话。

## 0.1.3 更新

- Agent/MCP 修改节点提示词后，已经打开的提示词面板会同步新内容；点生成使用新提示词，不再用面板里的旧本地草稿覆盖。
- 输入框聚焦时仍优先保留用户正在编辑的文字；生成刚结束时也不会把结果 prompt 回填、冲掉用户本次输入。

## 0.1.2 / 0.1.1 已包含

### 画布与生成
- 图片/视频/音频生成与「重新生成」遵循「新建节点 / 原地覆盖」偏好，默认新建。
- 失败/重试保留上次产物，失败提示条 4 秒后消失。
- 费用预估同一 meter 只取一档；支持 alibaba `wan3.0`（480P/720P/1080P、首尾帧、参考素材）。
- 导出→导入自包含；新建画布不再复制旧画布；连续新建节点自动错位。
- 便利贴 / Markdown / HTML 扩展节点；工具栏底部/左侧切换。

### Agent 与协作
- 每个画布独立多会话：对话/历史双标签，新建、切换、删除，transcript 落盘。
- `@` 引用画布资产；右键「发送到对话」与 @ 同链路。
- WorkBuddy ACP（`codebuddy --acp`）；MCP `serverName` 按项目+会话唯一化。
- 切换画布自动收起 Agent 面板；离开画布关闭 ACP 会话；悬浮面板支持自由拖动。
- 文本节点交给本地 Agent 生成，Agent 通过 `canvas_write_text` 写回。

## 升级

- daemon：重启 `npm run daemon` / `npm start`。
- Web：使用本包内 `web/dist` 或重新构建，刷新页面。
- 旧 conversation 的 ACP session 名已按会话唯一化，首次继续对话可能新建 ACP 会话；聊天记录与画布不受影响。

## 验证

- `tsc --noEmit` 通过。
- `smoke-mcp`、`smoke-runs`、`smoke-agent` 全部通过。

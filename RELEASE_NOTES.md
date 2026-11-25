# solgrid-canvas v0.1.4

solgrid 平台特化的本地无限画布：节点式生成图片/视频/音频，支持本地 Agent 通过 MCP 操作画布、通过 ACP 在画布内对话。

## 0.1.4 更新

- 修复文生语音“平台没有返回产物”：部分端点返回 `output: [{ audio: [{ base64, content_type }] }]`，daemon 现在会递归解析数组/嵌套结构并落成 mp3 资产。
- 平台状态 completed 但解析不到任何产物时，run 直接标记 failed，不再返回“成功但空”的结果。
- 音频 mime 支持读取 `content_type`。

## 0.1.3 / 0.1.2 / 0.1.1 已包含

- Agent/MCP 修改提示词后，已打开的提示词面板同步更新；生成使用新提示词。
- 悬浮 Agent 面板支持拖动；切换画布自动收起；MCP `serverName` 按项目+会话唯一化。
- 生成「新建节点 / 原地覆盖」偏好、失败保留旧产物、费用预估去重。
- 支持 alibaba `wan3.0`（480P/720P/1080P、首尾帧、参考素材）。
- 导出→导入自包含；新建画布不再复制旧画布；便利贴/Markdown/HTML 扩展节点。
- 多会话 Agent、@ 引用、右键「发送到对话」、WorkBuddy ACP。
- 文本节点交给本地 Agent 生成。

## 升级

- daemon：重启 `npm run daemon` / `npm start`。
- Web：使用本包内 `web/dist` 或重新构建，刷新页面。
- 旧 conversation 的 ACP session 名已按会话唯一化，首次继续对话可能新建 ACP 会话；聊天记录与画布不受影响。

## 验证

- `tsc --noEmit` 通过。
- `smoke-mcp`、`smoke-runs`、`smoke-agent` 全部通过。

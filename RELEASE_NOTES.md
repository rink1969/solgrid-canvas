# solgrid-canvas v0.1.2

solgrid 平台特化的本地无限画布：节点式生成图片/视频/音频，支持本地 Agent 通过 MCP 操作画布、通过 ACP 在画布内对话。

## 0.1.2 更新

- 悬浮的 Agent 面板支持按住顶部「拖动窗口」自由移动；位置持久化，并限制在视口内。
- 移除 GitHub Actions 的 Docker 镜像构建 workflow。

## 0.1.1 已包含

### Agent 与协作
- 每个画布独立多个会话：对话 / 历史双标签，支持新建、切换、删除，transcript 落盘。
- `@` 引用画布资产；节点右键「发送到对话」与 @ 同链路，插入带缩略图的引用 token。
- ACP 支持 WorkBuddy（CodeBuddy CLI `codebuddy --acp`）；MCP `serverName` 按项目+会话唯一化。
- 切换画布自动收起 Agent 面板；离开画布关闭 ACP 会话；修复旧会话 transcript 404。
- 文本节点交给本地 Agent 生成，Agent 通过 `canvas_write_text` 写回，遵循生成偏好。

### 生成与画布
- 生成与「重新生成」遵循「新建节点 / 原地覆盖」偏好，默认新建。
- 失败/重试保留上次产物；状态条 4 秒后消失。
- 费用预估同一 meter 只取一档，修复报价翻倍。
- 支持 alibaba `wan3.0`（480P/720P/1080P、首尾帧、参考素材）。
- 便利贴 / Markdown / HTML 扩展节点恢复；工具栏可切底部/左侧；Agent 面板可悬浮。
- 导出→导入自包含；新建画布不再复制旧画布；连续新建节点自动错位。

## 升级

- daemon：重启 `npm run daemon` / `npm start`。
- Web：使用本包内 `web/dist` 或重新构建，刷新页面。
- 旧 conversation 的 ACP session 名已按会话唯一化，首次继续对话可能新建 ACP 会话；聊天记录与画布不受影响。

## 验证

- `tsc --noEmit` 通过。
- `smoke-mcp`、`smoke-runs`、`smoke-agent` 全部通过。

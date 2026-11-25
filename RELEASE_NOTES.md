# solgrid-canvas v0.1.1

solgrid 平台特化的本地无限画布：节点式生成图片/视频/音频，支持本地 Agent 通过 MCP 操作画布、通过 ACP 在画布内对话。

## 这一版的重点

### Agent 与协作
- 每个画布独立多个会话：对话 / 历史双标签，支持新建、切换、删除，transcript 落盘。
- Agent 对话可 `@` 引用画布资产；节点右键「发送到对话」与 @ 同链路，插入带缩略图的引用 token。
- ACP 支持 WorkBuddy（CodeBuddy CLI `codebuddy --acp`）；MCP `serverName` 按项目+会话唯一化，兼容把 serverName 当全局键的旧实现。
- 画布切换时自动收起 Agent 面板；离开画布关闭 ACP 会话；修复旧会话导致 transcript 404。
- 文本节点改为本地 Agent 生成：Agent 通过 `canvas_write_text` 写回，输出遵循「新建节点 / 原地覆盖」偏好。

### 生成与画布
- 图片/视频/音频生成与「重新生成」统一遵循「新建节点 / 原地覆盖」偏好，默认新建节点。
- 生成失败/重试保留上一次产物；状态条 4 秒后自动消失，不再吞掉已成功的结果。
- 生成前费用预估对同一 meter 只取一档，修复同一 rate 多档累加导致的报价翻倍。
- 支持 alibaba `wan3.0` 视频端点（480P/720P/1080P、首尾帧、参考图/视频/音频）。
- 恢复便利贴、Markdown、HTML 扩展节点（随构建产物发布，默认启用）。
- 新建画布不再复制上一张画布；连续新建节点自动错位。
- 导出→导入画布改为自包含：资产复制到新项目并重写 storageKey/URL，删除原项目后媒体仍可用。

### 配置与文档
- 工具栏「外观」可切底部/左侧；Agent 面板可悬浮/停靠。
- 节点右键菜单把「发送到对话」与节点操作分组。
- `/api/approvals` 支持顶层 prompt / params.prompt / 节点 prompt 回退；`add_node` 的 `type:"file"` 按语义类型还原。
- AI_SETUP 增加 ACP 方法契约与兼容性说明；README 增加 Agent 兼容性说明。

## 升级

- daemon：重启 `npm run daemon` / `npm start`。
- Web：重新构建或使用本包内 `web/dist`，刷新页面。
- 旧 conversation 的 ACP session 名已按会话唯一化，首次继续对话可能新建 ACP 会话；聊天记录与画布不受影响。

## 验证

- `tsc --noEmit` 通过。
- `smoke-mcp`、`smoke-runs`、`smoke-agent` 全部通过（含 wan3.0 480P、add_node file、write_text）。

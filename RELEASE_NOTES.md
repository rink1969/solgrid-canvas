# solgrid-canvas v0.1.0

solgrid 平台特化的本地无限画布：节点式生成图片/视频/音频，支持本地 Agent 通过 MCP 操作画布、通过 ACP 在画布内对话。

## 这一版能做什么

- **本地画布**：节点、连线、图片/视频/音频节点；项目数据落在 `~/.solgrid-canvas/projects/`，`canvas.json` 可直接被 Agent / Obsidian 读写
- **solgrid 生成**：平台模型目录驱动（生图/生视频/生音频），单账号串行队列、幂等键、产物自动落地、失败/不确定状态区分
- **生成前成本预估**：确认框显示参考图/输出数量、视频时长与分辨率，以及预计 Spark
- **局部重绘**：蒙版局部修改、多角度、图片重新生成
- **视频片段重生成**：时间轴选段 → 首尾帧 i2v 或整段重编辑 → 本地 ffmpeg 拼接，音频沿用原音轨
- **Agent 双向集成**
  - MCP：`canvas_*` 11 个工具（读画布、改画布、导入素材、自动布点、发起生成、等待结果、取消）
  - ACP：画布右侧面板直接和本地 Agent 对话（默认 DSH，可用 `CANVAS_ACP_COMMAND` 接其他适配器）
  - 生成花费必须经用户确认；MCP 导入路径有白名单
- **本地优先 / 安全**：只监听 `127.0.0.1`，token 存 `~/.solgrid-canvas/daemon.json`，浏览器不持有 solgrid Key

## 安装

### 方式一：让本地 Agent 帮你装

把仓库根目录的 [`AI_SETUP.md`](AI_SETUP.md) 整篇发给你的 Agent（Claude Code / Codex / DSH），它会完成依赖安装、启动、MCP 注册与验收。

### 方式二：手动

```bash
npm --prefix web install
npm run build
npm start
# 打开 http://127.0.0.1:17371
```

要求：Node ≥ 22、`solgrid` CLI（已登录）、`ffmpeg`/`ffprobe`（视频功能需要）。

## 已知限制

- 平台账号级只允许 1 个在途 run；画布按串行排队
- 视频片段重生成的「整段重编辑」模式接缝依赖模型，首尾帧模式更稳
- 生成产物 URL 约 24h 过期，画布会把产物落到本地资产
- Agent 会话（ACP）目前默认只支持 DSH；其他 Agent 需要 ACP 适配器

## 校验

```bash
node bin/solgrid-canvas.mjs doctor
```

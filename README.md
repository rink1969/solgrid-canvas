# solgrid canvas

适用于solgrid平台的画布产品

## solgrid平台介绍

网址 https://solgrid.ai

solgrid是一个本地Agent友好的视频制作平台。

上面有大量的制作视频案例并附带了skill，方便用户使用本地的个人Agent参考，用以制作同类的视频。

同时为了方便用户接入各家视频模型，它还是一个生图，视频，音频以及相关服务的中转站。 详细情况参见 https://solgrid.ai/tools 

平台本身是Agent友好的，所有功能都可以通过用户自己的Agent完成。详情参见平台的skill https://solgrid.ai/SKILL.md

## Canvas

为了满足长视频和专业用户的需求，现增加画布功能。

功能要求上与libtv，即梦等类似，但是与他们不同的是，solgrid canvas不作为平台的一部分，而是更追求与本地Agent的结合。

使用过程：

1. 用户到solgrid网站注册充值，获取api key。

2. 给本地的agent（dsh，codex等）安装平台skill。自动安装solgrid cli并引导用户完成配置。

3. 当要制作长视频或者比较专业的视频时，安装 solgrid canvas。该 canvas 直接复用本地Agent的语言模型配置，复用本地已经配置好的solgrid信息来接入生图，视频，音频等模型，无需额外的配置。

4. 用户可以通过与本地Agent对话来操作画布。在画布上也可以复用本地Agent的能力，比如本地Agent已经配置好一个拉片的skill，画布上可以使用它来对画布上的视频节点进行拉片分析，产出的图片和文字描述以节点的方式自动放在画布上。

## 快速开始（生产）

```bash
git clone git@github.com:rink1969/solgrid-canvas.git
cd solgrid-canvas
npm --prefix web install
npm run build
npm start
# 打开 http://127.0.0.1:17371
```

`npm start` 会启动 daemon 并直接托管构建后的前端；首次访问自动下发鉴权 cookie。要求本机有 `solgrid` CLI 并已登录；视频片段重生成还需要 `ffmpeg`/`ffprobe`。

### 让 Agent 帮你装

把 [AI_SETUP.md](AI_SETUP.md) 整篇发给本地 Agent，它会自动安装依赖、启动 daemon、识别自己并注册 MCP。

## 快速开始（开发）

```bash
npm run daemon      # 终端 1
npm run dev         # 终端 2，http://localhost:3000
```

`install` 命令会自动把 token 写进 `web/.env.local` 供 Vite 代理使用。

项目数据落在 `~/.solgrid-canvas/projects/<id>/`：`project.json`（元信息）+ `canvas.json`（JSON Canvas 1.0，Agent 可直接读写）+ `assets/`（内容寻址资产）。

## 给 Agent 接入

```bash
npm run daemon                              # 先起 daemon
node bin/solgrid-canvas.mjs install --agent codex   # 或 claude / dsh
node bin/solgrid-canvas.mjs doctor          # 检查环境
# DSH 用户按当前 profile 安装（desktop / web / ...）
node bin/solgrid-canvas.mjs install --agent dsh --profile <profile>
# 把该 profile 的 provider/默认模型同步给画布使用的 ACP profile
node bin/solgrid-canvas.mjs sync-config --from <profile> --profile acp
```

画布右下角还有「Agent」入口：在画布内直接和本地 Agent 对话（ACP），它同样带着画布工具，可以边聊边改。

装好后在 Agent 里直接说：“在画布上建 3 个文本节点连成链”“读一下我选中的节点”“把这几张图放到视频节点右边”“生成这个图片节点”。Agent 发起生成时画布会弹确认框，你点允许才会计费。

## 文档

| 文档 | 内容 |
|---|---|
| [REQUIREMENTS 即本文件](#canvas) | 需求与产品定位 |
| [AI_SETUP.md](AI_SETUP.md) | 让本地 Agent 自动安装并配置画布 |
| [TECH_PLAN.md](TECH_PLAN.md) | 技术方案：架构、子系统、接口、里程碑、风险 |
| [notes/solgrid-findings.md](notes/solgrid-findings.md) | 平台实测结论（并发、幂等、URL 过期、日预算、无 mask inpaint） |
| [notes/lapian-methodology.md](notes/lapian-methodology.md) | 拉片方法论（抽帧、拼图、三轮 vision、产出布点） |
| [daemon/README.md](daemon/README.md) | daemon 接口、数据布局、自测 |
| [AGENTS.md](AGENTS.md) | 本项目开发约束（架构铁律） |
| [upstream_readme.md](upstream_readme.md) | 上游 infinite-canvas 原始 README（历史参考） |

## Agent 兼容性

画布 daemon 通过 ACP 驱动本地 Agent，按 stdio NDJSON 调用 `initialize / session/new / session/prompt / session/cancel / session/close` 等标准方法。推荐 DSH `0.2.2-rc.5` 及以上；旧版 dsh-acp 可能存在工具状态不回收、同一 serverName 多会话冲突的问题。WorkBuddy 通过 CodeBuddy Code CLI 的 `codebuddy --acp` 接入。

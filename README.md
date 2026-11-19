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

## 快速开始（开发）

当前进度：**M0（daemon + 项目目录存储）**。生成、资产、Agent 桥还没接上。

```bash
# 1. 起本地 daemon（零依赖，不用 npm install）
npm run daemon

# 2. 把 daemon 打印的 token 填进 web/.env.local（参考 web/.env.example）
cp web/.env.example web/.env.local && $EDITOR web/.env.local

# 3. 起画布前端
npm run dev
```

项目数据落在 `~/.solgrid-canvas/projects/<id>/`：`project.json`（元信息）+ `canvas.json`（JSON Canvas 1.0，Agent/Obsidian 可直接读写）+ `assets/`（M1 接入）。

## 文档

| 文档 | 内容 |
|---|---|
| [REQUIREMENTS 即本文件](#canvas) | 需求与产品定位 |
| [TECH_PLAN.md](TECH_PLAN.md) | 技术方案：架构、子系统、接口、里程碑、风险 |
| [notes/solgrid-findings.md](notes/solgrid-findings.md) | 平台实测结论（并发、幂等、URL 过期、日预算、无 mask inpaint） |
| [notes/lapian-methodology.md](notes/lapian-methodology.md) | 拉片方法论（抽帧、拼图、三轮 vision、产出布点） |
| [daemon/README.md](daemon/README.md) | daemon 接口、数据布局、自测 |
| [AGENTS.md](AGENTS.md) | 本项目开发约束（架构铁律） |
| [upstream_readme.md](upstream_readme.md) | 上游 infinite-canvas 原始 README（历史参考） |


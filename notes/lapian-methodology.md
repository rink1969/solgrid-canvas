# 拉片方法论（移植自 solgrid fork 的 plugins/canvas/lapian/SUMMARY.md）

> 来源：D:\data\github\infinite-canvas（solgrid fork，仅作参考，不继承代码）
> 用途：方法论与提示词框架保留；v1 由 Agent 技能执行，内置管道按需再做。


## 需求

在 infinite-canvas 画布中提供一个专门的「逐帧拉片」节点（对标 libtv 的拉片面板）：

- 上游：一个视频节点（连线输入）；
- 下游：一批产出节点——关键帧截图、主要人物/物品截图、全局概览/视觉风格/运动轨迹/分镜表/复刻提示词文本节点；
- 抽帧、拼图、多模态分析全部在节点内部完成，中间无需用户交互；
- 产出落到画布后，由用户自行挑选、连线给新的生成节点用于复刻。

拉片方法论参考 `video-reverse-engineering` skill（自适应抽帧、连环画拼图、两轮阅读法、蓝图模板、风格限定语、水印隔离）。

## 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 插件节点 vs 内置节点 | 官方插件 `plugins/canvas/lapian`（`lapian:reverse`） | 画布已有插件体系，节点 UI / 画布操作 / AI 调用 / 主题 / 存储全部由 SDK 提供，不侵入核心 |
| vision 调用通道 | 宿主 `generateText` 增加 `images` 参数（方案 B） | 备选方案（applyOps 建临时节点 + run_generation 借道）会让中间拼图污染画布、拿不到 Promise/错误/进度、无法 abort |
| 视频来源 | 仅支持已落地画布本地存储的视频（blob/data URL） | 远程 URL 受 CORS 限制；v1 不加 fetchMedia 宿主 API，遇到时明确报错提示 |
| 中间交互 | 无（一轮跑完） | 用户明确要求；多风格视频按整片逐段独立成节，不做中段打断 |
| 音乐维度 | v1 不做（面板置灰展示） | 浏览器端无音轨内容分析能力 |

## 改动清单

### 宿主（infinite-canvas）

| 文件 | 改动 |
| --- | --- |
| `web/src/types/canvas-plugin.ts` | `GenerateTextOptions` 增加 `images?: string[]` |
| `web/src/pages/canvas/hooks/use-plugin-host.tsx` | `generateText` 有 images 时组装多模态 `AiTextMessage`（`requestImageQuestion` 本就支持多模态，纯暴露参数） |
| `plugins/canvas/sdk/src/types.ts` | SDK 类型镜像同步 |
| `plugins/canvas/registry/build.mjs` | 官方插件登记表新增 lapian |
| `CHANGELOG.md` / `docs/content/docs/progress/pending-test.mdx` | 变更记录与验收项 |

### 插件（plugins/canvas/lapian）

| 文件 | 职责 |
| --- | --- |
| `src/frames.ts` | 浏览器端自适应抽帧（seek + 8×8 分块差异 + 二分补帧）、连环画拼图（3×3、单格 512px、烧录 `#序号 时间戳`）、主体 bbox 本地裁剪 |
| `src/prompts.ts` | 三轮 vision 提示词（浓缩自 skill 的分析框架与蓝图模板） |
| `src/pipeline.ts` | 流水线编排：取视频 → 抽帧 → 拼图 → 粗读选帧 → 精读成稿 → 主体识别 → applyOps 建产出节点+连线 |
| `src/index.tsx` | 节点卡片（状态展示）与下方面板（视频素材、模型选择、维度勾选、开始/停止、进度、结果统计） |

## 流水线

```
上游视频节点(blob URL)
  → 自适应抽帧:1s 稀疏 → 8×8 分块差异(top 25% 块)> 0.015 的区间二分补帧至 0.25s,上限 32 帧
  → 连环画拼图:3×3、单格 512px、JPEG 0.85、烧录帧序号+时间戳,≤4 张
  → vision ① 粗读(全部拼图):一句话概括、镜头分段、风格一致性、选 3–5 关键帧、识别叠加文字
  → vision ② 精读(拼图 + 全分辨率关键帧):产出 5 段成稿(概览/风格/运动/分镜/复刻提示词)
  → vision ③ 主体识别(关键帧原图):≤3 个主体的归一化 bbox → 本地裁剪;bbox 无效退化为整帧并标注"未裁剪"
  → applyOps:拉片节点右侧两列建产出节点(图片列 + 文本列),逐个与拉片节点连线
```

- 主体识别失败不阻断整体交付（面板提示原因）；其余轮失败即终止报错；
- 「停止」通过 AbortSignal 贯穿抽帧与 vision 调用，立即停止且不产出任何节点；
- 运行状态存模块级 store，面板关闭重开不丢进度；最近结果写入节点 metadata。

## 使用方法

1. 构建并启用：
   ```bash
   cd plugins/canvas/lapian && npm install && npm run build   # 或 npm run dev 起 watch
   ```
   构建产物自动同步到 `web/public/plugins/lapian.js`，lapian 默认启用，刷新画布页面即可直接使用（显式禁用过的记录仍尊重其设置）；本地开发可在 `web/.env.local` 加 `VITE_DEV_PLUGINS=/plugins/lapian.js` 让改动即时生效。
2. Channels 里配置一个**带视觉能力的文本模型**（如 qwen-vl / gpt-4o 类），拉片分析走该模型；
3. 画布上：视频节点 → 连线到「逐帧拉片」节点（创建菜单里可搜到）→ 单击节点打开面板 → 选模型、勾选维度 → 开始拉片；
4. 完成后产出节点出现在拉片节点右侧，按需连线给新的生成节点。

## 边界值（默认值）

| 环节 | 默认值 | 超限处理 |
| --- | --- | --- |
| 稀疏抽帧间隔 | 1.0s（长视频自动加大到 duration/32） | — |
| 补帧最小间隔 | 0.25s | 二分到此为止 |
| 分块差异阈值 | 0.015（8×8 网格取 top 25% 块） | — |
| 最大帧数 | 32 | 停止补帧 |
| 拼图 | 3×3、单格 512px、整图 ≤2048px、JPEG 0.85 | 帧多自动拆多张 |
| vision 调用 | 3 次/次拉片 | 失败即终止，不自动重试 |
| 关键帧 / 主体截图 | 3–5 张 / ≤3 个 | 模型选帧后裁剪 |

## 已知限制与后续方向

- 输入仅限本地已落地视频；远程 URL 视频需要宿主提供走代理的 fetchMedia 能力后才能支持；
- 音乐维度需要音轨分析能力（ffmpeg.wasm 或音频多模态模型），v2 再议；
- 多镜头风格差异明显的视频当前按整片逐段独立成节，无中段打断让用户选段的交互；
- 拉片中途刷新页面，进行中的任务不恢复（与画布 script 模型一致的限制）。

## 验收

见 `docs/content/docs/progress/pending-test.mdx`「逐帧拉片插件」条目。

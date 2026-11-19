# 平台实测要点（移植自 solgrid fork 的 scripts/solgrid/README.md）

> 来源：D:\data\github\infinite-canvas（solgrid fork，仅作参考，不继承代码）
> 用途：这些是花了几十次真实调用换来的契约/坑位结论，落在本仓库继续维护。


三个文件：

| 文件 | 作用 |
|---|---|
| `solgrid-canvas.script.js` | 粘贴到 Infinite Canvas 模型脚本里的那段代码（文生图 + 文生视频同一份） |
| `selftest.mjs` | 离线自检：用 mock 网络跑一遍脚本，并把请求体对照 `tool-definitions.json` 的 `InputSchemaJson` |
| `live-check.mjs` | 真实连通性检查（真提交 run，需要 Solgrid 余额） |
| `live-script-test.mjs` | 画布行为仿真：把 `solgrid-canvas.script.js` 原样并发跑 N 次（“数量 N”就是画布做的事），验证排队/让路/重试 |

## 选的两个模型

| 能力 | Provider | Endpoint | 执行 | 价格（inspect 实测） |
|---|---|---|---|---|
| 文生图 | `alibaba` | `/v1/image/qwen-image-3.0` | sync（直接返回） | output image ≈ $0.035/张（1K tier），参考图 $0.003/张 |
| 文生视频 | `bytedance` | `/v1/video/seedance-2.0-mini` | async（轮询） | 实测 $0.182 / 条（480p 4s） |

脚本里还有 `qwen-image-3.0-pro`、`wan2.7-image(-pro)`、`seedance-2.0(-fast)`、`seedance-2.5` 这几个同契约的模型名，改模型名即可切换。

## wan 系列视频模型（alibaba / DashScope 契约）

| 模型名 | 用途 | 参考素材 | 分辨率 | 时长 |
|---|---|---|---|---|
| `wan3.0` / `wan3.0-prime` | 通用：文生视频 + 首尾帧 + 全能参考 + 参考音视频 | 首/尾帧各 ≤1、参考图 ≤10、参考视频/音频各 ≤5 | 480p/720p/1080p | 2–30s |
| `wan2.7-t2v` | 纯文生视频（可带一条驱动音频） | 不支持参考图/视频；音频 → `input.audio_url` | 720p/1080p | 2–15s |
| `wan2.7-i2v` | 图生视频 | 首帧/尾帧（≤2 图）、`first_clip` 续拍视频、`driving_audio` 驱动音频 | 720p/1080p | 2–15s |
| `wan2.7-r2v` | 参考生视频 | 参考图 + 参考视频合计 ≤5（可加 1 张首帧）；不支持音频 | 720p/1080p | 2–15s |
| `wan2.7-videoedit` | 视频编辑 | 恰好 1 个待编辑视频 + ≤4 张参考图 | 720p/1080p | 2–10s |

画布语义映射不变：≤2 张图 = 首尾帧（frames），>2 张 = 全能参考（reference）。wan 的 body 是 `{ input: { prompt, media[] }, parameters }`（DashScope 风格），与 seedance 的 content 数组不同，脚本内部按模型名自动分流。模型不支持的素材类型会直接报错并提示换哪个模型，不会静默丢弃。注意：wan3.0 的 `audio` 参数对应画布的"生成音频"开关；wan2.7 系列没有该开关，音频只能来自驱动音频输入。

## 语音合成（MiniMax TTS）

画布模型名用 MiniMax 的 `speech-*` 模型名（如 `speech-2.8-turbo`，脚本按此前缀分流到 `/v1/t2a_v2`；`-turbo` 约 $60/百万字符，`-hd` 约 $100/百万字符）。画布的"声音/语速/格式"设置分别映射到 `voice_setting.voice_id` / `speed` / `audio_setting.format`；画布默认的 OpenAI 音色名（alloy 等）会自动换成 MiniMax 系统音色 `male-qn-qingse`，要指定 MiniMax 音色就在音频设置里填具体 voice_id。返回的 hex 音频在脚本内解码为 Blob 交给画布落地。

## 在画布里配置

**一键方式（推荐）**：设置 → 渠道 → 「添加 Solgrid 渠道」按钮，渠道、全部模型、调用脚本自动就位，只需填入自己的 API Key（`tl_...`）。

手动方式：

1. Channels → Add channel
   - Base URL：`https://api.solgrid.ai`
   - API Key：`tl_...`（Solgrid 的 key）
   - API 格式选什么都行 —— 有模型脚本时画布走脚本，不走 OpenAI/Gemini 请求
2. 在该 channel 下添加模型：`qwen-image-3.0`（capability = image）、`seedance-2.0-mini`（capability = video）
3. 每个模型右侧的 **脚本 / Script** 按钮 → 把 `solgrid-canvas.script.js` 整段粘贴进去 → Save
4. 画布上选该模型，Run

同一份脚本图/视频都能用：脚本靠模型名决定走哪条 route；模型名不在 catalog 里时，`params.seconds > 0` 走视频、否则走图片默认 route。

## 画布参数 → Solgrid 字段

| 画布注入 | 映射 |
|---|---|
| `prompt` | 图片：`input.messages[0].content[0].text`；视频：`content[0] = {type:"text", text}` |
| 参考图（data URL string[]） | 先上传 `POST /api/v1/file/upload` → `downloadUrl` → 图片 `content[].image`，视频 `content[].image_url` + `role`（见下面 `params.mode`） |
| `videos` / `audios`（画布注入的是 **File/Blob**，不是 data URL） | 同样上传成公网 URL，作为 `video_url` / `audio_url` + `role: reference_video/reference_audio` |
| `params.size`（`1024x1024` / `16:9`） | 图片 `parameters.size`（`W*H`，按 1K/2K preset 换算并钳到模型像素上限） |
| `params.count`（画布“数量”） | 不映射到 `parameters.n`：画布的“数量 N”是**并发调用脚本 N 次**，每次只出 1 张；要一次多张传 `params.n` |
| `params.resolution` | 视频 `resolution`（钳到该模型允许的档位，如 mini 只有 480p/720p） |
| `params.seconds` | 视频 `duration`（seedance 4–15，2.5 可到 30） |
| `params.ratio` | 视频 `ratio`，未知值 → `adaptive` |
| `params.generateAudio` | 视频 `generate_audio` |
| `params.mode`（画布 `videoMode`：`frames` / `reference`） | `frames` → 第 1 张 `first_frame`、第 2 张 `last_frame`（且 `ratio` 必须 `adaptive`）；`reference` → 所有图都是 `reference_image`，`ratio` 保持用户选的值。画布的规则是“>2 张图自动变 reference” |

## 实测出来的契约细节（写脚本时踩过）

- `POST /v1/runs/create` 的 body 是 `{ provider, endpoint, input: { body: <provider 请求体> } }` —— **不是**把请求体直接放 `input`。放错会得到 `400 alibaba_input_contract_invalid`。
- 有 `first_frame`/`last_frame` 时 `ratio` 必须是 `adaptive`（固定 ratio 会报 `400 bytedance_frames_require_adaptive_ratio`），脚本自动处理。
- 参考图上传的响应 `POST /api/v1/file/upload` 已经带签名 `url`，脚本直接用它，不再二次调 `download-url`。上传时不能把 FormData 当 JSON 序列化（实测 `415 Unsupported Media Type`）——画布的 `request` 是 axios，FormData 会自动变 multipart，所以脚本里直接 `data: form` 是对的。
- 文生图是 **sync**：`/v1/runs/create` 会阻塞 46–60s，Cloudflare 偶尔会吐 `504/520`（实测 ~20 次里 1 次）。脚本现在遇到 502/503/504/520/521/522 或网络层失败时，会用**同一个 Idempotency-Key** 调 `/v1/runs/get-by-idempotency-key` 找回那个 run（生成在服务器端仍在跑），找到就直接轮询到 COMPLETED；只有 lookup 返回 404（真的没创建）才重新提交 —— 这样不会重复扣费。CLI 也是同样的逻辑（create 失败后 `lookupByKey`）。
- `/v1/runs/get-by-idempotency-key` 的入参是 `{ idempotencyKey }`，不存在时返回 `404 tool_run_not_found`；存在时返回同一个 run（带 `output`）。
- 响应统一是 `{ success, code, message, errorData, data }`；`errorData` 里是 `{ errorCode, errorMessage }`。
- run 状态：`COMPLETED` 是成功；`FAILED / BLOCKED / TIMED_OUT / STOPPED` 是终态失败（脚本遇到这些直接抛错，不会死循环轮询）。
- qwen-image 的 `prompt_extend: false` 会报 `alibaba_thinking_requires_prompt_extend`（thinking 默认开）——脚本里不再显式设它。
- 结果取 `data.output.images[].url` / `data.output.videos[].url`；脚本还兜底扫描 `content.video_url` 等形状。
- API 的 CORS 是 `access-control-allow-origin: *`，所以浏览器直连没问题，**不需要转发服务**。
- 但结果/参考图的文件 URL 是阿里云 OSS 签名地址（约 24 小时过期，且不带 CORS 头）。画布拿不到 blob 时会退化成"直接引用远端 URL"，节点能用，但**不落地、过期后会失效**。

## 验证

```bash
node scripts/solgrid/selftest.mjs                 # 离线：语法 + 契约 + 结果解析 + 并发/重试/abort/mode 路径，28 个 case 全过
node scripts/solgrid/live-check.mjs --key tl_... qwen-image-3.0 "a red flower"
node scripts/solgrid/live-script-test.mjs --slots 3 --model qwen-image-3.0 "a red flower"   # 真画布并发 3 slot 的行为
```

key 没设置时请求头会变成 `Bearer undefined` → `401`（这不是契约问题，`live-check.mjs` 现在先检查 key 格式、打印 whoami + balance，再提交 run，结束时打印扣费后的余额）。

## 实测结果（真实生成，已跑通）

| 路径 | 模型 | 结果 | 实际扣费 |
|---|---|---|---|
| 纯文生图 | qwen-image-3.0（1024x1024） | 1024×1024 PNG ✓ | $0.03506 |
| 参考图 + 指令（data URL 上传 → 公网 URL） | qwen-image-3.0 | 1024×1024 PNG，参考图生效 ✓ | $0.03896 |
| 纯文生视频（480p 4s） | seedance-2.0-mini | 864×496 4.04s MP4 ✓ | $0.18186 |
| 首帧图 → 视频（data URL 上传，ratio 自动 adaptive） | seedance-2.0-mini | 864×496 4.04s MP4 ✓ | $0.18186 |

下载好的样本在 `.tmp/solgrid_samples/`。`/v1/runs/list` 只返回 `runId/status/cost`，拿结果要再调 `/v1/runs/get`。

预算参考：按 huachaoyizhang 蓝图铺 25 个关键帧 —— 全部出图 ≈ $0.9，全部出视频（480p/4s）≈ $4.5。充值 $100 足够跑几十轮。

## 视频节点“卡了很久还没结束” —— 实测根因（脚本 × 画布适配）

画布对 script 模型**没有任何超时**：`createPluginVideoTask` 是“一次跑完 create+poll 才返回 task”，所以脚本不返回 = 节点一直 loading。真正卡住的 5 个原因（全部已修）：

1. **`params.mode` 被忽略** —— 旧脚本按张数猜 role：3 张图 → `first_frame` + `last_frame` + `reference_image`。实测 seedance-2.0-mini 对这种混合形状直接 `FAILED: tool_execution_failed`（连跑 4 次都失败），脚本重试 5×3 次、每次 sleep 8–24s，节点看起来就是“卡死”。现在读 `params.mode`：画布 ≤2 张 → `frames`（首/尾帧），>2 张 → `reference`（全部 `reference_image`，比例保持用户选择）。
2. **参考图上传是串行** —— 单个上传实测 3–4s（大图可达 37s），9 张关键帧 = 几分钟。现在 `Promise.all` 并发 + 同一次调用内按内容 hash 缓存（3 张 346KB 从 ~10s 降到 ~3.4s）。
3. **视频 slot 不排队** —— `activeRuns()` 之前只过滤 `/image/`，视频 run 互相看不见 → 两个 run 同时提交 → 撞车 → 僵尸 `RUNNING` run 占死账号级 in-flight 槽 → 后面每个 slot 都永远等不到空槽。现在所有 active run 都计入，撞车时让路（`/v1/runs/stop` 停自己）。
4. **轮询一次网络抖动就终止** —— 实测 `/v1/runs/get` 偶发 `fetch failed`，整个脚本直接抛错（画布没有重试）。现在非 create 的瞬时失败（网络层 / 5xx / 429）重试 3 次；create 仍走 idempotency-key 找回，不会重复扣费。
5. **画布取消 / 二次 Run 不 stop 远端 run** —— 画布 abort 只 abort 本地 axios，Solgrid 那边继续 RUNNING，占住槽。现在脚本在 `signal` abort 时调 `/v1/runs/stop` 停自己的 run。

时间预算（脚本自带，因为画布没有）：图片 10 min、视频 15 min（视频 poll 单次 10 min + 僵尸检测 2 min：RUNNING 超过 2 min 且有别的 active run → 主动 stop 重试）。

实测：`seedance-2.0-mini` 480p/4s + 3 张参考图（reference mode）→ **167s 完成**，扣 $0.18186。纯文生图 46–60s。所以“慢”本身正常：画布对 script 模型没有进度条，只有节点转圈。想快：`数量 1`、`480p`、`4–6s`、参考图 ≤2 张。

> 另一个画布侧的限制（不是脚本能修的事）：script 模型的 video task 结果只存在内存 `pluginVideoResults` Map，**刷新页面后 node 的 loading 状态不可 resume**（`pollVideoTask` 会报 `pluginVideoExpired`）。生成中途刷新 = 节点废掉，只能重跑。

## 画布“数量 N”只成功 1 张 —— 根因与修正

画布 workbench 的“数量 3”不是“一次出 3 张”，而是 `Promise.allSettled` **并发发 3 个请求**（`pages/image/index.tsx` 的 `runGenerationSlot`），每个请求只取 `result[0]`。而 Solgrid **账号级只能跑一个 in-flight run**，实测（同一个 key，不同 endpoint 也一样）：

- 3 个并发 create → 全部失败：一个 `tool_service_unavailable`（source: provider），两个 `HTTP 500 code 99999`；对应的 run 变成僵尸 RUNNING，最后 `FAILED: tool_result_unconfirmed`（扣费 0，所以重试不会重复扣钱）
- 不同 endpoint 并发（qwen + wan2.7-image）同样撞车

脚本现在做三件事：
1. **提交前随机错开 + 排队**：查 `/v1/runs/list`，有 active run 就等 6s 再试
2. **撞车时让路**：runId 是时间序，最早的 run 继续，其余调 `/v1/runs/stop` 主动停自己再重试（不然会卡成僵尸 run 直到超时）
3. **失败不盲重提交**：先 `get-by-idempotency-key` 找回那个 run（见上面的 504 逻辑）

实测 `live-script-test.mjs --slots 3`（真画布并发 3 slot）：**3/3 成功，总耗时 163.6s，共扣 $0.10518**（串行 3 × $0.035），没有僵尸 run。

另外 `422 daily_budget_exceeded`（“Insufficient available daily budget, including reservations for unsettled calls”）是 Solgrid 的**日预算 / 在途 reservation**，不是钱包余额 —— 钱包有 $98 也可能触发。脚本把它当可重试（等 20–70s 再试），真用完才报错。

## Proxy 要不要停？

不用停，也没必要开。实测两条路径都通：直连 `https://api.solgrid.ai`（CORS 是 `access-control-allow-origin: *`）和经 `canvas-proxy`（46–59s 返回 200）。所以 504 不是 proxy 的问题，是上游网关在 sync 长阻塞请求上偶发超时。

要么：proxy 保持运行 + 配置里 Proxy 开关开着；要么：关掉 Proxy 开关直连。二者不能是“开关开着但 proxy 没跑” —— 那种会报连接失败。

## 什么时候才需要"转发服务"

不需要：Solgrid API 的 CORS 全开，脚本直连可行。

需要的情形（这时写一个 30 行的小 Node 代理，或开画布自带的 Proxy）：
- 不想把 `tl_...` key 暴露在浏览器/localStorage
- 想让远端结果落地到画布本地存储（OSS 签名 URL 会过期）——画布设置里的 **Proxy**（`@basketikun/canvas-proxy`）就是现成的转发：开启后 `uploadImage` / `uploadMediaFile` 走本地代理取字节
- 需要排队/重试/计费报表这类 CLI 语义，或想在服务端把多个 provider 的响应归一化

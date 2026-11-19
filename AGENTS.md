# AGENTS.md

本文件是本项目的 AI / 自动化开发约束。优先级：**用户当前消息 > 本文件 > 代码的历史写法**。

本项目是基于 `basketikun/infinite-canvas` 代码起点改造的 **solgrid 平台特化本地画布**（本地 daemon + 浏览器 UI）。
**不追求与上游兼容或合并**：可以大改、可以删除上游功能、可以改数据结构；上游只作为代码来源。

---

## 一、基本原则

- 先读现有代码再动手；优先沿用项目已有结构、命名和写法。
- 最少行数、最少抽象；不为"以后可能需要"预先加分支。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先用成熟稳定的库，不手写底层实现。
- **项目尚未上线**：不做旧数据兼容、不写迁移兜底；存储结构直接按新设计改。
- 不改无关文件，不顺手重构。
- 写完代码不代为构建、不做语法检查（用户自己会跑）。
- 如果某个问题反复出现、或被用户反复提醒，把它补成本文件里**可执行**的规则。

---

## 二、架构铁律（违反即返工）

1. **项目目录是唯一事实源**：`projects/<id>/` 下的 `canvas.json`、`assets/`、`runs.sqlite`、`timeline.json`、`exports/` 就是产品数据；Agent 通过文件系统直接读写。
2. **节点只存 `assetId`**：禁止把 dataURL / base64 / Blob 写进画布文档、前端 store 或日志。资产一律内容寻址落盘（`assets/<sha256>`）。
3. **只有 daemon 发起付费调用**：web 端不直连任何生成 API，不持有 solgrid API key，不持有任何模型凭证。
4. **生成只走 `solgrid` CLI**：`solgrid run -p … -e … -f body.json --idempotency-key K -j`（**不带 `--wait`**）+ `solgrid runs get -r R -j` 轮询。幂等键由 daemon 生成、入队即落盘；重试复用同一个键。
5. **默认单点串行**：平台账号级只允许 1 个在途 run。并发度是配置项，不是默认行为；提交前不做多路并发。
6. **模型 = `{provider, endpoint, params}`**：禁止把 solgrid 伪装成"OpenAI 兼容渠道"，禁止在代码里硬编码模型清单；参数表单由 `inspect` 的 JSON Schema 驱动，未知端点走 raw JSON 兜底。
7. **Agent 集成：ACP 进、MCP 出**：画布作为 ACP client 驱动本地 Agent，同时作为 MCP server 供 Agent 操作画布。**不读** `~/.codex`、`~/.claude`、`~/.dsh` 里的配置或凭证来"猜"模型。
8. **图与时间线分离**：时间线是独立文档（`timeline.json`），不是节点图的子集。
9. **付费必须可见可确认**：Agent 通道的花费确认挂在 ACP `request_permission`；UI 通道必须有明确确认动作。禁止静默花钱。

---

## 三、前端规范

- 沿用现有栈：Vite、React 19、React Router 7、TypeScript、Ant Design 6、Tailwind 4、Zustand、i18next。
- 目录约定：页面 `web/src/pages/`、画布组件 `web/src/components/canvas/`、画布状态 `web/src/stores/canvas/`、画布工具 `web/src/lib/canvas/`。
- **所有业务数据读写走 daemon**（`web/src/services/api/` 只调本机 daemon）；`localforage` 只允许存 UI 偏好（主题、面板开合、视口记忆），不存业务列表、生成记录、图片、base64 或大 JSON。
- 全局或跨页面状态放 store；组件需要时直接取，不层层透传 props；不新增只做转发的组件。
- 新增画布按钮 / 弹窗 / 浮层复用现有工具栏、节点面板、Modal 的视觉风格；必须走 `canvasThemes` / `useThemeStore` / antd token，不硬编码颜色。
- 画布顶部工具栏与状态信息保持极简扁平（无边框、无阴影、弱按钮感）；画布内操作按钮默认透明底 + 轻微 hover。
- 图片节点默认尊重原始比例；批量生成、助手面板等交互不占用过多画布空间。
- 页面文案中文；图标优先 `lucide-react`；组件私有样式用 Tailwind / 内联，不往全局 CSS 堆页面私有样式。
- 大列表/画布必须做视口裁剪，不做全量渲染。

---

## 四、daemon / 后端规范

- 只监听 `127.0.0.1`；随机端口；启动生成一次性 `connectToken`（写 `~/.solgrid-canvas/agent.json`，0600）；Origin 白名单首次连接后钉住。
- 日志必须脱敏：token、API key、dataURL 一律不落日志。
- 子进程只通过 `solgrid` CLI 与外部交互，**不复制网关协议**；CLI 不可用时明确报错并给安装指引。
- run 状态机保持少而明确：`queued / submitting / running / completed / failed / uncertain / stopped / parked`。`uncertain` 表示"结果未知"，**禁止自动重提**。
- 启动时恢复：有 `remoteRunId` 续轮询；只有 `idempotencyKey` 就 lookup；都没有才重提。
- 文件访问走白名单：用户显式选择的路径 + 项目 workspace；拒绝 `~/.ssh`、`~/.config` 等敏感根。

---

## 五、文档规范

- `README.md` 简洁（介绍 / 核心功能 / 快速开始）；`REQUIREMENTS.md` 放需求；`TECH_PLAN.md` 放技术方案；`notes/` 放测出来的结论。
- 影响用户可感知行为的改动，在 `CHANGELOG.md` 的 `Unreleased` 追加一条，按 `[新增]` / `[调整]` / `[修复]` / `[优化]` 分类，一句话中文归纳。
- 文档不写过期日期。

---

## 六、边界值变更

新增或调整超时、重试次数、并发上限、文件大小限制等会改变实际行为的值之前，先说明适用环节、默认值和失败后的处理方式，取得用户确认；不要把经验值当纯内部实现静默加入。

---

## 七、平台已知约束（实测，改动前先看 `notes/solgrid-findings.md`）

- 账号级只允许 **1 个在途 run**；并发会撞车并留下僵尸 RUNNING 占死槽位。
- 文生图是同步接口，阻塞 46–60s，偶发 Cloudflare 504/520。
- 提交失败不等于没创建：必须用同一 `Idempotency-Key` 找回（404 才是真没建成）。
- 产物 URL 是 OSS 签名地址，约 24 小时过期，且无 CORS 头 → 必须由 daemon 落地。
- `422 daily_budget_exceeded` 是日预算/在途预留不足，可重试，不是失败。
- **没有图像 mask inpaint 端点**：局部重绘要靠客户端 bbox 局部编辑 + 羽化回贴。
- 画布"数量 N"= 入队 N 个 run（不是并发 N 个请求）。

---

## 八、项目注意事项

- 不与上游同步合并；需要上游的单个修复时用 cherry-pick，不做整分支 merge。
- 旧 fork（`D:\data\github\infinite-canvas`）只作参考，不参与构建。
- 本地启动或验收时不要关闭用户已打开的浏览器窗口/标签页；自动化验证用独立页面。

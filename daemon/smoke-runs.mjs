// run 引擎冒烟测试：用假 CLI 跑通 提交 → 轮询 → 产物落地 → 账本/目录校验。
// 用法：node daemon/smoke-runs.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = 17398;
const TOKEN = "smoke-runs-token";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-runs-"));
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    cwd: here,
    env: {
        ...process.env,
        CANVAS_HOME: HOME,
        CANVAS_PORT: String(PORT),
        CANVAS_TOKEN: TOKEN,
        CANVAS_SOLGRID_BIN: path.join(here, "test", "fake-solgrid.mjs"),
        FAKE_STATE: path.join(HOME, "fake-state"),
        FAKE_POLLS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
child.stderr.on("data", (chunk) => process.stderr.write(`[daemon:err] ${chunk}`));

const headers = { "content-type": "application/json", "x-canvas-token": TOKEN, "x-canvas-client": "web" };

async function waitHealth() {
    for (let i = 0; i < 60; i++) {
        try {
            const response = await fetch(`${BASE}/health`);
            if (response.ok) return;
        } catch {
            /* 还没起来 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("daemon 未启动");
}

let failed = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
};

try {
    await waitHealth();

    // 工具目录
    const tools = await fetch(`${BASE}/api/tools?q=image`, { headers }).then((r) => r.json());
    check("tools list 返回候选", tools.results?.[0]?.endpoint === "/v1/fake-image", JSON.stringify(tools).slice(0, 200));
    const toolsCached = await fetch(`${BASE}/api/tools?q=image`, { headers }).then((r) => r.json());
    check("tools list 走缓存", toolsCached.cached === true && toolsCached.results?.[0]?.endpoint === "/v1/fake-image");
    const catalog = await fetch(`${BASE}/api/tools/catalog?refresh=1`, { headers }).then((r) => r.json());
    const imageEndpoints = (catalog.catalog?.image || []).map((item) => item.endpoint);
    const videoEndpoints = (catalog.catalog?.video || []).map((item) => item.endpoint);
    check(
        "tools categories 按 bucket 归入图片/视频/音频",
        imageEndpoints.includes("/v1/fake-image") && imageEndpoints.includes("/v1/image/magic-hour-ai-gif") && videoEndpoints.includes("/v1/video/fake") && videoEndpoints.includes("/v1/image/magic-hour-ai-gif") && (catalog.catalog?.audio?.length || 0) >= 2,
        JSON.stringify(catalog).slice(0, 300),
    );
    const detail = await fetch(`${BASE}/api/tools/detail?provider=fake&endpoint=/v1/fake-image`, { headers }).then((r) => r.json());
    check("inspect 返回 schema", detail.detail?.input?.body?.properties?.prompt?.type === "string");

    // 先建一个带节点的项目，验证 run 完成后回填节点（刷新页面不丢结果）
    await fetch(`${BASE}/api/projects/smokeproj`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
            project: {
                id: "smokeproj",
                title: "冒烟项目",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                backgroundMode: "lines",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                chatSessions: [],
                activeChatId: null,
                connections: [],
                nodes: [{ id: "node1", type: "image", title: "图", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { status: "loading" } }],
            },
        }),
    });

    const meta = await fetch(`${BASE}/api/meta`, { headers }).then((r) => r.json());
    check("meta 返回资产目录", typeof meta.projectsDir === "string" && meta.projectsDir.includes("projects"), JSON.stringify(meta).slice(0, 120));

    // 提交 run
    const created = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "a cat", size: "1024x1024" } }),
    }).then((r) => r.json());
    check("提交 run 返回 queued", created.run?.status === "queued" && !!created.run?.idempotencyKey, JSON.stringify(created).slice(0, 200));

    // 等它完成
    let run = null;
    for (let i = 0; i < 80; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const response = await fetch(`${BASE}/api/runs/${created.run.id}`, { headers });
        const payload = await response.json();
        run = payload.run;
        if (run && ["completed", "failed", "uncertain", "stopped"].includes(run.status)) break;
    }
    check("run 完成", run?.status === "completed", JSON.stringify(run).slice(0, 300));
    check("记账 cost", run?.costSpark === 3.9 && run?.billingStatus === "SETTLED");
    check("产物已落地", Array.isArray(run?.outputs) && run.outputs.length === 1 && run.outputs[0].storageKey.startsWith("asset:smokeproj/"), JSON.stringify(run?.outputs));
    const outputFile = path.join(HOME, "projects", "smokeproj", "assets", run.outputs[0].file);
    check("产物文件存在", fs.existsSync(outputFile), outputFile);
    check("产物 storageKey 可拼地址", run.outputs[0].url === `/api/projects/smokeproj/assets/${run.outputs[0].file}`);

    // 节点回填：daemon 完成 run 时把结果写进 canvas.json
    const projectAfterRun = await fetch(`${BASE}/api/projects/smokeproj`, { headers }).then((r) => r.json());
    const nodeAfterRun = projectAfterRun.project?.nodes?.find((node) => node.id === "node1");
    check("run 完成回填节点", nodeAfterRun?.metadata?.status === "success" && String(nodeAfterRun?.metadata?.storageKey || "").startsWith("asset:smokeproj/"), JSON.stringify(nodeAfterRun?.metadata).slice(0, 200));

    // family 映射：图片请求体
    const bodiesDir = path.join(HOME, "fake-state", "bodies");
    const readBodies = () => fs.readdirSync(bodiesDir).map((file) => JSON.parse(fs.readFileSync(path.join(bodiesDir, file), "utf8")));
    const imageBody = readBodies().find((item) => item?.input?.messages?.[0]?.content?.[0]?.text === "a cat");
    check("图片 body 符合 alibaba 契约", Boolean(imageBody) && /^\d+\*\d+$/.test(imageBody.parameters?.size || ""), JSON.stringify(imageBody).slice(0, 300));

    // data URL 参考图：入队时落成资产并进入请求体（此前被 sanitizeParams 脱敏成占位符）
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const refRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "ref cat", references: [`data:image/png;base64,${tinyPng}`] } }),
    }).then((r) => r.json());
    let refDone = null;
    for (let i = 0; i < 80; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const payload = await fetch(`${BASE}/api/runs/${refRun.run.id}`, { headers }).then((r) => r.json());
        refDone = payload.run;
        if (refDone && ["completed", "failed", "uncertain", "stopped"].includes(refDone.status)) break;
    }
    const refBody = readBodies().find((item) => item?.input?.messages?.[0]?.content?.[0]?.text === "ref cat");
    const refImages = (refBody?.input?.messages?.[0]?.content || []).filter((item) => item?.image);
    check("data URL 参考图进入请求体", refDone?.status === "completed" && refImages.length === 1, JSON.stringify(refBody).slice(0, 300));

    // family 映射：视频 + 参考素材上传
    const videoRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            projectId: "smokeproj",
            provider: "alibaba",
            endpoint: "/v1/video/wan2.7-i2v",
            params: { prompt: "视频测试", seconds: 5, resolution: "720p", references: [`data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`] },
        }),
    }).then((r) => r.json());
    let videoFinished = null;
    for (let i = 0; i < 80; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const payload = await fetch(`${BASE}/api/runs/${videoRun.run.id}`, { headers }).then((r) => r.json());
        videoFinished = payload.run;
        if (videoFinished && ["completed", "failed", "uncertain", "stopped"].includes(videoFinished.status)) break;
    }
    const videoBody = readBodies().find((item) => item?.input?.prompt === "视频测试");
    check("视频 body 用 input.media + parameters", videoBody?.parameters?.resolution === "720P" && videoBody?.parameters?.duration === 5, JSON.stringify(videoBody).slice(0, 300));
    check("参考图经 files upload 变成 URL", videoBody?.input?.media?.[0]?.type === "first_frame" && String(videoBody?.input?.media?.[0]?.url).startsWith("https://fake.local/"), JSON.stringify(videoBody?.input?.media));

    // wan3.0：单端点支持 480P，首帧图片走 input.media[].type=first_frame
    const wan3Run = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            projectId: "smokeproj",
            provider: "alibaba",
            endpoint: "/v1/video/wan3.0",
            params: { prompt: "wan3 测试", seconds: 5, resolution: "480", references: [`data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`] },
        }),
    }).then((r) => r.json());
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${wan3Run.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const wan3Body = readBodies().find((item) => item?.input?.prompt === "wan3 测试");
    check("wan3.0 480P + first_frame 映射", wan3Body?.parameters?.resolution === "480P" && wan3Body?.parameters?.duration === 5 && wan3Body?.input?.media?.[0]?.type === "first_frame", JSON.stringify(wan3Body).slice(0, 300));

    // seedance：vquality "480" → "480p"，size 640x480 → ratio 4:3（reference 模式）
    const seedanceRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            projectId: "smokeproj",
            provider: "bytedance",
            endpoint: "/v1/video/seedance-2.0-mini",
            params: { prompt: "seedance测试", references: ["asset:smokeproj/0000000000000000000000000000000000000000000000000000000000000000.png"], resolution: "480", size: "640x480", videoMode: "reference", seconds: "4" },
        }),
    }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const payload = await fetch(`${BASE}/api/runs/${seedanceRun.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const seedanceBody = readBodies().find((item) => item?.content?.[0]?.text === "seedance测试");
    check("seedance 分辨率归一化", seedanceBody?.resolution === "480p", JSON.stringify(seedanceBody).slice(0, 200));
    check("seedance 比例由 size 推断", seedanceBody?.ratio === "4:3", JSON.stringify(seedanceBody?.ratio));
    check("seedance 拒绝时标记 failed 而非 uncertain", seedanceRun.run.status !== "uncertain");

    // wan 端点校验：i2v + 参考模式应直接失败并给出改用 r2v 的指引（不提交 CLI）
    const badMode = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "alibaba", endpoint: "/v1/video/wan2.7-i2v", params: { prompt: "舞台", references: ["asset:smokeproj/1111111111111111111111111111111111111111111111111111111111111111.png"], videoMode: "reference" } }),
    }).then((r) => r.json());
    let badFinished = null;
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${badMode.run.id}`, { headers }).then((r) => r.json());
        badFinished = payload.run;
        if (["failed", "uncertain", "completed", "stopped"].includes(badFinished?.status)) break;
    }
    check("i2v + 参考模式给出明确错误", badFinished?.status === "failed" && /r2v/.test(badFinished?.error || ""), JSON.stringify(badFinished).slice(0, 200));

    const r2vRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "alibaba", endpoint: "/v1/video/wan2.7-r2v", params: { prompt: "r2v测试", references: ["asset:smokeproj/2222222222222222222222222222222222222222222222222222222222222222.png"], size: "640x480" } }),
    }).then((r) => r.json());
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${r2vRun.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const r2vBody = readBodies().find((item) => item?.input?.prompt === "r2v测试");
    check("r2v 使用 reference_image", r2vBody?.input?.media?.[0]?.type === "reference_image", JSON.stringify(r2vBody).slice(0, 200));

    // 陌生 family：rawBody 原样透传
    const rawRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "kling", endpoint: "/image-to-video/kling-2.6", params: { rawBody: { prompt: "raw body 测试", duration: "5" } } }),
    }).then((r) => r.json());
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${rawRun.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const rawBody = readBodies().find((item) => item?.prompt === "raw body 测试");
    check("rawBody 原样作为请求体（陌生 family 也能跑）", Boolean(rawBody) && rawBody.duration === "5");

    // rawBody 契约：字符串自动 parse；类型/JSON 错误明确 400；内部 data URL 落资产
    const stringRaw = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "kling", endpoint: "/image-to-video/kling-2.6", params: { rawBody: JSON.stringify({ prompt: "string raw body", duration: "7" }) } }),
    }).then((r) => r.json());
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${stringRaw.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const stringBody = readBodies().find((item) => item?.prompt === "string raw body");
    check("rawBody 字符串自动 parse", Boolean(stringBody) && stringBody.duration === "7", JSON.stringify(stringBody).slice(0, 200));

    const invalidRaw = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "kling", endpoint: "/image-to-video/kling-2.6", params: { rawBody: "{not json" } }),
    });
    check("非法 rawBody 返回 400", invalidRaw.status === 400, String(invalidRaw.status));
    const numberRaw = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "kling", endpoint: "/image-to-video/kling-2.6", params: { rawBody: 42 } }),
    });
    check("非对象 rawBody 返回 400", numberRaw.status === 400, String(numberRaw.status));

    const dataRaw = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "kling", endpoint: "/image-to-video/kling-2.6", params: { rawBody: { prompt: "raw data body", image: `data:image/png;base64,${tinyPng}` } } }),
    }).then((r) => r.json());
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${dataRaw.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const dataBody = readBodies().find((item) => item?.prompt === "raw data body");
    check("rawBody 内 data URL 落资产并上传", typeof dataBody?.image === "string" && dataBody.image.startsWith("https://fake.local/"), JSON.stringify(dataBody).slice(0, 200));

    // 运行详情/摘要/重试/删除
    const runDetail = await fetch(`${BASE}/api/runs/${run.id}`, { headers }).then((r) => r.json());
    check("详情带实际请求体", runDetail.run?.builtBody?.input?.messages?.[0]?.content?.[0]?.text === "a cat", JSON.stringify(runDetail.run?.builtBody).slice(0, 200));
    const listSummary = await fetch(`${BASE}/api/runs?projectId=smokeproj`, { headers }).then((r) => r.json());
    check("列表不带 body（避免大响应）", listSummary.runs.every((item) => !("body" in item) && !("builtBody" in item)));
    check("摘要标记 hasBuiltBody", listSummary.runs.some((item) => item.hasBuiltBody));

    const retried = await fetch(`${BASE}/api/runs/${run.id}/retry`, { method: "POST", headers }).then((r) => r.json());
    check("重试生成新 run", retried.run?.id && retried.run.id !== run.id && retried.run.status === "queued");
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${retried.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }

    const beforeDelete = (await fetch(`${BASE}/api/runs?projectId=smokeproj`, { headers }).then((r) => r.json())).runs.length;
    const deleted = await fetch(`${BASE}/api/runs/${retried.run.id}`, { method: "DELETE", headers }).then((r) => r.json());
    const afterDelete = (await fetch(`${BASE}/api/runs?projectId=smokeproj`, { headers }).then((r) => r.json())).runs.length;
    check("删除运行记录", deleted.ok === true && afterDelete === beforeDelete - 1);

    // 音频：minimax t2a_v2 → voice_setting + hex 音频落地为 mp3
    const audioRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "minimax", endpoint: "/v1/t2a_v2", params: { prompt: "你好世界", audioVoice: "female-shaonv", audioSpeed: "1" } }),
    }).then((r) => r.json());
    let audioFinished = null;
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${audioRun.run.id}`, { headers }).then((r) => r.json());
        audioFinished = payload.run;
        if (["completed", "failed", "uncertain", "stopped"].includes(audioFinished?.status)) break;
    }
    const audioBody = readBodies().find((item) => item?.text === "你好世界");
    check("音频 body 用 voice_setting", audioBody?.voice_setting?.voice_id === "female-shaonv" && audioBody?.audio_setting?.format === "mp3", JSON.stringify(audioBody).slice(0, 200));
    check("hex 音频落地为 mp3", audioFinished?.status === "completed" && String(audioFinished?.outputs?.[0]?.file || "").endsWith(".mp3"), JSON.stringify(audioFinished?.outputs));

    // 数量 N > 1：daemon 应该把多出来的产物也建成节点
    const multiRun = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "多图测试", count: 3, size: "1024x1024" } }),
    }).then((r) => r.json());
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${multiRun.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const projectAfterMulti = await fetch(`${BASE}/api/projects/smokeproj`, { headers }).then((r) => r.json());
    const imageNodes = projectAfterMulti.project.nodes.filter((node) => node.type === "image");
    check("数量 N 多产物都落画布", imageNodes.length === 3, `image nodes=${imageNodes.length}`);
    check("多产物都带 assetId", imageNodes.every((node) => String(node.metadata?.storageKey || "").startsWith("asset:smokeproj/")));

    // 审批：Agent 请求 → 用户允许 → 才会入队
    const approval = await fetch(`${BASE}/api/approvals`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "审批测试" } }),
    }).then((r) => r.json());
    check("审批创建为 pending", approval.status === "pending" && Boolean(approval.id));
    const pending = await fetch(`${BASE}/api/approvals?projectId=smokeproj&status=pending`, { headers }).then((r) => r.json());
    check("待审批列表包含该请求", pending.approvals.some((item) => item.id === approval.id));
    const decided = await fetch(`${BASE}/api/approvals/${approval.id}/decision`, {
        method: "POST",
        headers,
        body: JSON.stringify({ allow: true }),
    }).then((r) => r.json());
    check("允许后生成 run", decided.status === "approved" && Boolean(decided.run?.id));
    for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const payload = await fetch(`${BASE}/api/runs/${decided.run.id}`, { headers }).then((r) => r.json());
        if (["completed", "failed", "uncertain", "stopped"].includes(payload.run?.status)) break;
    }
    const afterDecision = await fetch(`${BASE}/api/approvals?projectId=smokeproj&status=pending`, { headers }).then((r) => r.json());
    check("审批处理后不在待办里", !afterDecision.approvals.some((item) => item.id === approval.id));

    // 批量审批：一次确认产生多个 run
    const batch = await fetch(`${BASE}/api/approvals`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            projectId: "smokeproj",
            items: [
                { nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "批量 A" } },
                { nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "批量 B" } },
            ],
        }),
    }).then((r) => r.json());
    check("批量审批包含两个 items", batch.status === "pending" && batch.items?.length === 2, JSON.stringify(batch).slice(0, 200));
    const batchDecided = await fetch(`${BASE}/api/approvals/${batch.id}/decision`, {
        method: "POST",
        headers,
        body: JSON.stringify({ allow: true }),
    }).then((r) => r.json());
    check("批量审批产生两个 run", batchDecided.status === "approved" && batchDecided.runs?.length === 2, JSON.stringify(batchDecided).slice(0, 200));

    // 偏好开关：允许 Agent 自动生成后，审批直接产生 run
    const settingsBefore = await fetch(`${BASE}/api/settings`, { headers }).then((r) => r.json());
    check("默认需要人工审批", settingsBefore.settings?.agentAutoApprove === false, JSON.stringify(settingsBefore).slice(0, 120));
    const settingsOn = await fetch(`${BASE}/api/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ agentAutoApprove: true }),
    }).then((r) => r.json());
    check("可开启 Agent 自动生成", settingsOn.settings?.agentAutoApprove === true, JSON.stringify(settingsOn).slice(0, 120));
    const autoApproval = await fetch(`${BASE}/api/approvals`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", items: [{ nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "自动审批测试" } }] }),
    }).then((r) => r.json());
    check("自动生成设置生效", autoApproval.status === "approved" && autoApproval.runs?.length === 1, JSON.stringify(autoApproval).slice(0, 200));
    await fetch(`${BASE}/api/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ agentAutoApprove: false }),
    });

    // 只有 token、没有浏览器确认头的请求不能绕过审批直接入队
    const blocked = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-token": TOKEN },
        body: JSON.stringify({ projectId: "smokeproj", nodeId: "node1", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "bypass" } }),
    });
    check("Agent token 不能绕过审批", blocked.status === 403, String(blocked.status));

    // 列表与取消
    const list = await fetch(`${BASE}/api/runs?projectId=smokeproj`, { headers }).then((r) => r.json());
    check("run 列表", (list.runs?.length || 0) >= 2 && list.runs.some((item) => item.id === run.id));

    const cancelTarget = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", params: { prompt: "second" } }),
    }).then((r) => r.json());
    const cancelled = await fetch(`${BASE}/api/runs/${cancelTarget.run.id}/cancel`, { method: "POST", headers }).then((r) => r.json());
    check("取消 run", ["stopped", "failed"].includes(cancelled.run?.status), JSON.stringify(cancelled).slice(0, 200));
} catch (error) {
    console.error("冒烟测试异常:", error);
    failed++;
} finally {
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exitCode = failed === 0 ? 0 : 1;
}

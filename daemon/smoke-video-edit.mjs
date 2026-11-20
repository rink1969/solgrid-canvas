// 视频片段重生成冒烟：真实 ffmpeg 裁剪/拼接，生成阶段用 fake 模式，不花钱。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = 17395;
const TOKEN = "smoke-video-edit";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-video-"));
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { "content-type": "application/json", "x-canvas-token": TOKEN };
const PROJECT = "videoproj";

function startDaemon() {
    return spawn(process.execPath, [path.join(here, "server.mjs")], {
        cwd: here,
        env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT), CANVAS_TOKEN: TOKEN, CANVAS_VIDEO_EDIT_FAKE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

const daemon = startDaemon();
daemon.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
daemon.stderr.on("data", (chunk) => {
    if (!/ExperimentalWarning/.test(String(chunk))) process.stderr.write(`[daemon:err] ${chunk}`);
});

let failed = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
};

const exec = (bin, args) =>
    new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} ${code}: ${stderr.slice(-400)}`))));
    });

try {
    for (let i = 0; i < 80; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) break;
        } catch {
            /* 等启动 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const assetsDir = path.join(HOME, "projects", PROJECT, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const sourceFile = path.join(assetsDir, "source.mp4");
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourceFile]);

    await fetch(`${BASE}/api/projects/${PROJECT}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
            project: {
                id: PROJECT,
                title: "视频编辑冒烟",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                backgroundMode: "lines",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                chatSessions: [],
                activeChatId: null,
                connections: [],
                nodes: [{ id: "video1", type: "video", title: "源视频", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { storageKey: `asset:${PROJECT}/source.mp4`, content: `/api/projects/${PROJECT}/assets/source.mp4`, status: "success", mimeType: "video/mp4" } }],
            },
        }),
    });

    const created = await fetch(`${BASE}/api/video-edits`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: PROJECT, sourceNodeId: "video1", start: 1, end: 4, prompt: "把这一段变成蓝色", mode: "flf", resolution: "720P" }),
    }).then((r) => r.json());
    check("创建片段任务", Boolean(created.job?.id), JSON.stringify(created).slice(0, 200));

    let job = created.job;
    const stages = new Set();
    for (let i = 0; i < 120; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await fetch(`${BASE}/api/video-edits/${created.job.id}`, { headers }).then((r) => r.json()).then((data) => data.job);
        stages.add(job?.stage);
        if (["completed", "failed", "cancelled"].includes(job?.status)) break;
    }
    check("任务完成", job?.status === "completed", `${job?.status} ${job?.error || ""} stages=${[...stages].join(",")}`);
    check("经过裁剪/生成/拼接阶段", ["extracting", "generating", "assembling"].every((name) => (job?.history || []).includes(name)), (job?.history || []).join(","));

    const project = await fetch(`${BASE}/api/projects/${PROJECT}`, { headers }).then((r) => r.json()).then((data) => data.project);
    const resultNode = project?.nodes?.find((node) => node.id === job.resultNodeId);
    check("结果节点已写入", Boolean(resultNode?.metadata?.segmentEdit), JSON.stringify(resultNode?.metadata).slice(0, 200));

    const resultFile = path.join(assetsDir, String(resultNode?.metadata?.storageKey || "").split("/").pop());
    check("成片文件存在", fs.existsSync(resultFile), resultFile);
    const probe = await new Promise((resolve, reject) => {
        const child = spawn("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", resultFile], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("exit", () => resolve(JSON.parse(out)));
        child.on("error", reject);
    });
    const duration = Number(probe.format?.duration || 0);
    const hasAudio = (probe.streams || []).some((stream) => stream.codec_type === "audio");
    check("成片时长接近原片", Math.abs(duration - 6) < 0.8, String(duration));
    check("成片保留音轨", hasAudio);
} catch (error) {
    console.error("冒烟测试异常:", error);
    failed++;
} finally {
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exitCode = failed === 0 ? 0 : 1;
}

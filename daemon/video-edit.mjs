// 视频片段重生成：本地裁剪/抽帧 → 平台生成 → 拼回原视频（音频沿用原音轨）。
// 两种模式：flf（首尾帧 i2v，拼接最稳）/ videoedit（整段重编辑，内容更贴近原片）。
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { saveAssetFromBuffer } from "./assets.mjs";
import { applyOps } from "./ops.mjs";

const FFMPEG = process.env.CANVAS_FFMPEG || "ffmpeg";
const FFPROBE = process.env.CANVAS_FFPROBE || "ffprobe";
const FLF_ENDPOINT = "/v1/video/wan2.7-i2v";
const EDIT_ENDPOINT = "/v1/video/wan2.7-videoedit";
const PROVIDER = "alibaba";

function run(bin, args, { cwd, onChild } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        onChild?.(child);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.length > 20000) stdout = stdout.slice(-20000);
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            if (stderr.length > 12000) stderr = stderr.slice(-12000);
        });
        child.on("error", (error) => reject(error));
        child.on("exit", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${path.basename(bin)} 失败（${code}）：${stderr.trim().slice(-600) || "无输出"}`));
        });
    });
}

function parseFps(value) {
    if (!value) return 30;
    const [num, den] = String(value).split("/").map(Number);
    if (!num) return 30;
    const fps = den ? num / den : num;
    return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 30;
}

export function createVideoEditManager({ runStore, engine, gateway, store, projectsDir, broadcast, log }) {
    const jobs = new Map();

    function emit(job) {
        broadcast?.({
            type: "video.edit",
            job: {
                id: job.id,
                projectId: job.projectId,
                status: job.status,
                stage: job.stage,
                error: job.error,
                resultNodeId: job.resultNodeId,
                resultStorageKey: job.resultStorageKey,
                updatedAt: job.updatedAt,
            },
        });
    }

    function stage(job, status, stageName, patch = {}) {
        job.history = [...(job.history || []), stageName];
        Object.assign(job, patch, { status, stage: stageName, updatedAt: new Date().toISOString() });
        emit(job);
    }

    function tempDir(job) {
        const dir = path.join(projectsDir, job.projectId, "tmp", job.id);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    async function probe(file) {
        const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
        const info = JSON.parse(stdout);
        const video = (info.streams || []).find((stream) => stream.codec_type === "video");
        if (!video) throw new Error("源文件没有视频轨");
        return {
            duration: Number(info.format?.duration) || Number(video.duration) || 0,
            width: Number(video.width) || 0,
            height: Number(video.height) || 0,
            fps: parseFps(video.avg_frame_rate || video.r_frame_rate),
            hasAudio: (info.streams || []).some((stream) => stream.codec_type === "audio"),
        };
    }

    async function extractFrame(file, time, out, onChild) {
        await run(FFMPEG, ["-y", "-i", file, "-ss", String(Math.max(0, time)), "-frames:v", "1", "-q:v", "2", out], { onChild });
    }

    async function trimClip(file, from, length, out, info, onChild) {
        await run(
            FFMPEG,
            ["-y", "-ss", String(from), "-i", file, "-t", String(length), "-vf", `fps=${info.fps},scale=${info.width}:${info.height}:force_original_aspect_ratio=decrease,pad=${info.width}:${info.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", out],
            { onChild },
        );
    }

    // 拼回原片：前段 + 新片段 + 后段；音频使用原视频完整音轨
    async function assemble({ sourceFile, segmentFile, start, end, duration, info, out, onChild }) {
        const total = Math.max(0.1, duration);
        const parts = [];
        if (start > 0.05) parts.push(`[0:v]trim=0:${start},setpts=PTS-STARTPTS,fps=${info.fps},scale=${info.width}:${info.height},setsar=1[v0]`);
        parts.push(`[1:v]trim=duration=${end - start},setpts=PTS-STARTPTS,fps=${info.fps},scale=${info.width}:${info.height},setsar=1,tpad=stop_mode=clone:stop_duration=${end - start}[v1]`);
        const labels = ["[v0]", "[v1]"];
        if (total - end > 0.05) {
            parts.push(`[0:v]trim=${end}:${total},setpts=PTS-STARTPTS,fps=${info.fps},scale=${info.width}:${info.height},setsar=1[v2]`);
            labels.push("[v2]");
        }
        parts.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[vout]`);
        const args = ["-y", "-i", sourceFile, "-i", segmentFile, "-filter_complex", parts.join(";"), "-map", "[vout]"];
        if (info.hasAudio) args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "160k", "-shortest");
        else args.push("-an");
        args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);
        await run(FFMPEG, args, { onChild });
    }

    async function fakeSegment({ info, length, out, onChild }) {
        await run(
            FFMPEG,
            ["-y", "-f", "lavfi", "-i", `color=c=0x3b82f6:s=${info.width}x${info.height}:d=${length}:r=${info.fps}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-an", out],
            { onChild },
        );
    }

    function assetPath(storageKey) {
        if (typeof storageKey !== "string" || !storageKey.startsWith("asset:")) return null;
        const rest = storageKey.slice("asset:".length);
        const slash = rest.indexOf("/");
        if (slash <= 0) return null;
        return path.join(projectsDir, rest.slice(0, slash), "assets", rest.slice(slash + 1));
    }

    async function generationOutput(job, runId) {
        for (let i = 0; i < 60 * 60; i++) {
            if (job.cancelled) throw new Error("已取消");
            const current = runStore.get(runId);
            if (!current) throw new Error("生成任务丢失");
            if (current.status === "completed") {
                const output = current.outputs?.[0];
                if (!output) throw new Error("平台没有返回产物");
                const file = path.join(projectsDir, job.projectId, "assets", output.file);
                return { file, output };
            }
            if (["failed", "uncertain", "stopped"].includes(current.status)) throw new Error(current.error || `生成失败（${current.status}）`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("生成超时");
    }

    async function execute(job) {
        try {
            const project = store.readProject(job.projectId);
            const source = project?.nodes?.find((node) => node.id === job.sourceNodeId);
            if (!source) throw new Error("源视频节点不存在");
            const sourceFile = assetPath(source.metadata?.storageKey);
            if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error("源视频文件不存在");

            stage(job, "running", "probing");
            const info = await probe(sourceFile);
            const total = info.duration;
            if (!total) throw new Error("读取视频时长失败");

            const start = Math.max(0, Math.min(job.start, total - 1));
            const end = Math.max(start + 1, Math.min(job.end, total));
            const length = end - start;
            if (length < 2) throw new Error("片段至少 2 秒");
            const maxLength = job.mode === "flf" ? 15 : 10;
            if (length > maxLength) throw new Error(`片段最长 ${maxLength} 秒`);
            job.start = start;
            job.end = end;

            const dir = tempDir(job);
            let segmentFile = path.join(dir, "segment.mp4");

            if (process.env.CANVAS_VIDEO_EDIT_FAKE === "1") {
                // 仅测试用：跳过平台调用，直接把一段纯色视频当作生成结果
                stage(job, "running", "extracting");
                stage(job, "running", "generating");
                await fakeSegment({ info, length, out: segmentFile, onChild: (child) => (job.child = child) });
            } else if (job.mode === "flf") {
                stage(job, "running", "extracting");
                const firstFile = path.join(dir, "first.png");
                const lastFile = path.join(dir, "last.png");
                await extractFrame(sourceFile, start, firstFile, (child) => (job.child = child));
                await extractFrame(sourceFile, Math.max(start + 0.04, end - 1 / info.fps), lastFile, (child) => (job.child = child));

                stage(job, "running", "uploading");
                const firstUrl = await gateway.uploadFile(firstFile);
                const lastUrl = await gateway.uploadFile(lastFile);

                stage(job, "running", "generating");
                const seconds = Math.max(2, Math.round(length));
                const rawBody = {
                    input: { prompt: job.prompt, media: [{ type: "first_frame", url: firstUrl }, { type: "last_frame", url: lastUrl }] },
                    parameters: { duration: seconds, resolution: job.resolution, prompt_extend: false, watermark: false },
                };
                const genRun = engine.enqueue({ projectId: job.projectId, nodeId: null, provider: PROVIDER, endpoint: FLF_ENDPOINT, body: { rawBody } });
                job.runId = genRun.id;
                emit(job);
                const output = await generationOutput(job, genRun.id);
                segmentFile = output.file;
            } else {
                stage(job, "running", "extracting");
                const handle = Math.min(0.3, Math.max(0.1, (10 - length) / 2));
                const clipFrom = Math.max(0, start - handle);
                const clipLength = Math.min(10, length + handle * 2);
                const clipFile = path.join(dir, "clip.mp4");
                await trimClip(sourceFile, clipFrom, clipLength, clipFile, info, (child) => (job.child = child));

                stage(job, "running", "uploading");
                const clipUrl = await gateway.uploadFile(clipFile);

                stage(job, "running", "generating");
                const rawBody = {
                    input: { prompt: job.prompt, media: [{ type: "video", url: clipUrl }] },
                    parameters: { duration: Math.max(2, Math.round(length)), resolution: job.resolution, audio_setting: "origin", prompt_extend: false },
                };
                const genRun = engine.enqueue({ projectId: job.projectId, nodeId: null, provider: PROVIDER, endpoint: EDIT_ENDPOINT, body: { rawBody } });
                job.runId = genRun.id;
                emit(job);
                const output = await generationOutput(job, genRun.id);
                segmentFile = output.file;
            }

            if (job.cancelled) throw new Error("已取消");

            stage(job, "running", "assembling");
            const outFile = path.join(dir, "output.mp4");
            await assemble({ sourceFile, segmentFile, start, end, duration: total, info, out: outFile, onChild: (child) => (job.child = child) });

            const buffer = fs.readFileSync(outFile);
            const asset = saveAssetFromBuffer(buffer, projectsDir, job.projectId, "video/mp4");
            const storageKey = `asset:${job.projectId}/${asset.file}`;
            const content = `/api/projects/${job.projectId}/assets/${asset.file}`;
            const segmentEdit = { sourceNodeId: source.id, start, end, prompt: job.prompt, mode: job.mode, resolution: job.resolution, runId: job.runId || null, createdAt: new Date().toISOString() };

            let resultNodeId = source.id;
            const ops = [];
            if (job.replace) {
                ops.push({ type: "update_node", id: source.id, patch: { metadata: { ...source.metadata, content, storageKey, status: "success", mimeType: "video/mp4", bytes: buffer.length, segmentEdit, previousStorageKey: source.metadata?.storageKey } } });
            } else {
                resultNodeId = `video-edit-${crypto.randomUUID().slice(0, 8)}`;
                ops.push({
                    type: "add_node",
                    node: {
                        id: resultNodeId,
                        type: "video",
                        title: `片段重生成 ${formatRange(start, end)}`,
                        position: { x: source.position.x + source.width + 96, y: source.position.y },
                        width: source.width,
                        height: source.height,
                        metadata: { content, storageKey, status: "success", mimeType: "video/mp4", bytes: buffer.length, prompt: job.prompt, provider: PROVIDER, endpoint: job.mode === "flf" ? FLF_ENDPOINT : EDIT_ENDPOINT, segmentEdit },
                    },
                });
                ops.push({ type: "add_edge", edge: { id: `edge-${resultNodeId}`, fromNodeId: source.id, toNodeId: resultNodeId } });
            }
            const result = applyOps(store, job.projectId, ops);
            broadcast?.({ type: "project.ops", id: job.projectId, rev: result.rev, ops: ops.length, clientId: "daemon" });

            stage(job, "completed", "done", { resultNodeId, resultStorageKey: storageKey });
            log(`视频片段重生成完成：${job.projectId} ${formatRange(start, end)} → ${resultNodeId}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stage(job, job.cancelled ? "cancelled" : "failed", job.cancelled ? "cancelled" : "failed", { error: message });
            log(`视频片段重生成失败：${message}`);
        } finally {
            try {
                fs.rmSync(tempDir(job), { recursive: true, force: true });
            } catch {
                /* 忽略临时目录清理失败 */
            }
            job.child = null;
        }
    }

    return {
        create(input) {
            const project = store.readProject(input.projectId);
            if (!project) throw Object.assign(new Error("项目不存在"), { code: "not_found" });
            const source = project.nodes?.find((node) => node.id === input.sourceNodeId);
            if (!source || source.type !== "video") throw Object.assign(new Error("源节点不是视频"), { code: "invalid_node" });
            if (!source.metadata?.content) throw Object.assign(new Error("视频节点还没有内容"), { code: "empty_node" });
            const mode = input.mode === "videoedit" ? "videoedit" : "flf";
            const start = Number(input.start);
            const end = Number(input.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Object.assign(new Error("时间区间无效"), { code: "invalid_range" });
            const prompt = String(input.prompt || "").trim();
            if (!prompt) throw Object.assign(new Error("请填写修改提示词"), { code: "missing_prompt" });
            const job = {
                id: crypto.randomUUID(),
                projectId: input.projectId,
                sourceNodeId: input.sourceNodeId,
                start,
                end,
                prompt,
                mode,
                resolution: input.resolution === "1080P" ? "1080P" : "720P",
                replace: Boolean(input.replace),
                status: "queued",
                stage: "queued",
                history: ["queued"],
                cancelled: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            jobs.set(job.id, job);
            emit(job);
            setTimeout(() => void execute(job), 0);
            return job;
        },
        get(id) {
            return jobs.get(id) || null;
        },
        cancel(id) {
            const job = jobs.get(id);
            if (!job) return false;
            job.cancelled = true;
            try {
                job.child?.kill();
            } catch {
                /* 忽略 */
            }
            if (job.runId) {
                const current = runStore.get(job.runId);
                if (current) void engine.cancel(current).catch(() => undefined);
            }
            stage(job, "cancelled", "cancelled");
            return true;
        },
    };
}

function formatRange(start, end) {
    const format = (value) => `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, "0")}`;
    return `${format(start)}-${format(end)}`;
}

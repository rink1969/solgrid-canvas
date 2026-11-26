// run 引擎（M1 极简版）：
// - 单点串行（平台账号级只允许 1 个在途 run）
// - 提交不带 --wait，拿到 runId 后轮询
// - 幂等键入队即落盘，崩溃后能找回
// - 完成即把产物下载/解码进项目 assets/
import crypto from "node:crypto";
import fs from "node:fs";

import path from "node:path";

import { saveAssetFromBuffer, saveAssetFromUrl } from "./assets.mjs";
import { buildBody } from "./families.mjs";
import { pickCost, pickOutputs, tempBodyPath } from "./gateway.mjs";
import { applyOps } from "./ops.mjs";

const POLL_START_MS = 2000;
const POLL_MAX_MS = 8000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "TIMED_OUT", "STOPPED"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// rawBody 在文档里是字符串（编辑器文本），到 daemon 必须统一成对象；类型不对就明确报错
function normalizeRawBody(body) {
    if (!body || body.rawBody === undefined || body.rawBody === null) return body;
    let raw = body.rawBody;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        } catch {
            throw Object.assign(new Error("rawBody 不是合法 JSON"), { code: "invalid_raw_body" });
        }
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw Object.assign(new Error("rawBody 必须是 JSON 对象"), { code: "invalid_raw_body" });
    }
    return { ...body, rawBody: raw };
}

function mapRawBodyStrings(value, mapper) {
    if (typeof value === "string") return mapper(value);
    if (Array.isArray(value)) return value.map((item) => mapRawBodyStrings(item, mapper));
    if (value && typeof value === "object") {
        const next = {};
        for (const [key, item] of Object.entries(value)) next[key] = mapRawBodyStrings(item, mapper);
        return next;
    }
    return value;
}

// rawBody 里的 data URL 同样落成资产，避免入库后被脱敏成占位符
function materializeRawBody(body, projectId, projectsDir) {
    if (!body?.rawBody) return body;
    const rawBody = mapRawBodyStrings(body.rawBody, (value) => {
        if (!value.startsWith("data:")) return value;
        const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(value);
        if (!match) return value;
        const asset = saveAssetFromBuffer(Buffer.from(match[2], "base64"), projectsDir, projectId, match[1]);
        return `asset:${projectId}/${asset.file}`;
    });
    return { ...body, rawBody };
}

// 参数里可能夹带 data URL（参考图的本地副本）：入队时落成项目资产再入库，避免撑大 DB 和日志
function materializeReferences(body, projectId, projectsDir) {
    if (!Array.isArray(body?.references)) return body;
    const references = body.references.map((ref) => {
        if (typeof ref !== "string" || !ref.startsWith("data:")) return ref;
        const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(ref);
        if (!match) return ref;
        const asset = saveAssetFromBuffer(Buffer.from(match[2], "base64"), projectsDir, projectId, match[1]);
        return `asset:${projectId}/${asset.file}`;
    });
    return { ...body, references };
}

// 入库/日志前的脱敏：data URL 只留标记（执行用的 body 必须已经 materialize 过）
function sanitizeParams(value) {
    if (typeof value === "string") return value.startsWith("data:") && value.length > 2000 ? "data:<omitted>" : value;
    if (Array.isArray(value)) return value.map(sanitizeParams);
    if (value && typeof value === "object") {
        const next = {};
        for (const [key, item] of Object.entries(value)) next[key] = sanitizeParams(item);
        return next;
    }
    return value;
}

export function createRunEngine({ store, gateway, projectsDir, bodyDir, broadcast, log, docStore, opLog, docOps }) {
    let busy = false;
    let docRetryTimer = null;

    function emit(run) {
        broadcast?.({ type: "run.updated", run });
    }

    // 把结果写回画布文档（daemon 是唯一写入方）：刷新页面后节点也能显示结果
    function scheduleDocRetry() {
        if (docRetryTimer || !docOps) return;
        docRetryTimer = setTimeout(() => {
            docRetryTimer = null;
            retryDocOps();
        }, 5000);
        docRetryTimer.unref?.();
    }

    function retryDocOps() {
        if (!docStore || !docOps) return;
        for (const item of docOps.list()) {
            if (item.attempts >= 20) {
                log(`run ${item.id} 回填画布补偿超过 20 次，停止重试；原始 ops 已保留在 doc_ops`);
                docOps.remove(item.id);
                continue;
            }
            try {
                const result = applyOps(docStore, item.projectId, item.ops);
                opLog?.append(item.projectId, item.ops, "daemon");
                broadcast?.({ type: "project.ops", id: item.projectId, rev: result.rev, ops: item.ops.length, clientId: "daemon" });
                docOps.remove(item.id);
                log(`run ${item.id} 回填画布补偿成功`);
            } catch (error) {
                docOps.bump(item.id);
                log(`run ${item.id} 回填画布补偿失败（第 ${item.attempts + 1} 次）：${error.message}`);
            }
        }
        if (docOps.list().length) scheduleDocRetry();
    }

    function applyDocOps(run, ops) {
        if (!docStore || !ops.length) return;
        try {
            const result = applyOps(docStore, run.projectId, ops);
            opLog?.append(run.projectId, ops, "daemon");
            broadcast?.({ type: "project.ops", id: run.projectId, rev: result.rev, ops: ops.length, clientId: "daemon" });
            docOps?.remove(run.id);
        } catch (error) {
            log(`run ${run.id} 回填画布失败：${error.message}`);
            docOps?.put(run.id, run.projectId, ops);
            scheduleDocRetry();
        }
    }

    function nodeMetadata(run, output) {
        const size = output.mime?.startsWith("image/") ? imageSizeOf(run, output) : null;
        return {
            content: output.url,
            storageKey: output.storageKey,
            status: "success",
            bytes: output.bytes,
            mimeType: output.mime,
            ...(size ? { naturalWidth: size.width, naturalHeight: size.height } : {}),
            prompt: run.body?.prompt,
            provider: run.provider,
            endpoint: run.endpoint,
            errorDetails: undefined,
        };
    }

    // 第一份产物回填原节点；多余的产物（数量 N > 1）在右侧按列新增节点，刷新后也在
    function writeResultNodes(run, outputs) {
        if (!run.nodeId || !outputs.length) return;
        const ops = [{ type: "update_node", id: run.nodeId, patch: { metadata: nodeMetadata(run, outputs[0]) } }];
        const extras = outputs.slice(1);
        if (extras.length) {
            const project = docStore?.readProject(run.projectId);
            const source = project?.nodes?.find((node) => node.id === run.nodeId);
            const baseX = source ? source.position.x + source.width + 320 : 0;
            const baseY = source ? source.position.y : 0;
            const presetWidth = Math.min(480, Math.max(160, source?.width || 320));
            const sourceTitle = String(source?.title || run.body?.prompt || "生成结果").trim();
            extras.forEach((output, index) => {
                const size = output.mime?.startsWith("image/") ? imageSizeOf(run, output) : null;
                const width = size ? presetWidth : 320;
                const height = size ? Math.round(presetWidth * (size.height / size.width)) : 320;
                const type = output.mime?.startsWith("video/") ? "video" : output.mime?.startsWith("audio/") ? "audio" : "image";
                ops.push({
                    type: "add_node",
                    node: {
                        id: `run-${run.id}-${index + 1}`,
                        type,
                        title: `${sourceTitle} -${index + 1}`,
                        position: { x: baseX, y: baseY + index * (height + 32) },
                        width,
                        height,
                        metadata: {
                            ...nodeMetadata(run, output),
                            // 多产物节点也要带生成参数，否则面板按默认（1:1）显示，和真实产物不一致
                            ...(run.body?.size ? { size: run.body.size } : {}),
                            count: 1,
                            generationMode: type,
                        },
                    },
                });
            });
        }
        applyDocOps(run, ops);
    }

    function fail(run, message, status = "failed") {
        const updated = store.update(run.id, { status, error: message, finishedAt: new Date().toISOString() });
        if (run.nodeId) applyDocOps(run, [{ type: "update_node", id: run.nodeId, patch: { metadata: { status: "error", errorDetails: message } } }]);
        log(`run ${run.id} ${status}: ${message}`);
        emit(updated);
        return updated;
    }

    function guessMime(item) {
        if (item.mime) return item.mime;
        if (item.content_type) return item.content_type;
        if (item.hint === "images") return "image/png";
        if (item.hint === "videos") return "video/mp4";
        if (item.hint === "audios" || item.hint === "audio" || item.hint === "music") return "audio/mpeg";
        const url = String(item.url || "");
        if (/\.mp3(\?|$)/i.test(url)) return "audio/mpeg";
        if (/\.wav(\?|$)/i.test(url)) return "audio/wav";
        if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return "image/png";
        if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return "video/mp4";
        return "application/octet-stream";
    }

    // 只读文件头 64KB 解析尺寸，避免为了宽高把大图整个读进来
    function imageSizeOf(run, output) {
        try {
            const file = path.join(projectsDir, run.projectId, "assets", output.file);
            const fd = fs.openSync(file, "r");
            const buffer = Buffer.alloc(65536);
            const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
            fs.closeSync(fd);
            const bytes = buffer.subarray(0, read);
            if (output.mime === "image/png" && bytes.length > 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
            if (output.mime === "image/jpeg") {
                let offset = 2;
                while (offset + 9 < bytes.length) {
                    if (bytes[offset] !== 0xff) {
                        offset += 1;
                        continue;
                    }
                    const marker = bytes[offset + 1];
                    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
                    }
                    offset += 2 + bytes.readUInt16BE(offset + 2);
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    async function collectOutputs(run, raw) {
        const items = pickOutputs(raw);
        const outputs = [];
        for (const [index, item] of items.entries()) {
            const mime = guessMime(item);
            const saved = item.base64
                ? saveAssetFromBuffer(Buffer.from(item.base64, "base64"), projectsDir, run.projectId, mime)
                : item.hex
                  ? saveAssetFromBuffer(Buffer.from(item.hex, "hex"), projectsDir, run.projectId, mime)
                  : await saveAssetFromUrl(item.url, projectsDir, run.projectId, mime);
            outputs.push({
                index,
                storageKey: `asset:${run.projectId}/${saved.file}`,
                url: `/api/projects/${run.projectId}/assets/${saved.file}`,
                file: saved.file,
                mime: saved.mime,
                bytes: saved.bytes,
            });
        }
        return outputs;
    }

    async function poll(run) {
        let delay = POLL_START_MS;
        for (;;) {
            await sleep(delay);
            let current;
            try {
                current = await gateway.getRun(run.remoteRunId);
            } catch (error) {
                // 单次查询失败不判死：退避后继续（最多由 CLI 超时保护）
                log(`run ${run.id} 轮询失败：${error.message}`);
                delay = Math.min(delay * 2, POLL_MAX_MS * 4);
                continue;
            }
            const status = String(current.status || "");
            if (!status) {
                delay = Math.min(delay * 2, POLL_MAX_MS * 4);
                continue;
            }
            if (status === "COMPLETED") {
                let outputs = [];
                try {
                    outputs = await collectOutputs(run, current.raw);
                } catch (error) {
                    return fail(run, `产物落地失败：${error.message}`, "failed");
                }
                if (!outputs.length) {
                    return fail(run, "平台没有返回产物", "failed");
                }
                const { cost, billingStatus } = pickCost(current.raw);
                const updated = store.update(run.id, {
                    status: "completed",
                    outputs,
                    costSpark: cost,
                    billingStatus,
                    finishedAt: new Date().toISOString(),
                });
                writeResultNodes(run, outputs);
                log(`run ${run.id} completed（${outputs.length} 个产物，cost=${cost ?? "?"}）`);
                emit(updated);
                return updated;
            }
            if (TERMINAL.has(status)) {
                const message = current.raw?.error?.message || current.raw?.errorMessage || `远端状态 ${status}`;
                return fail(run, message, status === "STOPPED" ? "stopped" : "failed");
            }
            if (status !== run.status) {
                run = store.update(run.id, { status: "running" });
                emit(run);
            }
            delay = Math.min(delay * 2, POLL_MAX_MS);
        }
    }

    // 参考素材：asset: 直接映射到项目文件；data: 落到临时文件；https 直接透传
    function resolveReference(ref, projectId) {
        if (typeof ref !== "string" || !ref) return null;
        if (ref.startsWith("asset:")) {
            const rest = ref.slice("asset:".length);
            const slash = rest.indexOf("/");
            if (slash <= 0) return null;
            const [project, file] = [rest.slice(0, slash), rest.slice(slash + 1)];
            if (project !== projectId) throw new Error("暂不支持跨项目引用素材");
            return { file: path.join(projectsDir, project, "assets", file) };
        }
        if (ref.startsWith("data:")) {
            const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(ref);
            if (!match) return null;
            const ext = (match[1].split("/")[1] || "bin").replace("jpeg", "jpg");
            const file = path.join(bodyDir, `ref-${crypto.randomUUID()}.${ext}`);
            fs.writeFileSync(file, Buffer.from(match[2], "base64"));
            return { file, temp: true };
        }
        if (/^https:\/\//i.test(ref)) return { url: ref };
        return null;
    }

    async function resolveRawBodyAssets(rawBody, projectId) {
        const cache = new Map();
        const resolveValue = async (value) => {
            if (typeof value === "string") {
                if (!value.startsWith("asset:")) return value;
                if (cache.has(value)) return cache.get(value);
                const resolved = resolveReference(value, projectId);
                if (!resolved?.file) throw new Error(`rawBody 里的资产无效：${value}`);
                const url = await gateway.uploadFile(resolved.file);
                cache.set(value, url);
                return url;
            }
            if (Array.isArray(value)) return Promise.all(value.map((item) => resolveValue(item)));
            if (value && typeof value === "object") {
                const next = {};
                for (const [key, item] of Object.entries(value)) next[key] = await resolveValue(item);
                return next;
            }
            return value;
        };
        return resolveValue(rawBody);
    }

    async function prepareBody(run) {
        const params = run.body || {};
        const tempFiles = [];
        const mediaUrls = [];
        if (params.rawBody) {
            const rawBody = await resolveRawBodyAssets(params.rawBody, run.projectId);
            const built = buildBody({ provider: run.provider, endpoint: run.endpoint, params: { ...params, rawBody }, mediaUrls });
            return { body: built.body, family: built.family, tempFiles };
        }
        for (const ref of Array.isArray(params.references) ? params.references : []) {
            const resolved = resolveReference(ref, run.projectId);
            if (!resolved) continue;
            if (resolved.url) mediaUrls.push(resolved.url);
            else {
                if (resolved.temp) tempFiles.push(resolved.file);
                mediaUrls.push(await gateway.uploadFile(resolved.file));
            }
        }
        try {
            const built = buildBody({ provider: run.provider, endpoint: run.endpoint, params, mediaUrls });
            return { body: built.body, family: built.family, tempFiles };
        } catch (error) {
            for (const file of tempFiles) fs.rm(file, { force: true }, () => undefined);
            throw error;
        }
    }

    async function execute(run) {
        let prepared;
        try {
            prepared = await prepareBody(run);
        } catch (error) {
            return fail(run, error.message, "failed");
        }
        // 留存实际发出去的请求体，失败排查/重试都用得上
        store.update(run.id, { builtBody: prepared.body });
        const bodyPath = tempBodyPath(bodyDir, run.idempotencyKey);
        fs.writeFileSync(bodyPath, JSON.stringify(prepared.body));
        const submitting = store.update(run.id, { status: "submitting", startedAt: new Date().toISOString() });
        emit(submitting);
        try {
            let submitted = null;
            try {
                submitted = await gateway.runTool({
                    provider: run.provider,
                    endpoint: run.endpoint,
                    bodyPath,
                    idempotencyKey: run.idempotencyKey,
                });
            } catch (error) {
                log(`run ${run.id} 提交失败：${error.message}（family=${prepared.family}）`);
                log(`run ${run.id} body=${JSON.stringify(prepared.body).slice(0, 800)}`);
                // 分类：网络/超时类才可能"已创建但结果未知"；参数/校验类一律判定没创建
                const maybeCreated = /超时|timeout|网络|network|ECONN|ENOTFOUND|fetch failed|socket/i.test(error.message);
                let outcome = maybeCreated ? "unknown" : "absent";
                if (error.remoteRunId) {
                    submitted = { remoteRunId: error.remoteRunId };
                } else if (error.idempotencyKey && outcome === "unknown") {
                    try {
                        const found = await gateway.getRunByKey(error.idempotencyKey);
                        if (found.remoteRunId) submitted = { remoteRunId: found.remoteRunId };
                        else outcome = "absent";
                    } catch (lookupError) {
                        if (lookupError.code === "tool_run_not_found") outcome = "absent";
                    }
                }
                if (!submitted) {
                    return outcome === "absent" ? fail(run, `提交被拒绝：${error.message}`, "failed") : fail(run, `提交结果未知：${error.message}`, "uncertain");
                }
            }
            const running = store.update(run.id, { status: "running", remoteRunId: submitted.remoteRunId });
            emit(running);
            return await poll(running);
        } finally {
            fs.rm(bodyPath, { force: true }, () => undefined);
            for (const file of prepared.tempFiles) fs.rm(file, { force: true }, () => undefined);
        }
    }

    async function loop() {
        if (busy) return;
        busy = true;
        try {
            let run;
            while ((run = store.nextQueued())) await execute(run);
        } finally {
            busy = false;
        }
    }

    return {
        enqueue({ projectId, nodeId, provider, endpoint, body }) {
            const normalized = normalizeRawBody(body ?? {});
            const withRaw = materializeRawBody(normalized, projectId, projectsDir);
            const materialized = materializeReferences(withRaw, projectId, projectsDir);
            const run = store.create({
                id: crypto.randomUUID(),
                projectId,
                nodeId,
                provider,
                endpoint,
                body: sanitizeParams(materialized),
                idempotencyKey: crypto.randomUUID(),
            });
            // 执行时使用原始（已落资产的）body，避免脱敏后的占位符
            run.body = materialized;
            emit(run);
            setTimeout(() => void loop(), 0);
            return run;
        },
        async cancel(run) {
            if (run.status === "queued") return fail(run, "已取消", "stopped");
            if (run.remoteRunId) {
                try {
                    await gateway.stopRun(run.remoteRunId);
                } catch (error) {
                    log(`run ${run.id} 停止失败：${error.message}`);
                }
            }
            return fail(run, "已取消", "stopped");
        },
        // 启动恢复：有 remoteRunId 的续轮询；只有幂等键的按 key 找回；都没有的重回队列
        async recover() {
            retryDocOps();
            const unfinished = store.unfinished();
            for (const run of unfinished) {
                if (run.remoteRunId) {
                    emit(run);
                    void poll(run);
                    continue;
                }
                store.update(run.id, { status: "queued" });
                log(`run ${run.id} 重新入队（未拿到 runId）`);
            }
            if (unfinished.length) setTimeout(() => void loop(), 0);
        },
    };
}

// run 引擎（M1 极简版）：
// - 单点串行（平台账号级只允许 1 个在途 run）
// - 提交不带 --wait，拿到 runId 后轮询
// - 幂等键入队即落盘，崩溃后能找回
// - 完成即把产物下载/解码进项目 assets/
import crypto from "node:crypto";
import fs from "node:fs";

import { saveAssetFromBuffer, saveAssetFromUrl } from "./assets.mjs";
import { pickCost, pickOutputs, tempBodyPath } from "./gateway.mjs";

const POLL_START_MS = 2000;
const POLL_MAX_MS = 8000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "TIMED_OUT", "STOPPED"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRunEngine({ store, gateway, projectsDir, bodyDir, broadcast, log }) {
    let busy = false;

    function emit(run) {
        broadcast?.({ type: "run.updated", run });
    }

    function fail(run, message, status = "failed") {
        const updated = store.update(run.id, { status, error: message, finishedAt: new Date().toISOString() });
        log(`run ${run.id} ${status}: ${message}`);
        emit(updated);
        return updated;
    }

    async function collectOutputs(run, raw) {
        const items = pickOutputs(raw);
        const outputs = [];
        for (const [index, item] of items.entries()) {
            const mime = item.mime || "application/octet-stream";
            const saved = item.base64
                ? saveAssetFromBuffer(Buffer.from(item.base64, "base64"), projectsDir, run.projectId, mime)
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
                const { cost, billingStatus } = pickCost(current.raw);
                const updated = store.update(run.id, {
                    status: "completed",
                    outputs,
                    costSpark: cost,
                    billingStatus,
                    finishedAt: new Date().toISOString(),
                });
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

    async function execute(run) {
        const bodyPath = tempBodyPath(bodyDir, run.idempotencyKey);
        fs.writeFileSync(bodyPath, JSON.stringify(run.body ?? {}));
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
                // 提交结果不确定：用同一个幂等键找回；找不到才算不确定
                if (error.idempotencyKey) {
                    try {
                        const found = await gateway.getRunByKey(error.idempotencyKey);
                        if (found.remoteRunId) submitted = { remoteRunId: found.remoteRunId };
                    } catch {
                        // 继续走 uncertain
                    }
                }
                if (!submitted) return fail(run, `提交结果未知：${error.message}`, "uncertain");
            }
            const running = store.update(run.id, { status: "running", remoteRunId: submitted.remoteRunId });
            emit(running);
            return await poll(running);
        } finally {
            fs.rm(bodyPath, { force: true }, () => undefined);
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
            const run = store.create({
                id: crypto.randomUUID(),
                projectId,
                nodeId,
                provider,
                endpoint,
                body,
                idempotencyKey: crypto.randomUUID(),
            });
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

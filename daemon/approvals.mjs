// 生成审批：Agent 想花钱时必须先在画布上被用户点"允许"。
// 审批只存在内存里（daemon 重启即失效，未执行的请求自然作废）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TTL_MS = 5 * 60 * 1000;

export function createApprovalStore({ engine, broadcast, log, autoApprove, stateFile }) {
    const items = new Map();
    const expiryTimers = new Map();

    function persist() {
        if (!stateFile) return;
        try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            const tmp = `${stateFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, `${JSON.stringify([...items.values()])}\n`);
            fs.renameSync(tmp, stateFile);
        } catch (error) {
            log?.(`审批状态持久化失败：${error.message}`);
        }
    }


    function removeLater(id, delayMs) {
        const timer = setTimeout(() => {
            items.delete(id);
            expiryTimers.delete(id);
            persist();
        }, delayMs);
        timer.unref?.();
    }

    function expireLater(id) {
        const existing = expiryTimers.get(id);
        if (existing) clearTimeout(existing);
        const item = items.get(id);
        const age = item?.createdAt ? Date.now() - Date.parse(item.createdAt) : 0;
        const delay = Math.max(0, TTL_MS - (Number.isFinite(age) ? age : 0));
        const timer = setTimeout(() => {
            expiryTimers.delete(id);
            const current = items.get(id);
            if (!current || current.status !== "pending") return;
            current.status = "expired";
            broadcast?.({ type: "approval.decided", id, status: "expired" });
            persist();
            // 不立即删除，给 Agent/UI 一个回读 expired 的窗口
            removeLater(id, 60_000);
        }, delay);
        timer.unref?.();
        expiryTimers.set(id, timer);
    }

    function decide(id, allow) {
        const item = items.get(id);
        if (!item || item.status !== "pending") return item || null;
        const expiry = expiryTimers.get(id);
        if (expiry) {
            clearTimeout(expiry);
            expiryTimers.delete(id);
        }
        if (allow) {
            item.runs = item.items.map((job) =>
                engine.enqueue({ projectId: item.projectId, nodeId: job.nodeId, provider: job.provider, endpoint: job.endpoint, body: job.params }),
            );
            item.run = item.runs[0] || null;
            item.status = "approved";
            log(`审批通过：${item.provider} ${item.endpoint}（${item.runs.length} 个 run）`);
        } else {
            item.runs = [];
            item.status = "denied";
            log(`审批拒绝：${item.provider} ${item.endpoint}`);
        }
        persist();
        broadcast?.({ type: "approval.decided", id, status: item.status });
        // 保留一小段时间，方便客户端/工具回查最终状态
        removeLater(id, 60_000);
        return item;
    }

    if (stateFile) {
        try {
            const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            for (const item of Array.isArray(saved) ? saved : []) {
                if (!item?.id || item.status !== "pending" || !item.projectId) continue;
                items.set(item.id, item);
                expireLater(item.id);
            }
        } catch {
            /* 首次启动或状态文件损坏 */
        }
    }

    return {
        create({ projectId, nodeId, provider, endpoint, params, items: rawItems }) {
            const jobs = (Array.isArray(rawItems) && rawItems.length ? rawItems : [{ nodeId, provider, endpoint, params }])
                .map((job) => ({
                    nodeId: job.nodeId || nodeId || null,
                    provider: job.provider || provider,
                    endpoint: job.endpoint || endpoint,
                    params: job.params || {},
                    estimatedSpark: typeof job.estimatedSpark === "number" ? job.estimatedSpark : null,
                }))
                .filter((job) => job.provider && job.endpoint);
            if (!jobs.length) throw new Error("审批缺少 provider/endpoint");
            if (jobs.length > 50) throw new Error("单次审批最多 50 个节点，请分批提交");
            const id = crypto.randomUUID();
            const first = jobs[0];
            const item = {
                id,
                projectId,
                items: jobs,
                nodeId: first.nodeId || null,
                provider: first.provider,
                endpoint: first.endpoint,
                params: first.params,
                status: "pending",
                run: null,
                runs: [],
                estimatedSpark: jobs.every((job) => typeof job.estimatedSpark === "number") ? Math.round(jobs.reduce((sum, job) => sum + job.estimatedSpark, 0) * 100) / 100 : null,
                createdAt: new Date().toISOString(),
            };
            items.set(id, item);
            persist();
            if (process.env.CANVAS_AUTO_APPROVE === "1" || autoApprove?.()) {
                log(`自动批准：${item.provider} ${item.endpoint}（用户已开启 Agent 自动生成）`);
                const decided = decide(id, true);
                return decided || item;
            }
            broadcast?.({
                type: "approval.requested",
                approval: {
                    id,
                    projectId,
                    items: item.items,
                    nodeId: item.nodeId,
                    provider: item.provider,
                    endpoint: item.endpoint,
                    params: item.params,
                    createdAt: item.createdAt,
                },
            });
            expireLater(id);
            return item;
        },
        get(id) {
            return items.get(id) || null;
        },
        list(projectId, status = "pending") {
            return [...items.values()].filter((item) => (!projectId || item.projectId === projectId) && (!status || item.status === status));
        },
        decide,
    };
}

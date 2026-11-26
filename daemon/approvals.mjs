// 生成审批：Agent 想花钱时必须先在画布上被用户点"允许"。
// 审批只存在内存里（daemon 重启即失效，未执行的请求自然作废）。
import crypto from "node:crypto";

const TTL_MS = 5 * 60 * 1000;

export function createApprovalStore({ engine, broadcast, log }) {
    const items = new Map();

    function removeLater(id, delayMs) {
        const timer = setTimeout(() => items.delete(id), delayMs);
        timer.unref?.();
    }

    function expireLater(id) {
        const timer = setTimeout(() => {
            const item = items.get(id);
            if (!item || item.status !== "pending") return;
            item.status = "expired";
            broadcast?.({ type: "approval.decided", id, status: "expired" });
            // 不立即删除，给 Agent/UI 一个回读 expired 的窗口
            removeLater(id, 60_000);
        }, TTL_MS);
        timer.unref?.();
    }

    function decide(id, allow) {
        const item = items.get(id);
        if (!item || item.status !== "pending") return item || null;
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
        broadcast?.({ type: "approval.decided", id, status: item.status });
        // 保留一小段时间，方便客户端/工具回查最终状态
        removeLater(id, 60_000);
        return item;
    }

    return {
        create({ projectId, nodeId, provider, endpoint, params, items: rawItems }) {
            const jobs = (Array.isArray(rawItems) && rawItems.length ? rawItems : [{ nodeId, provider, endpoint, params }])
                .map((job) => ({
                    nodeId: job.nodeId || nodeId || null,
                    provider: job.provider || provider,
                    endpoint: job.endpoint || endpoint,
                    params: job.params || {},
                }))
                .filter((job) => job.provider && job.endpoint);
            if (!jobs.length) throw new Error("审批缺少 provider/endpoint");
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
                createdAt: new Date().toISOString(),
            };
            items.set(id, item);
            if (process.env.CANVAS_AUTO_APPROVE === "1") {
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

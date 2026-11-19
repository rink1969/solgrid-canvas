// 生成审批：Agent 想花钱时必须先在画布上被用户点"允许"。
// 审批只存在内存里（daemon 重启即失效，未执行的请求自然作废）。
import crypto from "node:crypto";

const TTL_MS = 5 * 60 * 1000;

export function createApprovalStore({ engine, broadcast, log }) {
    const items = new Map();

    function expireLater(id) {
        const timer = setTimeout(() => {
            const item = items.get(id);
            if (!item || item.status !== "pending") return;
            item.status = "expired";
            broadcast?.({ type: "approval.decided", id, status: "expired" });
            items.delete(id);
        }, TTL_MS);
        timer.unref?.();
    }

    function decide(id, allow) {
        const item = items.get(id);
        if (!item || item.status !== "pending") return item || null;
        if (allow) {
            item.run = engine.enqueue({ projectId: item.projectId, nodeId: item.nodeId, provider: item.provider, endpoint: item.endpoint, body: item.params });
            item.status = "approved";
            log(`审批通过：${item.provider} ${item.endpoint}（run ${item.run.id}）`);
        } else {
            item.status = "denied";
            log(`审批拒绝：${item.provider} ${item.endpoint}`);
        }
        broadcast?.({ type: "approval.decided", id, status: item.status });
        // 保留一小段时间，方便客户端/工具回查最终状态
        const timer = setTimeout(() => items.delete(id), 60_000);
        timer.unref?.();
        return item;
    }

    return {
        create({ projectId, nodeId, provider, endpoint, params }) {
            const id = crypto.randomUUID();
            const item = { id, projectId, nodeId, provider, endpoint, params: params || {}, status: "pending", run: null, createdAt: new Date().toISOString() };
            items.set(id, item);
            if (process.env.CANVAS_AUTO_APPROVE === "1") {
                const decided = decide(id, true);
                return decided || item;
            }
            broadcast?.({
                type: "approval.requested",
                approval: { id, projectId, nodeId, provider, endpoint, params: item.params, createdAt: item.createdAt },
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

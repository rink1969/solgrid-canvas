// 增量 op：画布改动不再整份覆盖，按 op 应用（Agent 的 canvas_apply_ops 复用同一套）
const META_KEYS = ["title", "backgroundMode", "showImageInfo", "viewport", "activeChatId", "chatSessions"];

function ensure(condition, message) {
    if (!condition) throw Object.assign(new Error(message), { code: "invalid_op" });
}

export function normalizeOps(ops) {
    ensure(Array.isArray(ops) && ops.length > 0, "ops 不能为空");
    ensure(ops.length <= 500, "单次最多 500 个 op");
    return ops;
}

export function applyOps(store, projectId, ops) {
    const project = store.readProject(projectId);
    ensure(project, "项目不存在");

    const nodes = new Map(project.nodes.map((node) => [node.id, node]));
    let connections = [...project.connections];
    const meta = {};

    for (const op of ops) {
        ensure(op && typeof op === "object" && typeof op.type === "string", "op 缺少 type");
        switch (op.type) {
            case "add_node": {
                ensure(op.node?.id, "add_node 需要 node.id");
                nodes.set(op.node.id, op.node);
                break;
            }
            case "update_node": {
                ensure(op.id && nodes.has(op.id), `update_node 节点不存在：${op.id}`);
                const current = nodes.get(op.id);
                nodes.set(op.id, { ...current, ...op.patch, metadata: { ...current.metadata, ...(op.patch?.metadata || {}) } });
                break;
            }
            case "remove_nodes": {
                for (const id of op.ids || []) nodes.delete(id);
                connections = connections.filter((edge) => !(op.ids || []).includes(edge.fromNodeId) && !(op.ids || []).includes(edge.toNodeId));
                break;
            }
            case "add_edge": {
                ensure(op.edge?.id && op.edge?.fromNodeId && op.edge?.toNodeId, "add_edge 需要完整 edge");
                connections = [...connections.filter((edge) => edge.id !== op.edge.id), op.edge];
                break;
            }
            case "remove_edges": {
                connections = connections.filter((edge) => !(op.ids || []).includes(edge.id));
                break;
            }
            case "update_meta": {
                for (const key of META_KEYS) {
                    if (key in (op.patch || {})) meta[key] = op.patch[key];
                }
                break;
            }
            case "move_nodes": {
                const dx = Number(op.dx) || 0;
                const dy = Number(op.dy) || 0;
                for (const id of op.ids || []) {
                    const current = nodes.get(id);
                    if (!current) continue;
                    nodes.set(id, { ...current, position: { x: current.position.x + dx, y: current.position.y + dy } });
                }
                break;
            }
            default:
                throw Object.assign(new Error(`未知 op：${op.type}`), { code: "invalid_op" });
        }
    }

    const saved = store.saveProject(projectId, { ...project, ...meta, nodes: [...nodes.values()], connections });
    return { rev: saved.rev, nodes: nodes.size, connections: connections.length };
}

// 前端 diff 出的 op 在服务端再校验一次，避免把坏数据写进文档
export function isStorableOp(op) {
    return op && typeof op === "object" && typeof op.type === "string";
}

// 增量 op：画布改动不再整份覆盖，按 op 应用（Agent 的 canvas_apply_ops 复用同一套）
const META_KEYS = ["title", "backgroundMode", "showImageInfo", "viewport", "activeChatId", "chatSessions"];
// update_node/add_node 的已知字段：写错字段名（w/h/nodeType…）直接报错，不再静默丢弃
const NODE_PATCH_KEYS = ["type", "title", "position", "x", "y", "width", "height", "metadata"];
const NODE_ADD_KEYS = ["id", "type", "title", "position", "x", "y", "width", "height", "metadata", "x-solgrid"];

function assertKeys(object, allowed, label) {
    const unknown = Object.keys(object || {}).filter((key) => !allowed.includes(key));
    if (!unknown.length) return;
    throw Object.assign(new Error(`${label} 含未知字段：${unknown.join(", ")}（几何用 position:{x,y}/width/height，改标题用顶层 title）`), { code: "invalid_op" });
}

function normalizeViewport(viewport) {
    ensure(viewport && typeof viewport === "object", "viewport 必须是 {x,y,k}");
    const next = {
        x: toFiniteNumber(viewport.x, "viewport.x"),
        y: toFiniteNumber(viewport.y, "viewport.y"),
        k: toFiniteNumber(viewport.k, "viewport.k"),
    };
    ensure(next.k > 0, "viewport.k 必须大于 0");
    return next;
}

function ensure(condition, message) {
    if (!condition) throw Object.assign(new Error(message), { code: "invalid_op" });
}

const JSON_CANVAS_FILE_MIME = [
    ["image/", "image"],
    ["video/", "video"],
    ["audio/", "audio"],
];

// 外部工具可能按 JSON Canvas 规范传 type:"file"；落库前还原成语义节点类型，
// 否则 store 会把 JSON type 写成 text、语义类型留成 file，前端查不到渲染器。
function toFiniteNumber(value, label) {
    const number = Number(value);
    ensure(Number.isFinite(number), `${label} 必须是数字`);
    return number;
}

function normalizeDimension(value, label, fallback) {
    if (value === undefined || value === null) return fallback;
    const number = toFiniteNumber(value, label);
    ensure(number > 0, `${label} 必须大于 0`);
    return Math.round(number);
}

// 节点几何统一成 {position:{x,y}, width, height}：
// 兼容外部按 JSON Canvas 传顶层 x/y，也拒绝 "abc" 这类会静默破坏渲染的值。
function normalizeGeometry(node, current) {
    const next = { ...node };
    let position = next.position;
    if (position === undefined && (next.x !== undefined || next.y !== undefined)) {
        position = { x: next.x, y: next.y };
    }
    if (position === undefined) position = current?.position || { x: 0, y: 0 };
    ensure(position && typeof position === "object", "position 必须是 {x,y}");
    next.position = {
        x: Math.round(toFiniteNumber(position.x ?? current?.position?.x ?? 0, "position.x")),
        y: Math.round(toFiniteNumber(position.y ?? current?.position?.y ?? 0, "position.y")),
    };
    delete next.x;
    delete next.y;
    if (next.metadata !== undefined) {
        ensure(next.metadata === null || (typeof next.metadata === "object" && !Array.isArray(next.metadata)), "metadata 必须是对象");
        if (next.metadata === null) next.metadata = {};
    }
    if (next.width !== undefined || current) next.width = normalizeDimension(next.width, "width", current?.width ?? 320);
    if (next.height !== undefined || current) next.height = normalizeDimension(next.height, "height", current?.height ?? 240);
    return next;
}

function normalizeAddedNode(node) {
    const ext = node["x-solgrid"] || {};
    let type = node.type;
    if (type === "file") {
        const mime = String(node.metadata?.mimeType || node.metadata?.mime || "");
        const inferred = JSON_CANVAS_FILE_MIME.find(([prefix]) => mime.toLowerCase().startsWith(prefix))?.[1];
        type = ext.nodeType && ext.nodeType !== "file" ? ext.nodeType : inferred;
        ensure(type && type !== "file", "add_node 的 type=file 需要 x-solgrid.nodeType 或 metadata.mimeType（image/video/audio）");
    }
    ensure(typeof type === "string" && type.length > 0, "add_node 需要 node.type");
    return normalizeGeometry({ ...node, type });
}

export function validateProjectPayload(project) {
    ensure(project && typeof project === "object", "project 必须是对象");
    ensure(Array.isArray(project.nodes), "project.nodes 必须是数组");
    const ids = new Set();
    const nodes = project.nodes.map((node, index) => {
        const normalized = normalizeGeometry(node, undefined);
        ensure(typeof normalized.id === "string" && normalized.id.length > 0, `nodes[${index}].id 必须是非空字符串`);
        ensure(!ids.has(normalized.id), `节点 id 重复：${normalized.id}`);
        ids.add(normalized.id);
        ensure(typeof normalized.type === "string" && normalized.type.length > 0, `nodes[${index}].type 必须是非空字符串`);
        return normalized;
    });
    const edgeIds = new Set();
    const connections = (Array.isArray(project.connections) ? project.connections : []).map((edge, index) => {
        ensure(edge && typeof edge === "object", `connections[${index}] 必须是对象`);
        ensure(typeof edge.id === "string" && edge.id.length > 0, `connections[${index}].id 必须是非空字符串`);
        ensure(!edgeIds.has(edge.id), `连线 id 重复：${edge.id}`);
        edgeIds.add(edge.id);
        ensure(ids.has(edge.fromNodeId), `连线 ${edge.id} 的 fromNodeId 不存在：${edge.fromNodeId}`);
        ensure(ids.has(edge.toNodeId), `连线 ${edge.id} 的 toNodeId 不存在：${edge.toNodeId}`);
        ensure(edge.fromNodeId !== edge.toNodeId, `连线 ${edge.id} 不能连接到自身`);
        return edge;
    });
    return { ...project, nodes, connections };
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
                ensure(!nodes.has(op.node.id), `add_node 节点 id 已存在：${op.node.id}`);
                assertKeys(op.node, NODE_ADD_KEYS, "add_node.node");
                nodes.set(op.node.id, normalizeAddedNode(op.node));
                break;
            }
            case "update_node": {
                ensure(op.id && nodes.has(op.id), `update_node 节点不存在：${op.id}`);
                const current = nodes.get(op.id);
                ensure(op.patch?.id === undefined || op.patch.id === op.id, "update_node 不允许修改节点 id");
                assertKeys(op.patch || {}, NODE_PATCH_KEYS, "update_node.patch");
                if (op.patch?.title === undefined && op.patch?.metadata && "title" in op.patch.metadata) {
                    throw Object.assign(new Error("改节点标题请用顶层 patch.title，不要写 metadata.title（update_meta 改的是画布标题）"), { code: "invalid_op" });
                }
                const patch = normalizeGeometry(op.patch || {}, current);
                nodes.set(op.id, { ...current, ...patch, metadata: { ...current.metadata, ...(patch.metadata || {}) } });
                break;
            }
            case "remove_nodes": {
                for (const id of op.ids || []) nodes.delete(id);
                connections = connections.filter((edge) => !(op.ids || []).includes(edge.fromNodeId) && !(op.ids || []).includes(edge.toNodeId));
                break;
            }
            case "add_edge": {
                ensure(op.edge?.id && op.edge?.fromNodeId && op.edge?.toNodeId, 'add_edge 需要 edge.id / fromNodeId / toNodeId');
                ensure(nodes.has(op.edge.fromNodeId), `add_edge 的 fromNodeId 不存在：${op.edge.fromNodeId}`);
                ensure(nodes.has(op.edge.toNodeId), `add_edge 的 toNodeId 不存在：${op.edge.toNodeId}`);
                ensure(op.edge.fromNodeId !== op.edge.toNodeId, "add_edge 不能连接到自身");
                connections = [...connections.filter((edge) => edge.id !== op.edge.id), op.edge];
                break;
            }
            case "remove_edges": {
                connections = connections.filter((edge) => !(op.ids || []).includes(edge.id));
                break;
            }
            case "update_meta": {
                assertKeys(op.patch || {}, META_KEYS, "update_meta.patch");
                for (const key of META_KEYS) {
                    if (key in (op.patch || {})) meta[key] = op.patch[key];
                }
                if (meta.viewport !== undefined) meta.viewport = normalizeViewport(meta.viewport);
                break;
            }
            // 与前端 op 方言对齐：前端 Agent 侧用 set_viewport，daemon 侧统一落到 meta.viewport
            case "set_viewport": {
                meta.viewport = normalizeViewport(op.viewport);
                break;
            }
            case "move_nodes": {
                const dx = toFiniteNumber(op.dx ?? 0, "dx");
                const dy = toFiniteNumber(op.dy ?? 0, "dy");
                for (const id of op.ids || []) {
                    const current = nodes.get(id);
                    if (!current) continue;
                    nodes.set(id, { ...current, position: { x: Math.round(current.position.x + dx), y: Math.round(current.position.y + dy) } });
                }
                break;
            }
            // 绝对定位：栅格化排版的场景一次落位，不用逐节点 update_node
            case "place_nodes": {
                ensure(Array.isArray(op.placements) && op.placements.length > 0, "place_nodes 需要 placements:[{id,x,y}]");
                for (const item of op.placements) {
                    const current = nodes.get(item?.id);
                    ensure(current, `place_nodes 节点不存在：${item?.id}`);
                    nodes.set(item.id, {
                        ...current,
                        position: {
                            x: Math.round(toFiniteNumber(item.x, "placements.x")),
                            y: Math.round(toFiniteNumber(item.y, "placements.y")),
                        },
                    });
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

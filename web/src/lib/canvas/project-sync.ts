// 画布项目 ↔ daemon 的同步层：daemon 是事实源，store 只是内存镜像。
// 改动按增量 op 提交（节点增删改/连线/元信息），只有创建项目或 op 失败时才回退整份 PUT。
import { nanoid } from "nanoid";

import { daemonApi, openDaemonEvents, setDaemonClientId, type CanvasOp, type DaemonEvent } from "@/services/api/daemon";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

const DEBOUNCE_MS = 400;
const META_KEYS = ["title", "backgroundMode", "showImageInfo", "viewport", "activeChatId", "chatSessions"] as const;

const clientId = nanoid();
const synced = new Map<string, string>(); // id -> updatedAt
const snapshot = new Map<string, CanvasProject>(); // id -> 上次同步后的文档（用于 diff）
const revs = new Map<string, number>();
let applyingRemote = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let closeEvents: (() => void) | null = null;
let started = false;

function revOf(project: CanvasProject) {
    return Number((project as CanvasProject & { rev?: number }).rev) || 0;
}

function remember(projects: CanvasProject[]) {
    synced.clear();
    snapshot.clear();
    revs.clear();
    for (const project of projects) {
        synced.set(project.id, project.updatedAt);
        snapshot.set(project.id, project);
        revs.set(project.id, revOf(project));
    }
}

function applyProjects(projects: CanvasProject[]) {
    applyingRemote = true;
    useCanvasStore.getState().replaceProjects(projects);
    applyingRemote = false;
    remember(projects);
}

// 用对象引用比较：store 更新只替换改过的节点，未动节点保持同一引用
function diffProject(previous: CanvasProject, next: CanvasProject): CanvasOp[] {
    const ops: CanvasOp[] = [];

    const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
    const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
    const removedNodes = [...previousNodes.keys()].filter((id) => !nextNodes.has(id));
    if (removedNodes.length) ops.push({ type: "remove_nodes", ids: removedNodes });
    for (const [id, node] of nextNodes) {
        const before = previousNodes.get(id);
        if (!before) ops.push({ type: "add_node", node });
        else if (before !== (node as CanvasNodeData)) {
            const patch = changedNodePatch(before, node as CanvasNodeData);
            if (Object.keys(patch).length) ops.push({ type: "update_node", id, patch });
        }
    }

    const previousEdges = new Map(previous.connections.map((edge) => [edge.id, edge]));
    const nextEdges = new Map(next.connections.map((edge) => [edge.id, edge]));
    const removedEdges = [...previousEdges.keys()].filter((id) => !nextEdges.has(id));
    if (removedEdges.length) ops.push({ type: "remove_edges", ids: removedEdges });
    for (const [id, edge] of nextEdges) {
        if (!previousEdges.has(id)) ops.push({ type: "add_edge", edge: edge as CanvasConnection });
    }

    const metaPatch: Record<string, unknown> = {};
    for (const key of META_KEYS) {
        if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) metaPatch[key] = next[key];
    }
    if (Object.keys(metaPatch).length) ops.push({ type: "update_meta", patch: metaPatch });

    return ops;
}


// 只挑出真正变了的字段，冲突重放时不会覆盖别人的改动
function changedNodePatch(before: CanvasNodeData, after: CanvasNodeData) {
    const patch: Record<string, unknown> = {};
    if (before.type !== after.type) patch.type = after.type;
    if (before.title !== after.title) patch.title = after.title;
    if (before.position.x !== after.position.x || before.position.y !== after.position.y) patch.position = after.position;
    if (before.width !== after.width) patch.width = after.width;
    if (before.height !== after.height) patch.height = after.height;
    const beforeMeta = (before.metadata || {}) as Record<string, unknown>;
    const afterMeta = (after.metadata || {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(beforeMeta), ...Object.keys(afterMeta)])) {
        if (beforeMeta[key] !== afterMeta[key]) meta[key] = afterMeta[key];
    }
    if (Object.keys(meta).length) patch.metadata = meta;
    return patch;
}

// 把本地 op 重放到服务端最新文档上：已存在的不重复加、已删除的不再改
function replayOps(ops: CanvasOp[], fresh: CanvasProject): CanvasOp[] {
    const nodeIds = new Set(fresh.nodes.map((node) => node.id));
    const edgeIds = new Set(fresh.connections.map((edge) => edge.id));
    const replayed: CanvasOp[] = [];
    for (const op of ops) {
        if (op.type === "add_node") {
            const id = (op.node as { id?: string })?.id;
            if (id && !nodeIds.has(id)) replayed.push(op);
        } else if (op.type === "update_node") {
            if (nodeIds.has(op.id)) replayed.push(op);
        } else if (op.type === "remove_nodes") {
            const ids = op.ids.filter((id) => nodeIds.has(id));
            if (ids.length) replayed.push({ type: "remove_nodes", ids });
        } else if (op.type === "add_edge") {
            const edge = op.edge as { id?: string; fromNodeId?: string; toNodeId?: string };
            if (edge.id && !edgeIds.has(edge.id) && edge.fromNodeId && edge.toNodeId && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) replayed.push(op);
        } else if (op.type === "remove_edges") {
            const ids = op.ids.filter((id) => edgeIds.has(id));
            if (ids.length) replayed.push({ type: "remove_edges", ids });
        }
    }
    return replayed;
}

async function syncProject(project: CanvasProject) {
    const previous = snapshot.get(project.id);
    // 新项目（或没快照）：整份保存，顺便拿到 rev
    if (!previous) {
        const result = await daemonApi.putProject(project.id, project);
        revs.set(project.id, result.rev);
        snapshot.set(project.id, project);
        synced.set(project.id, project.updatedAt);
        return;
    }

    let ops = diffProject(previous, project);
    if (!ops.length) {
        synced.set(project.id, project.updatedAt);
        return;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await daemonApi.postOps(project.id, ops, revs.get(project.id));
            revs.set(project.id, result.rev);
            snapshot.set(project.id, project);
            synced.set(project.id, project.updatedAt);
            return;
        } catch (error) {
            // rev 冲突：拉最新文档，把本地 op 重放到新基线上再试，避免整份 PUT 覆盖别人的改动
            console.warn("[canvas-sync] op 同步冲突，重放到最新文档", project.id, error);
            const fresh = await daemonApi.getProject(project.id);
            revs.set(project.id, revOf(fresh));
            snapshot.set(project.id, fresh);
            ops = replayOps(ops, fresh);
            if (!ops.length) {
                synced.set(project.id, project.updatedAt);
                return;
            }
        }
    }

    // 连续冲突：采纳远端，避免用旧文档覆盖服务端
    console.warn("[canvas-sync] 多次冲突，采纳服务端最新文档", project.id);
    await refreshProject(project.id);
}

async function refreshProject(id: string) {
    const project = await daemonApi.getProject(id);
    const state = useCanvasStore.getState();
    const exists = state.projects.some((item) => item.id === id);
    const projects = exists ? state.projects.map((item) => (item.id === id ? project : item)) : [project, ...state.projects];
    applyingRemote = true;
    state.replaceProjects(projects);
    applyingRemote = false;
    synced.set(id, project.updatedAt);
    snapshot.set(id, project);
    revs.set(id, revOf(project));
}

function removeLocalProject(id: string) {
    const state = useCanvasStore.getState();
    applyingRemote = true;
    state.replaceProjects(state.projects.filter((item) => item.id !== id));
    applyingRemote = false;
    synced.delete(id);
    snapshot.delete(id);
    revs.delete(id);
}

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleRefresh(id: string) {
    const existing = refreshTimers.get(id);
    if (existing) clearTimeout(existing);
    refreshTimers.set(
        id,
        setTimeout(() => {
            refreshTimers.delete(id);
            void refreshProject(id).catch(() => undefined);
        }, 300),
    );
}

function handleEvent(event: DaemonEvent) {
    if (event.type === "hello") {
        void alignWithDaemon();
        return;
    }
    // Agent 流式事件与审批请求走 window 事件，交给对应的面板组件消费
    if (event.type === "agent.event") {
        window.dispatchEvent(new CustomEvent("canvas:agent", { detail: event }));
        return;
    }
    if (event.type === "approval.requested" || event.type === "approval.decided") {
        window.dispatchEvent(new CustomEvent("canvas:approval", { detail: event }));
        return;
    }
    if ((event.type === "project.updated" || event.type === "project.ops") && event.id) scheduleRefresh(event.id);
    if (event.type === "project.deleted" && event.id) removeLocalProject(event.id);
}

function scheduleFlush() {
    if (applyingRemote || !started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
}

async function flush() {
    timer = null;
    const projects = useCanvasStore.getState().projects;
    const currentIds = new Set(projects.map((project) => project.id));

    for (const id of [...synced.keys()]) {
        if (currentIds.has(id)) continue;
        synced.delete(id);
        snapshot.delete(id);
        revs.delete(id);
        await daemonApi.deleteProject(id).catch((error) => console.error("[canvas-sync] 删除项目失败", id, error));
    }

    for (const project of projects) {
        if (synced.get(project.id) === project.updatedAt) continue;
        try {
            await syncProject(project);
        } catch (error) {
            console.error("[canvas-sync] 保存项目失败", project.id, error);
            // 失败时清掉 updatedAt，让下一次改动重试
            synced.delete(project.id);
        }
    }
}

async function alignWithDaemon() {
    try {
        await flush();
        const projects = await daemonApi.listProjects();
        applyProjects(projects);
    } catch (error) {
        console.error("[canvas-sync] 对齐 daemon 失败", error);
    }
}

export function startProjectSync() {
    if (started) return;
    started = true;
    setDaemonClientId(clientId);

    void (async () => {
        try {
            const projects = await daemonApi.listProjects();
            applyProjects(projects);
        } catch (error) {
            console.error("[canvas-sync] 无法连接 daemon（请先运行 npm run daemon）", error);
        } finally {
            useCanvasStore.setState({ hydrated: true });
            useCanvasStore.subscribe(scheduleFlush);
            closeEvents = openDaemonEvents(clientId, handleEvent);
            window.addEventListener("beforeunload", () => closeEvents?.());
        }
    })();
}

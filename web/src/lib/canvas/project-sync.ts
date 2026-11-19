// 画布项目 ↔ daemon 的同步层：daemon 是唯一事实源，store 只是内存镜像。
// - 启动：从 daemon 拉全量项目，填充 store，标记 hydrated
// - 本地改动：按项目 diff（updatedAt），debounce 后 PUT 变更 / DELETE 缺失
// - 远端改动：SSE 通知后按项目重取，避免整库刷新
import { nanoid } from "nanoid";

import { daemonApi, openDaemonEvents, setDaemonClientId, type DaemonEvent } from "@/services/api/daemon";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const DEBOUNCE_MS = 400;
const clientId = nanoid();

// id -> updatedAt，用来判断"这个项目自上次同步后有没有变"
const synced = new Map<string, string>();
let applyingRemote = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let closeEvents: (() => void) | null = null;
let started = false;

function isEmpty(projects: CanvasProject[]) {
    return projects.length === 0;
}

function applyProjects(projects: CanvasProject[]) {
    applyingRemote = true;
    useCanvasStore.getState().replaceProjects(projects);
    applyingRemote = false;
    synced.clear();
    for (const project of projects) synced.set(project.id, project.updatedAt);
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
}

function removeLocalProject(id: string) {
    const state = useCanvasStore.getState();
    applyingRemote = true;
    state.replaceProjects(state.projects.filter((item) => item.id !== id));
    applyingRemote = false;
    synced.delete(id);
}

function handleEvent(event: DaemonEvent) {
    if (event.type === "hello") {
        // daemon 重启或 SSE 重连：先冲刷本地未同步改动，再全量对齐
        void alignWithDaemon();
        return;
    }
    if (event.type === "project.updated" && event.id) void refreshProject(event.id).catch(() => undefined);
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
        await daemonApi.deleteProject(id).catch((error) => {
            console.error("[canvas-sync] 删除项目失败", id, error);
            synced.set(id, ""); // 下次重试
        });
    }

    for (const project of projects) {
        if (synced.get(project.id) === project.updatedAt) continue;
        const previous = synced.get(project.id);
        synced.set(project.id, project.updatedAt);
        try {
            await daemonApi.putProject(project.id, project);
        } catch (error) {
            console.error("[canvas-sync] 保存项目失败", project.id, error);
            if (previous === undefined) synced.delete(project.id);
            else synced.set(project.id, previous);
        }
    }
}

async function alignWithDaemon() {
    try {
        await flush();
        const projects = await daemonApi.listProjects();
        // daemon 返回的是事实源；本地若有更晚的未同步改动，flush 已经先提交
        applyProjects(projects);
        if (isEmpty(projects)) useCanvasStore.setState({ hydrated: true });
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

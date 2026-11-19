// 本地 daemon 客户端。浏览器只和 127.0.0.1 上的 daemon 说话：
// - 不持有 solgrid API key / 模型凭证（见 AGENTS.md 架构铁律 3）
// - 开发时经 Vite 代理转发，代理负责注入 x-canvas-token，token 不进浏览器
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const BASE = import.meta.env.VITE_DAEMON_BASE || "/api";

// 每个标签页一个 clientId：daemon 广播时用来跳过自己（避免回声覆盖）
let clientId = "";
export function setDaemonClientId(id: string) {
    clientId = id;
}

function withClient(path: string) {
    if (!clientId) return path;
    return `${path}${path.includes("?") ? "&" : "?"}client=${encodeURIComponent(clientId)}`;
}

type RequestOptions = { method?: string; body?: string };

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const response = await fetch(`${BASE}${withClient(path)}`, {
        method: init.method,
        body: init.body,
        headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`daemon ${init.method || "GET"} ${path} → ${response.status} ${detail}`.trim());
    }
    return (await response.json()) as T;
}

export type CanvasOp =
    | { type: "add_node"; node: unknown }
    | { type: "update_node"; id: string; patch: unknown }
    | { type: "remove_nodes"; ids: string[] }
    | { type: "add_edge"; edge: unknown }
    | { type: "remove_edges"; ids: string[] }
    | { type: "update_meta"; patch: Record<string, unknown> }
    | { type: "move_nodes"; ids: string[]; dx: number; dy: number };

export const daemonApi = {
    listProjects: (): Promise<CanvasProject[]> => request<{ projects: CanvasProject[] }>("/projects").then((value) => value.projects),
    getProject: (id: string): Promise<CanvasProject> => request<{ project: CanvasProject }>(`/projects/${id}`).then((value) => value.project),
    putProject: (id: string, project: CanvasProject): Promise<{ rev: number }> =>
        request<{ rev: number }>(`/projects/${id}`, { method: "PUT", body: JSON.stringify({ project }) }),
    deleteProject: (id: string): Promise<{ ok: boolean }> => request<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
    postOps: (id: string, ops: CanvasOp[], expectRev?: number): Promise<{ rev: number }> =>
        request<{ rev: number }>(`/projects/${id}/ops`, { method: "POST", body: JSON.stringify({ ops, expectRev, origin: "user" }) }),
};

export type DaemonEvent = {
    type: "hello" | "project.updated" | "project.ops" | "project.deleted" | "approval.requested" | "approval.decided" | "agent.event";
    id?: string;
    rev?: number;
    ops?: number;
    approval?: unknown;
    status?: string;
    projectId?: string;
    kind?: string;
    update?: unknown;
    clientId?: string;
    version?: string;
};

// EventSource 不能带自定义 header，客户端标识与 token 都走 URL / 代理
export function openDaemonEvents(clientId: string, onEvent: (event: DaemonEvent) => void): () => void {
    const source = new EventSource(`${BASE}/events?client=${encodeURIComponent(clientId)}`);
    source.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data) as DaemonEvent;
            if (payload.clientId && payload.clientId === clientId) return;
            onEvent(payload);
        } catch {
            // 忽略非 JSON 心跳
        }
    };
    source.onerror = () => {
        // EventSource 会自动重连；重连后 daemon 会再发 hello，触发一次全量对齐
    };
    return () => source.close();
}

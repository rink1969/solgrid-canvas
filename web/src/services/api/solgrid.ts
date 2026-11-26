// solgrid 平台调用：全部经本机 daemon（浏览器不持有 key、不直连平台）
export type SolgridTool = { provider: string; endpoint: string; description?: string; price?: unknown; tags?: string[] };

export type SolgridOutput = { url: string; storageKey: string; file: string; mime: string; bytes: number };

export type SolgridRun = {
    id: string;
    provider?: string;
    endpoint?: string;
    nodeId?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    status: "queued" | "submitting" | "running" | "completed" | "failed" | "uncertain" | "stopped";
    error?: string | null;
    costSpark?: number | null;
    billingStatus?: string | null;
    queuePosition?: number;
    outputs?: SolgridOutput[] | null;
};

async function request<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const response = await fetch(`/api${path}`, {
        method: init?.method,
        body: init?.body,
        headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`daemon ${path} → ${response.status} ${detail}`.trim());
    }
    return (await response.json()) as T;
}

export type SolgridSchema = { type?: string; properties?: Record<string, SolgridSchema>; required?: string[]; enum?: unknown[]; items?: SolgridSchema };

export type SolgridToolDetail = {
    provider?: string;
    endpoint?: string;
    input?: { body?: SolgridSchema; queryParams?: SolgridSchema; pathParams?: SolgridSchema };
    price?: unknown;
    notes?: string;
    /** 由 daemon 按 schema 生成的请求体骨架 */
    skeleton?: unknown;
};

export type SolgridCatalog = { image: SolgridTool[]; video: SolgridTool[]; audio: SolgridTool[] };

export async function listCatalog(refresh = false): Promise<SolgridCatalog> {
    const data = await request<{ catalog: SolgridCatalog }>(`/tools/catalog${refresh ? "?refresh=1" : ""}`);
    return data.catalog || { image: [], video: [], audio: [] };
}

export async function inspectTool(provider: string, endpoint: string): Promise<SolgridToolDetail> {
    const data = await request<{ detail: SolgridToolDetail; skeleton?: unknown }>(`/tools/detail?provider=${encodeURIComponent(provider)}&endpoint=${encodeURIComponent(endpoint)}`);
    return { ...(data.detail || {}), skeleton: data.skeleton };
}

export async function listTools(query: string): Promise<SolgridTool[]> {
    const data = await request<{ results: SolgridTool[] }>(`/tools?q=${encodeURIComponent(query)}`);
    return data.results || [];
}

export function createRun(input: { projectId: string; nodeId?: string; provider: string; endpoint: string; params: Record<string, unknown> }) {
    return request<{ run: SolgridRun }>("/runs", { method: "POST", body: JSON.stringify(input) });
}

export function getRun(id: string) {
    return request<{ run: SolgridRun & { builtBody?: unknown; body?: unknown; idempotencyKey?: string; remoteRunId?: string | null } }>(`/runs/${id}`);
}

export type SolgridRunSummary = Omit<SolgridRun, "outputs"> & {
    outputs?: SolgridOutput[] | null;
    createdAt: string;
    hasBuiltBody?: boolean;
};

export async function listRuns(projectId: string, limit = 100): Promise<SolgridRunSummary[]> {
    const data = await request<{ runs: SolgridRunSummary[] }>(`/runs?projectId=${encodeURIComponent(projectId)}&limit=${limit}`);
    return data.runs || [];
}

export function cancelRun(id: string) {
    return request<{ run: SolgridRun }>(`/runs/${id}/cancel`, { method: "POST" });
}

export function retryRun(id: string) {
    return request<{ run: SolgridRun }>(`/runs/${id}/retry`, { method: "POST" });
}

export function deleteRun(id: string) {
    return request<{ ok: boolean }>(`/runs/${id}`, { method: "DELETE" });
}

const TERMINAL = new Set(["completed", "failed", "uncertain", "stopped"]);

// 轮询到终态；不做自动重提（结果未知时由用户决定）
export async function waitRun(id: string, signal?: AbortSignal, intervalMs = 2000): Promise<SolgridRun> {
    for (;;) {
        if (signal?.aborted) throw new DOMException("canceled", "AbortError");
        const { run } = await getRun(id);
        if (TERMINAL.has(run.status)) return run;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

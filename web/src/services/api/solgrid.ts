// solgrid 平台调用：全部经本机 daemon（浏览器不持有 key、不直连平台）
export type SolgridTool = { provider: string; endpoint: string; description?: string; price?: unknown; tags?: string[] };

export type SolgridOutput = { url: string; storageKey: string; file: string; mime: string; bytes: number };

export type SolgridRun = {
    id: string;
    status: "queued" | "submitting" | "running" | "completed" | "failed" | "uncertain" | "stopped";
    error?: string | null;
    costSpark?: number | null;
    billingStatus?: string | null;
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

export async function listTools(query: string): Promise<SolgridTool[]> {
    const data = await request<{ results: SolgridTool[] }>(`/tools?q=${encodeURIComponent(query)}`);
    return data.results || [];
}

export function createRun(input: { projectId: string; nodeId?: string; provider: string; endpoint: string; params: Record<string, unknown> }) {
    return request<{ run: SolgridRun }>("/runs", { method: "POST", body: JSON.stringify(input) });
}

export function getRun(id: string) {
    return request<{ run: SolgridRun }>(`/runs/${id}`);
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

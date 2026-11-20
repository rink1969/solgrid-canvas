// 视频片段重生成：裁剪 + 生成 + 拼接都在 daemon 完成
export type VideoEditJob = {
    id: string;
    projectId: string;
    mode: "flf" | "videoedit";
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    stage: string;
    error?: string;
    resultNodeId?: string;
    resultStorageKey?: string;
};

async function request<T>(pathname: string, init?: { method?: string; body?: string }): Promise<T> {
    const response = await fetch(`/api${pathname}`, {
        method: init?.method,
        body: init?.body,
        headers: { "content-type": "application/json" },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.message || `daemon ${pathname} → ${response.status}`);
    return data as T;
}

export function createVideoEdit(input: { projectId: string; sourceNodeId: string; start: number; end: number; prompt: string; mode: "flf" | "videoedit"; resolution: "720P" | "1080P"; replace?: boolean }) {
    return request<{ job: VideoEditJob }>("/video-edits", { method: "POST", body: JSON.stringify(input) }).then((data) => data.job);
}

export function getVideoEdit(id: string) {
    return request<{ job: VideoEditJob }>(`/video-edits/${id}`).then((data) => data.job);
}

export function cancelVideoEdit(id: string) {
    return request<{ ok: boolean }>(`/video-edits/${id}/cancel`, { method: "POST" });
}

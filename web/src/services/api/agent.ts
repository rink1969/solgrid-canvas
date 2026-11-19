// 画布 → 本地 Agent（ACP）：经 daemon 转发，浏览器不碰 Agent 配置
export type AgentOption = { value: string; name: string; description?: string };
export type AgentConfigOption = {
    id: string;
    name: string;
    category?: string;
    type: string;
    currentValue?: string;
    options?: Array<{ group?: string; name?: string; options?: AgentOption[] }>;
};

export type AgentTranscriptItem = {
    role: "user" | "assistant" | "thought" | "tool";
    text?: string;
    messageId?: string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
};

async function request<T>(pathname: string, init?: { method?: string; body?: string }): Promise<T> {
    const response = await fetch(`/api${pathname}`, {
        method: init?.method,
        body: init?.body,
        headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`daemon ${pathname} → ${response.status} ${detail}`.trim());
    }
    return (await response.json()) as T;
}

export function getAgentStatus() {
    return request<{ available: boolean; adapter: string | null; sessions: Array<{ projectId: string; sessionId: string; running: boolean; configOptions: AgentConfigOption[] }> }>("/agent/status");
}

export function startAgentSession(projectId: string) {
    return request<{ sessionId: string; configOptions: AgentConfigOption[] }>("/agent/start", { method: "POST", body: JSON.stringify({ projectId }) });
}

export function getAgentTranscript(projectId: string) {
    return request<{ transcript: AgentTranscriptItem[] }>(`/agent/transcript?projectId=${encodeURIComponent(projectId)}`);
}

export function sendAgentPrompt(projectId: string, text: string) {
    return request<{ ok: boolean }>("/agent/prompt", { method: "POST", body: JSON.stringify({ projectId, text }) });
}

export function cancelAgentPrompt(projectId: string) {
    return request<{ ok: boolean }>("/agent/cancel", { method: "POST", body: JSON.stringify({ projectId }) });
}

export function setAgentModel(projectId: string, configId: string, value: string) {
    return request<{ configOptions: AgentConfigOption[] }>("/agent/model", { method: "POST", body: JSON.stringify({ projectId, configId, value }) });
}

export function decideAgentPermission(id: string, allow: boolean) {
    return request<{ ok: boolean }>(`/agent/permissions/${id}`, { method: "POST", body: JSON.stringify({ allow }) });
}

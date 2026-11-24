// 画布 → 本地 Agent（ACP）：每个画布多个对话，经 daemon 转发
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

export type AgentConversation = {
    id: string;
    title: string;
    preview?: string;
    createdAt?: string;
    updatedAt?: string;
    running?: boolean;
    configOptions?: AgentConfigOption[];
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
    return request<{ available: boolean; adapter: string | null; sessions: Array<{ projectId: string; conversationId: string; sessionId: string; running: boolean; configOptions: AgentConfigOption[] }> }>("/agent/status");
}

export async function listAgentConversations(projectId: string): Promise<AgentConversation[]> {
    const data = await request<{ conversations: AgentConversation[] }>(`/projects/${projectId}/agent/conversations`);
    return data.conversations || [];
}

export async function createAgentConversation(projectId: string, title?: string): Promise<AgentConversation> {
    const data = await request<{ conversation: AgentConversation }>(`/projects/${projectId}/agent/conversations`, { method: "POST", body: JSON.stringify({ title }) });
    return data.conversation;
}

export function deleteAgentConversation(projectId: string, conversationId: string) {
    return request<{ ok: boolean }>(`/projects/${projectId}/agent/conversations/${conversationId}`, { method: "DELETE" });
}

export function closeAgentProject(projectId: string) {
    return request<{ closed: number }>(`/projects/${projectId}/agent/close`, { method: "POST" });
}

export function getAgentTranscript(projectId: string, conversationId: string) {
    return request<{ transcript: AgentTranscriptItem[] }>(`/projects/${projectId}/agent/conversations/${conversationId}/transcript`);
}

export function sendAgentPrompt(projectId: string, conversationId: string, text: string) {
    return request<{ ok: boolean }>(`/projects/${projectId}/agent/conversations/${conversationId}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
}

export function cancelAgentPrompt(projectId: string, conversationId: string) {
    return request<{ ok: boolean }>(`/projects/${projectId}/agent/conversations/${conversationId}/cancel`, { method: "POST" });
}

export function setAgentModel(projectId: string, conversationId: string, configId: string, value: string) {
    return request<{ configOptions: AgentConfigOption[] }>(`/projects/${projectId}/agent/conversations/${conversationId}/model`, { method: "POST", body: JSON.stringify({ configId, value }) });
}

export function decideAgentPermission(id: string, allow: boolean) {
    return request<{ ok: boolean }>(`/agent/permissions/${id}`, { method: "POST", body: JSON.stringify({ allow }) });
}

// 生成审批：MCP 工具发起的花费请求会在这里等用户点确认
export type CanvasApproval = {
    id: string;
    projectId: string;
    nodeId?: string | null;
    provider: string;
    endpoint: string;
    params: Record<string, unknown>;
    items?: Array<{ nodeId?: string | null; provider: string; endpoint: string; params: Record<string, unknown> }>;
    createdAt?: string;
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

export async function listPendingApprovals(projectId: string): Promise<CanvasApproval[]> {
    const data = await request<{ approvals: CanvasApproval[] }>(`/approvals?projectId=${encodeURIComponent(projectId)}&status=pending`);
    return data.approvals || [];
}

export async function decideApproval(id: string, allow: boolean) {
    return request<{ id: string; status: string; run?: { id: string } | null }>(`/approvals/${id}/decision`, { method: "POST", body: JSON.stringify({ allow }) });
}

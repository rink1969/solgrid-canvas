export type DaemonSettings = {
    agentAutoApprove: boolean;
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

export async function getDaemonSettings(): Promise<DaemonSettings> {
    const data = await request<{ settings: DaemonSettings }>("/settings");
    return data.settings;
}

export async function updateDaemonSettings(patch: Partial<DaemonSettings>): Promise<DaemonSettings> {
    const data = await request<{ settings: DaemonSettings }>("/settings", { method: "PUT", body: JSON.stringify(patch) });
    return data.settings;
}

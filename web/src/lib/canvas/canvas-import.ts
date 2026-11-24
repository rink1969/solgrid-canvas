// 导入画布时把旧项目的资产引用重写到新项目：
// - storageKey: asset:<oldId>/<sha>.<ext> → asset:<newId>/<sha>.<ext>
// - URL: /api/projects/<oldId>/assets/<file> → /api/projects/<newId>/assets/<file>
// 其它字符串（提示词、data URL 等）原样保留。
export function rewriteImportedProject<T>(value: T, oldProjectId: string, newProjectId: string, storageKeyMap: Map<string, string>): T {
    if (oldProjectId === newProjectId) return value;
    return rewriteValue(value, oldProjectId, newProjectId, storageKeyMap) as T;
}

function rewriteValue(value: unknown, oldProjectId: string, newProjectId: string, storageKeyMap: Map<string, string>): unknown {
    if (typeof value === "string") {
        const mapped = storageKeyMap.get(value);
        if (mapped) return mapped;
        const oldUrlPrefix = `/api/projects/${oldProjectId}/assets/`;
        if (value.startsWith(oldUrlPrefix)) {
            const file = value.slice(oldUrlPrefix.length);
            const mappedKey = storageKeyMap.get(`asset:${oldProjectId}/${file}`);
            if (mappedKey) return `/api/projects/${newProjectId}/assets/${mappedKey.split("/").pop()}`;
        }
        return value
            .split(`asset:${oldProjectId}/`).join(`asset:${newProjectId}/`)
            .split(oldUrlPrefix).join(`/api/projects/${newProjectId}/assets/`);
    }
    if (Array.isArray(value)) return value.map((item) => rewriteValue(item, oldProjectId, newProjectId, storageKeyMap));
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = rewriteValue(item, oldProjectId, newProjectId, storageKeyMap);
        }
        return result;
    }
    return value;
}

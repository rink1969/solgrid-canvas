// rawBody 的前端契约：文档里是字符串（编辑器文本），提交前统一 parse 成对象。
export type RawBodyParseResult = { value?: Record<string, unknown>; error?: string };

export function parseRawBodyText(text?: string | null): RawBodyParseResult {
    const trimmed = (text || "").trim();
    if (!trimmed) return {};
    try {
        const value = JSON.parse(trimmed);
        if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "rawBody 必须是 JSON 对象" };
        return { value: value as Record<string, unknown> };
    } catch {
        return { error: "rawBody 不是合法 JSON" };
    }
}

// 成本预估：rawBody 可能覆盖 duration / resolution / 数量
export function rawBodyEstimateInputs(rawBody?: Record<string, unknown> | null) {
    const parameters = (rawBody?.parameters || {}) as Record<string, unknown>;
    const input = (rawBody?.input || {}) as Record<string, unknown>;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    return {
        seconds: number(parameters.duration) ?? number(parameters.seconds),
        resolution: typeof parameters.resolution === "string" ? parameters.resolution : undefined,
        outputs: number(parameters.n) ?? number(parameters.count) ?? number(input.n),
    };
}

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; default?: unknown; minimum?: number; items?: Schema; pattern?: string };

/** 从 inspect 的 body schema 生成一份可编辑的请求体骨架 */
export function buildRawBodySkeleton(schema?: Schema | null, depth = 0): Record<string, unknown> | null {
    if (!schema || typeof schema !== "object" || depth > 6) return null;
    if (schema.type === "object" || schema.properties) {
        const result: Record<string, unknown> = {};
        for (const [key, property] of Object.entries(schema.properties || {}).slice(0, 24)) {
            const value = exampleFrom(property, depth + 1);
            if (value !== undefined) result[key] = value;
        }
        return result;
    }
    const single = exampleFrom(schema, depth);
    return single && typeof single === "object" && !Array.isArray(single) ? (single as Record<string, unknown>) : null;
}

function exampleFrom(schema: Schema | undefined, depth: number): unknown {
    if (!schema || typeof schema !== "object" || depth > 6) return undefined;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (schema.default !== undefined) return schema.default;
    switch (schema.type) {
        case "object":
        case undefined:
            return schema.properties ? buildRawBodySkeleton(schema, depth) : {};
        case "array":
            return schema.items ? [exampleFrom(schema.items, depth + 1)].filter((item) => item !== undefined) : [];
        case "string":
            return schema.pattern && /https/i.test(schema.pattern) ? "https://example.com/file.mp4" : "";
        case "integer":
        case "number":
            return schema.minimum ?? 0;
        case "boolean":
            return false;
        default:
            return null;
    }
}

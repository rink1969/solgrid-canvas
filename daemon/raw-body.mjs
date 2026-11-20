// 请求体骨架：根据 /api/tools/detail 返回的 JSON Schema 生成一份可直接改的 raw body。
export function skeletonFromSchema(schema, depth = 0) {
    if (!schema || typeof schema !== "object" || depth > 6) return null;
    const type = schema.type;
    if (type === "object" || schema.properties) {
        const result = {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const entries = Object.entries(schema.properties || {}).slice(0, 24);
        for (const [key, property] of entries) {
            const value = exampleFrom(property, depth + 1);
            if (value === undefined) continue;
            // 顶层 input/parameters 一定保留；其余可选字段保留但给空值，方便用户删改
            result[key] = value;
            void required;
        }
        return result;
    }
    return exampleFrom(schema, depth);
}

function exampleFrom(schema, depth) {
    if (!schema || typeof schema !== "object" || depth > 6) return undefined;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (schema.default !== undefined) return schema.default;
    switch (schema.type) {
        case "object":
        case undefined:
            return schema.properties ? skeletonFromSchema(schema, depth) : {};
        case "array":
            return schema.items ? [exampleFrom(schema.items, depth + 1)].filter((item) => item !== undefined) : [];
        case "string":
            if (schema.pattern && /https/i.test(schema.pattern)) return "https://example.com/file.mp4";
            return "";
        case "integer":
        case "number":
            return schema.minimum ?? schema.default ?? 0;
        case "boolean":
            return false;
        default:
            return null;
    }
}

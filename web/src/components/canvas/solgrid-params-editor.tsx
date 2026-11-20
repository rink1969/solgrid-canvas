import { useEffect, useMemo, useState } from "react";
import { Input, Tooltip } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { buildRawBodySkeleton } from "@/lib/canvas/solgrid-raw-body";
import { inspectTool, type SolgridToolDetail } from "@/services/api/solgrid";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

const detailCache = new Map<string, Promise<SolgridToolDetail>>();

function loadDetail(provider: string, endpoint: string) {
    const key = `${provider}|${endpoint}`;
    const cached = detailCache.get(key);
    if (cached) return cached;
    const promise = inspectTool(provider, endpoint).catch((error) => {
        detailCache.delete(key);
        throw error;
    });
    detailCache.set(key, promise);
    return promise;
}

function describeSchema(detail: SolgridToolDetail | null) {
    const body = detail?.input?.body;
    if (!body?.properties) return [];
    const required = new Set(body.required || []);
    return Object.entries(body.properties).map(([name, schema]) => ({
        name,
        type: schema?.type || (schema?.properties ? "object" : "?"),
        required: required.has(name),
        enum: Array.isArray(schema?.enum) ? (schema.enum as unknown[]).map(String) : undefined,
    }));
}

function describePrice(price: unknown) {
    if (!price || typeof price !== "object") return "";
    const value = price as { type?: string; amount?: { value?: string; currency?: string }; rates?: Array<{ meter?: string; unitPrice?: number }> };
    if (value.amount?.value) return `${value.amount.value} ${value.amount.currency || "Spark"}（${value.type || ""}）`;
    if (value.rates?.length) return value.rates.map((rate) => `${rate.meter} ${rate.unitPrice}`).join(" / ");
    return value.type || "";
}

// 未知模型族的逃生舱：参数表单看不懂时，直接写请求体。
export function SolgridParamsEditor({ node, onChange }: { node: CanvasNodeData; onChange: (patch: Partial<CanvasNodeMetadata>) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const provider = node.metadata?.provider;
    const endpoint = node.metadata?.endpoint;
    const [detail, setDetail] = useState<SolgridToolDetail | null>(null);
    const [open, setOpen] = useState(false);
    const [text, setText] = useState(node.metadata?.rawBody || "");
    const [error, setError] = useState("");

    useEffect(() => {
        setText(node.metadata?.rawBody || "");
        setError("");
    }, [node.id, node.metadata?.rawBody]);

    useEffect(() => {
        if (!provider || !endpoint) return;
        let canceled = false;
        loadDetail(provider, endpoint)
            .then((value) => {
                if (!canceled) setDetail(value);
            })
            .catch(() => {
                if (!canceled) setDetail(null);
            });
        return () => {
            canceled = true;
        };
    }, [provider, endpoint]);

    const fields = useMemo(() => describeSchema(detail), [detail]);
    const price = useMemo(() => describePrice(detail?.price), [detail]);
    const skeleton = useMemo(() => detail?.skeleton ?? buildRawBodySkeleton(detail?.input?.body), [detail]);

    if (!provider || !endpoint) return null;

    const commit = (value: string) => {
        setText(value);
        const trimmed = value.trim();
        if (!trimmed) {
            setError("");
            onChange({ rawBody: undefined });
            return;
        }
        try {
            JSON.parse(trimmed);
            setError("");
            onChange({ rawBody: trimmed });
        } catch {
            setError("JSON 格式不正确，修正后才会生效");
        }
    };

    return (
        <div className="mt-2 rounded-xl border p-2 text-xs" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>
            <div className="flex items-center justify-between gap-2">
                <Tooltip title={price ? `参考价：${price}` : "价格由平台计费"}>
                    <button type="button" className="truncate text-left opacity-80 hover:opacity-100" onClick={() => setOpen((value) => !value)}>
                        {open ? "收起高级参数" : "高级参数 / raw JSON"}
                        {fields.length ? `（${fields.length} 个字段）` : ""}
                    </button>
                </Tooltip>
                <span className="flex items-center gap-2">
                    {skeleton ? (
                        <button
                            type="button"
                            className="rounded border px-1.5 py-0.5 opacity-80 hover:opacity-100"
                            style={{ borderColor: theme.toolbar.border }}
                            onClick={() => {
                                const text = JSON.stringify(skeleton, null, 2);
                                setText(text);
                                onChange({ rawBody: text });
                                setError("");
                                setOpen(true);
                            }}
                        >
                            生成骨架
                        </button>
                    ) : null}
                    {node.metadata?.rawBody ? <span className="opacity-60">已使用 raw JSON</span> : null}
                </span>
            </div>

            {open ? (
                <div className="mt-2 space-y-2">
                    {fields.length ? (
                        <div className="space-y-1">
                            {fields.map((field) => (
                                <div key={field.name} className="flex gap-2 font-mono text-[11px] opacity-80">
                                    <span>{field.name}</span>
                                    <span className="opacity-60">{field.type}</span>
                                    {field.required ? <span>必填</span> : null}
                                    {field.enum ? <span className="truncate opacity-60">{[...new Set(field.enum)].slice(0, 6).join(" | ")}</span> : null}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="opacity-60">还没拿到该端点的表单结构，可直接写请求体。</div>
                    )}
                    <Input.TextArea
                        value={text}
                        onChange={(event) => commit(event.target.value)}
                        autoSize={{ minRows: 4, maxRows: 12 }}
                        className="font-mono !text-[11px]"
                        placeholder="留空 = 用画布参数自动构建请求体；填写后直接作为请求体发送"
                    />
                    {error ? <div className="text-red-500">{error}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

import { useEffect, useState } from "react";
import { Select } from "antd";

import { listTools, type SolgridTool } from "@/services/api/solgrid";
import { useConfigStore } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

// discover 结果缓存到模块级：节点面板频繁挂载时不重复拉起 CLI
const cache = new Map<string, Promise<SolgridTool[]>>();

function loadTools(mode: "image" | "video") {
    const query = mode === "video" ? "video generation" : "image generation";
    const cached = cache.get(query);
    if (cached) return cached;
    const promise = listTools(query)
        .then((items) => items.filter((item) => (mode === "video" ? item.endpoint.includes("/video/") : item.endpoint.includes("/image/"))))
        .catch((error) => {
            cache.delete(query);
            throw error;
        });
    cache.set(query, promise);
    return promise;
}

export function SolgridToolPicker({ node, mode, onChange }: { node: CanvasNodeData; mode: "image" | "video"; onChange: (patch: Partial<CanvasNodeMetadata>) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [tools, setTools] = useState<SolgridTool[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let canceled = false;
        setLoading(true);
        loadTools(mode)
            .then((items) => {
                if (!canceled) setTools(items);
            })
            .catch(() => {
                if (!canceled) setTools([]);
            })
            .finally(() => {
                if (!canceled) setLoading(false);
            });
        return () => {
            canceled = true;
        };
    }, [mode]);

    const config = useConfigStore((state) => state.config);
    const fallback = mode === "video" ? config.defaultVideoTool : config.defaultImageTool;
    const own = node.metadata?.provider && node.metadata?.endpoint ? `${node.metadata.provider}|${node.metadata.endpoint}` : undefined;
    const value = own ?? (fallback ? `${fallback.provider}|${fallback.endpoint}` : undefined);

    return (
        <Select
            size="small"
            loading={loading}
            value={value}
            placeholder={fallback ? "使用默认模型（可在设置里改）" : "选择 solgrid 模型"}
            className="!max-w-[210px]"
            popupMatchSelectWidth={460}
            variant="borderless"
            style={{ color: theme.node.text }}
            options={tools.map((tool) => ({
                value: `${tool.provider}|${tool.endpoint}`,
                label: `${tool.provider} · ${tool.endpoint}`,
            }))}
            onChange={(raw: string) => {
                const [provider, endpoint] = raw.split("|");
                onChange({ provider, endpoint, toolTitle: `${provider} · ${endpoint}`, model: `${provider}/${endpoint}` });
            }}
        />
    );
}

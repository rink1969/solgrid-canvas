import { useEffect, useState } from "react";
import { Select } from "antd";

import { listCatalog, type SolgridCatalog, type SolgridTool } from "@/services/api/solgrid";
import { useConfigStore, type ToolRef } from "@/stores/use-config-store";

const cache = { value: null as SolgridCatalog | null, promise: null as Promise<SolgridCatalog> | null };

function loadCatalog() {
    if (cache.value) return Promise.resolve(cache.value);
    if (!cache.promise) {
        cache.promise = listCatalog(false)
            .then((value) => {
                cache.value = value;
                return value;
            })
            .finally(() => {
                cache.promise = null;
            });
    }
    return cache.promise;
}

function toValue(tool?: ToolRef) {
    return tool ? `${tool.provider}|${tool.endpoint}` : undefined;
}

function fromValue(value: string): ToolRef {
    const [provider, endpoint] = value.split("|");
    return { provider, endpoint, title: `${provider} · ${endpoint}` };
}

// 偏好设置里的默认模型：图片 / 视频 / 音频
export function SolgridDefaultModels() {
    const config = useConfigStore((state) => state.config);
    const setDefaultTool = useConfigStore((state) => state.setDefaultTool);
    const [catalog, setCatalog] = useState<SolgridCatalog>({ image: [], video: [], audio: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let canceled = false;
        setLoading(true);
        loadCatalog()
            .then((value) => {
                if (!canceled) setCatalog(value);
            })
            .catch((cause) => {
                if (!canceled) setError(cause instanceof Error ? cause.message : "加载模型目录失败");
            })
            .finally(() => {
                if (!canceled) setLoading(false);
            });
        return () => {
            canceled = true;
        };
    }, []);

    const options = (tools: SolgridTool[]) => tools.map((tool) => ({ value: `${tool.provider}|${tool.endpoint}`, label: `${tool.provider} · ${tool.endpoint}` }));

    const groups = [
        { key: "image" as const, label: "默认生图模型", value: config.defaultImageTool },
        { key: "video" as const, label: "默认生视频模型", value: config.defaultVideoTool },
        { key: "audio" as const, label: "默认声音模型", value: config.defaultAudioTool },
    ];

    return (
        <div className="mb-4 grid gap-4 md:grid-cols-3">
            {groups.map((group) => (
                <div key={group.key}>
                    <div className="mb-2 text-sm font-semibold">{group.label}</div>
                    <Select
                        className="w-full"
                        placeholder="选择默认模型"
                        loading={loading}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        value={toValue(group.value)}
                        options={options(catalog[group.key])}
                        onChange={(value?: string) => setDefaultTool(group.key, value ? fromValue(value) : null)}
                    />
                </div>
            ))}
            {error ? <div className="text-xs text-red-500 md:col-span-3">{error}</div> : null}
        </div>
    );
}

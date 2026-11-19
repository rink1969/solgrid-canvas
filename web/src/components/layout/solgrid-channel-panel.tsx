import { useEffect, useState } from "react";
import { Button, Select, Tag } from "antd";
import { RefreshCw } from "lucide-react";

import { listCatalog, type SolgridCatalog, type SolgridTool } from "@/services/api/solgrid";
import { useConfigStore, type ToolRef } from "@/stores/use-config-store";

function toRef(tool: SolgridTool): ToolRef {
    return { provider: tool.provider, endpoint: tool.endpoint, title: `${tool.provider} · ${tool.endpoint}` };
}

function toValue(tool?: ToolRef) {
    return tool ? `${tool.provider}|${tool.endpoint}` : undefined;
}

function fromValue(value: string): ToolRef {
    const [provider, endpoint] = value.split("|");
    return { provider, endpoint, title: `${provider} · ${endpoint}` };
}

const capabilityLabel: Record<keyof SolgridCatalog, string> = {
    image: "生图模型",
    video: "生视频模型",
    audio: "音频模型",
};

// 内置渠道：没有 baseUrl / apiKey，模型列表来自 daemon 缓存的平台目录。
export function SolgridChannelPanel() {
    const defaults = useConfigStore((state) => state.config);
    const setDefaultTool = useConfigStore((state) => state.setDefaultTool);
    const [catalog, setCatalog] = useState<SolgridCatalog>({ image: [], video: [], audio: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const load = (refresh = false) => {
        setLoading(true);
        setError("");
        listCatalog(refresh)
            .then((value) => setCatalog(value))
            .catch((cause) => setError(cause instanceof Error ? cause.message : "加载模型目录失败"))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load(false);
    }, []);

    const options = (tools: SolgridTool[]) =>
        tools.map((tool) => ({
            value: `${tool.provider}|${tool.endpoint}`,
            label: `${tool.provider} · ${tool.endpoint}`,
        }));

    return (
        <div className="space-y-5">
            <div className="rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">Solgrid（内置渠道）</span>
                            <Tag color="blue">默认</Tag>
                        </div>
                        <div className="mt-1 text-xs text-stone-500">
                            通过本机已登录的 solgrid CLI 调用，不需要填 API Key。模型列表由平台目录决定，平台新增模型无需升级画布。
                        </div>
                    </div>
                    <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} onClick={() => load(true)} loading={loading}>
                        刷新
                    </Button>
                </div>
                {error ? <div className="mt-2 text-xs text-red-500">{error}</div> : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <div>
                    <div className="mb-2 text-sm font-semibold">默认生图模型</div>
                    <Select
                        className="w-full"
                        placeholder="选择默认生图模型"
                        loading={loading}
                        allowClear
                        value={toValue(defaults.defaultImageTool)}
                        options={options(catalog.image)}
                        onChange={(value?: string) => setDefaultTool("image", value ? fromValue(value) : null)}
                        showSearch
                        optionFilterProp="label"
                    />
                    <div className="mt-1 text-xs text-stone-500">新建图片节点或节点未单独选模型时使用</div>
                </div>
                <div>
                    <div className="mb-2 text-sm font-semibold">默认生视频模型</div>
                    <Select
                        className="w-full"
                        placeholder="选择默认生视频模型"
                        loading={loading}
                        allowClear
                        value={toValue(defaults.defaultVideoTool)}
                        options={options(catalog.video)}
                        onChange={(value?: string) => setDefaultTool("video", value ? fromValue(value) : null)}
                        showSearch
                        optionFilterProp="label"
                    />
                    <div className="mt-1 text-xs text-stone-500">新建视频节点或节点未单独选模型时使用</div>
                </div>
            </div>

            {(["image", "video", "audio"] as const).map((capability) => (
                <div key={capability}>
                    <div className="mb-2 text-sm font-semibold">
                        {capabilityLabel[capability]}（{catalog[capability].length}）
                    </div>
                    <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                        {catalog[capability].length === 0 ? <div className="py-2 text-stone-500">暂无数据</div> : null}
                        {catalog[capability].map((tool) => (
                            <div key={`${tool.provider}|${tool.endpoint}`} className="flex items-center justify-between gap-3 py-1">
                                <span className="truncate font-mono">{tool.provider} · {tool.endpoint}</span>
                                <span className="shrink-0 truncate text-stone-500">{tool.description || ""}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

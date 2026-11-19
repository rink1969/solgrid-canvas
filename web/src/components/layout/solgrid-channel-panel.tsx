import { useEffect, useState } from "react";
import { Button, Tag } from "antd";
import { RefreshCw } from "lucide-react";

import { listCatalog, type SolgridCatalog } from "@/services/api/solgrid";

const capabilityLabel: Record<keyof SolgridCatalog, string> = {
    image: "生图",
    video: "生视频",
    audio: "音频",
};

// 渠道列表：目前只有内置的 Solgrid 一个渠道，只读展示与模型清单。
// 默认模型在「偏好设置」里配置。
export function SolgridChannelPanel() {
    const [catalog, setCatalog] = useState<SolgridCatalog>({ image: [], video: [], audio: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [expanded, setExpanded] = useState<keyof SolgridCatalog | null>(null);

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

    const total = catalog.image.length + catalog.video.length + catalog.audio.length;

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">Solgrid（内置渠道）</span>
                            <Tag color="blue">默认</Tag>
                        </div>
                        <div className="mt-1 text-xs text-stone-500">
                            通过本机已登录的 solgrid CLI 调用，不需要填 API Key；共 {total} 个模型（生图 {catalog.image.length} / 生视频 {catalog.video.length} / 音频 {catalog.audio.length}）。
                        </div>
                    </div>
                    <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} onClick={() => load(true)} loading={loading}>
                        刷新
                    </Button>
                </div>
                {error ? <div className="mt-2 text-xs text-red-500">{error}</div> : null}
            </div>

            {(["image", "video", "audio"] as const).map((capability) => (
                <div key={capability} className="rounded-lg border border-stone-200 dark:border-stone-800">
                    <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm"
                        onClick={() => setExpanded((current) => (current === capability ? null : capability))}
                    >
                        <span className="font-medium">
                            {capabilityLabel[capability]}模型（{catalog[capability].length}）
                        </span>
                        <span className="text-xs text-stone-500">{expanded === capability ? "收起" : "查看"}</span>
                    </button>
                    {expanded === capability ? (
                        <div className="max-h-80 space-y-1 overflow-y-auto border-t border-stone-200 px-4 py-2 text-xs dark:border-stone-800">
                            {catalog[capability].length === 0 ? <div className="py-2 text-stone-500">暂无数据</div> : null}
                            {catalog[capability].map((tool) => (
                                <div key={`${tool.provider}|${tool.endpoint}`} className="flex items-center justify-between gap-3 py-1">
                                    <span className="truncate font-mono">
                                        {tool.provider} · {tool.endpoint}
                                    </span>
                                    <span className="shrink-0 truncate text-stone-500">{tool.description || ""}</span>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

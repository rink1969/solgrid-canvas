import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Alert, Button, Input, Modal, Radio, Select, Slider, Space, Switch, Tag } from "antd";
import { Scissors } from "lucide-react";

import { estimateSpark, findToolPrice } from "@/lib/canvas/solgrid-cost";
import { listCatalog } from "@/services/api/solgrid";
import { cancelVideoEdit, createVideoEdit, getVideoEdit, type VideoEditJob } from "@/services/api/video-edit";
import type { CanvasNodeData } from "@/types/canvas";

const FLF_ENDPOINT = "/v1/video/wan2.7-i2v";
const EDIT_ENDPOINT = "/v1/video/wan2.7-videoedit";
const STAGE_LABELS: Record<string, string> = {
    queued: "排队中",
    probing: "读取视频信息",
    extracting: "裁剪/抽帧",
    uploading: "上传片段",
    generating: "平台生成中",
    assembling: "拼接成片",
    done: "完成",
    failed: "失败",
    cancelled: "已取消",
};

export function CanvasVideoSegmentDialog({ node, projectId, open, onClose }: { node: CanvasNodeData; projectId: string; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [duration, setDuration] = useState(0);
    const [range, setRange] = useState<[number, number]>([0, 5]);
    const [prompt, setPrompt] = useState("");
    const [mode, setMode] = useState<"flf" | "videoedit">("flf");
    const [resolution, setResolution] = useState<"720P" | "1080P">("720P");
    const [replace, setReplace] = useState(false);
    const [job, setJob] = useState<VideoEditJob | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof listCatalog>> | null>(null);
    const [playingSelection, setPlayingSelection] = useState(false);

    const maxLength = mode === "flf" ? 15 : 10;
    const length = Math.max(0, range[1] - range[0]);
    const active = job && ["queued", "running"].includes(job.status);

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setError("");
        setJob(null);
        setBusy(false);
        setReplace(false);
        const source = node.metadata?.vquality;
        setResolution(String(source || "").toUpperCase().includes("1080") ? "1080P" : "720P");
    }, [open, node.id, node.metadata?.vquality]);

    useEffect(() => {
        if (!open) return;
        void listCatalog().then(setCatalog).catch(() => undefined);
    }, [open]);

    const clampRange = useCallback(
        (next: [number, number], total: number) => {
            const max = Math.max(2, Math.min(maxLength, Math.floor(total)));
            let [start, end] = next.map((value) => Math.round(value));
            start = Math.max(0, Math.min(start, max - 2));
            end = Math.max(start + 2, Math.min(end, start + max));
            if (total > 0) end = Math.min(end, Math.floor(total));
            if (end - start < 2) start = Math.max(0, end - 2);
            return [start, end] as [number, number];
        },
        [maxLength],
    );

    const onLoadedMetadata = () => {
        const total = videoRef.current?.duration || 0;
        if (!total) return;
        setDuration(total);
        setRange((current) => clampRange(current[1] > total ? [0, Math.min(5, total)] : current, total));
    };

    const estimate = useMemo(() => {
        if (!catalog || !duration) return null;
        const endpoint = mode === "flf" ? FLF_ENDPOINT : EDIT_ENDPOINT;
        const price = findToolPrice(catalog, "alibaba", endpoint);
        return estimateSpark(price, { seconds: length, resolution });
    }, [catalog, mode, length, resolution, duration]);

    const seekTo = (time: number) => {
        const video = videoRef.current;
        if (video) video.currentTime = Math.max(0, Math.min(time, video.duration || time));
    };

    const playSelection = () => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = range[0];
        void video.play();
        setPlayingSelection(true);
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const onTime = () => {
            if (playingSelection && video.currentTime >= range[1]) {
                video.pause();
                setPlayingSelection(false);
            }
        };
        video.addEventListener("timeupdate", onTime);
        return () => video.removeEventListener("timeupdate", onTime);
    }, [playingSelection, range]);

    const poll = useCallback(async (id: string) => {
        for (let i = 0; i < 60 * 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            try {
                const next = await getVideoEdit(id);
                setJob(next);
                if (next.status === "completed") {
                    message.success("片段已重生成并拼接完成");
                    setBusy(false);
                    onClose();
                    return;
                }
                if (next.status === "failed" || next.status === "cancelled") {
                    setBusy(false);
                    setError(next.error || (next.status === "cancelled" ? "已取消" : "生成失败"));
                    return;
                }
            } catch (cause) {
                setBusy(false);
                setError(cause instanceof Error ? cause.message : String(cause));
                return;
            }
        }
        setBusy(false);
        setError("等待超时，可稍后到运行历史里查看");
    }, [message, onClose]);

    const submit = async () => {
        if (!duration) return setError("视频还没加载完成");
        if (!prompt.trim()) return setError("请填写修改提示词");
        if (length < 2) return setError("片段至少 2 秒");
        setError("");
        setBusy(true);
        try {
            const created = await createVideoEdit({ projectId, sourceNodeId: node.id, start: range[0], end: range[1], prompt: prompt.trim(), mode, resolution, replace });
            setJob(created);
            void poll(created.id);
        } catch (cause) {
            setBusy(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const cancel = async () => {
        if (!job) return;
        await cancelVideoEdit(job.id).catch(() => undefined);
        setBusy(false);
        setError("已取消");
    };

    return (
        <Modal
            open={open}
            onCancel={() => {
                if (active) return message.warning("正在处理，先取消再关闭");
                onClose();
            }}
            footer={null}
            width={900}
            title={
                <span className="inline-flex items-center gap-2">
                    <Scissors className="size-4" /> 片段重生成
                </span>
            }
            destroyOnHidden
        >
            <div className="space-y-3 text-sm">
                <div className="overflow-hidden rounded-xl border border-black/10 bg-black/90 dark:border-white/10">
                    <video ref={videoRef} src={node.metadata?.content} controls className="mx-auto max-h-[46vh] w-full object-contain" onLoadedMetadata={onLoadedMetadata} />
                </div>

                <div>
                    <div className="mb-1 flex items-center justify-between text-xs opacity-70">
                        <span>选择片段（2–{maxLength} 秒）</span>
                        <span className="font-mono">
                            {formatTime(range[0])} → {formatTime(range[1])}（{length}s）
                        </span>
                    </div>
                    <Slider
                        range
                        min={0}
                        max={Math.max(2, Math.floor(duration))}
                        step={1}
                        value={range}
                        disabled={busy || duration < 2}
                        onChange={(value) => setRange(clampRange(value as [number, number], duration))}
                        onChangeComplete={(value) => seekTo((value as [number, number])[0])}
                        tooltip={{ formatter: (value) => formatTime(Number(value)) }}
                    />
                    <Space size={8} className="mt-1">
                        <Button size="small" onClick={playSelection} disabled={busy}>
                            播放选中片段
                        </Button>
                        <Button size="small" onClick={() => seekTo(range[0])} disabled={busy}>
                            定位到起点
                        </Button>
                    </Space>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <div className="mb-1 text-xs opacity-70">衔接方式</div>
                        <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy}>
                            <Radio value="flf">首尾帧（推荐，拼接最稳）</Radio>
                            <Radio value="videoedit">整段重编辑（内容更贴近原片）</Radio>
                        </Radio.Group>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex-1">
                            <div className="mb-1 text-xs opacity-70">分辨率</div>
                            <Select
                                className="w-full"
                                value={resolution}
                                disabled={busy}
                                onChange={(value) => setResolution(value)}
                                options={[
                                    { value: "720P", label: "720P（13 Spark/秒）" },
                                    { value: "1080P", label: "1080P（19.5 Spark/秒）" },
                                ]}
                            />
                        </div>
                        <div>
                            <div className="mb-1 text-xs opacity-70">替换原节点</div>
                            <Switch checked={replace} onChange={setReplace} disabled={busy} />
                        </div>
                    </div>
                </div>

                <div>
                    <div className="mb-1 text-xs opacity-70">修改要求</div>
                    <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="例如：把这段变成夜晚的街景，人物保持不动" disabled={busy} />
                </div>

                <div className="flex items-center justify-between rounded-lg bg-stone-100 px-3 py-2 text-xs dark:bg-stone-900">
                    <span>
                        预计费用：{typeof estimate === "number" ? <strong>{estimate} Spark</strong> : "以平台实际计费为准"}
                        {length ? ` · ${length} 秒 · ${resolution}` : ""}
                    </span>
                    {job ? <Tag color={job.status === "failed" ? "red" : job.status === "completed" ? "green" : "blue"}>{STAGE_LABELS[job.stage] || job.stage}</Tag> : null}
                </div>

                {error ? <Alert type="error" showIcon message={error} /> : null}

                <div className="flex justify-end gap-2">
                    {active ? (
                        <Button danger onClick={() => void cancel()}>
                            取消任务
                        </Button>
                    ) : null}
                    <Button onClick={onClose} disabled={busy}>
                        关闭
                    </Button>
                    <Button type="primary" onClick={() => void submit()} loading={busy} disabled={active || duration < 2}>
                        生成片段并拼接
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function formatTime(value: number) {
    const total = Math.max(0, Math.round(value));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

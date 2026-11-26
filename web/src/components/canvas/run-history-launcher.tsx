import { useEffect, useMemo, useState } from "react";
import { Button, Drawer, Popconfirm, Tag, Tooltip } from "antd";
import { History, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";

import { cancelRun, deleteRun, getRun, listRuns, retryRun, type SolgridRunSummary } from "@/services/api/solgrid";

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
    queued: { text: "排队中", color: "default" },
    submitting: { text: "提交中", color: "processing" },
    running: { text: "生成中", color: "processing" },
    completed: { text: "完成", color: "success" },
    failed: { text: "失败", color: "error" },
    uncertain: { text: "结果未知", color: "warning" },
    stopped: { text: "已取消", color: "default" },
};

const ACTIVE = new Set(["queued", "submitting", "running"]);

function formatTime(value?: string | null) {
    if (!value) return "";
    const date = new Date(value);
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(run: SolgridRunSummary) {
    if (!run.startedAt || !run.finishedAt) return "";
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return "";
    return ms > 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

function formatCost(value?: number | null) {
    return typeof value === "number" ? `${value} Spark` : "";
}

// 运行历史：项目内所有生成任务的账本视图
export function RunHistoryLauncher({ projectId }: { projectId: string }) {
    const [open, setOpen] = useState(false);
    const [runs, setRuns] = useState<SolgridRunSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [detailId, setDetailId] = useState<string | null>(null);
    const [detail, setDetail] = useState<Awaited<ReturnType<typeof getRun>>["run"] | null>(null);

    const load = () => {
        setLoading(true);
        listRuns(projectId, 200)
            .then((value) => setRuns(value))
            .catch(() => undefined)
            .finally(() => setLoading(false));
    };

    // 打开时轮询；关闭时只取一次（让浮标能显示数量与花费）
    useEffect(() => {
        load();
    }, [projectId]);

    useEffect(() => {
        if (!open) return;
        const timer = setInterval(load, 2500);
        return () => clearInterval(timer);
    }, [open, projectId]);

    useEffect(() => {
        if (!open || !detailId) return;
        getRun(detailId)
            .then((payload) => setDetail(payload.run))
            .catch(() => setDetail(null));
    }, [open, detailId]);

    const summary = useMemo(() => {
        const totalCost = runs.reduce((sum, run) => sum + (typeof run.costSpark === "number" ? run.costSpark : 0), 0);
        const failed = runs.filter((run) => run.status === "failed" || run.status === "uncertain").length;
        const active = runs.filter((run) => ACTIVE.has(run.status)).length;
        return { totalCost: Math.round(totalCost * 100) / 100, failed, active };
    }, [runs]);

    return (
        <>
            <button
                type="button"
                data-canvas-no-zoom
                className="absolute bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-black/10 bg-white/80 px-3 py-1.5 text-xs text-stone-600 shadow-sm backdrop-blur transition hover:bg-white dark:border-white/10 dark:bg-stone-900/80 dark:text-stone-300 dark:hover:bg-stone-900"
                onClick={() => setOpen(true)}
                title="运行历史"
            >
                <History className="size-3.5" />
                <span>运行 {runs.length || ""}</span>
                {summary.totalCost ? <span className="text-stone-400">· {summary.totalCost} Spark</span> : null}
                {summary.active ? <span className="text-blue-500">· {summary.active} 进行中</span> : null}
            </button>

            <Drawer open={open} onClose={() => setOpen(false)} width={640} title="运行历史" styles={{ body: { padding: 12 } }}>
                <div className="mb-3 flex items-center gap-3 text-xs text-stone-500">
                    <span>共 {runs.length} 次</span>
                    <span>累计 {summary.totalCost} Spark</span>
                    <span>失败/未知 {summary.failed}</span>
                    {summary.active ? <span className="text-blue-500">进行中 {summary.active}</span> : null}
                    <Button size="small" type="text" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} onClick={load} />
                </div>

                <div className="space-y-1.5">
                    {runs.length === 0 ? <div className="py-8 text-center text-sm text-stone-400">还没有生成记录</div> : null}
                    {runs.map((run) => {
                        const status = STATUS_LABEL[run.status] || { text: run.status, color: "default" };
                        return (
                            <div key={run.id} className="rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                                <div className="flex items-center gap-2">
                                    <Tag color={status.color} className="!m-0">
                                        {status.text}
                                        {run.status === "queued" && run.queuePosition ? ` #${run.queuePosition}` : ""}
                                    </Tag>
                                    <span className="min-w-0 flex-1 truncate font-mono">
                                        {run.provider} · {run.endpoint}
                                    </span>
                                    <span className="shrink-0 text-stone-500">{formatTime(run.createdAt)}</span>
                                    <span className="shrink-0 text-stone-500">{formatCost(run.costSpark)}</span>
                                    <span className="w-14 shrink-0 text-right text-stone-500">{formatDuration(run)}</span>
                                </div>
                                {run.error ? <div className="mt-1 truncate text-red-500" title={run.error}>{run.error}</div> : null}
                                <div className="mt-1 flex items-center gap-1">
                                    <Button size="small" type="text" onClick={() => setDetailId(run.id)}>
                                        详情
                                    </Button>
                                    {ACTIVE.has(run.status) ? (
                                        <Tooltip title="取消">
                                            <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={() => void cancelRun(run.id).then(load)} />
                                        </Tooltip>
                                    ) : (
                                        <Tooltip title="用同样参数重试">
                                            <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} onClick={() => void retryRun(run.id).then(load)} />
                                        </Tooltip>
                                    )}
                                    <Popconfirm title="删除这条记录？" okText="删除" cancelText="取消" onConfirm={() => void deleteRun(run.id).then(load)}>
                                        <Button size="small" type="text" icon={<Trash2 className="size-3.5" />} />
                                    </Popconfirm>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </Drawer>

            <Drawer open={Boolean(detailId)} onClose={() => setDetailId(null)} width={680} title="运行详情" styles={{ body: { padding: 12 } }}>
                {detail ? (
                    <div className="space-y-3 text-xs">
                        <div className="grid grid-cols-2 gap-2">
                            <div>状态：{STATUS_LABEL[detail.status]?.text || detail.status}{detail.status === "queued" && detail.queuePosition ? `（第 ${detail.queuePosition} 位）` : ""}</div>
                            <div>花费：{formatCost(detail.costSpark)}</div>
                            <div className="col-span-2 font-mono break-all">模型：{detail.provider} · {detail.endpoint}</div>
                            {detail.remoteRunId ? <div className="col-span-2 break-all">平台 runId：{detail.remoteRunId}</div> : null}
                            {detail.error ? <div className="col-span-2 text-red-500 whitespace-pre-wrap">错误：{detail.error}</div> : null}
                        </div>
                        {detail.outputs?.length ? (
                            <div>
                                <div className="mb-1 font-semibold">产物</div>
                                <div className="flex flex-wrap gap-2">
                                    {detail.outputs.map((output) =>
                                        output.mime?.startsWith("video/") ? (
                                            <video key={output.url} src={output.url} controls className="h-32 rounded-lg" />
                                        ) : (
                                            <img key={output.url} src={output.url} alt="产物" className="h-32 rounded-lg object-cover" />
                                        ),
                                    )}
                                </div>
                            </div>
                        ) : null}
                        <div>
                            <div className="mb-1 font-semibold">画布参数</div>
                            <pre className="max-h-56 overflow-auto rounded-lg bg-stone-100 p-2 text-[11px] dark:bg-stone-900">{JSON.stringify(detail.body ?? {}, null, 2)}</pre>
                        </div>
                        {detail.builtBody ? (
                            <div>
                                <div className="mb-1 font-semibold">实际请求体</div>
                                <pre className="max-h-56 overflow-auto rounded-lg bg-stone-100 p-2 text-[11px] dark:bg-stone-900">{JSON.stringify(detail.builtBody, null, 2)}</pre>
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <div className="py-8 text-center text-sm text-stone-400">加载中…</div>
                )}
            </Drawer>
        </>
    );
}

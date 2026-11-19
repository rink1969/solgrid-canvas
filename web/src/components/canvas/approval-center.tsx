import { useEffect, useState } from "react";
import { Button, Modal, Tag } from "antd";

import { decideApproval, listPendingApprovals, type CanvasApproval } from "@/services/api/approvals";

const MODE_LABEL: Record<string, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };

function summarize(approval: CanvasApproval) {
    const params = approval.params || {};
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    const count = Number(params.count) || 1;
    const seconds = params.seconds ? `${params.seconds}s` : "";
    const resolution = typeof params.resolution === "string" ? params.resolution : "";
    return { prompt, count, seconds, resolution };
}

// Agent 通过 MCP 请求生成时，在这里等用户确认；不点就不花钱
export function ApprovalCenter({ projectId }: { projectId: string }) {
    const [approvals, setApprovals] = useState<CanvasApproval[]>([]);
    const [deciding, setDeciding] = useState<string | null>(null);

    useEffect(() => {
        listPendingApprovals(projectId)
            .then((items) => setApprovals(items))
            .catch(() => undefined);

        const onApproval = (event: Event) => {
            const detail = (event as CustomEvent<{ type: string; approval?: CanvasApproval; id?: string }>).detail;
            if (!detail) return;
            if (detail.type === "approval.requested" && detail.approval && detail.approval.projectId === projectId) {
                setApprovals((prev) => (prev.some((item) => item.id === detail.approval!.id) ? prev : [...prev, detail.approval!]));
            }
            if (detail.type === "approval.decided" && detail.id) {
                setApprovals((prev) => prev.filter((item) => item.id !== detail.id));
            }
        };
        window.addEventListener("canvas:approval", onApproval);
        return () => window.removeEventListener("canvas:approval", onApproval);
    }, [projectId]);

    const decide = async (approval: CanvasApproval, allow: boolean) => {
        setDeciding(approval.id);
        try {
            await decideApproval(approval.id, allow);
            setApprovals((prev) => prev.filter((item) => item.id !== approval.id));
        } finally {
            setDeciding(null);
        }
    };

    const current = approvals[0];
    if (!current) return null;
    const { prompt, count, seconds, resolution } = summarize(current);
    const kind = current.endpoint.includes("/video/") ? "video" : current.endpoint.includes("/audio/") || current.endpoint.includes("t2a") ? "audio" : "image";

    return (
        <Modal open title="Agent 请求生成" onCancel={() => void decide(current, false)} footer={null} width={520} maskClosable={false}>
            <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                    <Tag color="blue">花费用平台计费</Tag>
                    <span className="font-mono text-xs">
                        {current.provider} · {current.endpoint}
                    </span>
                </div>
                <div className="rounded-lg bg-stone-100 px-3 py-2 text-xs dark:bg-stone-900">
                    <div>
                        类型：{MODE_LABEL[kind] || kind}
                        {kind === "image" ? ` · ${count} 张` : ""}
                        {seconds ? ` · ${seconds}` : ""}
                        {resolution ? ` · ${resolution}` : ""}
                    </div>
                    {prompt ? <div className="mt-1 line-clamp-3 opacity-80">{prompt}</div> : null}
                </div>
                <div className="text-xs text-stone-500">批准后立即入队；拒绝不会产生任何费用。</div>
                <div className="flex justify-end gap-2">
                    <Button onClick={() => void decide(current, false)} loading={deciding === current.id}>
                        拒绝
                    </Button>
                    <Button type="primary" onClick={() => void decide(current, true)} loading={deciding === current.id}>
                        允许本次生成
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Modal, Select, Tag } from "antd";
import { Bot, Send, Square } from "lucide-react";

import {
    cancelAgentPrompt,
    decideAgentPermission,
    getAgentStatus,
    getAgentTranscript,
    sendAgentPrompt,
    setAgentModel,
    startAgentSession,
    type AgentConfigOption,
    type AgentTranscriptItem,
} from "@/services/api/agent";

// 画布内嵌 Agent 对话：ACP 会话由 daemon 管理，模型/凭证都来自本地 Agent
export function AgentChatPanel({ projectId }: { projectId: string }) {
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState<boolean | null>(null);
    const [adapter, setAdapter] = useState<string | null>(null);
    const [configOptions, setConfigOptions] = useState<AgentConfigOption[]>([]);
    const [items, setItems] = useState<AgentTranscriptItem[]>([]);
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const [permission, setPermission] = useState<{ id: string; title?: string } | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);

    const modelOption = configOptions.find((option) => option.id === "model");
    const modelGroups = (modelOption?.options || []).map((group) => ({
        label: group.name || group.group || "",
        options: (group.options || []).map((option) => ({ value: option.value, label: option.name })),
    }));

    const ensureSession = async () => {
        try {
            const status = await getAgentStatus();
            setAvailable(status.available);
            setAdapter(status.adapter);
            if (!status.available) return;
            const session = await startAgentSession(projectId);
            let nextOptions = session.configOptions;
            // 默认路由没配 key 时，自动切到本机已登录的 account 路由
            const current = nextOptions.find((option) => option.id === "model")?.currentValue || "";
            if (current.includes("deepseek-official")) {
                const account = nextOptions
                    .find((option) => option.id === "model")
                    ?.options?.flatMap((group) => group.options || [])
                    .find((option) => option.value.includes("deepseek-account"));
                if (account) nextOptions = (await setAgentModel(projectId, "model", account.value)).configOptions;
            }
            setConfigOptions(nextOptions);
            const { transcript } = await getAgentTranscript(projectId);
            setItems(transcript);
        } catch (cause) {
            setAvailable(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    useEffect(() => {
        if (open) void ensureSession();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, projectId]);

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<Record<string, unknown>>).detail as Record<string, any>;
            if (!detail || detail.projectId !== projectId) return;
            if (detail.kind === "permission") {
                setPermission({ id: detail.id, title: detail.toolCall?.title });
                return;
            }
            if (detail.kind === "permission-decided") {
                setPermission(null);
                return;
            }
            if (detail.kind === "model") {
                setConfigOptions(detail.configOptions || []);
                return;
            }
            if (detail.kind === "user") {
                setItems((prev) => [...prev, { role: "user", text: detail.text }]);
                setRunning(true);
                return;
            }
            if (detail.kind === "done") {
                setRunning(false);
                if (detail.error) setError(detail.error);
                return;
            }
            if (detail.kind === "update") {
                const update = detail.update || {};
                const kind = update.sessionUpdate || update.type;
                if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
                    const role = kind === "agent_message_chunk" ? "assistant" : "thought";
                    const text = update.content?.text || "";
                    setItems((prev) => {
                        const last = prev[prev.length - 1];
                        if (last?.role === role && last.messageId === update.messageId) {
                            const copy = [...prev];
                            copy[copy.length - 1] = { ...last, text: `${last.text || ""}${text}` };
                            return copy;
                        }
                        return [...prev, { role, text, messageId: update.messageId }];
                    });
                } else if (kind === "tool_call") {
                    setItems((prev) => [...prev, { role: "tool", toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status }]);
                } else if (kind === "tool_call_update") {
                    setItems((prev) => prev.map((item) => (item.toolCallId === update.toolCallId ? { ...item, status: update.status } : item)));
                }
            }
        };
        window.addEventListener("canvas:agent", handler);
        return () => window.removeEventListener("canvas:agent", handler);
    }, [projectId]);

    // 轮询兜底：SSE 丢失或重连时，打开面板期间定期对齐 daemon 的 transcript / running 状态
    useEffect(() => {
        if (!open) return;
        let alive = true;
        const timer = setInterval(async () => {
            try {
                const [transcript, status] = await Promise.all([getAgentTranscript(projectId), getAgentStatus()]);
                if (!alive) return;
                setItems(transcript.transcript);
                const session = status.sessions.find((item) => item.projectId === projectId);
                setRunning(Boolean(session?.running));
            } catch {
                /* daemon 未就绪时忽略 */
            }
        }, 2500);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [open, projectId]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: "end" });
    }, [items.length, open]);

    const send = async () => {
        const text = input.trim();
        if (!text || running) return;
        setError("");
        setInput("");
        setItems((prev) => [...prev, { role: "user", text }]);
        setRunning(true);
        try {
            await sendAgentPrompt(projectId, text);
        } catch (cause) {
            setRunning(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return (
        <>
            <button
                type="button"
                data-canvas-no-zoom
                className="absolute bottom-4 right-40 z-30 flex items-center gap-2 rounded-full border border-black/10 bg-white/80 px-3 py-1.5 text-xs text-stone-600 shadow-sm backdrop-blur transition hover:bg-white dark:border-white/10 dark:bg-stone-900/80 dark:text-stone-300"
                onClick={() => setOpen(true)}
                title="本地 Agent"
            >
                <Bot className="size-3.5" />
                <span>Agent</span>
            </button>

            <Drawer open={open} onClose={() => setOpen(false)} width={440} title="本地 Agent" styles={{ body: { padding: 12, display: "flex", flexDirection: "column", gap: 8 } }}>
                <div className="flex items-center gap-2">
                    <Tag color={adapter ? "green" : "default"}>{adapter || "未连接"}</Tag>
                    <Select
                        size="small"
                        className="min-w-0 flex-1"
                        value={modelOption?.currentValue}
                        options={modelGroups}
                        placeholder="选择模型"
                        onChange={(value: string) => void setAgentModel(projectId, "model", value).then((result) => setConfigOptions(result.configOptions)).catch(() => undefined)}
                    />
                    {running ? (
                        <Button size="small" danger icon={<Square className="size-3.5" />} onClick={() => void cancelAgentPrompt(projectId)}>
                            停止
                        </Button>
                    ) : null}
                </div>

                {available === false ? (
                    <div className="rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                        没有找到可用的 ACP Agent。目前支持 DSH 桌面版；也可以用环境变量 <code>CANVAS_ACP_COMMAND</code> / <code>CANVAS_ACP_ARGS</code> 指定别的适配器。
                    </div>
                ) : null}

                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto rounded-lg border border-stone-200 p-2 text-sm dark:border-stone-800">
                    {items.map((item, index) => {
                        if (item.role === "user") {
                            return (
                                <div key={index} className="mb-2 ml-auto max-w-[85%] rounded-xl bg-blue-50 px-3 py-1.5 text-[13px] dark:bg-blue-950/40">
                                    {item.text}
                                </div>
                            );
                        }
                        if (item.role === "assistant") {
                            return (
                                <div key={index} className="mb-2 max-w-[95%] whitespace-pre-wrap px-1 text-[13px]">
                                    {item.text}
                                </div>
                            );
                        }
                        if (item.role === "thought") {
                            return (
                                <div key={index} className="mb-2 max-w-[95%] whitespace-pre-wrap px-1 text-[12px] italic text-stone-400">
                                    {item.text}
                                </div>
                            );
                        }
                        return (
                            <div key={index} className="mb-1 flex items-center gap-2 px-1 text-[11px] text-stone-500">
                                <Tag className="!m-0" color={item.status === "completed" ? "green" : item.status === "failed" ? "red" : "blue"}>
                                    {item.status || "running"}
                                </Tag>
                                <span className="truncate">{item.title || item.toolCallId}</span>
                            </div>
                        );
                    })}
                    <div ref={bottomRef} />
                </div>

                {error ? <div className="text-xs text-red-500">{error}</div> : null}

                <div className="flex items-end gap-2">
                    <textarea
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        rows={2}
                        placeholder="让 Agent 做点什么，例如：在画布上把这两个节点连起来"
                        className="min-h-[56px] flex-1 resize-none rounded-lg border border-stone-200 bg-transparent px-3 py-2 text-sm outline-none dark:border-stone-700"
                    />
                    <Button type="primary" icon={<Send className="size-3.5" />} disabled={!input.trim() || running} onClick={() => void send()}>
                        发送
                    </Button>
                </div>
            </Drawer>

            <Modal
                open={Boolean(permission)}
                title="Agent 请求执行操作"
                onCancel={() => {
                    if (permission) void decideAgentPermission(permission.id, false);
                }}
                footer={[
                    <Button key="deny" onClick={() => permission && void decideAgentPermission(permission.id, false)}>
                        拒绝
                    </Button>,
                    <Button key="allow" type="primary" onClick={() => permission && void decideAgentPermission(permission.id, true)}>
                        允许
                    </Button>,
                ]}
            >
                <div className="text-sm">{permission?.title || "Agent 需要你的确认才能继续。"}</div>
            </Modal>
        </>
    );
}

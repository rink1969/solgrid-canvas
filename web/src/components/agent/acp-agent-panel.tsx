import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Tag } from "antd";
import { Bot, PanelRightClose } from "lucide-react";
import { useMatch } from "react-router-dom";

import { canvasThemes } from "@/lib/canvas-theme";
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
import { useAgentStore, type AgentChatItem, type AgentModel } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { AgentChatTimeline } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";

const POLL_MS = 2500;

function modelOf(configOptions: AgentConfigOption[]): { models: AgentModel[]; current: string } {
    const option = configOptions.find((item) => item.id === "model");
    const models: AgentModel[] = [];
    for (const group of option?.options || []) {
        for (const item of group.options || []) {
            let model = item.value;
            try {
                const parsed = JSON.parse(item.value);
                if (Array.isArray(parsed)) model = String(parsed[1] || parsed[0] || item.value);
            } catch {
                /* 非 JSON 值直接用 */
            }
            models.push({ id: item.value, model, displayName: item.name, defaultReasoningEffort: "medium", supportedReasoningEfforts: [], isDefault: item.value === option?.currentValue });
        }
    }
    return { models, current: option?.currentValue || "" };
}

function messagesFromTranscript(transcript: AgentTranscriptItem[]): AgentChatItem[] {
    return transcript.map((item, index) => {
        if (item.role === "user") return { id: `user-${index}`, role: "user", text: item.text || "" };
        if (item.role === "thought") return { id: `thought-${index}`, role: "system", text: item.text || "" };
        if (item.role === "tool") return { id: item.toolCallId || `tool-${index}`, role: "tool", title: item.title || "工具", text: item.status || "", detail: { status: item.status } };
        return { id: `assistant-${index}`, role: "assistant", text: item.text || "" };
    });
}

// 用上游 Agent 面板的视觉（右侧停靠 + 可拖宽），数据层换成 daemon 的 ACP 会话
export function AcpAgentPanel() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const match = useMatch("/canvas/:id");
    const projectId = match?.params.id || "";
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const closePanel = useAgentStore((state) => state.closePanel);
    const panelOpen = useAgentStore((state) => state.panelOpen);

    const [messages, setMessages] = useState<AgentChatItem[]>([]);
    const [configOptions, setConfigOptions] = useState<AgentConfigOption[]>([]);
    const [prompt, setPrompt] = useState("");
    const [sending, setSending] = useState(false);
    const [available, setAvailable] = useState<boolean | null>(null);
    const [adapter, setAdapter] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [permission, setPermission] = useState<{ id: string; title?: string } | null>(null);
    const sendingRef = useRef(false);
    const projectRef = useRef(projectId);

    const { models, current } = useMemo(() => modelOf(configOptions), [configOptions]);

    useEffect(() => {
        projectRef.current = projectId;
    }, [projectId]);

    // 面板开着就同步给全局 store（时间线读 store 里的 messages）
    useEffect(() => {
        setAgentState({ messages, enabled: true, connected: available !== false, models, model: current, panelMounted: true });
    }, [messages, models, current, available, setAgentState]);

    const loadSession = useCallback(async () => {
        if (!projectId) return;
        setError("");
        try {
            const status = await getAgentStatus();
            setAvailable(status.available);
            setAdapter(status.adapter);
            if (!status.available) return;
            const session = await startAgentSession(projectId);
            setConfigOptions(session.configOptions);
            const { transcript } = await getAgentTranscript(projectId);
            setMessages(messagesFromTranscript(transcript));
            setSending(false);
            sendingRef.current = false;
        } catch (cause) {
            setAvailable(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [projectId]);

    useEffect(() => {
        if (panelOpen) void loadSession();
    }, [panelOpen, loadSession]);

    // SSE 流式更新：直接拼到消息列表，保留打字效果
    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<Record<string, any>>).detail;
            if (!detail || detail.projectId !== projectRef.current) return;
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
                setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text: detail.text || "" }]);
                return;
            }
            if (detail.kind === "done") {
                setSending(false);
                sendingRef.current = false;
                setMessages((prev) => prev.map((item) => ({ ...item, streamId: undefined })));
                if (detail.error) setError(detail.error);
                return;
            }
            if (detail.kind !== "update") return;
            const update = detail.update || {};
            const kind = update.sessionUpdate || update.type;
            if (kind === "agent_message_chunk") {
                const text = update.content?.text || "";
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant" && last.id === `as-${update.messageId}`) {
                        const copy = [...prev];
                        copy[copy.length - 1] = { ...last, text: `${last.text}${text}`, streamId: update.messageId };
                        return copy;
                    }
                    return [...prev, { id: `as-${update.messageId}`, role: "assistant", text, streamId: update.messageId }];
                });
                return;
            }
            if (kind === "tool_call") {
                setMessages((prev) => [...prev, { id: update.toolCallId, role: "tool", title: update.title || "工具", text: update.kind || "", detail: { status: update.status || "running" } }]);
                return;
            }
            if (kind === "tool_call_update") {
                setMessages((prev) => prev.map((item) => (item.id === update.toolCallId ? { ...item, detail: { status: update.status } } : item)));
            }
        };
        window.addEventListener("canvas:agent", handler);
        return () => window.removeEventListener("canvas:agent", handler);
    }, []);

    // 轮询兜底：SSE 丢失/重连时对齐 transcript 与运行状态
    useEffect(() => {
        if (!projectId || !panelOpen) return;
        let alive = true;
        const timer = setInterval(async () => {
            try {
                const [transcript, status] = await Promise.all([getAgentTranscript(projectId), getAgentStatus()]);
                if (!alive) return;
                const session = status.sessions.find((item) => item.projectId === projectId);
                const running = Boolean(session?.running);
                if (!sendingRef.current && !running) setMessages(messagesFromTranscript(transcript.transcript));
                if (running !== sendingRef.current) {
                    sendingRef.current = running;
                    setSending(running);
                }
            } catch {
                /* daemon 未就绪时忽略 */
            }
        }, POLL_MS);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [projectId, panelOpen]);

    const submit = async () => {
        const text = prompt.trim();
        if (!text || sending || !projectId) return;
        setPrompt("");
        setError("");
        setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
        setSending(true);
        sendingRef.current = true;
        try {
            await sendAgentPrompt(projectId, text);
        } catch (cause) {
            setSending(false);
            sendingRef.current = false;
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const stop = () => {
        if (projectId) void cancelAgentPrompt(projectId);
    };

    const changeModel = async (value: string) => {
        if (!projectId) return;
        try {
            const result = await setAgentModel(projectId, "model", value);
            setConfigOptions(result.configOptions);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const decide = async (allow: boolean) => {
        if (!permission) return;
        const id = permission.id;
        setPermission(null);
        await decideAgentPermission(id, allow).catch(() => undefined);
    };

    return (
        <div className="flex h-full min-h-0 flex-col" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${theme.node.stroke}` }}>
                <Bot className="size-4 opacity-70" />
                <span className="text-sm font-medium">本地 Agent</span>
                <Tag className="!m-0" color={available ? "green" : "default"}>
                    {adapter || "未连接"}
                </Tag>
                <div className="ml-auto flex items-center gap-1">
                    <Button size="small" type="text" icon={<PanelRightClose className="size-4" />} onClick={closePanel} aria-label="关闭" />
                </div>
            </div>

            {available === false ? (
                <div className="mx-3 rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                    没有找到可用的 ACP Agent。目前支持 DSH 桌面版；也可以用环境变量 <code>CANVAS_ACP_COMMAND</code> / <code>CANVAS_ACP_ARGS</code> 指定别的适配器。
                </div>
            ) : null}

            {!projectId ? (
                <div className="mx-3 rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">打开一个画布项目后，Agent 会跟随这个项目工作。</div>
            ) : null}

            <AgentChatTimeline
                theme={theme}
                pendingTool={null}
                pendingApprovals={[]}
                sending={sending}
                waiting={sending}
                onRejectTool={() => undefined}
                onApproveTool={() => undefined}
                onApprovalDecision={() => undefined}
            />

            {error ? <div className="px-3 pb-1 text-xs text-red-500">{error}</div> : null}

            <AgentChatComposer
                prompt={prompt}
                theme={theme}
                placeholder="让 Agent 做点什么，例如：在画布上把这两个节点连起来"
                disabled={!projectId || available === false}
                sending={sending}
                onPromptChange={setPrompt}
                onSubmit={() => void submit()}
                onStop={stop}
                models={models}
                model={current}
                onModelChange={(value: string) => void changeModel(value)}
            />

            <Modal
                open={Boolean(permission)}
                title="Agent 请求执行操作"
                onCancel={() => void decide(false)}
                footer={[
                    <Button key="deny" onClick={() => void decide(false)}>
                        拒绝
                    </Button>,
                    <Button key="allow" type="primary" onClick={() => void decide(true)}>
                        允许
                    </Button>,
                ]}
            >
                <div className="text-sm">{permission?.title || "Agent 需要你的确认才能继续。"}</div>
            </Modal>
        </div>
    );
}

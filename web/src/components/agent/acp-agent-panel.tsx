import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Modal, Segmented, Tag } from "antd";
import { Bot, Folder, History, MessageSquare, PanelRightClose, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMatch } from "react-router-dom";
import dayjs from "dayjs";

import { canvasThemes } from "@/lib/canvas-theme";
import { daemonApi } from "@/services/api/daemon";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { promptWithCanvasReferences } from "./agent-event-formatters";
import {
    cancelAgentPrompt,
    createAgentConversation,
    decideAgentPermission,
    deleteAgentConversation,
    getAgentStatus,
    getAgentTranscript,
    listAgentConversations,
    sendAgentPrompt,
    setAgentModel,
    type AgentConfigOption,
    type AgentConversation,
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

// 画布内 Agent：每个画布一个对话列表，对话之间会话隔离、可切换
export function AcpAgentPanel() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const match = useMatch("/canvas/:id");
    const projectId = match?.params.id || "";
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const closePanel = useAgentStore((state) => state.closePanel);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const { message, modal } = App.useApp();

    const [conversations, setConversations] = useState<AgentConversation[]>([]);
    const [activeId, setActiveId] = useState("");
    const [messages, setMessages] = useState<AgentChatItem[]>([]);
    const [prompt, setPrompt] = useState("");
    const [sending, setSending] = useState(false);
    const [available, setAvailable] = useState<boolean | null>(null);
    const [adapter, setAdapter] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [permission, setPermission] = useState<{ id: string; title?: string } | null>(null);
    const [tab, setTab] = useState<"chat" | "history">("chat");
    const [refreshing, setRefreshing] = useState(false);
    const [projectsDir, setProjectsDir] = useState("");
    const sendingRef = useRef(false);
    const projectRef = useRef(projectId);
    const activeRef = useRef(activeId);
    const storageKey = useMemo(() => `canvas-agent-active-conversation:${projectId}`, [projectId]);

    const active = conversations.find((item) => item.id === activeId) || null;
    const configOptions = active?.configOptions || [];
    const { models, current } = useMemo(() => modelOf(configOptions), [configOptions]);
    const currentModelName = models.find((item) => item.id === current)?.model || models[0]?.model || "";
    const projectPath = projectsDir ? `${projectsDir.replace(/[\\/]+$/, "")}${projectsDir.includes("\\") ? "\\" : "/"}${projectId}` : "";

    useEffect(() => {
        projectRef.current = projectId;
    }, [projectId]);
    useEffect(() => {
        activeRef.current = activeId;
    }, [activeId]);

    useEffect(() => {
        setAgentState({ messages, enabled: true, connected: available !== false, models, model: current, panelMounted: true });
    }, [messages, models, current, available, setAgentState]);

    const loadTranscript = useCallback(
        async (conversationId: string) => {
            const { transcript } = await getAgentTranscript(projectId, conversationId);
            setMessages(messagesFromTranscript(transcript));
        },
        [projectId],
    );

    const refreshConversations = useCallback(async () => {
        const list = await listAgentConversations(projectId);
        let next = list;
        if (!next.length) {
            const created = await createAgentConversation(projectId);
            next = [created];
        }
        setConversations(next);
        const saved = localStorage.getItem(storageKey);
        const pick = next.some((item) => item.id === saved) ? (saved as string) : next[0].id;
        setActiveId((currentId) => (next.some((item) => item.id === currentId) ? currentId : pick));
        return next;
    }, [projectId, storageKey]);

    const loadSession = useCallback(async () => {
        if (!projectId) return;
        setError("");
        try {
            const status = await getAgentStatus();
            setAvailable(status.available);
            setAdapter(status.adapter);
            if (!status.available) return;
            const list = await refreshConversations();
            const pick = localStorage.getItem(storageKey);
            const id = list.some((item) => item.id === pick) ? (pick as string) : list[0]?.id;
            if (id) {
                setActiveId(id);
                await loadTranscript(id);
            }
        } catch (cause) {
            setAvailable(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [projectId, refreshConversations, loadTranscript, storageKey]);

    useEffect(() => {
        if (!panelOpen) return;
        void loadSession();
    }, [panelOpen, loadSession]);

    const canvasProject = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));

    // 把当前画布快照喂给 @ 引用候选列表（之前 canvasContext 为空，@ 列表是空的）
    useEffect(() => {
        if (!panelOpen || !canvasProject) return;
        const snapshot = {
            projectId,
            title: canvasProject.title || "",
            nodes: canvasProject.nodes,
            connections: canvasProject.connections,
            selectedNodeIds: [] as string[],
            viewport: canvasProject.viewport,
        };
        useAgentStore.getState().setCanvasContext({
            snapshot,
            applyOps: () => snapshot,
            undoOps: () => null,
            canUndo: false,
        });
    }, [panelOpen, projectId, canvasProject, canvasProject?.nodes, canvasProject?.connections]);

    useEffect(() => {
        const focusChat = () => setTab("chat");
        window.addEventListener("canvas:agent-focus-chat", focusChat);
        return () => window.removeEventListener("canvas:agent-focus-chat", focusChat);
    }, []);

    useEffect(() => {
        if (!panelOpen) return;
        let alive = true;
        void daemonApi
            .getMeta()
            .then((meta) => {
                if (alive) setProjectsDir(meta.projectsDir || "");
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [panelOpen]);

    // 切换对话：记录当前选择并加载 transcript
    useEffect(() => {
        if (!activeId) return;
        localStorage.setItem(storageKey, activeId);
        setSending(false);
        sendingRef.current = false;
        useAgentStore.getState().setAgentState({ canvasReferences: [] });
        void loadTranscript(activeId).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, [activeId, loadTranscript, storageKey]);

    // SSE：只把当前对话的流式事件写进时间线
    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<Record<string, any>>).detail;
            if (!detail || detail.projectId !== projectRef.current) return;
            if (detail.kind === "conversation") {
                void refreshConversations();
                return;
            }
            if (detail.conversationId !== activeRef.current) return;
            if (detail.kind === "permission") {
                setPermission({ id: detail.id, title: detail.toolCall?.title });
                return;
            }
            if (detail.kind === "permission-decided") {
                setPermission(null);
                return;
            }
            if (detail.kind === "session" || detail.kind === "model") {
                setConversations((prev) => prev.map((item) => (item.id === activeRef.current ? { ...item, configOptions: detail.configOptions || item.configOptions } : item)));
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
    }, [refreshConversations]);

    // 轮询兜底：只同步当前对话的 transcript 与运行状态
    useEffect(() => {
        if (!projectId || !panelOpen || !activeId) return;
        let alive = true;
        const timer = setInterval(async () => {
            try {
                const [transcript, list] = await Promise.all([getAgentTranscript(projectId, activeId), listAgentConversations(projectId)]);
                if (!alive) return;
                setConversations(list);
                const current = list.find((item) => item.id === activeId);
                const running = Boolean(current?.running);
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
    }, [projectId, panelOpen, activeId]);

    const submit = async () => {
        const text = prompt.trim();
        const references = useAgentStore.getState().canvasReferences;
        if ((!text && !references.length) || sending || !projectId || !activeId) return;
        setPrompt("");
        setError("");
        const finalPrompt = promptWithCanvasReferences(text, references);
        setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text: finalPrompt }]);
        setSending(true);
        sendingRef.current = true;
        try {
            await sendAgentPrompt(projectId, activeId, finalPrompt);
            useAgentStore.getState().setAgentState({ canvasReferences: [] });
        } catch (cause) {
            setSending(false);
            sendingRef.current = false;
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const stop = () => {
        if (projectId && activeId) void cancelAgentPrompt(projectId, activeId);
    };

    const changeModel = async (value: string) => {
        if (!projectId || !activeId) return;
        try {
            const result = await setAgentModel(projectId, activeId, "model", value);
            setConversations((prev) => prev.map((item) => (item.id === activeId ? { ...item, configOptions: result.configOptions } : item)));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const refreshList = async () => {
        setRefreshing(true);
        try {
            await refreshConversations();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setRefreshing(false);
        }
    };

    const newConversation = async () => {
        if (!projectId) return;
        try {
            const created = await createAgentConversation(projectId);
            setConversations((prev) => [created, ...prev]);
            setActiveId(created.id);
            setMessages([]);
            setError("");
            setTab("chat");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const removeConversation = (conversationId: string) => {
        modal.confirm({
            title: "删除这个对话？",
            content: "对话记录会一并删除，无法恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await deleteAgentConversation(projectId, conversationId).catch(() => undefined);
                const rest = conversations.filter((item) => item.id !== conversationId);
                if (rest.length) {
                    setConversations(rest);
                    setActiveId(rest[0].id);
                } else {
                    await newConversation();
                }
            },
        });
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
                    <Segmented
                        size="small"
                        value={tab}
                        onChange={(value) => setTab(value as "chat" | "history")}
                        options={[
                            { value: "chat", label: <span className="flex items-center gap-1"><MessageSquare className="size-3.5" />对话</span> },
                            { value: "history", label: <span className="flex items-center gap-1"><History className="size-3.5" />历史{conversations.length ? ` ${conversations.length}` : ""}</span> },
                        ]}
                    />
                    <Button size="small" type="text" icon={<PanelRightClose className="size-4" />} onClick={closePanel} aria-label="关闭" />
                </div>
            </div>

            {tab === "history" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 px-3 py-2 text-xs" style={{ borderBottom: `1px solid ${theme.node.stroke}` }}>
                        <Folder className="size-3.5 shrink-0 opacity-60" />
                        <span className="truncate opacity-70" title={projectPath}>工作空间 {projectPath || "…"}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-xs opacity-60">{conversations.length} 条历史</span>
                        <div className="flex items-center gap-1">
                            <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} loading={refreshing} onClick={() => void refreshList()}>
                                刷新
                            </Button>
                            <Button size="small" type="primary" icon={<Plus className="size-3.5" />} onClick={() => void newConversation()}>
                                新对话
                            </Button>
                        </div>
                    </div>
                    <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
                        {conversations.map((conversation) => (
                            <div
                                key={conversation.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                    setActiveId(conversation.id);
                                    setTab("chat");
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        setActiveId(conversation.id);
                                        setTab("chat");
                                    }
                                }}
                                className="group relative w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition hover:bg-black/[.03] dark:hover:bg-white/[.04]"
                                style={{ borderColor: conversation.id === activeId ? theme.toolbar.activeBg : theme.node.stroke }}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{conversation.title || "新对话"}</span>
                                    {conversation.id === activeId ? (
                                        <Tag className="!m-0" color="blue">
                                            当前
                                        </Tag>
                                    ) : null}
                                    <span className="shrink-0 text-[11px] opacity-50">{formatConversationTime(conversation.updatedAt)}</span>
                                </div>
                                {conversation.preview ? <div className="mt-0.5 truncate text-xs opacity-55">{conversation.preview}</div> : null}
                                <button
                                    type="button"
                                    className="absolute bottom-2 right-2 hidden rounded p-1 text-rose-500 group-hover:block"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        removeConversation(conversation.id);
                                    }}
                                    aria-label="删除对话"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </div>
                        ))}
                        {!conversations.length ? <div className="px-3 py-8 text-center text-xs opacity-50">还没有对话，点「新对话」开始</div> : null}
                    </div>
                </div>
            ) : (
                <>
                    {available === false ? (
                        <div className="mx-3 rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                            没有找到可用的 ACP Agent。目前支持 DSH 桌面版；也可以用环境变量 <code>CANVAS_ACP_COMMAND</code> / <code>CANVAS_ACP_ARGS</code> 指定别的适配器。
                        </div>
                    ) : null}

                    {!projectId ? (
                        <div className="mx-3 rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">打开一个画布项目后，Agent 会跟随这个项目工作。</div>
                    ) : null}

                    {active ? <div className="truncate px-3 pt-1 text-[11px] opacity-50">{active.title}</div> : null}

                    <AgentChatTimeline theme={theme} pendingTool={null} pendingApprovals={[]} sending={sending} waiting={sending} onRejectTool={() => undefined} onApproveTool={() => undefined} onApprovalDecision={() => undefined} />

                    {error ? <div className="px-3 pb-1 text-xs text-red-500">{error}</div> : null}

                    <AgentChatComposer
                        prompt={prompt}
                        theme={theme}
                        placeholder="让 Agent 做点什么，例如：在画布上把这两个节点连起来"
                        disabled={!projectId || !activeId || available === false}
                        sending={sending}
                        onPromptChange={setPrompt}
                        onSubmit={() => void submit()}
                        onStop={stop}
                        models={models}
                        model={currentModelName}
                        onModelChange={(value: string) => {
                            const item = models.find((model) => model.model === value);
                            if (item) void changeModel(item.id);
                        }}
                    />
                </>
            )}

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

function formatConversationTime(value?: string) {
    if (!value) return "";
    const date = dayjs(value);
    return date.isValid() ? date.format("MM-DD HH:mm") : "";
}

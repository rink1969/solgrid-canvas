import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Modal, Segmented, Tag } from "antd";
import { Bot, Folder, History, MessageSquare, Move, PanelRightClose, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMatch } from "react-router-dom";
import dayjs from "dayjs";

import { canvasThemes } from "@/lib/canvas-theme";
import { daemonApi } from "@/services/api/daemon";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { promptWithCanvasReferences } from "./agent-event-formatters";
import {
    cancelAgentPrompt,
    closeAgentProject,
    createAgentConversation,
    decideAgentPermission,
    deleteAgentConversation,
    getAgentStatus,
    getAgentTranscript,
    listAgentConversations,
    listAgentPermissions,
    prepareAgentConversation,
    sendAgentPrompt,
    setAgentModel,
    type AgentConfigOption,
    type AgentConversation,
    type AgentTranscriptItem,
} from "@/services/api/agent";
import { useAgentStore, type AgentChatItem, type AgentModel } from "@/stores/use-agent-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { agentReferenceMarker } from "./agent-chat-inline-tokens";
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
            let provider = "";
            try {
                const parsed = JSON.parse(item.value);
                if (Array.isArray(parsed)) {
                    provider = String(parsed[0] || "");
                    model = String(parsed[1] || parsed[0] || item.value);
                }
            } catch {
                /* 非 JSON 值直接用 */
            }
            // 不同 provider 可能有同名模型：选择器的 value 必须唯一，否则会被合并成一个选项。
            const uniqueModel = provider ? `${provider} / ${model}` : model;
            models.push({ id: item.value, model: uniqueModel, displayName: provider ? `${provider} / ${item.name || model}` : item.name, defaultReasoningEffort: "medium", supportedReasoningEfforts: [], isDefault: item.value === option?.currentValue });
        }
    }
    return { models, current: option?.currentValue || "" };
}

function messagesFromTranscript(transcript: AgentTranscriptItem[]): AgentChatItem[] {
    return transcript.map((item, index) => {
        if (item.role === "user") return { id: `user-${index}`, role: "user", text: item.text || "", startedAt: item.startedAt };
        if (item.role === "thought") return { id: `thought-${index}`, role: "system", text: item.text || "", startedAt: item.startedAt, endedAt: item.endedAt };
        if (item.role === "tool") return { id: item.toolCallId || `tool-${index}`, role: "tool", title: item.title || "工具", text: item.status || "", detail: { status: item.status }, startedAt: item.startedAt, endedAt: item.endedAt };
        return { id: `assistant-${index}`, role: "assistant", text: item.text || "", startedAt: item.startedAt };
    });
}

// 画布内 Agent：每个画布一个对话列表，对话之间会话隔离、可切换
export function AcpAgentPanel({ floating = false, onToggleFloating }: { floating?: boolean; onToggleFloating?: () => void } = {}) {
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
    const previousActiveRef = useRef("");
    const refreshPromiseRef = useRef<Promise<AgentConversation[]> | null>(null);
    const projectRef = useRef(projectId);
    const activeProjectRef = useRef("");
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

    // 切换画布：收起面板并清掉上一张画布的会话状态，避免用旧 conversation 去请求新项目
    const previousProjectRef = useRef(projectId);
    useEffect(() => {
        if (previousProjectRef.current === projectId) return;
        previousProjectRef.current = projectId;
        activeProjectRef.current = "";
        activeRef.current = "";
        setActiveId("");
        setConversations([]);
        setMessages([]);
        setError("");
        setTab("chat");
        closePanel();
    }, [closePanel, projectId]);

    // 离开画布页面时也收起，避免回到另一张画布时自动展开旧面板
    useEffect(() => {
        return () => closePanel();
    }, [closePanel]);

    // 离开当前画布时关闭该项目的 ACP 会话，避免切画布后旧会话一直挂起
    useEffect(() => {
        if (!projectId) return;
        return () => {
            void closeAgentProject(projectId).catch(() => undefined);
        };
    }, [projectId]);
    useEffect(() => {
        activeRef.current = activeId;
    }, [activeId]);

    useEffect(() => {
        setAgentState({ messages, enabled: true, connected: available !== false, models, model: current, panelMounted: true });
    }, [messages, models, current, available, setAgentState]);

    const loadTranscript = useCallback(
        async (conversationId: string) => {
            if (!projectId || !conversationId || projectRef.current !== projectId) return;
            const { transcript } = await getAgentTranscript(projectId, conversationId);
            setMessages(messagesFromTranscript(transcript));
        },
        [projectId],
    );

    const refreshConversations = useCallback(async () => {
        if (!projectId) return [];
        // 并发调用（打开面板 + 文本生成事件）共用一次请求，避免重复建对话
        if (refreshPromiseRef.current) return refreshPromiseRef.current;
        const run = (async () => {
            const list = await listAgentConversations(projectId);
            if (projectRef.current !== projectId) return [];
            let next = list;
            if (!next.length) {
                const created = await createAgentConversation(projectId);
                next = [created];
            }
            setConversations(next);
            const saved = localStorage.getItem(storageKey);
            const pick = next.some((item) => item.id === saved) ? (saved as string) : next[0].id;
            activeProjectRef.current = projectId;
            setActiveId((currentId) => (next.some((item) => item.id === currentId) ? currentId : pick));
            return next;
        })();
        refreshPromiseRef.current = run;
        try {
            return await run;
        } finally {
            refreshPromiseRef.current = null;
        }
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
                activeProjectRef.current = projectId;
                setActiveId(id);
                await loadTranscript(id);
                const current = list.find((item) => item.id === id);
                if (current && !(current.configOptions || []).length) {
                    void prepareAgentConversation(projectId, id)
                        .then((prepared) => setConversations((prev) => prev.map((item) => (item.id === prepared.id ? { ...item, ...prepared } : item))))
                        .catch(() => undefined);
                }
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

    // 右键「发送到对话」：把节点 marker 插入输入框，效果与 @ 选中的 token 一致
    useEffect(() => {
        const addReference = (event: Event) => {
            const incoming = (event as CustomEvent<{ reference?: CanvasResourceReference }>).detail?.reference;
            if (!incoming) return;
            const current = useAgentStore.getState().canvasReferences;
            // 同一节点可能已经有引用（label 不同），复用已有的，保证 marker 与引用列表一致
            const existing = current.find((item) => item.nodeId === incoming.nodeId);
            if (!existing) useAgentStore.getState().setAgentState({ canvasReferences: [...current, incoming] });
            const reference = existing || incoming;
            setPrompt((previous) => {
                const marker = agentReferenceMarker(reference);
                if (previous.includes(marker)) return previous;
                return `${previous}${previous && !/\s$/.test(previous) ? " " : ""}${marker} `;
            });
            setTab("chat");
        };
        window.addEventListener("canvas:agent-reference", addReference);
        return () => window.removeEventListener("canvas:agent-reference", addReference);
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
        if (!activeId || !projectId) return;
        if (activeProjectRef.current !== projectId) return;
        const previous = previousActiveRef.current;
        previousActiveRef.current = activeId;
        localStorage.setItem(storageKey, activeId);
        setSending(false);
        sendingRef.current = false;
        // 只有真正从 A 切到 B 才清空引用；首次加载（"" -> id）要保留右键发送进来的引用
        if (previous && previous !== activeId) useAgentStore.getState().setAgentState({ canvasReferences: [] });
        setPermission(null);
        void loadTranscript(activeId).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, [activeId, loadTranscript, projectId, storageKey]);

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
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "user" && last.text === (detail.text || "")) return prev;
                    return [...prev, { id: `u-${Date.now()}`, role: "user", text: detail.text || "", startedAt: new Date().toISOString() }];
                });
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
            if (kind === "agent_thought_chunk") {
                const text = update.content?.text || "";
                const now = new Date().toISOString();
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "system" && last.id === `th-${update.messageId}`) {
                        const copy = [...prev];
                        copy[copy.length - 1] = { ...last, text: `${last.text}${text}`, streamId: update.messageId };
                        return copy;
                    }
                    const closed = last?.role === "system" && !last.endedAt ? prev.map((item) => (item === last ? { ...item, endedAt: now } : item)) : prev;
                    return [...closed, { id: `th-${update.messageId}`, role: "system", text, streamId: update.messageId, startedAt: now }];
                });
                return;
            }
            if (kind === "agent_message_chunk") {
                const text = update.content?.text || "";
                const now = new Date().toISOString();
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    const closed = last?.role === "system" && !last.endedAt ? prev.map((item) => (item === last ? { ...item, endedAt: now } : item)) : prev;
                    if (last?.role === "assistant" && last.id === `as-${update.messageId}`) {
                        const copy = [...closed];
                        copy[copy.length - 1] = { ...last, text: `${last.text}${text}`, streamId: update.messageId };
                        return copy;
                    }
                    return [...closed, { id: `as-${update.messageId}`, role: "assistant", text, streamId: update.messageId, startedAt: now }];
                });
                return;
            }
            if (kind === "tool_call") {
                setMessages((prev) => [...prev, { id: update.toolCallId, role: "tool", title: update.title || "工具", text: update.kind || "", detail: { status: update.status || "running" }, startedAt: new Date().toISOString() }]);
                return;
            }
            if (kind === "tool_call_update") {
                setMessages((prev) => prev.map((item) => (item.id === update.toolCallId ? { ...item, detail: { status: update.status }, endedAt: new Date().toISOString() } : item)));
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
            if (activeProjectRef.current !== projectId) return;
            try {
                const [transcript, list, permissions] = await Promise.all([
                    getAgentTranscript(projectId, activeId),
                    listAgentConversations(projectId),
                    listAgentPermissions(projectId, activeId).catch(() => []),
                ]);
                if (!alive) return;
                setConversations(list);
                setPermission((current) => {
                    if (current && permissions.some((item) => item.id === current.id)) return current;
                    const next = permissions[0];
                    return next ? { id: next.id, title: next.title || next.toolCall?.title } : null;
                });
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

    const ensureConversation = async () => {
        if (activeRef.current) return activeRef.current;
        const list = await refreshConversations();
        const id = list[0]?.id;
        if (!id) {
            const created = await createAgentConversation(projectId);
            setConversations((prev) => [created, ...prev]);
            activeProjectRef.current = projectId;
            activeRef.current = created.id;
            setActiveId(created.id);
            return created.id;
        }
        activeProjectRef.current = projectId;
        activeRef.current = id;
        setActiveId(id);
        return id;
    };

    const sendToConversation = async (conversationId: string, text: string, nodeId?: string) => {
        // 先切到目标对话，确保紧随其后的 SSE 流能被当前面板接收
        activeProjectRef.current = projectId;
        activeRef.current = conversationId;
        setActiveId(conversationId);
        setPrompt("");
        useAgentStore.getState().setAgentState({ canvasReferences: [] });
        setError("");
        setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
        setSending(true);
        sendingRef.current = true;
        try {
            await sendAgentPrompt(projectId, conversationId, text);
        } catch (cause) {
            setSending(false);
            sendingRef.current = false;
            const detail = cause instanceof Error ? cause.message : String(cause);
            setError(detail);
            if (nodeId) window.dispatchEvent(new CustomEvent("canvas:agent-text-error", { detail: { nodeId, error: detail } }));
        }
    };

    // 文本节点「用本地 Agent 生成」：创建/复用对话并自动发送指令
    useEffect(() => {
        const handler = async (event: Event) => {
            const detail = (event as CustomEvent<{ text?: string; nodeId?: string }>).detail;
            const text = detail?.text;
            if (!text) return;
            setTab("chat");
            if (available === false) {
                window.dispatchEvent(new CustomEvent("canvas:agent-text-error", { detail: { nodeId: detail?.nodeId, error: "没有可用的本地 Agent" } }));
                return;
            }
            try {
                const conversationId = await ensureConversation();
                await sendToConversation(conversationId, text, detail?.nodeId);
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                setError(message);
                window.dispatchEvent(new CustomEvent("canvas:agent-text-error", { detail: { nodeId: detail?.nodeId, error: message } }));
            }
        };
        window.addEventListener("canvas:agent-request", handler);
        return () => window.removeEventListener("canvas:agent-request", handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, available]);

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
            let conversation = created;
            try {
                conversation = await prepareAgentConversation(projectId, created.id);
            } catch {
                /* ACP 不可用时仍然保留新对话，第一轮由发送时再建立会话 */
            }
            setConversations((prev) => [conversation, ...prev]);
            setActiveId(conversation.id);
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
        try {
            await decideAgentPermission(id, allow);
            setPermission(null);
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
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
                    {onToggleFloating ? <Button size="small" type="text" icon={<Move className="size-4" />} onClick={onToggleFloating} aria-label={floating ? "停靠到右侧" : "悬浮"} title={floating ? "停靠到右侧" : "悬浮"} /> : null}
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
                    {available === false && !error ? (
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

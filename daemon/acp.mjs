// ACP client：画布 → 本地 Agent（stdin/stdout，NDJSON JSON-RPC）。
// 会话建立时把 canvas MCP 注入进去，Agent 一进来就有画布工具。
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CANVAS_HOME || path.join(os.homedir(), ".solgrid-canvas");
const PORT = Number(process.env.CANVAS_PORT || 17371);
const MCP_PATH = path.join(DAEMON_DIR, "mcp.mjs");

function defaultDshExe() {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
}

// 在 PATH 里找 dsh CLI（npm 全局安装）；Windows 下 npm 生成的是 .cmd
function findCommand(name) {
    const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
            } catch {
                /* 忽略不可读目录 */
            }
        }
    }
    return null;
}

// 适配器解析：优先显式配置，其次本机 DSH 桌面版（Electron 以 node 模式跑它自带的 CLI）
export function resolveAdapter() {
    if (process.env.CANVAS_ACP_COMMAND) {
        let args = [];
        try {
            args = JSON.parse(process.env.CANVAS_ACP_ARGS || "[]");
        } catch {
            args = [];
        }
        return { id: "custom", command: process.env.CANVAS_ACP_COMMAND, args, env: {} };
    }
    // 1) DSH CLI（npm 全局）：web/tui profile 用户走这条（用 shell 探测，兼容 .cmd 与不同 shell 的 PATH）
    const probe = spawnSync("dsh", ["--version"], { shell: true, encoding: "utf8", timeout: 8000, windowsHide: true });
    if (probe.status === 0) return { id: "dsh-cli", command: "dsh", args: ["--profile", "acp"], env: {}, shell: true };

    // 2) WorkBuddy：其 ACP 能力由 CodeBuddy Code CLI 提供（codebuddy --acp，部分安装是 cbc）
    for (const name of ["codebuddy", "cbc"]) {
        const found = findCommand(name);
        if (!found) continue;
        const version = spawnSync(process.platform === "win32" ? `"${found}"` : found, ["--version"], { shell: true, encoding: "utf8", timeout: 8000, windowsHide: true });
        if (version.status === 0) {
            return { id: "workbuddy", command: process.platform === "win32" ? `"${found}"` : found, args: ["--acp"], env: {}, shell: process.platform === "win32" };
        }
    }
    const dshCli = findCommand("dsh");
    if (dshCli) {
        return { id: "dsh-cli", command: process.platform === "win32" ? `"${dshCli}"` : dshCli, args: ["--profile", "acp"], env: {}, shell: process.platform === "win32" };
    }
    // 3) 当前进程是从 DSH 内部启动的：环境变量里带可执行文件与安装目录
    const dshNode = process.env.DSH_NODE_EXECUTABLE;
    const dshBin = process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, "lib", "bin.js") : "";
    if (dshNode && dshBin && fs.existsSync(dshBin)) {
        return { id: "dsh", command: dshNode, args: [dshBin, "--profile", "acp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    // 4) DSH 桌面版默认安装位置
    const exe = process.env.CANVAS_DSH_EXE || defaultDshExe();
    const bin = path.join(path.dirname(exe), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    // bin 在 app.asar 内，普通 node 的 existsSync 看不到；只要 exe 在就交给 Electron 去解析
    if (fs.existsSync(exe)) {
        return { id: "dsh", command: exe, args: [bin, "--profile", "acp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    return null;
}

function mcpEntry(projectId, conversationId) {
    // 部分 ACP 实现把 MCP serverName 当成进程级全局键；按会话唯一化，避免第二个会话/画布冲突。
    // 哈希稳定，保证同一 conversation 的 session/resume 仍使用同一个名字。
    const suffix = crypto.createHash("sha256").update(`${projectId}:${conversationId}`).digest("hex").slice(0, 10);
    return {
        name: `solgrid_canvas_${suffix}`,
        command: process.execPath,
        args: [MCP_PATH],
        env: [
            { name: "CANVAS_HOME", value: ROOT },
            { name: "CANVAS_PORT", value: String(PORT) },
            ...(process.env.CANVAS_IMPORT_ROOTS ? [{ name: "CANVAS_IMPORT_ROOTS", value: process.env.CANVAS_IMPORT_ROOTS }] : []),
        ],
    };
}

function createConnection({ adapter, onNotification, onRequest, onExit, log }) {
    const child = spawn(adapter.command, adapter.args, { env: { ...process.env, ...adapter.env }, stdio: ["pipe", "pipe", "pipe"], shell: adapter.shell === true });
    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    const incoming = new Map();

    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            if (message.id !== undefined && pending.has(message.id)) {
                const { resolve, reject, timer } = pending.get(message.id);
                pending.delete(message.id);
                clearTimeout(timer);
                if (message.error) {
                    const details = message.error.data?.details;
                    reject(new Error(details ? `${message.error.message || "ACP error"}：${details}` : message.error.message || "ACP error"));
                } else resolve(message.result);
                continue;
            }
            if (message.id !== undefined && message.method) {
                incoming.set(message.id, message);
                onRequest?.(message);
                continue;
            }
            if (message.method) onNotification?.(message);
        }
    });
    child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        if (!/ExperimentalWarning|Debugging|model listing/i.test(text)) log(`[acp] ${text.slice(0, 300).trim()}`);
    });
    child.on("exit", (code) => {
        log(`[acp] 进程退出（code=${code}）`);
        // 进程没了，挂起的请求不会再回来；立刻失败，避免每个请求都等满超时。
        for (const [id, { reject, timer }] of pending) {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error("ACP Agent 进程已退出，请重试"));
        }
        incoming.clear();
        onExit?.(code);
    });

    function request(method, params, timeoutMs = 120000) {
        const id = nextId++;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return new Promise((resolve, reject) => {
            const timer = timeoutMs ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`ACP ${method} 超时`));
            }, timeoutMs) : null;
            pending.set(id, { resolve, reject, timer });
        });
    }

    function respond(id, result) {
        incoming.delete(id);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    }

    function notify(method, params) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }

    return { request, respond, notify, close: () => child.kill() };
}

function sessionFile(cwd) {
    return path.join(cwd, "agent-session.json");
}

function readSessionFile(cwd) {
    try {
        return JSON.parse(fs.readFileSync(sessionFile(cwd), "utf8"));
    } catch {
        return null;
    }
}

function writeSessionFile(cwd, sessionId) {
    try {
        fs.writeFileSync(sessionFile(cwd), JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2));
    } catch (error) {
        log(`[acp] 会话文件写入失败：${error.message}`);
    }
}

function agentDir(cwd) {
    return path.join(cwd, "agent");
}

function conversationsPath(cwd) {
    return path.join(agentDir(cwd), "conversations.json");
}

function transcriptPath(cwd, conversationId) {
    return path.join(agentDir(cwd), "transcripts", `${conversationId}.json`);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

export function createAgentManager({ broadcast, log }) {
    const adapter = resolveAdapter();
    let connection = null;
    let initializing = null;
    const runtimes = new Map(); // `${projectId}/${conversationId}` -> runtime
    const bySession = new Map(); // sessionId -> runtime
    const projects = new Map(); // projectId -> { cwd, conversations: [] }
    const permissions = new Map(); // id -> { requestId, projectId, conversationId }
    const sessionPromises = new Map();
    const transcriptTimers = new Map();

    return manager();

    function manager() {
        return {
            status() {
                return {
                    available: Boolean(adapter),
                    adapter: adapter?.id || null,
                    sessions: [...runtimes.values()].map((runtime) => ({
                        projectId: runtime.projectId,
                        conversationId: runtime.conversationId,
                        sessionId: runtime.sessionId,
                        running: runtime.running,
                        lastTurn: runtime.lastTurn ? { id: runtime.lastTurn.id, status: runtime.lastTurn.status, startedAt: runtime.lastTurn.startedAt, finishedAt: runtime.lastTurn.finishedAt, error: runtime.lastTurn.error } : null,
                        configOptions: runtime.configOptions,
                    })),
                };
            },
            listConversations(projectId, cwd) {
                const entry = loadProject(projectId, cwd);
                return entry.conversations
                    .slice()
                    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
                    .map((conversation) => summary(projectId, conversation));
            },
            createConversation(projectId, cwd, title) {
                const entry = loadProject(projectId, cwd);
                const conversation = {
                    id: crypto.randomUUID(),
                    title: String(title || "").trim() || "新对话",
                    preview: "",
                    sessionId: null,
                    configOptions: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                entry.conversations.push(conversation);
                saveConversations(projectId);
                emit(projectId, conversation.id, { kind: "conversation", action: "created" });
                return summary(projectId, conversation);
            },
            async prepareConversation(projectId, cwd, conversationId) {
                await this.ensureSession(projectId, cwd, conversationId);
                return summary(projectId, findConversation(projectId, cwd, conversationId));
            },
            renameConversation(projectId, cwd, conversationId, title) {
                const conversation = findConversation(projectId, cwd, conversationId);
                conversation.title = String(title || "").trim() || conversation.title;
                conversation.updatedAt = new Date().toISOString();
                saveConversations(projectId);
                emit(projectId, conversationId, { kind: "conversation", action: "renamed" });
                return summary(projectId, conversation);
            },
            async deleteConversation(projectId, cwd, conversationId) {
                const entry = loadProject(projectId, cwd);
                const index = entry.conversations.findIndex((item) => item.id === conversationId);
                if (index < 0) return false;
                const [conversation] = entry.conversations.splice(index, 1);
                const runtime = runtimes.get(runtimeKey(projectId, conversationId));
                if (runtime) await closeSession(runtime);
                try {
                    fs.rmSync(transcriptPath(cwd, conversation.id), { force: true });
                } catch {
                    /* 忽略 */
                }
                saveConversations(projectId);
                emit(projectId, conversationId, { kind: "conversation", action: "deleted" });
                return true;
            },
            async closeProject(projectId) {
                const targets = [...runtimes.values()].filter((runtime) => runtime.projectId === projectId);
                await Promise.allSettled(targets.map((runtime) => closeSession(runtime)));
                return targets.length;
            },
            transcript(projectId, cwd, conversationId) {
                const runtime = runtimes.get(runtimeKey(projectId, conversationId));
                if (runtime) return runtime.transcript;
                const saved = readJson(transcriptPath(cwd, conversationId), null);
                return Array.isArray(saved?.messages) ? saved.messages : [];
            },
            async ensureSession(projectId, cwd, conversationId) {
                const key = runtimeKey(projectId, conversationId);
                const existing = runtimes.get(key);
                if (existing) return existing;
                const pending = sessionPromises.get(key);
                if (pending) return pending;
                const promise = this.ensureSessionUnlocked(projectId, cwd, conversationId);
                sessionPromises.set(key, promise);
                try {
                    return await promise;
                } finally {
                    if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
                }
            },
            async ensureSessionUnlocked(projectId, cwd, conversationId) {
                const conversation = findConversation(projectId, cwd, conversationId);
                const key = runtimeKey(projectId, conversationId);
                const existing = runtimes.get(key);
                if (existing) return existing;

                const client = await ensureConnection();
                const transcript = Array.isArray(readJson(transcriptPath(cwd, conversationId), null)?.messages)
                    ? readJson(transcriptPath(cwd, conversationId), {}).messages
                    : [];

                let sessionId = conversation.sessionId;
                let configOptions = conversation.configOptions || [];
                let resumed = false;
                if (sessionId) {
                    try {
                        const result = await client.request("session/resume", { sessionId, cwd, mcpServers: [mcpEntry(projectId, conversationId)] });
                        configOptions = result?.configOptions || configOptions;
                        resumed = true;
                    } catch (error) {
                        log(`[acp] 恢复会话失败，改为新建：${error.message}`);
                        sessionId = null;
                    }
                }
                if (!sessionId) {
                    let result;
                    try {
                        result = await client.request("session/new", { cwd, mcpServers: [mcpEntry(projectId, conversationId)] });
                    } catch (error) {
                        // 有些 ACP 实现（如 CodeBuddy）不接受 mcpServers 注入，退化为纯对话
                        log(`[acp] 会话不接受 MCP 注入，改为不带 MCP 重试：${error.message}`);
                        result = await client.request("session/new", { cwd });
                    }
                    sessionId = result.sessionId;
                    configOptions = result.configOptions || [];
                }

                conversation.sessionId = sessionId;
                conversation.configOptions = configOptions;
                conversation.updatedAt = new Date().toISOString();
                saveConversations(projectId);

                const runtime = { projectId, conversationId, cwd, sessionId, configOptions, running: false, transcript };
                runtimes.set(key, runtime);
                bySession.set(sessionId, runtime);
                emit(projectId, conversationId, { kind: "session", sessionId, configOptions, resumed });
                return runtime;
            },
            async setModel(projectId, cwd, conversationId, configId, value) {
                const runtime = await this.ensureSession(projectId, cwd, conversationId);
                const result = await (await ensureConnection()).request("session/set_config_option", { sessionId: runtime.sessionId, configId, value });
                runtime.configOptions = result?.configOptions || runtime.configOptions;
                const conversation = findConversation(projectId, cwd, conversationId);
                conversation.configOptions = runtime.configOptions;
                conversation.updatedAt = new Date().toISOString();
                saveConversations(projectId);
                emit(projectId, conversationId, { kind: "model", configOptions: runtime.configOptions });
                return runtime.configOptions;
            },
            async prompt(projectId, cwd, conversationId, text) {
                const runtime = await this.ensureSession(projectId, cwd, conversationId);
                if (runtime.running) throw Object.assign(new Error("上一轮还在进行中"), { code: "agent_busy", turnId: runtime.lastTurn?.id });
                runtime.running = true;
                // 每轮一个可查的 turnId：提交后凭它判断“这轮在不在跑 / 跑完没有”，忙时 409 也带上当前 turn
                const turn = { id: crypto.randomUUID(), status: "running", startedAt: new Date().toISOString() };
                runtime.lastTurn = turn;
                const conversation = findConversation(projectId, cwd, conversationId);
                if (!conversation.title || conversation.title === "新对话") conversation.title = String(text).slice(0, 24);
                conversation.preview = String(text).slice(0, 80);
                conversation.updatedAt = new Date().toISOString();
                saveConversations(projectId);

                runtime.transcript.push({ role: "user", text });
                emit(projectId, conversationId, { kind: "user", text });
                emit(projectId, conversationId, { kind: "conversation", action: "updated" });
                persistTranscript(projectId, conversationId, cwd, runtime.transcript);

                const client = await ensureConnection();
                const withContext = String(text).includes(`projectId=${projectId}`) ? text : `[画布上下文] 当前画布 projectId=${projectId}。\n\n${text}`;
                const promise = client.request("session/prompt", { sessionId: runtime.sessionId, prompt: [{ type: "text", text: withContext }] }, 0);
                promise
                    .then((result) => {
                        runtime.running = false;
                        const endedAt = new Date().toISOString();
                        turn.status = "done";
                        turn.finishedAt = endedAt;
                        const tail = runtime.transcript[runtime.transcript.length - 1];
                        if (tail && tail.role === "thought" && !tail.endedAt) tail.endedAt = endedAt;
                        conversation.updatedAt = new Date().toISOString();
                        saveConversations(projectId);
                        persistTranscript(projectId, conversationId, cwd, runtime.transcript, { immediate: true });
                        emit(projectId, conversationId, { kind: "done", turnId: turn.id, stopReason: result?.stopReason });
                    })
                    .catch((error) => {
                        runtime.running = false;
                        const endedAt = new Date().toISOString();
                        turn.status = "failed";
                        turn.finishedAt = endedAt;
                        turn.error = error.message;
                        const tail = runtime.transcript[runtime.transcript.length - 1];
                        if (tail && tail.role === "thought" && !tail.endedAt) tail.endedAt = endedAt;
                        persistTranscript(projectId, conversationId, cwd, runtime.transcript, { immediate: true });
                        if (/not found|unknown session|invalid session/i.test(error.message)) {
                            runtimes.delete(runtimeKey(projectId, conversationId));
                            bySession.delete(runtime.sessionId);
                            conversation.sessionId = null;
                            saveConversations(projectId);
                            emit(projectId, conversationId, { kind: "done", turnId: turn.id, error: "Agent 会话已失效，已重置，请重新发送" });
                            return;
                        }
                        emit(projectId, conversationId, { kind: "done", turnId: turn.id, error: error.message });
                    });
                return { ok: true, turnId: turn.id };
            },
            async cancel(projectId, cwd, conversationId) {
                const runtime = runtimes.get(runtimeKey(projectId, conversationId));
                if (!runtime) return;
                const client = await ensureConnection();
                client.notify("session/cancel", { sessionId: runtime.sessionId });
            },
            decidePermission(id, allow) {
                const item = permissions.get(id);
                if (!item) return false;
                permissions.delete(id);
                const options = item.params?.options || [];
                const wanted = allow
                    ? options.find((option) => /allow/.test(option.kind || "")) || options[0]
                    : options.find((option) => /reject/.test(option.kind || "")) || options[options.length - 1];
                connection?.respond(item.requestId, { outcome: { outcome: "selected", optionId: wanted?.optionId } });
                emit(item.projectId, item.conversationId, { kind: "permission-decided", id, allow });
                return true;
            },
            // 前端轮询兜底：ACP permission 是 request，错过通知时靠这里把待决项捞回来
            listPermissions(projectId, conversationId) {
                return [...permissions.entries()]
                    .filter(([, item]) => (!projectId || item.projectId === projectId) && (!conversationId || item.conversationId === conversationId))
                    .map(([id, item]) => ({
                        id,
                        projectId: item.projectId,
                        conversationId: item.conversationId,
                        title: String(item.params?.toolCall?.title || item.params?.toolCall?.kind || "权限请求"),
                        toolCall: item.params?.toolCall,
                        options: item.params?.options,
                    }));
            },
            close() {
                connection?.close();
                connection = null;
                runtimes.clear();
                bySession.clear();
            },
        };
    }

    // ---- 内部实现 ----

    function runtimeKey(projectId, conversationId) {
        return `${projectId}/${conversationId}`;
    }

    // session/close 在 ACP 里是 request（要回执），notify 会被对端忽略：
    // 会话不关，Agent 侧的 MCP 子进程（cwd=项目目录）就一直在，Windows 下项目目录删不掉。
    async function closeSession(runtime) {
        bySession.delete(runtime.sessionId);
        runtimes.delete(runtimeKey(runtime.projectId, runtime.conversationId));
        if (!connection) return;
        try {
            await connection.request("session/close", { sessionId: runtime.sessionId }, 15000);
        } catch (error) {
            log(`[acp] 关闭会话失败（${runtime.sessionId}）：${error.message}`);
        }
    }

    function loadProject(projectId, cwd) {
        const existing = projects.get(projectId);
        if (existing) {
            existing.cwd = cwd;
            return existing;
        }
        const file = conversationsPath(cwd);
        const saved = readJson(file, null);
        let conversations = Array.isArray(saved?.conversations) ? saved.conversations : null;
        if (!conversations) {
            // 兼容旧版：agent-session.json 里只有一个 sessionId
            const legacy = readJson(path.join(cwd, "agent-session.json"), null);
            conversations = legacy?.sessionId
                ? [{ id: "default", title: "默认会话", sessionId: legacy.sessionId, configOptions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
                : [];
            writeJson(file, { conversations });
        }
        const entry = { cwd, conversations };
        projects.set(projectId, entry);
        return entry;
    }

    function findConversation(projectId, cwd, conversationId) {
        const entry = loadProject(projectId, cwd);
        const conversation = conversationId ? entry.conversations.find((item) => item.id === conversationId) : null;
        if (!conversation) throw new Error("对话不存在");
        return conversation;
    }

    function saveConversations(projectId) {
        const entry = projects.get(projectId);
        if (!entry) return;
        try {
            writeJson(conversationsPath(entry.cwd), { conversations: entry.conversations });
        } catch (error) {
            log(`[acp] 对话列表写入失败：${error.message}`);
        }
    }

    function persistTranscript(projectId, conversationId, cwd, transcript, options = {}) {
        const key = runtimeKey(projectId, conversationId);
        const timer = transcriptTimers.get(key);
        if (timer) clearTimeout(timer);
        const write = () => {
            transcriptTimers.delete(key);
            try {
                writeJson(transcriptPath(cwd, conversationId), { messages: transcript });
            } catch (error) {
                log(`[acp] transcript 写入失败：${error.message}`);
            }
        };
        if (options.immediate) {
            const pending = transcriptTimers.get(key);
            if (pending) {
                clearTimeout(pending);
                transcriptTimers.delete(key);
            }
            write();
            return;
        }
        // 流式更新很频繁，合并成 400ms 一次写盘；done 时再强制落一次
        const next = setTimeout(write, 400);
        next.unref?.();
        transcriptTimers.set(key, next);
    }

    function summary(projectId, conversation) {
        const runtime = runtimes.get(runtimeKey(projectId, conversation.id));
        return {
            id: conversation.id,
            title: conversation.title,
            preview: conversation.preview || "",
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            running: Boolean(runtime?.running),
            configOptions: runtime?.configOptions || conversation.configOptions || [],
        };
    }

    function emit(projectId, conversationId, event) {
        broadcast?.({ type: "agent.event", projectId, conversationId, ...event });
    }

    function handleNotification(message) {
        const params = message.params || {};
        const runtime = bySession.get(params.sessionId);
        if (!runtime) return;
        if (message.method === "session/update") {
            const update = params.update || {};
            const kind = update.sessionUpdate || update.type;
            if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
                const text = update.content?.text || "";
                const role = kind === "agent_message_chunk" ? "assistant" : "thought";
                const last = runtime.transcript[runtime.transcript.length - 1];
                if (last && last.role === role && last.messageId && last.messageId === update.messageId) last.text += text;
                else runtime.transcript.push({ role, text, messageId: update.messageId });
                persistTranscript(runtime.projectId, runtime.conversationId, runtime.cwd, runtime.transcript);
            } else if (kind === "tool_call") {
                runtime.transcript.push({ role: "tool", toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status });
                persistTranscript(runtime.projectId, runtime.conversationId, runtime.cwd, runtime.transcript);
            } else if (kind === "tool_call_update") {
                // 个别 ACP 适配器（旧版 dsh-acp）tool_call_update 不带 toolCallId：
                // 退回到最近一个仍 in_progress 的工具条目，至少让卡片能收尾。
                const item = update.toolCallId
                    ? runtime.transcript.find((entry) => entry.toolCallId === update.toolCallId)
                    : [...runtime.transcript].reverse().find((entry) => entry.role === "tool" && entry.status === "in_progress");
                if (item) Object.assign(item, { status: update.status, content: update.content });
                update.toolCallId = update.toolCallId || item?.toolCallId;
                persistTranscript(runtime.projectId, runtime.conversationId, runtime.cwd, runtime.transcript);
            }
            emit(runtime.projectId, runtime.conversationId, { kind: "update", update });
            return;
        }
        if (message.method === "session/request_permission") {
            const id = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            permissions.set(id, { requestId: message.id, projectId: runtime.projectId, conversationId: runtime.conversationId, params });
            emit(runtime.projectId, runtime.conversationId, { kind: "permission", id, toolCall: params.toolCall, options: params.options });
        }
    }

    async function ensureConnection() {
        if (connection) return connection;
        if (!adapter) throw new Error("没有可用的 ACP Agent：未找到 DSH 桌面版，也没有配置 CANVAS_ACP_COMMAND");
        if (initializing) return initializing;
        initializing = (async () => {
            const conn = createConnection({
                adapter,
                onNotification: handleNotification,
                onRequest: (message) => {
                    if (message.method === "session/request_permission") handleNotification(message);
                },
                // Agent 进程意外退出后作废这条连接，下次请求重新拉起；否则所有调用都会写到死管道上。
                onExit: () => {
                    if (connection === conn) connection = null;
                },
                log,
            });
            connection = conn;
            try {
                await conn.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "solgrid-canvas", version: "0.2.2" } });
            } catch (error) {
                if (connection === conn) connection = null;
                throw error;
            }
            return conn;
        })().finally(() => {
            initializing = null;
        });
        return initializing;
    }
}

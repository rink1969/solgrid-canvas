// ACP client：画布 → 本地 Agent（stdin/stdout，NDJSON JSON-RPC）。
// 会话建立时把 canvas MCP 注入进去，Agent 一进来就有画布工具。
import { spawn, spawnSync } from "node:child_process";
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
    const dshCli = findCommand("dsh");
    if (dshCli) {
        return { id: "dsh-cli", command: process.platform === "win32" ? `"${dshCli}"` : dshCli, args: ["--profile", "acp"], env: {}, shell: process.platform === "win32" };
    }
    // 2) 当前进程是从 DSH 内部启动的：环境变量里带可执行文件与安装目录
    const dshNode = process.env.DSH_NODE_EXECUTABLE;
    const dshBin = process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, "lib", "bin.js") : "";
    if (dshNode && dshBin && fs.existsSync(dshBin)) {
        return { id: "dsh", command: dshNode, args: [dshBin, "--profile", "acp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    // 3) DSH 桌面版默认安装位置
    const exe = process.env.CANVAS_DSH_EXE || defaultDshExe();
    const bin = path.join(path.dirname(exe), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    // bin 在 app.asar 内，普通 node 的 existsSync 看不到；只要 exe 在就交给 Electron 去解析
    if (fs.existsSync(exe)) {
        return { id: "dsh", command: exe, args: [bin, "--profile", "acp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    return null;
}

function mcpEntry() {
    return {
        name: "solgrid_canvas",
        command: process.execPath,
        args: [MCP_PATH],
        env: [
            { name: "CANVAS_HOME", value: ROOT },
            { name: "CANVAS_PORT", value: String(PORT) },
            ...(process.env.CANVAS_IMPORT_ROOTS ? [{ name: "CANVAS_IMPORT_ROOTS", value: process.env.CANVAS_IMPORT_ROOTS }] : []),
        ],
    };
}

function createConnection({ adapter, onNotification, onRequest, log }) {
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
                if (message.error) reject(new Error(message.error.message || "ACP error"));
                else resolve(message.result);
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
    child.on("exit", (code) => log(`[acp] 进程退出（code=${code}）`));

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

export function createAgentManager({ broadcast, log }) {
    const adapter = resolveAdapter();
    let connection = null;
    let initializing = null;
    const sessions = new Map(); // projectId -> { sessionId, configOptions, running, transcript, pendingPrompt }
    const permissions = new Map(); // id -> { requestId, projectId, params }

    function emit(projectId, event) {
        broadcast?.({ type: "agent.event", projectId, ...event });
    }

    function handleNotification(message) {
        const params = message.params || {};
        const projectId = [...sessions.entries()].find(([, item]) => item.sessionId === params.sessionId)?.[0];
        if (!projectId) return;
        const session = sessions.get(projectId);

        if (message.method === "session/update") {
            const update = params.update || {};
            const kind = update.sessionUpdate || update.type;
            if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
                const text = update.content?.text || "";
                const role = kind === "agent_message_chunk" ? "assistant" : "thought";
                const last = session.transcript[session.transcript.length - 1];
                if (last && last.role === role && last.messageId && last.messageId === update.messageId) last.text += text;
                else session.transcript.push({ role, text, messageId: update.messageId });
            } else if (kind === "tool_call") {
                session.transcript.push({ role: "tool", toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status });
            } else if (kind === "tool_call_update") {
                const item = session.transcript.find((entry) => entry.toolCallId === update.toolCallId);
                if (item) Object.assign(item, { status: update.status, content: update.content });
            }
            emit(projectId, { kind: "update", update });
            return;
        }
        if (message.method === "session/request_permission") {
            const id = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            permissions.set(id, { requestId: message.id, projectId, params });
            emit(projectId, { kind: "permission", id, toolCall: params.toolCall, options: params.options });
            return;
        }
    }

    async function ensureConnection() {
        if (connection) return connection;
        if (!adapter) throw new Error("没有可用的 ACP Agent：未找到 DSH 桌面版，也没有配置 CANVAS_ACP_COMMAND");
        if (initializing) return initializing;
        initializing = (async () => {
            connection = createConnection({ adapter, onNotification: handleNotification, onRequest: (message) => {
                if (message.method === "session/request_permission") handleNotification(message);
            }, log });
            await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "solgrid-canvas", version: "0.1.0" } });
            return connection;
        })().finally(() => {
            initializing = null;
        });
        return initializing;
    }

    return {
        status() {
            return {
                available: Boolean(adapter),
                adapter: adapter?.id || null,
                sessions: [...sessions.entries()].map(([projectId, item]) => ({ projectId, sessionId: item.sessionId, running: item.running, configOptions: item.configOptions })),
            };
        },
        transcript(projectId) {
            return sessions.get(projectId)?.transcript || [];
        },
        async ensureSession(projectId, cwd) {
            const existing = sessions.get(projectId);
            if (existing) return existing;
            const client = await ensureConnection();

            // 先尝试恢复上次的会话（daemon 重启后仍能接上上下文）
            const saved = readSessionFile(cwd);
            if (saved?.sessionId) {
                try {
                    const resumed = await client.request("session/resume", { sessionId: saved.sessionId, cwd, mcpServers: [mcpEntry()] });
                    const session = { sessionId: saved.sessionId, configOptions: resumed?.configOptions || [], running: false, transcript: [], resumed: true };
                    sessions.set(projectId, session);
                    emit(projectId, { kind: "session", sessionId: session.sessionId, configOptions: session.configOptions, resumed: true });
                    return session;
                } catch (error) {
                    log(`[acp] 恢复会话失败，改为新建：${error.message}`);
                }
            }

            const result = await client.request("session/new", { cwd, mcpServers: [mcpEntry()] });
            const session = { sessionId: result.sessionId, configOptions: result.configOptions || [], running: false, transcript: [] };
            sessions.set(projectId, session);
            writeSessionFile(cwd, session.sessionId);
            emit(projectId, { kind: "session", sessionId: session.sessionId, configOptions: session.configOptions });
            return session;
        },
        async setModel(projectId, configId, value) {
            const session = sessions.get(projectId);
            if (!session) throw new Error("会话还没建立");
            const result = await (await ensureConnection()).request("session/set_config_option", { sessionId: session.sessionId, configId, value });
            session.configOptions = result?.configOptions || session.configOptions;
            emit(projectId, { kind: "model", configOptions: session.configOptions });
            return session.configOptions;
        },
        async prompt(projectId, text) {
            const session = sessions.get(projectId);
            if (!session) throw new Error("会话还没建立");
            if (session.running) throw new Error("上一轮还在进行中");
            session.running = true;
            session.transcript.push({ role: "user", text });
            emit(projectId, { kind: "user", text });
            const client = await ensureConnection();
            const promise = client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] }, 0);
            promise
                .then((result) => {
                    session.running = false;
                    emit(projectId, { kind: "done", stopReason: result?.stopReason });
                })
                .catch((error) => {
                    session.running = false;
                    if (/not found|unknown session|invalid session/i.test(error.message)) {
                        try {
                            fs.rmSync(sessionFile(path.join(ROOT, "projects", projectId)), { force: true });
                        } catch {
                            /* 忽略清理失败 */
                        }
                        sessions.delete(projectId);
                        emit(projectId, { kind: "done", error: "Agent 会话已失效，已重置，请重新发送" });
                        return;
                    }
                    emit(projectId, { kind: "done", error: error.message });
                });
            return { ok: true };
        },
        async cancel(projectId) {
            const session = sessions.get(projectId);
            if (!session) return;
            const client = await ensureConnection();
            client.notify("session/cancel", { sessionId: session.sessionId });
        },
        decidePermission(id, allow) {
            const item = permissions.get(id);
            if (!item) return false;
            permissions.delete(id);
            const options = item.params?.options || [];
            const wanted = allow
                ? options.find((option) => /allow/.test(option.kind || "")) || options[0]
                : options.find((option) => /reject/.test(option.kind || "")) || options[options.length - 1];
            const client = connection;
            client?.respond(item.requestId, { outcome: { outcome: "selected", optionId: wanted?.optionId } });
            emit(item.projectId, { kind: "permission-decided", id, allow });
            return true;
        },
        close() {
            connection?.close();
            connection = null;
            sessions.clear();
        },
    };
}

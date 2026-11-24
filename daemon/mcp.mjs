// MCP server（stdio）：把画布暴露给本地 Agent。零依赖，手写 JSON-RPC。
// 所有实际操作转发给 daemon；MCP 自己不碰 solgrid、不碰文件写入。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { layoutArtifacts } from "./layout.mjs";

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CANVAS_HOME || path.join(os.homedir(), ".solgrid-canvas");
const PORT = Number(process.env.CANVAS_PORT || 17371);
const BASE = process.env.CANVAS_DAEMON_URL || `http://127.0.0.1:${PORT}`;

let token = "";

function readToken() {
    if (process.env.CANVAS_TOKEN) return process.env.CANVAS_TOKEN;
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, "daemon.json"), "utf8")).token || "";
    } catch {
        return "";
    }
}

async function ping() {
    try {
        const response = await fetch(`${BASE}/health`);
        return response.ok;
    } catch {
        return false;
    }
}

// 画布没开时自动拉起 daemon（stdio 进程保持 MCP 生命周期，daemon 独立常驻）
async function ensureDaemon() {
    if (await ping()) return;
    const child = spawn(process.execPath, [path.join(DAEMON_DIR, "server.mjs")], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CANVAS_HOME: ROOT, CANVAS_PORT: String(PORT) },
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (await ping()) return;
    }
    throw new Error(`daemon 未启动：${BASE}`);
}

async function api(pathname, init) {
    const response = await fetch(`${BASE}${pathname}`, {
        method: init?.method || "GET",
        body: init?.body,
        headers: {
            "content-type": "application/json",
            ...(token ? { "x-canvas-token": token } : {}),
        },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
        const message = data?.message || data?.error || `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }
    return data;
}

const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
};

const PROJECTS_DIR = path.join(ROOT, "projects");
const INBOX_DIR = path.join(ROOT, "inbox");
const SENSITIVE_DIRS = [".ssh", ".aws", ".gnupg", ".config", ".dsh", ".codex", ".claude"];

// Agent 只能导入：项目目录、inbox、显式配置的根；敏感目录一律拒绝
function resolveImportPath(projectId, filePath) {
    let real;
    try {
        real = fs.realpathSync(path.resolve(filePath));
    } catch {
        throw new Error(`文件不存在：${filePath}`);
    }
    const home = os.homedir();
    const sensitive = SENSITIVE_DIRS.map((name) => path.join(home, name));
    if (sensitive.some((dir) => real === dir || real.startsWith(`${dir}${path.sep}`))) {
        throw new Error(`拒绝导入敏感目录：${real}`);
    }
    const extraRoots = (process.env.CANVAS_IMPORT_ROOTS || "")
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(item));
    const roots = [path.join(PROJECTS_DIR, projectId), INBOX_DIR, ...extraRoots];
    if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
        throw new Error(`路径不在允许范围：${real}\n允许：项目目录、${INBOX_DIR}${extraRoots.length ? `、${extraRoots.join("、")}` : ""}（可用 CANVAS_IMPORT_ROOTS 添加）`);
    }
    if (!fs.statSync(real).isFile()) throw new Error(`不是文件：${filePath}`);
    return real;
}

async function uploadFile(projectId, filePath) {
    const buffer = fs.readFileSync(filePath);
    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const response = await fetch(`${BASE}/api/projects/${projectId}/assets?mime=${encodeURIComponent(mime)}`, {
        method: "POST",
        body: buffer,
        headers: { "content-type": mime, ...(token ? { "x-canvas-token": token } : {}) },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `上传失败：${response.status}`);
    return { storageKey: `asset:${projectId}/${data.file}`, url: `/api/projects/${projectId}/assets/${data.file}`, bytes: data.bytes, mime };
}

function pickNodeSummary(node) {
    return {
        id: node.id,
        type: node.type,
        title: node.title,
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        width: node.width,
        height: node.height,
        status: node.metadata?.status,
        prompt: node.metadata?.prompt,
        provider: node.metadata?.provider,
        endpoint: node.metadata?.endpoint,
        storageKey: node.metadata?.storageKey,
        content: typeof node.metadata?.content === "string" ? node.metadata.content.slice(0, 2000) : undefined,
        pluginColor: node.metadata?.pluginColor,
    };
}

const TOOLS = [
    {
        name: "canvas_list_projects",
        description: "列出本机所有画布项目（id、标题、更新时间）。",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "canvas_get_state",
        description: "读取一个画布：节点摘要、连线、标题。用于了解当前画面再决定怎么改。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                nodeIds: { type: "array", items: { type: "string" }, description: "只看这些节点" },
                includeConnections: { type: "boolean", default: true },
            },
            required: ["projectId"],
        },
    },
    {
        name: "canvas_get_node",
        description: "读取单个节点详情（含上下游连线）。",
        inputSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" } }, required: ["projectId", "nodeId"] },
    },
    {
        name: "canvas_apply_ops",
        description:
            "批量修改画布，原子生效。op 类型：add_node{node} / update_node{id,patch} / remove_nodes{ids} / add_edge{edge} / remove_edges{ids} / update_meta{patch} / move_nodes{ids,dx,dy}。返回新 rev。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                ops: { type: "array", items: { type: "object" } },
                expectRev: { type: "number" },
            },
            required: ["projectId", "ops"],
        },
    },
    {
        name: "canvas_write_text",
        description: "把文本写进一个文本节点（设置 content 并标记 success）。文本生成类任务优先用这个工具，而不是手写 update_node。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                nodeId: { type: "string" },
                text: { type: "string" },
                title: { type: "string", description: "可选：顺便更新节点标题" },
            },
            required: ["projectId", "nodeId", "text"],
        },
    },
    {
        name: "canvas_import_local",
        description: "把本机文件导入项目资产（assets/<sha256>），返回 asset 引用，不创建节点。",
        inputSchema: {
            type: "object",
            properties: { projectId: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
            required: ["projectId", "paths"],
        },
    },
    {
        name: "canvas_place_artifacts",
        description:
            "把一批产物放到画布上并自动布点（图片一列、文本一列，从锚点右侧展开，自动避让）。items 每项：{kind:'image'|'text'|'video'|'audio', path? 或 text? 或 storageKey?, title?, role?, width?, height?}。不要自己算坐标。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                anchorNodeId: { type: "string" },
                items: { type: "array", items: { type: "object" } },
                connect: { type: "boolean", default: true },
                groupTitle: { type: "string" },
            },
            required: ["projectId", "anchorNodeId", "items"],
        },
    },
    {
        name: "canvas_list_tools",
        description: "搜索 solgrid 平台上的模型/工具（provider + endpoint + 描述 + 价格）。",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
        name: "canvas_inspect_tool",
        description: "查看某个端点需要的请求体字段（JSON Schema）与价格。",
        inputSchema: {
            type: "object",
            properties: { provider: { type: "string" }, endpoint: { type: "string" } },
            required: ["provider", "endpoint"],
        },
    },
    {
        name: "canvas_run_nodes",
        description:
            "对节点发起生成。会先向用户弹出审批（花费需要确认），批准后才入队；返回 runId。provider/endpoint 省略时用节点上已选好的；prompt 省略时用节点 prompt；参考图取上游连线节点。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                nodeIds: { type: "array", items: { type: "string" }, description: "要生成的节点，默认取 nodeId" },
                nodeId: { type: "string" },
                provider: { type: "string" },
                endpoint: { type: "string" },
                params: { type: "object", description: "覆盖参数，如 prompt/size/count/seconds/resolution/videoMode/generateAudio" },
                approvalTimeoutSeconds: { type: "number", default: 180 },
            },
            required: ["projectId"],
        },
    },
    {
        name: "canvas_watch_run",
        description: "等待某个 run 结束，返回状态、成本、产物（asset 引用）。",
        inputSchema: {
            type: "object",
            properties: { runId: { type: "string" }, timeoutSeconds: { type: "number", default: 300 } },
            required: ["runId"],
        },
    },
    {
        name: "canvas_cancel_run",
        description: "取消一个还在跑的 run。",
        inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    },
];

async function getProject(projectId) {
    return (await api(`/api/projects/${projectId}`)).project;
}

function collectParams(node, project) {
    const incoming = project.connections.filter((edge) => edge.toNodeId === node.id).map((edge) => project.nodes.find((item) => item.id === edge.fromNodeId)).filter(Boolean);
    const references = incoming.map((item) => item.metadata?.storageKey).filter((key) => typeof key === "string" && key.startsWith("asset:"));
    // 文档里 rawBody 是 JSON 文本，这里解析成对象再交给 daemon；解析失败直接报给 Agent
    let rawBody;
    const rawText = node.metadata?.rawBody;
    if (typeof rawText === "string" && rawText.trim()) {
        try {
            const parsed = JSON.parse(rawText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
            rawBody = parsed;
        } catch (error) {
            throw new Error(`节点 rawBody 无效：${error.message}`);
        }
    }
    return {
        ...(rawBody ? { rawBody } : {}),
        prompt: node.metadata?.prompt,
        references,
        size: node.metadata?.size,
        count: node.metadata?.count,
        seconds: node.metadata?.seconds,
        resolution: node.metadata?.vquality,
        generateAudio: node.metadata?.generateAudio,
        videoMode: node.metadata?.videoMode,
        audioVoice: node.metadata?.audioVoice,
        audioFormat: node.metadata?.audioFormat,
        audioSpeed: node.metadata?.audioSpeed,
    };
}

const HANDLERS = {
    async canvas_list_projects() {
        const projects = (await api("/api/projects")).projects;
        return projects.map((project) => ({ id: project.id, title: project.title, updatedAt: project.updatedAt }));
    },

    async canvas_get_state({ projectId, nodeIds, includeConnections = true }) {
        const project = await getProject(projectId);
        const nodes = (nodeIds?.length ? project.nodes.filter((node) => nodeIds.includes(node.id)) : project.nodes).map(pickNodeSummary);
        return { project: { id: project.id, title: project.title, rev: project.rev }, nodes, connections: includeConnections ? project.connections : undefined };
    },

    async canvas_get_node({ projectId, nodeId }) {
        const project = await getProject(projectId);
        const node = project.nodes.find((item) => item.id === nodeId);
        if (!node) throw new Error(`节点不存在：${nodeId}`);
        return {
            node,
            upstream: project.connections.filter((edge) => edge.toNodeId === nodeId),
            downstream: project.connections.filter((edge) => edge.fromNodeId === nodeId),
        };
    },

    async canvas_apply_ops({ projectId, ops, expectRev }) {
        return api(`/api/projects/${projectId}/ops`, { method: "POST", body: JSON.stringify({ ops, expectRev, origin: "agent" }) });
    },

    async canvas_write_text({ projectId, nodeId, text, title }) {
        if (typeof text !== "string" || !text.trim()) throw new Error("text 不能为空");
        const project = await getProject(projectId);
        const node = project.nodes.find((item) => item.id === nodeId);
        if (!node) throw new Error(`节点不存在：${nodeId}`);
        if (node.type !== "text") throw new Error(`不是文本节点：${nodeId}`);
        const ops = [{ type: "update_node", id: nodeId, patch: { ...(title ? { title } : {}), metadata: { content: text, status: "success", errorDetails: undefined } } }];
        const result = await api(`/api/projects/${projectId}/ops`, { method: "POST", body: JSON.stringify({ ops, origin: "agent" }) });
        return { rev: result.rev, nodeId };
    },

    async canvas_import_local({ projectId, paths }) {
        const results = [];
        for (const filePath of paths) {
            const real = resolveImportPath(projectId, filePath);
            results.push({ path: real, ...(await uploadFile(projectId, real)) });
        }
        return results;
    },

    async canvas_place_artifacts({ projectId, anchorNodeId, items, connect = true, groupTitle }) {
        const project = await getProject(projectId);
        const anchor = project.nodes.find((node) => node.id === anchorNodeId);
        if (!anchor) throw new Error(`锚点节点不存在：${anchorNodeId}`);

        const prepared = [];
        for (const item of items) {
            const kind = ["image", "video", "audio", "text"].includes(item.kind) ? item.kind : "text";
            if (kind === "text") {
                if (!item.text) throw new Error("text 产物需要 text 字段");
                prepared.push({ kind, title: item.title || "文本", text: item.text });
                continue;
            }
            if (item.storageKey) {
                prepared.push({ kind, title: item.title || "产物", storageKey: item.storageKey, mime: item.mime });
                continue;
            }
            if (!item.path) throw new Error("image/video/audio 产物需要 path 或 storageKey");
            const real = resolveImportPath(projectId, item.path);
            const uploaded = await uploadFile(projectId, real);
            prepared.push({ kind, title: item.title || path.basename(real), ...uploaded });
        }

        const placements = layoutArtifacts({ anchor, items: prepared, nodes: project.nodes });
        const stamp = Date.now().toString(36);
        const ops = [];
        const created = [];
        prepared.forEach((item, index) => {
            const slot = placements[index];
            const id = `artifact-${stamp}-${index}`;
            const metadata =
                item.kind === "text"
                    ? { content: item.text, status: "success" }
                    : { content: item.url, storageKey: item.storageKey, status: "success", mimeType: item.mime, ...(groupTitle ? { groupTitle } : {}) };
            ops.push({
                type: "add_node",
                node: { id, type: item.kind, title: item.title, position: { x: slot.x, y: slot.y }, width: slot.width, height: slot.height, metadata },
            });
            if (connect) ops.push({ type: "add_edge", edge: { id: `edge-${stamp}-${index}`, fromNodeId: anchorNodeId, toNodeId: id } });
            created.push({ id, kind: item.kind, title: item.title, x: slot.x, y: slot.y });
        });

        const result = await api(`/api/projects/${projectId}/ops`, { method: "POST", body: JSON.stringify({ ops, origin: "agent" }) });
        return { rev: result.rev, created };
    },

    async canvas_list_tools({ query }) {
        return (await api(`/api/tools?q=${encodeURIComponent(query)}`)).results;
    },

    async canvas_inspect_tool({ provider, endpoint }) {
        return api(`/api/tools/detail?provider=${encodeURIComponent(provider)}&endpoint=${encodeURIComponent(endpoint)}`);
    },

    async canvas_run_nodes({ projectId, nodeId, nodeIds, provider, endpoint, params, approvalTimeoutSeconds = 180 }) {
        const project = await getProject(projectId);
        const targetId = nodeId || nodeIds?.[0] || project.nodes.find((node) => node.type === "image" || node.type === "video" || node.type === "audio")?.id;
        const node = project.nodes.find((item) => item.id === targetId);
        if (!node) throw new Error("找不到要生成的节点");

        const resolvedProvider = provider || node.metadata?.provider;
        const resolvedEndpoint = endpoint || node.metadata?.endpoint;
        if (!resolvedProvider || !resolvedEndpoint) throw new Error("节点还没有选择模型：请先在画布上选，或传 provider/endpoint");

        const payload = { ...collectParams(node, project), ...(params || {}) };
        const approval = await api("/api/approvals", {
            method: "POST",
            body: JSON.stringify({ projectId, nodeId: targetId, provider: resolvedProvider, endpoint: resolvedEndpoint, params: payload }),
        });

        if (approval.status === "approved" && approval.run?.id) {
            return { runId: approval.run.id, status: approval.run.status, nodeId: targetId };
        }

        const deadline = Date.now() + Math.max(10, approvalTimeoutSeconds) * 1000;
        while (Date.now() < deadline) {
            const state = await api(`/api/approvals/${approval.id}`);
            if (state.status === "approved") return { runId: state.run?.id, status: state.run?.status, nodeId: targetId };
            if (state.status === "denied") throw new Error("用户拒绝了这次生成");
            if (state.status === "expired") throw new Error("审批超时，未执行生成");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("审批超时，未执行生成");
    },

    async canvas_watch_run({ runId, timeoutSeconds = 300 }) {
        const deadline = Date.now() + Math.max(10, timeoutSeconds) * 1000;
        let run = null;
        while (Date.now() < deadline) {
            run = (await api(`/api/runs/${runId}`)).run;
            if (["completed", "failed", "uncertain", "stopped"].includes(run.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!run) throw new Error("找不到该 run");
        return {
            id: run.id,
            status: run.status,
            error: run.error,
            costSpark: run.costSpark,
            outputs: (run.outputs || []).map((item) => ({ storageKey: item.storageKey, mime: item.mime, bytes: item.bytes })),
        };
    },

    async canvas_cancel_run({ runId }) {
        return (await api(`/api/runs/${runId}/cancel`, { method: "POST" })).run;
    },
};

// ---- stdio JSON-RPC ----
let buffer = "";

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
}

function replyError(id, message, code = -32000) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
    if (!message || message.jsonrpc !== "2.0") return;
    const { id, method, params } = message;

    if (method === "initialize") {
        reply(id, {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "solgrid-canvas", version: "0.1.0" },
        });
        return;
    }
    if (method === "notifications/initialized") return;
    if (method === "ping") {
        reply(id, {});
        return;
    }
    if (method === "tools/list") {
        reply(id, { tools: TOOLS });
        return;
    }
    if (method === "tools/call") {
        const name = params?.name;
        const handler = HANDLERS[name];
        if (!handler) {
            replyError(id, `未知工具：${name}`);
            return;
        }
        try {
            await ensureDaemon();
            token = readToken();
            const result = await handler(params?.arguments || {});
            reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
        } catch (error) {
            reply(id, { content: [{ type: "text", text: `${error.message}` }], isError: true });
        }
        return;
    }
    if (id !== undefined) replyError(id, `不支持的方法：${method}`, -32601);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
            void handle(JSON.parse(line));
        } catch {
            // 单条消息解析失败不影响后续
        }
    }
});
process.stdin.on("end", () => process.exit(0));

// 主动预热：client 还没调用工具时也把 daemon 拉起来
void ensureDaemon().catch(() => undefined);

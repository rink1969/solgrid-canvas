// 项目目录存储：projects/<id>/{project.json, canvas.json}
// canvas.json 是 JSON Canvas 1.0（nodes/edges），solgrid 扩展字段放 x-solgrid 命名空间。
// 这里不做任何旧数据兼容：dataURL 一律剥离（由资产层接管），见 AGENTS.md 架构铁律 1/2。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FORMAT = "solgrid-canvas/1";

// 画布节点类型 → JSON Canvas 的四种标准类型
const TO_JSON_CANVAS = { text: "text", image: "file", video: "file", audio: "file", group: "group", config: "text" };
const FROM_JSON_CANVAS = { text: "text", file: "image", group: "group", link: "text" };

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

// 先写临时文件再 rename，避免进程中断留下半个文档
function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
}

// 递归剔除 data: URL（画布文档里只允许 assetId / storageKey）
function stripDataUrls(value, counter) {
    if (typeof value === "string") return value.startsWith("data:") ? (counter.n++, undefined) : value;
    if (Array.isArray(value)) {
        const next = [];
        for (const item of value) {
            const cleaned = stripDataUrls(item, counter);
            if (cleaned !== undefined) next.push(cleaned);
        }
        return next;
    }
    if (value && typeof value === "object") {
        const next = {};
        for (const [key, item] of Object.entries(value)) {
            const cleaned = stripDataUrls(item, counter);
            if (cleaned !== undefined) next[key] = cleaned;
        }
        return next;
    }
    return value;
}

function nodeToJsonCanvas(node) {
    // 保持 JSON Canvas 1.0 的标准字段；原始类型/标题/生成参数进 x-solgrid
    const base = {
        id: node.id,
        type: TO_JSON_CANVAS[node.type] || "text",
        x: node.position?.x ?? 0,
        y: node.position?.y ?? 0,
        width: node.width ?? 320,
        height: node.height ?? 240,
        "x-solgrid": {
            nodeType: node.type,
            title: node.title,
            metadata: node.metadata || {},
        },
    };
    if (base.type === "text") base.text = node.metadata?.content || "";
    if (base.type === "file") base.file = node.metadata?.assetId || node.metadata?.storageKey || "";
    return base;
}

function connectionToEdge(connection) {
    return { id: connection.id, fromNode: connection.fromNodeId, toNode: connection.toNodeId };
}

function fromJsonCanvasNode(raw) {
    const ext = raw["x-solgrid"] || {};
    return {
        id: raw.id,
        type: ext.nodeType || FROM_JSON_CANVAS[raw.type] || "text",
        title: ext.title || "",
        position: { x: raw.x ?? 0, y: raw.y ?? 0 },
        width: raw.width ?? 320,
        height: raw.height ?? 240,
        metadata: ext.metadata || {},
    };
}

function fromEdge(edge) {
    return { id: edge.id, fromNodeId: edge.fromNode, toNodeId: edge.toNode };
}

export function createStore(root) {
    const projectsDir = path.join(root, "projects");

    function projectDir(id) {
        // id 只允许安全字符，防止路径穿越
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid project id: ${id}`);
        return path.join(projectsDir, id);
    }

    function readProject(id) {
        const dir = projectDir(id);
        const meta = readJson(path.join(dir, "project.json"));
        const canvas = readJson(path.join(dir, "canvas.json"));
        if (!meta || !canvas) return null;
        const ext = canvas["x-solgrid"] || {};
        return {
            id: meta.id,
            title: meta.title,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            nodes: (canvas.nodes || []).map(fromJsonCanvasNode),
            connections: (canvas.edges || []).map(fromEdge),
            chatSessions: ext.chatSessions || [],
            activeChatId: ext.activeChatId ?? null,
            backgroundMode: meta.backgroundMode || "lines",
            showImageInfo: Boolean(meta.showImageInfo),
            viewport: meta.viewport || { x: 0, y: 0, k: 1 },
            rev: meta.rev || 0,
        };
    }

    function listProjects() {
        ensureDir(projectsDir);
        const projects = [];
        for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const project = readProject(entry.name);
            if (project) projects.push(project);
        }
        projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return projects;
    }

    function saveProject(id, input) {
        const dir = projectDir(id);
        ensureDir(path.join(dir, "assets"));
        const previous = readProject(id);
        const counter = { n: 0 };
        const nodes = stripDataUrls(Array.isArray(input.nodes) ? input.nodes : [], counter);
        const chatSessions = stripDataUrls(Array.isArray(input.chatSessions) ? input.chatSessions : [], counter);
        const now = new Date().toISOString();
        const rev = (previous?.rev || 0) + 1;

        const meta = {
            id,
            title: String(input.title || "未命名画布"),
            createdAt: input.createdAt || previous?.createdAt || now,
            updatedAt: input.updatedAt || now,
            backgroundMode: input.backgroundMode || "lines",
            showImageInfo: Boolean(input.showImageInfo),
            viewport: input.viewport || { x: 0, y: 0, k: 1 },
            rev,
        };
        const canvas = {
            "x-solgrid": { format: FORMAT, chatSessions, activeChatId: input.activeChatId ?? null },
            nodes: nodes.map(nodeToJsonCanvas),
            edges: (Array.isArray(input.connections) ? input.connections : []).map(connectionToEdge),
        };

        writeJsonAtomic(path.join(dir, "project.json"), meta);
        writeJsonAtomic(path.join(dir, "canvas.json"), canvas);
        return { rev, stripped: counter.n, dir };
    }

    function deleteProject(id) {
        const dir = projectDir(id);
        if (!fs.existsSync(dir)) return false;
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    }

    return { root, projectsDir, listProjects, readProject, saveProject, deleteProject };
}

export function hashId(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

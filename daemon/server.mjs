// solgrid canvas daemon：只监听 127.0.0.1，零运行时依赖（Node 内置 http/sqlite/fs）
// M0 范围：项目目录存储 + 文档同步 + SSE 广播。run 引擎 / 资产 / ACP 在 M1/M2 接入。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createStore } from "./store.mjs";
import { receiveAsset, serveAsset } from "./assets.mjs";
import { createCatalogCache, createDocOpStore, createOpLog, createRunStore, createSettingsStore, openDb } from "./db.mjs";
import { applyOps, normalizeOps, validateProjectPayload } from "./ops.mjs";
import { createApprovalStore } from "./approvals.mjs";
import { createAgentManager } from "./acp.mjs";
import { createVideoEditManager } from "./video-edit.mjs";
import { skeletonFromSchema } from "./raw-body.mjs";
import { estimateSpark, findCatalogPrice } from "./cost.mjs";
import { createGateway } from "./gateway.mjs";
import { createRunEngine } from "./runs.mjs";

const VERSION = "0.2.0";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const TOOLS_QUERY_TTL_MS = 24 * 60 * 60 * 1000;
const TOOL_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WEB_DIST = process.env.CANVAS_WEB_DIST || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "web", "dist");
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
};
const PORT = Number(process.env.CANVAS_PORT || 17371);
const HOST = "127.0.0.1";
const ROOT = process.env.CANVAS_HOME || path.join(os.homedir(), ".solgrid-canvas");
const BODY_LIMIT = 16 * 1024 * 1024;

fs.mkdirSync(ROOT, { recursive: true });

// ---- 访问令牌：只落本机 0600 文件，不出现在日志里 ----
function resolveToken() {
    if (process.env.CANVAS_TOKEN) return process.env.CANVAS_TOKEN;
    const file = path.join(ROOT, "daemon.json");
    try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        if (saved.token) return saved.token;
    } catch {
        // 首次启动，下面生成
    }
    const token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(file, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
    return token;
}

const TOKEN = resolveToken();
const store = createStore(ROOT);
const clients = new Set(); // SSE 连接
let catalogBuilding = false;
const catalogWaiters = [];

function log(...args) {
    // 日志脱敏：不打印 token / dataURL
    console.log(`[daemon ${new Date().toISOString().slice(11, 19)}]`, ...args.map((item) => (typeof item === "string" ? item.replace(/data:[^,]{0,80},[^\s"']*/g, "data:<redacted>") : item)));
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > BODY_LIMIT) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function isAllowedOrigin(origin) {
    if (!origin) return false;
    // 本地开发：任意 localhost / 127.0.0.1 端口（Vite 常用 5173，可能被占用后换端口）
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function applyCors(req, res) {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-allow-headers", "content-type, x-canvas-token, x-canvas-client");
        res.setHeader("access-control-allow-methods", "GET, PUT, DELETE, OPTIONS");
        res.setHeader("vary", "origin");
        return true;
    }
    return false;
}

function cookieValue(req, name) {
    for (const part of String(req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return "";
}

function authorized(req) {
    // 生产模式同源访问用 HttpOnly cookie；开发模式由 Vite 代理注入 header
    const token = req.headers["x-canvas-token"] || cookieValue(req, "canvas_token");
    if (typeof token !== "string" || token.length !== TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
}

// 区分“浏览器/UI 请求”和“Agent/MCP 的 token 请求”：花费确认只允许前者直接触发。
function isBrowserRequest(req) {
    return Boolean(cookieValue(req, "canvas_token")) || req.headers["x-canvas-client"] === "web";
}

// 生产：daemon 直接托管构建后的前端（SPA fallback + 首次访问写鉴权 cookie）
function serveStatic(req, res, pathname) {
    let relative = decodeURIComponent(pathname);
    if (relative === "/" || relative === "") relative = "/index.html";
    const dist = path.resolve(WEB_DIST);
    const target = path.resolve(dist, `.${relative}`);
    if (!target.startsWith(dist)) {
        res.writeHead(400);
        res.end("bad path");
        return;
    }
    const exists = fs.existsSync(target) && fs.statSync(target).isFile();
    if (!exists && path.extname(relative)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
    }
    const page = path.join(dist, "index.html");
    if (!exists && !fs.existsSync(page)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<h1>solgrid-canvas</h1><p>前端还没构建：在仓库根目录运行 <code>npm run build</code> 后刷新。</p>");
        return;
    }
    const file = exists ? target : page;
    const ext = path.extname(file).toLowerCase();
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html") {
        headers["cache-control"] = "no-store";
        headers["set-cookie"] = `canvas_token=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`;
    } else {
        headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
}

function broadcast(event, exceptClientId) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
        if (exceptClientId && client.clientId === exceptClientId) continue;
        client.res.write(payload);
    }
}

// ---- run 引擎（M1）----
const db = openDb(ROOT);
const runStore = createRunStore(db);
const catalog = createCatalogCache(db);
const settings = createSettingsStore(db);
const docOps = createDocOpStore(db);
const opLog = createOpLog(db);
const gateway = createGateway();
const bodyDir = path.join(ROOT, "tmp");
fs.mkdirSync(bodyDir, { recursive: true });
const engine = createRunEngine({
    store: runStore,
    gateway,
    projectsDir: store.projectsDir,
    bodyDir,
    broadcast,
    log,
    docStore: store,
    opLog,
    docOps,
});
void engine.recover();
const approvals = createApprovalStore({ engine, broadcast, log, autoApprove: () => Boolean(settings.get("agentAutoApprove", false)), stateFile: path.join(ROOT, "approvals.json") });
const agent = createAgentManager({ broadcast, log });
const videoEdits = createVideoEditManager({ runStore, engine, gateway, store, projectsDir: store.projectsDir, broadcast, log });

// ---- 路由 ----
async function handle(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
        applyCors(req, res);
        res.writeHead(204).end();
        return;
    }

    if (pathname === "/health") {
        sendJson(res, 200, { ok: true, version: VERSION, root: ROOT });
        return;
    }

    applyCors(req, res);
    if (!pathname.startsWith("/api") && req.method === "GET") {
        serveStatic(req, res, pathname);
        return;
    }
    if (!authorized(req)) {
        sendJson(res, 401, { error: "unauthorized", hint: "缺少或错误的 x-canvas-token（见 ~/.solgrid-canvas/daemon.json）" });
        return;
    }

    if (pathname === "/api/meta" && req.method === "GET") {
        return sendJson(res, 200, { root: ROOT, projectsDir: store.projectsDir, version: VERSION });
    }

    if (pathname === "/api/settings" && req.method === "GET") {
        return sendJson(res, 200, { settings: { agentAutoApprove: Boolean(settings.get("agentAutoApprove", false)) } });
    }

    if (pathname === "/api/settings" && req.method === "PUT") {
        if (!isBrowserRequest(req)) return sendJson(res, 403, { error: "confirmation_required", message: "偏好设置只能从画布 UI 修改" });
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        if (typeof body?.agentAutoApprove !== "boolean") return sendJson(res, 400, { error: "invalid_settings", message: "agentAutoApprove 必须是布尔值" });
        settings.set("agentAutoApprove", body.agentAutoApprove);
        log(`设置：agentAutoApprove=${body.agentAutoApprove}`);
        return sendJson(res, 200, { settings: { agentAutoApprove: body.agentAutoApprove } });
    }

    // 项目列表（M0 直接返回完整文档：文档不含二进制，通常只有几十 KB）
    if (pathname === "/api/projects" && req.method === "GET") {
        sendJson(res, 200, { projects: store.listProjects() });
        return;
    }

    // SSE：文档变更广播给其他标签页 / 其他客户端
    if (pathname === "/api/events" && req.method === "GET") {
        const clientId = String(req.headers["x-canvas-client"] || url.searchParams.get("client") || "");
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "hello", version: VERSION })}\n\n`);
        const client = { res, clientId };
        clients.add(client);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
            clearInterval(heartbeat);
            clients.delete(client);
        });
        return;
    }

    // ---- 工具目录：solgrid tools / inspect（缓存 24h，失败时退回旧缓存）----
    if (pathname === "/api/tools" && req.method === "GET") {
        const query = String(url.searchParams.get("q") || "").trim();
        if (!query) return sendJson(res, 400, { error: "missing_query" });
        const includeUnavailable = url.searchParams.get("include_unavailable") === "1";
        const key = `tools:q:v2:${includeUnavailable ? "all:" : ""}${query}`;
        const cached = catalog.get(key, TOOLS_QUERY_TTL_MS);
        if (cached) return sendJson(res, 200, { results: cached, cached: true });
        try {
            const data = await gateway.listTools({ query, limit: 20, includeUnavailable });
            const results = (data.items || [])
                .filter((item) => item?.provider && item?.endpoint)
                .map((item) => ({
                    provider: item.provider,
                    endpoint: item.endpoint,
                    displayName: item.displayName,
                    description: item.description,
                    price: item.price,
                    tags: item.tags || item.categories || [],
                    categories: item.categories,
                    invocationEnabled: item.invocationEnabled,
                    unavailableReason: item.unavailableReason,
                }));
            catalog.put(key, results);
            catalog.prune("tools:q:v2:", TOOLS_QUERY_TTL_MS);
            return sendJson(res, 200, { results, cached: false });
        } catch (error) {
            const stale = catalog.get(key);
            if (stale) return sendJson(res, 200, { results: stale, cached: true, warning: error.message });
            return sendJson(res, 502, { error: "solgrid_unavailable", message: error.message });
        }
    }

    // 平台模型目录：solgrid tools categories + list，按类别归到图片/视频/音频，缓存 24h（?refresh=1 强制刷新）
    if (pathname === "/api/tools/catalog" && req.method === "GET") {
        const key = "catalog:v3";
        const force = url.searchParams.get("refresh") === "1";
        if (!force) {
            const cached = catalog.get(key, CATALOG_TTL_MS);
            if (cached) return sendJson(res, 200, { catalog: cached, cached: true });
            if (catalogBuilding) {
                await new Promise((resolve) => catalogWaiters.push(resolve));
                const shared = catalog.get(key, CATALOG_TTL_MS);
                if (shared) return sendJson(res, 200, { catalog: shared, cached: true });
            }
        }
        catalogBuilding = true;
        try {
            const categoryBuckets = { image: "image", video: "video", music: "audio", "sound-effect": "audio", speech: "audio", "audio-editing": "audio" };
            const categories = await gateway.toolCategories();
            const buckets = { image: [], video: [], audio: [] };
            const seen = new Set();
            for (const category of categories) {
                const bucket = categoryBuckets[category.code];
                if (!bucket) continue;
                let page = 1;
                let totalPages = 1;
                while (page <= totalPages && page <= 20) {
                    const data = await gateway.listTools({ category: category.code, limit: 100, page });
                    for (const item of data.items || []) {
                        if (!item?.provider || !item?.endpoint) continue;
                        const id = `${item.provider}|${item.endpoint}`;
                        // 同一工具可能同时属于多个类别（如 magic-hour: video,image），
                        // 去重必须按 bucket 分开，否则先处理 video 会把 image 里的条目吞掉。
                        const itemBuckets = new Set((item.categories || []).map((code) => categoryBuckets[code]).filter(Boolean));
                        if (!itemBuckets.size) itemBuckets.add(bucket);
                        for (const targetBucket of itemBuckets) {
                            const key = `${targetBucket}|${id}`;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            buckets[targetBucket].push({ provider: item.provider, endpoint: item.endpoint, description: item.description, price: item.price });
                        }
                    }
                    totalPages = Math.max(1, Number(data.totalPages) || 1);
                    page += 1;
                }
            }
            buckets.image.sort((a, b) => (a.provider + a.endpoint).localeCompare(b.provider + b.endpoint));
            buckets.video.sort((a, b) => (a.provider + a.endpoint).localeCompare(b.provider + b.endpoint));
            buckets.audio.sort((a, b) => (a.provider + a.endpoint).localeCompare(b.provider + b.endpoint));
            catalog.put(key, buckets);
            return sendJson(res, 200, { catalog: buckets, cached: false });
        } catch (error) {
            const stale = catalog.get(key);
            if (stale) return sendJson(res, 200, { catalog: stale, cached: true, warning: error.message });
            return sendJson(res, 502, { error: "solgrid_unavailable", message: error.message });
        } finally {
            catalogBuilding = false;
            for (const resolve of catalogWaiters.splice(0)) resolve();
        }
    }

    if (pathname === "/api/tools/detail" && req.method === "GET") {
        const provider = String(url.searchParams.get("provider") || "").trim();
        const endpoint = String(url.searchParams.get("endpoint") || "").trim();
        if (!provider || !endpoint) return sendJson(res, 400, { error: "missing_provider_or_endpoint" });
        const key = `inspect:${provider}:${endpoint}`;
        const cached = catalog.get(key, TOOL_DETAIL_TTL_MS);
        if (cached) return sendJson(res, 200, { detail: cached, skeleton: skeletonFromSchema(cached?.input?.body), cached: true });
        try {
            const detail = await gateway.inspect(provider, endpoint);
            catalog.put(key, detail);
            return sendJson(res, 200, { detail, skeleton: skeletonFromSchema(detail?.input?.body), cached: false });
        } catch (error) {
            const stale = catalog.get(key);
            if (stale) return sendJson(res, 200, { detail: stale, skeleton: skeletonFromSchema(stale?.input?.body), cached: true, warning: error.message });
            return sendJson(res, 502, { error: "solgrid_unavailable", message: error.message });
        }
    }

    // ---- 视频片段重生成 ----
    if (pathname === "/api/video-edits" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        try {
            const job = videoEdits.create(body || {});
            return sendJson(res, 200, { job: { id: job.id, status: job.status, stage: job.stage } });
        } catch (error) {
            return sendJson(res, 400, { error: error.code || "invalid_request", message: error.message });
        }
    }

    const videoEditMatch = pathname.match(/^\/api\/video-edits\/([0-9a-f-]{36})$/);
    if (videoEditMatch && req.method === "GET") {
        const job = videoEdits.get(videoEditMatch[1]);
        if (!job) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, { job });
    }

    const videoEditCancel = pathname.match(/^\/api\/video-edits\/([0-9a-f-]{36})\/cancel$/);
    if (videoEditCancel && req.method === "POST") {
        const ok = videoEdits.cancel(videoEditCancel[1]);
        return sendJson(res, ok ? 200 : 404, { ok });
    }

    // ---- Agent（ACP）：画布 → 本地 Agent（每个画布多个对话）----
    if (pathname === "/api/agent/status" && req.method === "GET") {
        return sendJson(res, 200, agent.status());
    }

    const closeAgentProject = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/agent\/close$/);
    if (closeAgentProject && req.method === "POST") {
        return sendJson(res, 200, { closed: await agent.closeProject(closeAgentProject[1]) });
    }

    const conversationProject = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/agent\/conversations$/);
    if (conversationProject) {
        const projectId = conversationProject[1];
        if (!store.readProject(projectId)) return sendJson(res, 404, { error: "not_found" });
        const cwd = path.join(store.projectsDir, projectId);
        if (req.method === "GET") return sendJson(res, 200, { conversations: agent.listConversations(projectId, cwd) });
        if (req.method === "POST") {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (error) {
                return sendJson(res, 400, { error: "invalid_json", message: error.message });
            }
            return sendJson(res, 200, { conversation: agent.createConversation(projectId, cwd, body?.title) });
        }
        return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const conversationItem = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/agent\/conversations\/([A-Za-z0-9-]{1,64})$/);
    if (conversationItem) {
        const [projectId, conversationId] = [conversationItem[1], conversationItem[2]];
        if (!store.readProject(projectId)) return sendJson(res, 404, { error: "not_found" });
        const cwd = path.join(store.projectsDir, projectId);
        if (req.method === "DELETE") return sendJson(res, 200, { ok: await agent.deleteConversation(projectId, cwd, conversationId) });
        if (req.method === "PATCH") {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (error) {
                return sendJson(res, 400, { error: "invalid_json", message: error.message });
            }
            try {
                return sendJson(res, 200, { conversation: agent.renameConversation(projectId, cwd, conversationId, body?.title) });
            } catch (error) {
                return sendJson(res, 404, { error: "not_found", message: error.message });
            }
        }
        return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const conversationAction = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/agent\/conversations\/([A-Za-z0-9-]{1,64})\/(transcript|prompt|cancel|model|prepare)$/);
    if (conversationAction) {
        const [projectId, conversationId, action] = [conversationAction[1], conversationAction[2], conversationAction[3]];
        if (!store.readProject(projectId)) return sendJson(res, 404, { error: "not_found" });
        const cwd = path.join(store.projectsDir, projectId);

        if (action === "transcript" && req.method === "GET") {
            return sendJson(res, 200, { transcript: agent.transcript(projectId, cwd, conversationId) });
        }
        if (action === "prepare" && req.method === "POST") {
            try {
                return sendJson(res, 200, { conversation: await agent.prepareConversation(projectId, cwd, conversationId) });
            } catch (error) {
                return sendJson(res, 502, { error: "agent_unavailable", message: error.message });
            }
        }
        if (action === "prompt" && req.method === "POST") {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (error) {
                return sendJson(res, 400, { error: "invalid_json", message: error.message });
            }
            if (!body?.text) return sendJson(res, 400, { error: "missing_text" });
            try {
                await agent.prompt(projectId, cwd, conversationId, String(body.text));
                return sendJson(res, 200, { ok: true });
            } catch (error) {
                if (error.code === "agent_busy") {
                    res.setHeader("retry-after", "5");
                    return sendJson(res, 409, { error: "agent_busy", message: error.message, retryAfterSeconds: 5 });
                }
                return sendJson(res, 400, { error: "agent_prompt_failed", message: error.message });
            }
        }
        if (action === "cancel" && req.method === "POST") {
            await agent.cancel(projectId, cwd, conversationId).catch(() => undefined);
            return sendJson(res, 200, { ok: true });
        }
        if (action === "model" && req.method === "POST") {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (error) {
                return sendJson(res, 400, { error: "invalid_json", message: error.message });
            }
            try {
                const configOptions = await agent.setModel(projectId, cwd, conversationId, body?.configId || "model", body?.value);
                return sendJson(res, 200, { configOptions });
            } catch (error) {
                return sendJson(res, 400, { error: "agent_model_failed", message: error.message });
            }
        }
        return sendJson(res, 405, { error: "method_not_allowed" });
    }

    if (pathname === "/api/agent/permissions" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId") || "";
        const conversationId = url.searchParams.get("conversationId") || "";
        return sendJson(res, 200, { permissions: agent.listPermissions(projectId, conversationId) });
    }

    const permMatch = pathname.match(/^\/api\/agent\/permissions\/([A-Za-z0-9-]{1,64})$/);
    if (permMatch && req.method === "POST") {
        if (!isBrowserRequest(req)) return sendJson(res, 403, { error: "confirmation_required", message: "Agent 权限必须由画布 UI 确认" });
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const ok = agent.decidePermission(permMatch[1], Boolean(body?.allow));
        return sendJson(res, ok ? 200 : 404, { ok });
    }

    // ---- 生成审批（Agent 花钱前必须由用户确认）----
    if (pathname === "/api/approvals" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const { projectId, nodeId, provider, endpoint, prompt } = body || {};
        if (!projectId) return sendJson(res, 400, { error: "missing_fields" });
        const rawItems = Array.isArray(body?.items) && body.items.length ? body.items : [{ nodeId, provider, endpoint, params: body?.params || {}, prompt }];
        const items = [];
        for (const raw of rawItems) {
            const jobNodeId = raw.nodeId || nodeId || null;
            const jobProvider = raw.provider || provider;
            const jobEndpoint = raw.endpoint || endpoint;
            if (!jobProvider || !jobEndpoint) return sendJson(res, 400, { error: "missing_fields", message: "每个审批项都需要 provider/endpoint" });
            const params = { ...(raw.params || {}) };
            if (typeof params.prompt !== "string" || !params.prompt.trim()) {
                if (typeof raw.prompt === "string") params.prompt = raw.prompt;
                else if (typeof prompt === "string") params.prompt = prompt;
            }
            if (typeof params.prompt !== "string" || !params.prompt.trim()) {
                if (jobNodeId) {
                    const node = store.readProject(projectId)?.nodes?.find((item) => item.id === jobNodeId);
                    if (typeof node?.metadata?.prompt === "string") params.prompt = node.metadata.prompt;
                }
            }
            const price = findCatalogPrice(catalog.get("catalog:v3", CATALOG_TTL_MS), jobProvider, jobEndpoint);
            const estimatedSpark = estimateSpark(price, {
                outputs: Number(params.count) || 1,
                seconds: Number(params.seconds) || 0,
                resolution: typeof params.resolution === "string" ? params.resolution : "",
                references: Array.isArray(params.references) ? params.references.length : 0,
            });
            items.push({ nodeId: jobNodeId, provider: jobProvider, endpoint: jobEndpoint, params, estimatedSpark });
        }
        const estimatedTotal = items.every((item) => typeof item.estimatedSpark === "number") ? Math.round(items.reduce((sum, item) => sum + item.estimatedSpark, 0) * 100) / 100 : null;
        const maxCostSpark = Number(body?.maxCostSpark);
        if (Number.isFinite(maxCostSpark) && maxCostSpark > 0) {
            if (estimatedTotal === null) return sendJson(res, 400, { error: "cost_unavailable", message: "无法估算本次费用，不能应用 maxCostSpark" });
            if (estimatedTotal > maxCostSpark) return sendJson(res, 400, { error: "cost_limit_exceeded", message: `预计 ${estimatedTotal} Spark，超过上限 ${maxCostSpark} Spark` });
        }
        let approval;
        try {
            approval = approvals.create({ projectId, items });
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_approval", message: error.message });
        }
        return sendJson(res, 200, { id: approval.id, status: approval.status, items: approval.items, run: approval.run || null, runs: approval.runs || [], runIds: (approval.runs || []).map((run) => run.id) });
    }

    if (pathname === "/api/approvals" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId") || "";
        const status = url.searchParams.get("status") || "pending";
        return sendJson(res, 200, { approvals: approvals.list(projectId, status) });
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([0-9a-f-]{36})$/);
    if (approvalMatch && req.method === "GET") {
        const item = approvals.get(approvalMatch[1]);
        if (!item) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, { id: item.id, status: item.status, items: item.items || [], run: item.run || null, runs: item.runs || [], runIds: (item.runs || []).map((run) => run.id) });
    }

    const decisionMatch = pathname.match(/^\/api\/approvals\/([0-9a-f-]{36})\/decision$/);
    if (decisionMatch && req.method === "POST") {
        if (!isBrowserRequest(req)) return sendJson(res, 403, { error: "confirmation_required", message: "审批必须由画布 UI 确认" });
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const decided = approvals.decide(decisionMatch[1], Boolean(body?.allow));
        if (!decided) return sendJson(res, 404, { error: "not_found_or_decided" });
        return sendJson(res, 200, { id: decided.id, status: decided.status, run: decided.run || null, runs: decided.runs || [], runIds: (decided.runs || []).map((run) => run.id) });
    }

    // ---- run 队列 ----
    if (pathname === "/api/runs" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId") || "";
        const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
        const runs = runStore.list(projectId || null, limit).map((run) => {
            // 列表不带 body（可能很大），详情单独取
            const { body, builtBody, idempotencyKey, ...summary } = run;
            return { ...summary, hasBuiltBody: Boolean(builtBody), queuePosition: run.status === "queued" ? runStore.queuePosition(run.id) : 0 };
        });
        return sendJson(res, 200, { runs });
    }

    if (pathname === "/api/runs" && req.method === "POST") {
        if (!isBrowserRequest(req)) return sendJson(res, 403, { error: "confirmation_required", message: "Agent/MCP 发起生成必须走 /api/approvals，由用户在画布上确认；不能直接调用 /api/runs" });
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const { projectId, nodeId, provider, endpoint } = body || {};
        if (!projectId || !provider || !endpoint) return sendJson(res, 400, { error: "missing_fields", hint: "需要 projectId / provider / endpoint" });
        // params 是画布语义（prompt/size/references…），由 daemon 按 family 转成 provider 契约；
        // 想直接控制请求体就传 params.rawBody（对象，或 JSON 字符串）。
        try {
            const run = engine.enqueue({ projectId, nodeId, provider, endpoint, body: body.params ?? body.body ?? {} });
            return sendJson(res, 200, { run });
        } catch (error) {
            return sendJson(res, 400, { error: error.code || "invalid_params", message: error.message });
        }
    }

    const runMatch = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
    if (runMatch && req.method === "GET") {
        const run = runStore.get(runMatch[1]);
        if (!run) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, { run: { ...run, queuePosition: run.status === "queued" ? runStore.queuePosition(run.id) : 0 } });
    }
    if (runMatch && req.method === "DELETE") {
        return sendJson(res, 200, { ok: runStore.remove(runMatch[1]) });
    }

    const retryMatch = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/retry$/);
    if (retryMatch && req.method === "POST") {
        if (!isBrowserRequest(req)) return sendJson(res, 403, { error: "confirmation_required", message: "重试生成必须在画布 UI 确认" });
        const source = runStore.get(retryMatch[1]);
        if (!source) return sendJson(res, 404, { error: "not_found" });
        const run = engine.enqueue({ projectId: source.projectId, nodeId: source.nodeId, provider: source.provider, endpoint: source.endpoint, body: source.body });
        return sendJson(res, 200, { run });
    }

    const cancelMatch = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/cancel$/);
    if (cancelMatch && req.method === "POST") {
        const run = runStore.get(cancelMatch[1]);
        if (!run) return sendJson(res, 404, { error: "not_found" });
        const updated = await engine.cancel(run);
        return sendJson(res, 200, { run: updated });
    }

    // 增量 op：画布改动按 op 应用，返回新 rev；expectRev 不匹配返回 409 让客户端回退整份保存
    const opsMatch = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/ops$/);
    if (opsMatch && req.method === "POST") {
        const id = opsMatch[1];
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        try {
            const ops = normalizeOps(body.ops);
            const existing = store.readProject(id);
            if (!existing) return sendJson(res, 404, { error: "not_found" });
            if (body.expectRev != null && existing.rev !== body.expectRev) return sendJson(res, 409, { error: "rev_conflict", rev: existing.rev });
            const result = applyOps(store, id, ops);
            opLog.append(id, ops, body.origin || "user");
            const clientId = String(req.headers["x-canvas-client"] || url.searchParams.get("client") || "");
            broadcast({ type: "project.ops", id, rev: result.rev, ops: ops.length, clientId });
            return sendJson(res, 200, { rev: result.rev });
        } catch (error) {
            return sendJson(res, 400, { error: error.code || "invalid_op", message: error.message });
        }
    }

    if (opsMatch && req.method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
        return sendJson(res, 200, { ops: opLog.list(opsMatch[1], limit) });
    }

    // 资产上传：body 为原始二进制，mime 走 query（浏览器 fetch 的 content-type 可直接用）
    const assetUpload = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/assets$/);
    if (assetUpload && req.method === "POST") {
        const mime = String(url.searchParams.get("mime") || req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
        try {
            const saved = await receiveAsset(req, store.projectsDir, assetUpload[1], mime);
            return sendJson(res, 200, saved);
        } catch (error) {
            log("asset upload failed:", error.message);
            return sendJson(res, 400, { error: "asset_upload_failed", message: error.message });
        }
    }

    // 资产读取：支持 Range（视频拖动进度必需）
    const assetGc = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/assets\/gc$/);
    if (assetGc && req.method === "POST") {
        let body = {};
        try {
            const raw = await readBody(req);
            if (raw.trim()) body = JSON.parse(raw);
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const minAgeHours = Math.max(1, Number(body?.minAgeHours) || 168);
        try {
            const result = store.cleanupOrphanAssets(assetGc[1], { minAgeMs: minAgeHours * 60 * 60 * 1000 });
            log(`项目 ${assetGc[1]} 资产清理：删除 ${result.deleted}，保留 ${result.kept}`);
            return sendJson(res, 200, { ...result, minAgeHours });
        } catch (error) {
            return sendJson(res, 400, { error: "asset_gc_failed", message: error.message });
        }
    }

    const assetGet = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/assets\/([a-f0-9]{64}\.[a-z0-9]{2,5})$/);
    if (assetGet && req.method === "GET") {
        serveAsset(req, res, store.projectsDir, assetGet[1], assetGet[2]);
        return;
    }

    const match = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})$/);
    if (match) {
        const id = match[1];
        if (req.method === "GET") {
            const project = store.readProject(id);
            if (!project) return sendJson(res, 404, { error: "not_found" });
            return sendJson(res, 200, { project });
        }
        if (req.method === "PUT") {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (error) {
                return sendJson(res, 400, { error: "invalid_json", message: error.message });
            }
            const project = body?.project ?? body;
            if (!project || typeof project !== "object") return sendJson(res, 400, { error: "invalid_project" });
            const existing = store.readProject(id);
            if (existing && body?.expectRev != null && existing.rev !== body.expectRev) {
                return sendJson(res, 409, { error: "rev_conflict", rev: existing.rev });
            }
            if (existing && body?.expectRev == null) {
                return sendJson(res, 409, { error: "rev_required", rev: existing.rev, message: "覆盖已有画布必须带 expectRev，请改用 /ops 增量修改" });
            }
            let normalized;
            try {
                normalized = validateProjectPayload(project);
            } catch (error) {
                return sendJson(res, 400, { error: "invalid_project", message: error.message });
            }
            let saved;
            try {
                saved = store.saveProject(id, normalized);
            } catch (error) {
                return sendJson(res, 500, { error: "save_failed", message: error.message });
            }
            if (saved.stripped > 0) log(`project ${id}: 剥离 ${saved.stripped} 个 dataURL（资产层接管前暂不支持内联图片）`);
            const clientId = String(req.headers["x-canvas-client"] || url.searchParams.get("client") || "");
            broadcast({ type: "project.updated", id, rev: saved.rev, clientId });
            return sendJson(res, 200, { rev: saved.rev, dir: saved.dir });
        }
        if (req.method === "DELETE") {
            if (!store.readProject(id)) return sendJson(res, 404, { error: "not_found" });
            // 先关掉该项目下的 Agent 会话：会话里的 MCP 子进程以项目目录为 cwd，不退出就删不掉目录。
            await agent.closeProject(id);
            try {
                store.deleteProject(id);
            } catch (error) {
                if (error.code === "EPERM" || error.code === "EBUSY") {
                    return sendJson(res, 409, { error: "project_busy", message: "项目目录仍被占用（Agent 会话或文件锁），稍后重试" });
                }
                throw error;
            }
            const clientId = String(req.headers["x-canvas-client"] || url.searchParams.get("client") || "");
            broadcast({ type: "project.deleted", id, clientId });
            return sendJson(res, 200, { ok: true });
        }
    }

    sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
        log("request failed:", error.message);
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: error.message });
        else res.end();
    });
});

server.listen(PORT, HOST, () => {
    log(`listening http://${HOST}:${PORT}`);
    log(`projects: ${store.projectsDir}`);
    log(`token file: ${path.join(ROOT, "daemon.json")}`);
    log("把 token 填到 web/.env.local 的 CANVAS_TOKEN，然后 npm run dev");
});

function shutdown() {
    log("shutting down");
    agent.close();
    server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// solgrid canvas daemon：只监听 127.0.0.1，零运行时依赖（Node 内置 http/sqlite/fs）
// M0 范围：项目目录存储 + 文档同步 + SSE 广播。run 引擎 / 资产 / ACP 在 M1/M2 接入。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createStore } from "./store.mjs";
import { receiveAsset, serveAsset } from "./assets.mjs";
import { createCatalogCache, createOpLog, createRunStore, openDb } from "./db.mjs";
import { applyOps, normalizeOps } from "./ops.mjs";
import { createApprovalStore } from "./approvals.mjs";
import { createAgentManager } from "./acp.mjs";
import { createGateway } from "./gateway.mjs";
import { createRunEngine } from "./runs.mjs";

const VERSION = "0.1.0";
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

function authorized(req) {
    const token = req.headers["x-canvas-token"];
    return typeof token === "string" && token.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
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
});
void engine.recover();
const approvals = createApprovalStore({ engine, broadcast, log });
const agent = createAgentManager({ broadcast, log });

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
    if (!authorized(req)) {
        sendJson(res, 401, { error: "unauthorized", hint: "缺少或错误的 x-canvas-token（见 ~/.solgrid-canvas/daemon.json）" });
        return;
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

    // ---- 工具目录：discover / inspect（缓存 24h，失败时退回旧缓存）----
    if (pathname === "/api/tools" && req.method === "GET") {
        const query = String(url.searchParams.get("q") || "").trim();
        if (!query) return sendJson(res, 400, { error: "missing_query" });
        const key = `discover:${query}`;
        try {
            const results = await gateway.discover(query);
            catalog.put(key, results);
            return sendJson(res, 200, { results, cached: false });
        } catch (error) {
            const stale = catalog.get(key);
            if (stale) return sendJson(res, 200, { results: stale, cached: true, warning: error.message });
            return sendJson(res, 502, { error: "solgrid_unavailable", message: error.message });
        }
    }

    // 平台模型目录：discover 多个关键词按能力归类，缓存 24h（?refresh=1 强制刷新）
    if (pathname === "/api/tools/catalog" && req.method === "GET") {
        const key = "catalog:v1";
        const force = url.searchParams.get("refresh") === "1";
        if (!force) {
            const cached = catalog.get(key, 24 * 60 * 60 * 1000);
            if (cached) return sendJson(res, 200, { catalog: cached, cached: true });
        }
        try {
            const queries = ["image", "video", "audio"];
            const buckets = { image: [], video: [], audio: [] };
            const seen = new Set();
            for (const query of queries) {
                const results = await gateway.discover(query, 100);
                for (const item of results) {
                    if (!item?.provider || !item?.endpoint) continue;
                    const id = `${item.provider}|${item.endpoint}`;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    const endpoint = String(item.endpoint);
                    const bucket = /image-to-video|\/video\//.test(endpoint) ? "video" : /\/image\//.test(endpoint) ? "image" : /audio|t2a|tts|music|speech|sound/i.test(endpoint) ? "audio" : null;
                    if (!bucket) continue;
                    buckets[bucket].push({ provider: item.provider, endpoint, description: item.description, price: item.price });
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
        }
    }

    if (pathname === "/api/tools/detail" && req.method === "GET") {
        const provider = String(url.searchParams.get("provider") || "").trim();
        const endpoint = String(url.searchParams.get("endpoint") || "").trim();
        if (!provider || !endpoint) return sendJson(res, 400, { error: "missing_provider_or_endpoint" });
        const key = `inspect:${provider}:${endpoint}`;
        try {
            const detail = await gateway.inspect(provider, endpoint);
            catalog.put(key, detail);
            return sendJson(res, 200, { detail, cached: false });
        } catch (error) {
            const stale = catalog.get(key);
            if (stale) return sendJson(res, 200, { detail: stale, cached: true, warning: error.message });
            return sendJson(res, 502, { error: "solgrid_unavailable", message: error.message });
        }
    }

    // ---- Agent（ACP）：画布 → 本地 Agent ----
    if (pathname === "/api/agent/status" && req.method === "GET") {
        return sendJson(res, 200, agent.status());
    }

    if (pathname === "/api/agent/start" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const projectId = body?.projectId;
        if (!projectId) return sendJson(res, 400, { error: "missing_project" });
        if (!store.readProject(projectId)) return sendJson(res, 404, { error: "not_found" });
        try {
            const session = await agent.ensureSession(projectId, path.join(store.projectsDir, projectId));
            return sendJson(res, 200, { sessionId: session.sessionId, configOptions: session.configOptions });
        } catch (error) {
            return sendJson(res, 502, { error: "agent_unavailable", message: error.message });
        }
    }

    if (pathname === "/api/agent/transcript" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId") || "";
        return sendJson(res, 200, { transcript: agent.transcript(projectId) });
    }

    if (pathname === "/api/agent/prompt" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const { projectId, text } = body || {};
        if (!projectId || !text) return sendJson(res, 400, { error: "missing_fields" });
        try {
            await agent.ensureSession(projectId, path.join(store.projectsDir, projectId));
            await agent.prompt(projectId, text);
            return sendJson(res, 200, { ok: true });
        } catch (error) {
            return sendJson(res, 400, { error: "agent_prompt_failed", message: error.message });
        }
    }

    if (pathname === "/api/agent/cancel" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        await agent.cancel(body?.projectId).catch(() => undefined);
        return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/agent/model" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        try {
            const configOptions = await agent.setModel(body?.projectId, body?.configId || "model", body?.value);
            return sendJson(res, 200, { configOptions });
        } catch (error) {
            return sendJson(res, 400, { error: "agent_model_failed", message: error.message });
        }
    }

    const permMatch = pathname.match(/^\/api\/agent\/permissions\/([A-Za-z0-9-]{1,64})$/);
    if (permMatch && req.method === "POST") {
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
        const { projectId, nodeId, provider, endpoint } = body || {};
        if (!projectId || !provider || !endpoint) return sendJson(res, 400, { error: "missing_fields" });
        const approval = approvals.create({ projectId, nodeId: nodeId || null, provider, endpoint, params: body.params || {} });
        return sendJson(res, 200, { id: approval.id, status: approval.status, run: approval.run || null });
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
        return sendJson(res, 200, { id: item.id, status: item.status, run: item.run || null });
    }

    const decisionMatch = pathname.match(/^\/api\/approvals\/([0-9a-f-]{36})\/decision$/);
    if (decisionMatch && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const decided = approvals.decide(decisionMatch[1], Boolean(body?.allow));
        if (!decided) return sendJson(res, 404, { error: "not_found_or_decided" });
        return sendJson(res, 200, { id: decided.id, status: decided.status, run: decided.run || null });
    }

    // ---- run 队列 ----
    if (pathname === "/api/runs" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId") || "";
        const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
        const runs = runStore.list(projectId || null, limit).map((run) => {
            // 列表不带 body（可能很大），详情单独取
            const { body, builtBody, idempotencyKey, ...summary } = run;
            return { ...summary, hasBuiltBody: Boolean(builtBody) };
        });
        return sendJson(res, 200, { runs });
    }

    if (pathname === "/api/runs" && req.method === "POST") {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, 400, { error: "invalid_json", message: error.message });
        }
        const { projectId, nodeId, provider, endpoint } = body || {};
        if (!projectId || !provider || !endpoint) return sendJson(res, 400, { error: "missing_fields", hint: "需要 projectId / provider / endpoint" });
        // params 是画布语义（prompt/size/references…），由 daemon 按 family 转成 provider 契约；
        // 想直接控制请求体就传 params.rawBody。
        const run = engine.enqueue({ projectId, nodeId, provider, endpoint, body: body.params ?? body.body ?? {} });
        return sendJson(res, 200, { run });
    }

    const runMatch = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
    if (runMatch && req.method === "GET") {
        const run = runStore.get(runMatch[1]);
        if (!run) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, { run });
    }
    if (runMatch && req.method === "DELETE") {
        return sendJson(res, 200, { ok: runStore.remove(runMatch[1]) });
    }

    const retryMatch = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/retry$/);
    if (retryMatch && req.method === "POST") {
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
            const saved = store.saveProject(id, project);
            if (saved.stripped > 0) log(`project ${id}: 剥离 ${saved.stripped} 个 dataURL（资产层接管前暂不支持内联图片）`);
            const clientId = String(req.headers["x-canvas-client"] || url.searchParams.get("client") || "");
            broadcast({ type: "project.updated", id, rev: saved.rev, clientId });
            return sendJson(res, 200, { rev: saved.rev, dir: saved.dir });
        }
        if (req.method === "DELETE") {
            const removed = store.deleteProject(id);
            if (!removed) return sendJson(res, 404, { error: "not_found" });
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

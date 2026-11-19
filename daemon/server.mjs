// solgrid canvas daemon：只监听 127.0.0.1，零运行时依赖（Node 内置 http/sqlite/fs）
// M0 范围：项目目录存储 + 文档同步 + SSE 广播。run 引擎 / 资产 / ACP 在 M1/M2 接入。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createStore } from "./store.mjs";

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

process.on("SIGINT", () => {
    log("shutting down");
    server.close(() => process.exit(0));
});

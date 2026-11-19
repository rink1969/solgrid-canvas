// daemon 冒烟测试：起一个临时 daemon（独立 CANVAS_HOME），跑一遍读写/鉴权/剥离 dataURL，然后清理。
// 用法：node daemon/smoke.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 17399;
const TOKEN = "smoke-token";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-smoke-"));
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
    env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT), CANVAS_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
child.stderr.on("data", (chunk) => process.stderr.write(`[daemon:err] ${chunk}`));

const api = async (method, url, body, token = TOKEN) => {
    const response = await fetch(`${BASE}${url}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { "x-canvas-token": token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
};

const waitHealth = async () => {
    for (let i = 0; i < 50; i++) {
        try {
            const response = await fetch(`${BASE}/health`);
            if (response.ok) return;
        } catch {
            /* 还没起来 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("daemon 未启动");
};

let failed = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
};

try {
    await waitHealth();

    check("无 token 被拒", (await api("GET", "/api/projects", null, "")).status === 401);
    check("错误 token 被拒", (await api("GET", "/api/projects", null, "wrong")).status === 401);
    check("正确 token 可读", (await api("GET", "/api/projects")).status === 200);

    const project = {
        id: "smoke1",
        title: "冒烟画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        chatSessions: [],
        activeChatId: null,
        connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "n2" }],
        nodes: [
            { id: "n1", type: "text", title: "提示词", position: { x: 10, y: 20 }, width: 320, height: 200, metadata: { content: "一只猫" } },
            { id: "n2", type: "image", title: "结果", position: { x: 400, y: 20 }, width: 320, height: 320, metadata: { content: "data:image/png;base64,AAAAAAAA" } },
        ],
    };
    const put = await api("PUT", "/api/projects/smoke1", { project });
    check("保存项目", put.status === 200 && put.json?.rev === 1, JSON.stringify(put.json));

    const diskCanvas = JSON.parse(fs.readFileSync(path.join(HOME, "projects", "smoke1", "canvas.json"), "utf8"));
    check("canvas.json 是 JSON Canvas 结构", Array.isArray(diskCanvas.nodes) && Array.isArray(diskCanvas.edges) && diskCanvas["x-solgrid"]?.format === "solgrid-canvas/1");
    check("边被映射为 fromNode/toNode", diskCanvas.edges[0]?.fromNode === "n1" && diskCanvas.edges[0]?.toNode === "n2");
    check("dataURL 被剥离", !JSON.stringify(diskCanvas).includes("data:image"), JSON.stringify(diskCanvas.nodes[1]));
    check("文本节点带 text 字段", diskCanvas.nodes[0]?.text === "一只猫");

    const list = await api("GET", "/api/projects");
    check("列表返回 1 个项目", list.json?.projects?.length === 1);
    check("读回节点完整", list.json.projects[0].nodes.length === 2 && list.json.projects[0].connections.length === 1);
    check("读回 rev", list.json.projects[0].rev === 1);

    const removed = await api("DELETE", "/api/projects/smoke1");
    check("删除项目", removed.status === 200 && !fs.existsSync(path.join(HOME, "projects", "smoke1")));
    check("删除后列表为空", (await api("GET", "/api/projects")).json?.projects?.length === 0);

    check("路径穿越被拒", (await api("PUT", "/api/projects/..%2F..%2Fevil", { project })).status === 404);
} catch (error) {
    console.error("冒烟测试异常:", error);
    failed++;
} finally {
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exitCode = failed === 0 ? 0 : 1;
}

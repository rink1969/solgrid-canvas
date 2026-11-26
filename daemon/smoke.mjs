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
            { id: "n3", type: "image", title: "编辑结果", position: { x: 400, y: 400 }, width: 320, height: 320, metadata: { content: "blob:http://localhost:3000/73577af8", storageKey: "image:abc" } },
        ],
    };
    const put = await api("PUT", "/api/projects/smoke1", { project });
    check("保存项目", put.status === 200 && put.json?.rev === 1, JSON.stringify(put.json));

    const diskCanvas = JSON.parse(fs.readFileSync(path.join(HOME, "projects", "smoke1", "canvas.json"), "utf8"));
    check("canvas.json 是 JSON Canvas 结构", Array.isArray(diskCanvas.nodes) && Array.isArray(diskCanvas.edges) && diskCanvas["x-solgrid"]?.format === "solgrid-canvas/1");
    check("边被映射为 fromNode/toNode", diskCanvas.edges[0]?.fromNode === "n1" && diskCanvas.edges[0]?.toNode === "n2");
    check("dataURL 被剥离", !JSON.stringify(diskCanvas).includes("data:image"), JSON.stringify(diskCanvas.nodes[1]));
    check("blob URL 被剥离且保留 storageKey", !JSON.stringify(diskCanvas).includes("blob:") && diskCanvas.nodes[2]?.["x-solgrid"]?.metadata?.storageKey === "image:abc", JSON.stringify(diskCanvas.nodes[2]));
    check("文本节点带 text 字段", diskCanvas.nodes[0]?.text === "一只猫");

    const list = await api("GET", "/api/projects");
    check("列表返回 1 个项目", list.json?.projects?.length === 1);
    check("读回节点完整", list.json.projects[0].nodes.length === 3 && list.json.projects[0].connections.length === 1);
    check("读回 rev", list.json.projects[0].rev === 1);

    // ---- 增量 op ----
    const before = await api("GET", "/api/projects/smoke1");
    const beforeRev = before.json.project.rev;
    const badGeometryPut = await api("PUT", "/api/projects/smoke1", {
        expectRev: beforeRev,
        project: { ...before.json.project, nodes: [{ ...before.json.project.nodes[0], position: { x: "bad", y: 0 } }] },
    });
    check("全量保存也拒绝坏几何", badGeometryPut.status === 400, JSON.stringify(badGeometryPut.json).slice(0, 160));
    const overwriteWithoutRev = await api("PUT", "/api/projects/smoke1", { project: before.json.project });
    check("已有画布全量保存需要 expectRev", overwriteWithoutRev.status === 409, JSON.stringify(overwriteWithoutRev.json).slice(0, 160));
    const opsResult = await api("POST", "/api/projects/smoke1/ops", {
        ops: [
            { type: "add_node", node: { id: "n4", type: "text", title: "新节点", position: { x: 10, y: 600 }, width: 200, height: 100, metadata: { content: "op 新增" } } },
            { type: "update_node", id: "n1", patch: { title: "改名后", metadata: { content: "一只狗" } } },
            { type: "add_edge", edge: { id: "c2", fromNodeId: "n1", toNodeId: "n4" } },
            { type: "update_meta", patch: { title: "op 改标题" } },
        ],
        expectRev: beforeRev,
        origin: "agent",
    });
    check("op 批量应用", opsResult.status === 200 && opsResult.json.rev === beforeRev + 1, JSON.stringify(opsResult.json));
    const afterOps = await api("GET", "/api/projects/smoke1");
    check("op 结果落库", afterOps.json.project.nodes.length === 4 && afterOps.json.project.title === "op 改标题" && afterOps.json.project.nodes.find((n) => n.id === "n1").metadata.content === "一只狗", JSON.stringify(afterOps.json.project.title));
    check("op 连线落库", afterOps.json.project.connections.length === 2);

    const conflict = await api("POST", "/api/projects/smoke1/ops", { ops: [{ type: "update_meta", patch: { title: "冲突" } }], expectRev: 999 });
    check("expectRev 不匹配返回冲突", conflict.status === 409 && conflict.json.error === "rev_conflict", JSON.stringify(conflict.json));

    const opLog = await api("GET", "/api/projects/smoke1/ops");
    check("op 日志可查", opLog.json.ops?.length === 4 && opLog.json.ops[0].origin === "agent", JSON.stringify(opLog.json).slice(0, 200));

    const badOp = await api("POST", "/api/projects/smoke1/ops", { ops: [{ type: "unknown_op" }] });
    check("未知 op 被拒", badOp.status === 400 && badOp.json.error === "invalid_op");

    // ---- 资产：上传 / 去重 / 读取 / Range ----
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e621bc330000000049454e44ae426082", "hex");
    const uploadAsset = async (buffer, mime) => {
        const response = await fetch(`${BASE}/api/projects/smoke1/assets?mime=${encodeURIComponent(mime)}`, {
            method: "POST",
            headers: { "x-canvas-token": TOKEN, "content-type": mime },
            body: buffer,
        });
        return { status: response.status, json: await response.json() };
    };
    const first = await uploadAsset(png, "image/png");
    check("资产上传", first.status === 200 && /^[a-f0-9]{64}\.png$/.test(first.json.file), JSON.stringify(first.json));
    const second = await uploadAsset(png, "image/png");
    check("同内容去重", first.json.file === second.json.file);
    check("assets 目录有文件", fs.existsSync(path.join(HOME, "projects", "smoke1", "assets", first.json.file)));
    const assetResponse = await fetch(`${BASE}/api/projects/smoke1/assets/${first.json.file}`, { headers: { "x-canvas-token": TOKEN } });
    const assetBytes = Buffer.from(await assetResponse.arrayBuffer());
    check("资产读取", assetResponse.status === 200 && assetBytes.equals(png));
    const rangeResponse = await fetch(`${BASE}/api/projects/smoke1/assets/${first.json.file}`, { headers: { "x-canvas-token": TOKEN, range: "bytes=0-7" } });
    check("Range 请求", rangeResponse.status === 206 && (rangeResponse.headers.get("content-range") || "").startsWith("bytes 0-7/"));

    const orphanPath = path.join(HOME, "projects", "smoke1", "assets", first.json.file);
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphanPath, oldTime, oldTime);
    const gc = await api("POST", "/api/projects/smoke1/assets/gc", { minAgeHours: 1 });
    check("孤儿资产 GC", gc.status === 200 && gc.json.deleted >= 1 && !fs.existsSync(orphanPath), JSON.stringify(gc.json));

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

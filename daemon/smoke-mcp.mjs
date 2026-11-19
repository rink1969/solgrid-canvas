// MCP 冒烟：起临时 daemon + stdio MCP，跑一遍 初始化 / 工具列表 / 读写画布 / 布点 / 生成审批。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = 17397;
const TOKEN = "smoke-mcp";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-mcp-"));
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { "content-type": "application/json", "x-canvas-token": TOKEN };

const daemon = spawn(process.execPath, [path.join(here, "server.mjs")], {
    cwd: here,
    env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT), CANVAS_TOKEN: TOKEN, CANVAS_AUTO_APPROVE: "1", CANVAS_SOLGRID_BIN: path.join(here, "test", "fake-solgrid.mjs"), FAKE_STATE: path.join(HOME, "fake"), FAKE_POLLS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
});
daemon.stderr.on("data", (chunk) => {
    if (!/ExperimentalWarning/.test(String(chunk))) process.stderr.write(`[daemon:err] ${chunk}`);
});

const mcp = spawn(process.execPath, [path.join(here, "mcp.mjs")], {
    cwd: here,
    env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT), CANVAS_TOKEN: TOKEN, CANVAS_DAEMON_URL: BASE },
    stdio: ["pipe", "pipe", "pipe"],
});
mcp.stderr.on("data", (chunk) => process.stderr.write(`[mcp:err] ${chunk}`));

let buffer = "";
let nextId = 1;
const waiting = new Map();
mcp.stdout.on("data", (chunk) => {
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
        if (message.id && waiting.has(message.id)) {
            waiting.get(message.id)(message);
            waiting.delete(message.id);
        }
    }
});

function rpc(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    mcp.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 20000);
        waiting.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
        });
    });
}

function notify(method) {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

async function call(name, args) {
    const response = await rpc("tools/call", { name, arguments: args });
    const text = response.result?.content?.[0]?.text || "";
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { isError: Boolean(response.result?.isError), data, raw: response };
}

const waitHealth = async () => {
    for (let i = 0; i < 60; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) return;
        } catch {
            /* 还没起 */
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

const TINY_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e621bc330000000049454e44ae426082", "hex");

try {
    await waitHealth();

    // 准备一个画布 + 锚点节点
    await fetch(`${BASE}/api/projects/mcpproj`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
            project: {
                id: "mcpproj",
                title: "MCP 冒烟",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                backgroundMode: "lines",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                chatSessions: [],
                activeChatId: null,
                connections: [],
                nodes: [{ id: "anchor", type: "image", title: "视频截图", position: { x: 0, y: 0 }, width: 320, height: 200, metadata: { provider: "alibaba", endpoint: "/v1/image/qwen-image-3.0", prompt: "锚点" } }],
            },
        }),
    });

    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
    check("initialize 返回 serverInfo", init.result?.serverInfo?.name === "solgrid-canvas", JSON.stringify(init).slice(0, 200));
    notify("notifications/initialized");

    const tools = await rpc("tools/list", {});
    const names = (tools.result?.tools || []).map((tool) => tool.name);
    check("工具数 >= 10", names.length >= 10, String(names.length));
    check("包含关键工具", ["canvas_get_state", "canvas_apply_ops", "canvas_place_artifacts", "canvas_run_nodes", "canvas_watch_run"].every((name) => names.includes(name)));

    const projects = await call("canvas_list_projects", {});
    check("list_projects 能看到项目", projects.data.some((item) => item.id === "mcpproj"));

    const state = await call("canvas_get_state", { projectId: "mcpproj" });
    check("get_state 返回节点", state.data?.nodes?.some((node) => node.id === "anchor"));

    const applied = await call("canvas_apply_ops", {
        projectId: "mcpproj",
        ops: [{ type: "update_node", id: "anchor", patch: { metadata: { prompt: "被 MCP 改过" } } }],
        expectRev: state.data.project.rev,
    });
    check("apply_ops 生效", !applied.isError && applied.data.rev > state.data.project.rev, JSON.stringify(applied.data));

    const pngPath = path.join(HOME, "frame.png");
    fs.writeFileSync(pngPath, TINY_PNG);
    const placed = await call("canvas_place_artifacts", {
        projectId: "mcpproj",
        anchorNodeId: "anchor",
        items: [
            { kind: "image", path: pngPath, title: "关键帧 1" },
            { kind: "text", text: "这是分镜说明", title: "分镜表" },
        ],
    });
    check("place_artifacts 创建节点", !placed.isError && placed.data.created?.length === 2, JSON.stringify(placed.data).slice(0, 300));
    const afterPlace = await call("canvas_get_state", { projectId: "mcpproj" });
    const image = afterPlace.data.nodes.find((node) => node.title === "关键帧 1");
    const text = afterPlace.data.nodes.find((node) => node.title === "分镜表");
    check("图片节点在锚点右侧", image && image.x > 320, JSON.stringify(image));
    check("文本节点在图片右侧（分列）", text && text.x > image.x, JSON.stringify({ image: image?.x, text: text?.x }));
    check("产物自动连线", afterPlace.data.connections.filter((edge) => edge.fromNodeId === "anchor").length === 2);

    const run = await call("canvas_run_nodes", { projectId: "mcpproj", nodeId: "anchor", approvalTimeoutSeconds: 20 });
    check("run_nodes 经审批后返回 runId", !run.isError && typeof run.data?.runId === "string", JSON.stringify(run.data).slice(0, 300));
    if (run.data?.runId) {
        const watched = await call("canvas_watch_run", { runId: run.data.runId, timeoutSeconds: 30 });
        check("watch_run 拿到产物", !watched.isError && watched.data.status === "completed" && watched.data.outputs?.length === 1, JSON.stringify(watched.data).slice(0, 300));
    }
} catch (error) {
    console.error("冒烟测试异常:", error);
    failed++;
} finally {
    mcp.kill();
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exitCode = failed === 0 ? 0 : 1;
}

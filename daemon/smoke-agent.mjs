// ACP 冒烟：临时 daemon + 真实 DSH ACP agent，验证 会话建立 / 模型切换 / prompt / transcript。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = 17394;
const TOKEN = "smoke-acp";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-acp-"));
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { "content-type": "application/json", "x-canvas-token": TOKEN };

const daemon = spawn(process.execPath, [path.join(here, "server.mjs")], {
    cwd: here,
    env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT), CANVAS_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
});
daemon.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
daemon.stderr.on("data", (chunk) => {
    if (!/ExperimentalWarning/.test(String(chunk))) process.stderr.write(`[daemon:err] ${chunk}`);
});

const api = async (pathname, init) => {
    const response = await fetch(`${BASE}${pathname}`, { ...init, headers });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
};

let failed = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
};

try {
    for (let i = 0; i < 60; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) break;
        } catch {
            /* 等启动 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await api("/api/projects/acpproj", {
        method: "PUT",
        body: JSON.stringify({
            project: {
                id: "acpproj",
                title: "ACP 冒烟",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                backgroundMode: "lines",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                chatSessions: [],
                activeChatId: null,
                connections: [],
                nodes: [],
            },
        }),
    });

    const status = await api("/api/agent/status");
    check("检测到 ACP 适配器", status.json?.available === true && status.json.adapter === "dsh", JSON.stringify(status.json));

    const started = await api("/api/agent/start", { method: "POST", body: JSON.stringify({ projectId: "acpproj" }) });
    check("建立 ACP 会话", Boolean(started.json?.sessionId), JSON.stringify(started.json).slice(0, 200));

    const options = started.json?.configOptions || [];
    const model = options.find((option) => option.id === "model");
    check("默认模型来自 ACP profile 同步", String(model?.currentValue || "").includes("deepseek-account"), String(model?.currentValue));
    const account = model?.options?.flatMap((group) => group.options || []).find((option) => option.value.includes("deepseek-account"));
    if (account) {
        const changed = await api("/api/agent/model", { method: "POST", body: JSON.stringify({ projectId: "acpproj", configId: "model", value: account.value }) });
        check("切换模型路由", Boolean(changed.json?.configOptions), JSON.stringify(changed.json).slice(0, 150));
    }

    await api("/api/agent/prompt", { method: "POST", body: JSON.stringify({ projectId: "acpproj", text: "只回答一句话：你当前可用的工具里有没有以 mcp__solgrid_canvas 开头的？不要调用工具、不要读写文件。" }) });

    let transcript = [];
    for (let i = 0; i < 90; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const payload = await api("/api/agent/transcript?projectId=acpproj");
        transcript = payload.json?.transcript || [];
        const assistant = transcript.filter((item) => item.role === "assistant").map((item) => item.text).join("");
        if (assistant.includes("有") || assistant.length > 10) break;
    }
    const assistantText = transcript.filter((item) => item.role === "assistant").map((item) => item.text).join("");
    check("拿到 Agent 回复", assistantText.length > 0, assistantText.slice(0, 120));
    check("Agent 能看到 canvas MCP 工具", /mcp__solgrid_canvas|canvas_get_state|canvas_run_nodes/.test(assistantText), assistantText.slice(0, 160));
} catch (error) {
    console.error("冒烟测试异常:", error);
    failed++;
} finally {
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exitCode = failed === 0 ? 0 : 1;
}

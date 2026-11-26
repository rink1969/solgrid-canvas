// ACP 多对话冒烟：同一画布两个对话隔离、重启后持久化、删除。
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
const PROJECT = "acpproj";

function spawnDaemon() {
    const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
        cwd: here,
        env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT), CANVAS_TOKEN: TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
    child.stderr.on("data", (chunk) => {
        if (!/ExperimentalWarning/.test(String(chunk))) process.stderr.write(`[daemon:err] ${chunk}`);
    });
    return child;
}

let daemon = spawnDaemon();

const api = async (pathname, init) => {
    const response = await fetch(`${BASE}${pathname}`, { ...init, headers });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
};

const post = (pathname, body) => api(pathname, { method: "POST", body: JSON.stringify(body ?? {}) });

let failed = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
};

async function waitHealth() {
    for (let i = 0; i < 80; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) return;
        } catch {
            /* 等启动 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("daemon 未启动");
}

async function waitAssistant(projectId, conversationId, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const result = await api(`/api/projects/${projectId}/agent/conversations/${conversationId}/transcript`);
        const transcript = result.json?.transcript || [];
        const text = transcript.filter((item) => item.role === "assistant").map((item) => item.text).join("");
        if (text.trim()) return { transcript, text };
    }
    return { transcript: [], text: "" };
}

try {
    await waitHealth();
    await api(`/api/projects/${PROJECT}`, {
        method: "PUT",
        body: JSON.stringify({
            project: {
                id: PROJECT,
                title: "ACP 多对话冒烟",
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

    const empty = await api(`/api/projects/${PROJECT}/agent/conversations`);
    check("新画布对话列表为空", Array.isArray(empty.json?.conversations) && empty.json.conversations.length === 0);

    const createdA = await post(`/api/projects/${PROJECT}/agent/conversations`, { title: "对话 A" });
    const conversationA = createdA.json?.conversation;
    check("创建对话 A", Boolean(conversationA?.id), JSON.stringify(createdA.json).slice(0, 160));

    const preparedA = await post(`/api/projects/${PROJECT}/agent/conversations/${conversationA.id}/prepare`, {});
    check("prepare 返回模型 configOptions", preparedA.status === 200 && Array.isArray(preparedA.json?.conversation?.configOptions), JSON.stringify(preparedA.json).slice(0, 200));

    const promptA = await post(`/api/projects/${PROJECT}/agent/conversations/${conversationA.id}/prompt`, { text: "只回复两个字：收到A" });
    check("对话 A 提交成功", promptA.status === 200, JSON.stringify(promptA.json).slice(0, 160));
    const replyA = await waitAssistant(PROJECT, conversationA.id);
    check("对话 A 拿到回复", replyA.text.length > 0, replyA.text.slice(0, 60));

    const createdB = await post(`/api/projects/${PROJECT}/agent/conversations`, { title: "对话 B" });
    const conversationB = createdB.json?.conversation;
    check("创建对话 B", Boolean(conversationB?.id) && conversationB.id !== conversationA.id);
    await post(`/api/projects/${PROJECT}/agent/conversations/${conversationB.id}/prompt`, { text: "只回复两个字：收到B" });
    const replyB = await waitAssistant(PROJECT, conversationB.id);
    check("对话 B 拿到回复", replyB.text.length > 0, replyB.text.slice(0, 60));
    check("对话 A 不含 B 的内容", !replyA.text.includes("收到B") && !replyB.text.includes("收到A"), `A=${replyA.text.slice(0, 40)} B=${replyB.text.slice(0, 40)}`);

    const listed = await api(`/api/projects/${PROJECT}/agent/conversations`);
    check("列表包含两个对话", listed.json?.conversations?.length === 2, JSON.stringify(listed.json?.conversations?.map((item) => item.title)));
    check("列表带对话预览", listed.json?.conversations?.some((item) => String(item.preview || "").includes("收到A")), JSON.stringify(listed.json?.conversations?.map((item) => item.preview)));

    // 重启 daemon：对话与 transcript 都要保留
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    daemon = spawnDaemon();
    await waitHealth();
    const afterRestart = await api(`/api/projects/${PROJECT}/agent/conversations`);
    check("重启后对话列表保留", afterRestart.json?.conversations?.length === 2);
    const persistedA = await api(`/api/projects/${PROJECT}/agent/conversations/${conversationA.id}/transcript`);
    check("重启后 transcript 保留", (persistedA.json?.transcript || []).some((item) => item.role === "assistant" && item.text), JSON.stringify(persistedA.json?.transcript?.length));

    const deleted = await api(`/api/projects/${PROJECT}/agent/conversations/${conversationB.id}`, { method: "DELETE" });
    check("删除对话 B", deleted.status === 200 && deleted.json?.ok === true);
    const finalList = await api(`/api/projects/${PROJECT}/agent/conversations`);
    check("删除后只剩一个对话", finalList.json?.conversations?.length === 1);
} catch (error) {
    console.error("冒烟测试异常:", error);
    failed++;
} finally {
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
        fs.rmSync(HOME, { recursive: true, force: true });
    } catch {
        /* 临时目录可能被占用 */
    }
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exitCode = failed === 0 ? 0 : 1;
}

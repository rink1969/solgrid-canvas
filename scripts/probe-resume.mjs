// 探测 ACP session/resume：同一 sessionId 在进程重启后能否恢复。
import { spawn } from "node:child_process";

const EXE = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const BIN = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const PROJECT = "D:\\data\\dsh-workspace\\solgrid-canvas";

function run(script) {
    return new Promise((resolve, reject) => {
        const child = spawn(EXE, [BIN, "--profile", "acp"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
        let buffer = "";
        const waiting = new Map();
        let nextId = 1;
        child.stdout.on("data", (chunk) => {
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
        child.stderr.on("data", () => undefined);
        const request = (method, params) => {
            const id = nextId++;
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
            return new Promise((res, rej) => {
                const timer = setTimeout(() => rej(new Error(`${method} 超时`)), 20000);
                waiting.set(id, (message) => {
                    clearTimeout(timer);
                    message.error ? rej(new Error(`${method}: ${message.error.message}`)) : res(message.result);
                });
            });
        };
        script({ request, close: () => child.kill() }).then(resolve, reject).finally(() => child.kill());
    });
}

let sessionId = null;
await run(async ({ request, close }) => {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "probe", version: "0" } });
    const session = await request("session/new", { cwd: PROJECT, mcpServers: [] });
    sessionId = session.sessionId;
    console.log("new:", sessionId, "| model:", session.configOptions?.[0]?.currentValue);
    close();
});

await new Promise((resolve) => setTimeout(resolve, 1500));

try {
    await run(async ({ request }) => {
        await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "probe", version: "0" } });
        for (const params of [
            { sessionId, cwd: PROJECT, mcpServers: [] },
            { sessionId },
        ]) {
            try {
                const resumed = await request("session/resume", params);
                console.log("resume ok:", JSON.stringify(resumed).slice(0, 300));
                return;
            } catch (error) {
                console.log("resume variant failed:", error.message.slice(0, 160));
            }
        }
    });
} catch (error) {
    console.log("resume 全部失败:", error.message);
}

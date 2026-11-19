// 手工探测 DSH 的 ACP 端点：启动 dsh --profile acp，发 initialize / session/new，看能否拿到响应。
import { spawn } from "node:child_process";

const EXE = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const BIN = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";

const child = spawn(EXE, [BIN, "--profile", "acp"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        console.log("[stdout]", line.slice(0, 600));
    }
    buffer = "";
});
child.stderr.on("data", (chunk) => process.stderr.write(`[stderr] ${chunk}`));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

setTimeout(() => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientCapabilities: {}, clientInfo: { name: "probe", version: "0" } } });
}, 800);
setTimeout(() => {
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "D:\\data\\dsh-workspace\\solgrid-canvas", mcpServers: [] } });
}, 4000);
setTimeout(() => {
    child.kill();
    process.exit(0);
}, 9000);

// 探测 ACP：initialize(number) → session/new(注入 canvas MCP) → prompt，观察 session/update。
import { spawn } from "node:child_process";

const EXE = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const BIN = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const PROJECT = "D:\\data\\dsh-workspace\\solgrid-canvas";
const MCP = `${PROJECT}\\daemon\\mcp.mjs`;
const NODE = process.execPath;

const variant = process.argv[2] || "plain";
const server =
    variant === "typed"
        ? { type: "stdio", name: "solgrid_canvas", command: NODE, args: [MCP], env: [] }
        : variant === "envpair"
          ? { name: "solgrid_canvas", command: NODE, args: [MCP], env: [{ name: "CANVAS_PORT", value: "17371" }] }
          : { name: "solgrid_canvas", command: NODE, args: [MCP] };

const child = spawn(EXE, [BIN, "--profile", "acp"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let sessionId = null;
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
        if (message.error) {
            console.log("[error]", message.id, JSON.stringify(message.error).slice(0, 400));
            continue;
        }
        if (message.method === "session/update") {
            const kind = message.params?.update?.sessionUpdate || message.params?.update?.type || "?";
            const text = JSON.stringify(message.params?.update).slice(0, 200);
            console.log("[update]", kind, text);
            continue;
        }
        if (message.method === "session/request_permission") {
            console.log("[permission]", JSON.stringify(message.params).slice(0, 300));
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: message.params?.options?.[0]?.optionId } } })}\n`);
            continue;
        }
        if (message.result?.sessionId) {
            sessionId = message.result.sessionId;
            console.log("[session]", sessionId, "| configOptions:", JSON.stringify(message.result.configOptions || []).slice(0, 200));
            // 切到本地已登录的 deepseek-account 路由，否则默认 route 没有 key
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/set_config_option", params: { sessionId, configId: "model", value: JSON.stringify(["deepseek-account", "deepseek-flash"]) } })}\n`);
            continue;
        }
        if (message.id === 4) {
            console.log("[model]", JSON.stringify(message.result).slice(0, 150));
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "只回答一句话：你当前可用的工具里，有没有以 mcp__solgrid_canvas 开头的？不要调用任何工具、不要读写文件。" }] } })}\n`);
            continue;
        }
        console.log("[result]", message.id, JSON.stringify(message.result).slice(0, 200));
    }
});
child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (!/ExperimentalWarning|Debugger/.test(text)) process.stderr.write(`[stderr] ${text.slice(0, 300)}`);
});

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "probe", version: "0" } } })}\n`);
setTimeout(() => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: PROJECT, mcpServers: [server] } })}\n`);
}, 2500);
setTimeout(() => {
    child.kill();
    process.exit(0);
}, 40000);

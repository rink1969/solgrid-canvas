// 探测 ACP 会话是否能看到/加载 skills。
import { spawn } from "node:child_process";

const EXE = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const BIN = "C:\\Users\\rink1\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const PROJECT = "D:\\data\\dsh-workspace\\solgrid-canvas";

const prompt = process.argv[2] || "只回答：你当前可用的 skill 名称有哪些？用逗号分隔，不要调用工具、不要读写文件。";

const child = spawn(EXE, [BIN, "--profile", "acp"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let sessionId = null;
let answer = "";

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
            console.log("[error]", JSON.stringify(message.error).slice(0, 300));
            continue;
        }
        if (message.method === "session/update") {
            const update = message.params?.update || {};
            if ((update.sessionUpdate || update.type) === "agent_message_chunk") answer += update.content?.text || "";
            continue;
        }
        if (message.method === "session/request_permission") {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: message.params?.options?.[0]?.optionId } } })}\n`);
            continue;
        }
        if (message.result?.sessionId) {
            sessionId = message.result.sessionId;
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/set_config_option", params: { sessionId, configId: "model", value: JSON.stringify(["deepseek-account", "deepseek-flash"]) } })}\n`);
            continue;
        }
        if (message.id === 4) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } })}\n`);
            continue;
        }
        if (message.id === 3) {
            console.log("\n[assistant]", answer.trim().slice(0, 800));
            child.kill();
            process.exit(0);
        }
    }
});
child.stderr.on("data", (chunk) => {
    if (!/ExperimentalWarning|model listing/i.test(String(chunk))) process.stderr.write(`[stderr] ${String(chunk).slice(0, 200)}`);
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "probe", version: "0" } } })}\n`);
setTimeout(() => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: PROJECT, mcpServers: [] } })}\n`), 2500);
setTimeout(() => {
    console.log("\n[timeout]", answer.slice(0, 400));
    child.kill();
    process.exit(1);
}, 60000);

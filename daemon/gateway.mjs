// solgrid CLI 适配层：daemon 不复制网关协议，所有调用都走本机 solgrid CLI。
// 约定（见 AGENTS.md 架构铁律 4）：提交不带 --wait，拿到 runId 后自己轮询 runs get。
import { spawn } from "node:child_process";
import path from "node:path";

const TIMEOUTS = { run: 180_000, get: 60_000, stop: 30_000, discover: 60_000, inspect: 60_000 };

function resolveBinary() {
    const configured = process.env.CANVAS_SOLGRID_BIN || "solgrid";
    // 测试/自托管场景允许直接指向一个 .mjs 脚本（用当前 node 执行，避免 Windows 上的 .cmd 问题）
    if (/\.(mjs|js|cjs)$/i.test(configured)) return { command: process.execPath, prefix: [configured], script: true };
    return { command: configured, prefix: [], script: false };
}

function quote(value) {
    return /[\s"&|<>^]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
}

// 进入命令行之前先卡死形状：只允许目录/模型标识这类安全字符，free-text 查询去掉 cmd 展开符
const SAFE_TOKEN = /^[A-Za-z0-9._/:-]{1,200}$/;
function assertSafe(value, name) {
    if (!SAFE_TOKEN.test(String(value || ""))) throw new Error(`${name} 含非法字符`);
    return String(value);
}
function sanitizeQuery(value) {
    return String(value || "").replace(/[%\r\n\t]/g, " ").trim().slice(0, 200);
}

function runCli(args, timeoutMs) {
    const { command, prefix, script } = resolveBinary();
    const fullArgs = [...prefix, ...args];
    return new Promise((resolve, reject) => {
        // Windows 上 solgrid 是 .cmd，必须经 shell；用「单条命令字符串 + 严格字符校验」避免参数注入
        const useShell = !script && process.platform === "win32";
        const child = useShell
            ? spawn([command, ...fullArgs.map(quote)].join(" "), { shell: true, windowsHide: true, env: process.env })
            : spawn(command, fullArgs, { windowsHide: true, env: process.env });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`solgrid ${args[0]} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`无法执行 solgrid（${command}）：${error.message}`));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

// CLI 的 -j 输出是纯 JSON；出错时也可能带一段 JSON（含 error / idempotencyKey）
export function parseJsonLoose(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start === -1 || end <= start) return null;
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}

function unwrap(json) {
    if (!json || typeof json !== "object") return {};
    // 兼容 {success,data:{...}} 与直接返回
    return json.data && typeof json.data === "object" ? json.data : json;
}

function pickRunId(json) {
    const value = unwrap(json);
    return value.id || value.runId || value.run?.id || null;
}

function pickStatus(json) {
    const value = unwrap(json);
    return value.status || value.run?.status || "";
}

function pickError(json) {
    const value = unwrap(json);
    const error = value.error || value;
    return { code: error?.code || error?.errorCode || "", message: error?.message || error?.errorMessage || "" };
}

async function callCli(args, timeoutKey) {
    const result = await runCli(args, TIMEOUTS[timeoutKey]);
    const json = parseJsonLoose(result.stdout) || parseJsonLoose(result.stderr);
    if (result.code !== 0) {
        const { code, message } = pickError(json);
        const error = new Error(message || `solgrid 退出码 ${result.code}${result.stderr ? `: ${result.stderr.slice(0, 300)}` : ""}`);
        error.code = code;
        error.idempotencyKey = json?.idempotencyKey;
        error.remoteRunId = pickRunId(json);
        throw error;
    }
    return json;
}

export function createGateway() {
    return {
        available() {
            return runCli(["--version"], 20_000)
                .then((result) => result.code === 0)
                .catch(() => false);
        },
        async runTool({ provider, endpoint, bodyPath, idempotencyKey }) {
            assertSafe(provider, "provider");
            assertSafe(endpoint, "endpoint");
            assertSafe(idempotencyKey, "idempotencyKey");
            const json = await callCli(["run", "-p", provider, "-e", endpoint, "-f", bodyPath, "--idempotency-key", idempotencyKey, "-j"], "run");
            const remoteRunId = pickRunId(json);
            if (!remoteRunId) throw new Error("solgrid run 未返回 runId");
            return { remoteRunId, status: pickStatus(json), raw: unwrap(json) };
        },
        async getRun(remoteRunId) {
            assertSafe(remoteRunId, "runId");
            const json = await callCli(["runs", "get", "-r", remoteRunId, "-j"], "get");
            return { status: pickStatus(json), raw: unwrap(json) };
        },
        async getRunByKey(idempotencyKey) {
            assertSafe(idempotencyKey, "idempotencyKey");
            const json = await callCli(["runs", "get", "--idempotency-key", idempotencyKey, "-j"], "get");
            return { remoteRunId: pickRunId(json), status: pickStatus(json), raw: unwrap(json) };
        },
        async stopRun(remoteRunId) {
            assertSafe(remoteRunId, "runId");
            return callCli(["runs", "stop", "-r", remoteRunId, "-j"], "stop");
        },
        async discover(query, limit = 20) {
            const json = await callCli(["discover", "-q", sanitizeQuery(query), "-l", String(limit), "-j"], "discover");
            return unwrap(json).results || [];
        },
        async inspect(provider, endpoint) {
            assertSafe(provider, "provider");
            assertSafe(endpoint, "endpoint");
            const json = await callCli(["inspect", "-p", provider, "-e", endpoint, "-j"], "inspect");
            return unwrap(json);
        },
    };
}

export function pickOutputs(raw) {
    const output = raw?.output || raw?.run?.output || {};
    const candidates = [...(output.images || []), ...(output.videos || []), ...(output.files || []), ...(output.audios || [])];
    const items = [];
    for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        if (item.base64) items.push({ base64: item.base64, mime: item.mime || item.mimeType || "image/png" });
        else if (item.url) items.push({ url: item.url, mime: item.mime || item.mimeType || "application/octet-stream" });
    }
    return items;
}

export function pickCost(raw) {
    const value = unwrap(raw);
    const cost = typeof value.cost === "number" ? value.cost : typeof value.run?.cost === "number" ? value.run.cost : null;
    return { cost, billingStatus: value.billingStatus || value.run?.billingStatus || "" };
}

export function tempBodyPath(dir, key) {
    return path.join(dir, `run-${key}.json`);
}

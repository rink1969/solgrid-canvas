// 测试用的假 solgrid CLI：不联网、不花钱，行为对齐 daemon 依赖的那几条命令。
// state 目录由 FAKE_STATE 指定；FAKE_POLLS 控制第几次查询返回 COMPLETED。
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.FAKE_STATE || path.join(process.cwd(), ".fake-solgrid");
const pollLimit = Number(process.env.FAKE_POLLS || 1);
fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
fs.mkdirSync(path.join(stateDir, "keys"), { recursive: true });
fs.mkdirSync(path.join(stateDir, "bodies"), { recursive: true });
fs.mkdirSync(path.join(stateDir, "uploads"), { recursive: true });

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

const argv = process.argv.slice(2);
const command = argv[0];
if (command === "tools") {
    fs.appendFileSync(path.join(stateDir, "tools-calls.log"), `${argv.slice(0, 2).join(" ")}\n`);
}
const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
};

function emit(value, code = 0) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exit(code);
}

function readRun(id) {
    const file = path.join(stateDir, "runs", `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function writeRun(run) {
    fs.writeFileSync(path.join(stateDir, "runs", `${run.id}.json`), JSON.stringify(run));
}

if (command === "--version") emit({ version: "fake-0.0.1" });

if (command === "run") {
    if (process.env.FAKE_FAIL_SUBMIT) emit({ error: { code: "tool_service_unavailable", message: "fake submit failure" } }, 1);
    const id = `fake-${Date.now()}`;
    const key = flag("--idempotency-key");
    // 把 daemon 生成的请求体留档，冒烟测试据此校验 family 映射
    const inputFile = flag("-f");
    if (inputFile && fs.existsSync(inputFile)) fs.copyFileSync(inputFile, path.join(stateDir, "bodies", `${id}.json`));
    writeRun({ id, polls: 0, key, endpoint: flag("-e"), bodyFile: inputFile && fs.existsSync(inputFile) ? `${id}.json` : null });
    if (key) fs.writeFileSync(path.join(stateDir, "keys", key), id);
    emit({ id, status: "READY", idempotencyKey: key });
}

if (command === "runs" && argv[1] === "get") {
    const runId = flag("-r");
    const key = flag("--idempotency-key");
    let id = runId;
    if (!id && key) {
        const file = path.join(stateDir, "keys", key);
        if (!fs.existsSync(file)) emit({ error: { code: "tool_run_not_found", message: "not found" } }, 1);
        id = fs.readFileSync(file, "utf8");
    }
    const run = readRun(id);
    if (!run) emit({ error: { code: "tool_run_not_found", message: "not found" } }, 1);
    run.polls += 1;
    writeRun(run);
    if (run.polls <= pollLimit) emit({ id, status: "RUNNING", cost: null });
    const isAudio = /t2a|text-to-speech|stable-audio/.test(String(run.endpoint || ""));
    let count = 1;
    if (run.bodyFile) {
        try {
            const body = JSON.parse(fs.readFileSync(path.join(stateDir, "bodies", run.bodyFile), "utf8"));
            count = Math.max(1, Math.min(6, Number(body?.parameters?.n) || 1));
        } catch {
            count = 1;
        }
    }
    emit({
        id,
        status: "COMPLETED",
        cost: 3.9,
        billingStatus: "SETTLED",
        output: isAudio ? { audio: `49443303${"00".repeat(400)}` } : { images: Array.from({ length: count }, () => ({ base64: TINY_PNG, mime: "image/png" })) },
    });
}

if (command === "runs" && argv[1] === "stop") emit({ id: flag("-r"), status: "STOPPED" });

if (command === "files" && argv[1] === "upload") {
    const file = argv[2];
    const name = path.basename(String(file));
    if (file && fs.existsSync(file)) fs.copyFileSync(file, path.join(stateDir, "uploads", name));
    emit({ downloadUrl: `https://fake.local/${encodeURIComponent(name)}` });
}

const FAKE_TOOLS = [
    { provider: "fake", providerName: "Fake", endpoint: "/v1/fake-image", displayName: "fake-image", description: "fake image tool", price: { type: "PER_CALL", amount: { value: "3.9", currency: "Spark" } }, categories: ["image"], tags: ["image"], invocationEnabled: true },
    { provider: "fake", providerName: "Fake", endpoint: "/v1/video/fake", displayName: "fake-video", description: "fake video tool", price: { type: "PER_CALL", amount: { value: "9", currency: "Spark" } }, categories: ["video"], tags: ["video"], invocationEnabled: true },
    { provider: "fake", providerName: "Fake", endpoint: "/v1/image/magic-hour-ai-gif", displayName: "fake-gif", description: "fake multi-category tool", price: { type: "PER_CALL", amount: { value: "4", currency: "Spark" } }, categories: ["video", "image"], tags: ["video", "image"], invocationEnabled: true },
    { provider: "fake", providerName: "Fake", endpoint: "/v1/text-to-speech", displayName: "fake-tts", description: "fake speech tool", price: { type: "PER_CALL", amount: { value: "1", currency: "Spark" } }, categories: ["speech"], tags: ["audio"], invocationEnabled: true },
    { provider: "fake", providerName: "Fake", endpoint: "/v1/music", displayName: "fake-music", description: "fake music tool", price: { type: "PER_CALL", amount: { value: "2", currency: "Spark" } }, categories: ["music"], tags: ["audio"], invocationEnabled: true },
];

if (command === "tools" && argv[1] === "categories") {
    const counts = {};
    for (const tool of FAKE_TOOLS) for (const category of tool.categories) counts[category] = (counts[category] || 0) + 1;
    emit({ items: Object.entries(counts).map(([code, total]) => ({ code, total, names: { zh: code, en: code } })) });
}

if (command === "tools" && argv[1] === "list") {
    const category = flag("-c");
    const query = String(flag("-q") || "").toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(flag("-l")) || 20));
    const page = Math.max(1, Number(flag("--page")) || 1);
    const filtered = FAKE_TOOLS.filter((tool) => (!category || tool.categories.includes(category)) && (!query || `${tool.provider} ${tool.endpoint} ${tool.description}`.toLowerCase().includes(query)));
    const start = (page - 1) * limit;
    emit({ items: filtered.slice(start, start + limit), pageIndex: page, pageSize: limit, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / limit)) });
}

if (command === "inspect") {
    emit({
        provider: flag("-p"),
        endpoint: flag("-e"),
        input: { body: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
        price: { type: "PER_CALL", amount: { value: "3.9", currency: "Spark" } },
    });
}

process.stderr.write(`fake-solgrid: 未实现的命令 ${argv.join(" ")}\n`);
process.exit(1);

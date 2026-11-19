// run 引擎冒烟测试：用假 CLI 跑通 提交 → 轮询 → 产物落地 → 账本/目录校验。
// 用法：node daemon/smoke-runs.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = 17398;
const TOKEN = "smoke-runs-token";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-runs-"));
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    cwd: here,
    env: {
        ...process.env,
        CANVAS_HOME: HOME,
        CANVAS_PORT: String(PORT),
        CANVAS_TOKEN: TOKEN,
        CANVAS_SOLGRID_BIN: path.join(here, "test", "fake-solgrid.mjs"),
        FAKE_STATE: path.join(HOME, "fake-state"),
        FAKE_POLLS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
child.stderr.on("data", (chunk) => process.stderr.write(`[daemon:err] ${chunk}`));

const headers = { "content-type": "application/json", "x-canvas-token": TOKEN };

async function waitHealth() {
    for (let i = 0; i < 60; i++) {
        try {
            const response = await fetch(`${BASE}/health`);
            if (response.ok) return;
        } catch {
            /* 还没起来 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("daemon 未启动");
}

let failed = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
};

try {
    await waitHealth();

    // 工具目录
    const tools = await fetch(`${BASE}/api/tools?q=image`, { headers }).then((r) => r.json());
    check("discover 返回候选", tools.results?.[0]?.endpoint === "/v1/fake-image", JSON.stringify(tools).slice(0, 200));
    const toolsCached = await fetch(`${BASE}/api/tools?q=image`, { headers }).then((r) => r.json());
    check("discover 走缓存", toolsCached.results?.[0]?.endpoint === "/v1/fake-image");
    const detail = await fetch(`${BASE}/api/tools/detail?provider=fake&endpoint=/v1/fake-image`, { headers }).then((r) => r.json());
    check("inspect 返回 schema", detail.detail?.input?.body?.properties?.prompt?.type === "string");

    // 提交 run
    const created = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", nodeId: "node1", provider: "fake", endpoint: "/v1/fake-image", body: { prompt: "a cat" } }),
    }).then((r) => r.json());
    check("提交 run 返回 queued", created.run?.status === "queued" && !!created.run?.idempotencyKey, JSON.stringify(created).slice(0, 200));

    // 等它完成
    let run = null;
    for (let i = 0; i < 80; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const response = await fetch(`${BASE}/api/runs/${created.run.id}`, { headers });
        const payload = await response.json();
        run = payload.run;
        if (run && ["completed", "failed", "uncertain", "stopped"].includes(run.status)) break;
    }
    check("run 完成", run?.status === "completed", JSON.stringify(run).slice(0, 300));
    check("记账 cost", run?.costSpark === 3.9 && run?.billingStatus === "SETTLED");
    check("产物已落地", Array.isArray(run?.outputs) && run.outputs.length === 1 && run.outputs[0].storageKey.startsWith("asset:smokeproj/"), JSON.stringify(run?.outputs));
    const outputFile = path.join(HOME, "projects", "smokeproj", "assets", run.outputs[0].file);
    check("产物文件存在", fs.existsSync(outputFile), outputFile);
    check("产物 storageKey 可拼地址", run.outputs[0].url === `/api/projects/smokeproj/assets/${run.outputs[0].file}`);

    // 列表与取消
    const list = await fetch(`${BASE}/api/runs?projectId=smokeproj`, { headers }).then((r) => r.json());
    check("run 列表", list.runs?.length === 1 && list.runs[0].id === run.id);

    const cancelTarget = await fetch(`${BASE}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "smokeproj", provider: "fake", endpoint: "/v1/fake-image", body: { prompt: "second" } }),
    }).then((r) => r.json());
    const cancelled = await fetch(`${BASE}/api/runs/${cancelTarget.run.id}/cancel`, { method: "POST", headers }).then((r) => r.json());
    check("取消 run", ["stopped", "failed"].includes(cancelled.run?.status), JSON.stringify(cancelled).slice(0, 200));
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

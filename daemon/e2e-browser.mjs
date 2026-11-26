// 浏览器 E2E：验证已运行的 daemon + 生产构建能渲染真实画布。
// 用法：CANVAS_BASE=http://127.0.0.1:17371 CANVAS_PROJECT=xxx node daemon/e2e-browser.mjs
// 不发起生成，只读页面；没有 Chrome 时设置 CHROME_PATH。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.env.CANVAS_BASE || "http://127.0.0.1:17371";
const project = process.env.CANVAS_PROJECT || "";
const port = Number(process.env.CDP_PORT || 9335);
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const screenshot = process.env.E2E_SCREENSHOT || path.join(os.tmpdir(), "solgrid-canvas-browser-e2e.png");
if (!project) throw new Error("缺少 CANVAS_PROJECT");
if (!fs.existsSync(chromePath)) throw new Error(`找不到 Chrome：${chromePath}（可设置 CHROME_PATH）`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "solgrid-canvas-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => undefined);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 30000, label = "condition") {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await fn().catch(() => false);
        if (value) return value;
        await wait(250);
    }
    throw new Error(`timeout: ${label}`);
}

let ws;
let id = 1;
const waiting = new Map();
const exceptions = [];
function cdp(method, params = {}) {
    const requestId = id++;
    ws.send(JSON.stringify({ id: requestId, method, params }));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`CDP ${method} timeout`)); }, 30000);
        waiting.set(requestId, { resolve, reject, timer });
    });
}

try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 30000, "chrome");
    const tab = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${base}/canvas/${project}`)}`, { method: "PUT" }).then((r) => r.json());
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && waiting.has(message.id)) {
            const entry = waiting.get(message.id);
            waiting.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
            else entry.resolve(message.result);
            return;
        }
        if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
    };
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Page.navigate", { url: `${base}/canvas/${project}` });
    await wait(4000);
    const evalJs = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
    const body = String(await evalJs("document.body.innerText"));
    await waitFor(async () => (await evalJs("document.body.innerText.includes('画布')")) === true, 30000, "canvas page");
    const media = await evalJs(`(() => { const img = [...document.images].find((item) => item.src.includes('/assets/')); const video = document.querySelector('video'); return { image: img ? { src: img.src, width: img.naturalWidth, height: img.naturalHeight, complete: img.complete } : null, video: video ? { src: video.src, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, duration: video.duration } : null }; })()`);
    if (!media.image && !media.video) throw new Error("页面没有渲染任何真实资产");
    if (media.image && (!media.image.complete || !media.image.width)) throw new Error(`图片未渲染：${JSON.stringify(media.image)}`);
    if (media.video && (!media.video.readyState || !media.video.width)) throw new Error(`视频未就绪：${JSON.stringify(media.video)}`);
    if (exceptions.length) throw new Error(`页面异常：${exceptions.join("\n")}`);
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ ok: true, project, media, screenshot, body: body.slice(0, 300) }, null, 2));
} catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
} finally {
    try { ws?.close(); } catch { /* ignore */ }
    chrome.kill();
    await wait(300);
}

// 资产落地：上传流 → sha256 → projects/<id>/assets/<sha256>.<ext>
// 内容寻址：同一张图重复上传只会有一个文件。附带 <sha256>.json 记录来源，便于 Agent 直接看。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 1024 * 1024 * 1024; // 1GB，视频也够用

const MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
};

const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]));

export function extFromMime(mime) {
    return MIME_TO_EXT[String(mime || "").toLowerCase()] || "bin";
}

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_FILE = /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

export function assetFilePath(projectsDir, projectId, file) {
    if (!PROJECT_ID.test(projectId)) throw new Error("invalid project id");
    if (!ASSET_FILE.test(file)) throw new Error("invalid asset name");
    return path.join(projectsDir, projectId, "assets", file);
}

// 流式接收：边写临时文件边算 sha256，读完才知道最终文件名
export function receiveAsset(req, projectsDir, projectId, mime) {
    return new Promise((resolve, reject) => {
        if (!PROJECT_ID.test(projectId)) return reject(new Error("invalid project id"));
        const normalizedMime = String(mime || "").toLowerCase();
        const allowedImages = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
        if (normalizedMime.startsWith("image/") && !allowedImages.has(normalizedMime)) {
            return reject(new Error(`不支持的图片格式：${normalizedMime}；请先转成 PNG/JPEG/WebP 再上传`));
        }
        const dir = path.join(projectsDir, projectId, "assets");
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.upload-${crypto.randomUUID()}.tmp`);
        const out = fs.createWriteStream(tmp);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        let failed = false;

        const fail = (error) => {
            if (failed) return;
            failed = true;
            out.destroy();
            fs.rm(tmp, { force: true }, () => reject(error));
        };

        req.on("data", (chunk) => {
            if (failed) return;
            bytes += chunk.length;
            if (bytes > MAX_BYTES) {
                fail(new Error("asset too large"));
                req.destroy();
                return;
            }
            hash.update(chunk);
            out.write(chunk);
        });
        req.on("aborted", () => fail(new Error("client aborted")));
        req.on("error", fail);
        out.on("error", fail);
        req.on("end", () => {
            out.end(() => {
                if (failed) return;
                try {
                    const assetId = hash.digest("hex");
                    const file = `${assetId}.${extFromMime(mime)}`;
                    const finalPath = path.join(dir, file);
                    if (fs.existsSync(finalPath)) fs.rmSync(tmp, { force: true });
                    else fs.renameSync(tmp, finalPath);
                    const metaFile = path.join(dir, `${assetId}.json`);
                    if (!fs.existsSync(metaFile)) {
                        fs.writeFileSync(metaFile, `${JSON.stringify({ assetId, file, mime: mime || "application/octet-stream", bytes, createdAt: new Date().toISOString() }, null, 2)}\n`);
                    }
                    resolve({ assetId, file, bytes, mime: mime || "application/octet-stream" });
                } catch (error) {
                    fail(error);
                }
            });
        });
    });
}

// 结果落地：把 run 产出的二进制写进 assets/（内容寻址，与上传共用同一套命名）
export function saveAssetFromBuffer(buffer, projectsDir, projectId, mime) {
    fs.mkdirSync(path.join(projectsDir, projectId, "assets"), { recursive: true });
    const assetId = crypto.createHash("sha256").update(buffer).digest("hex");
    const file = `${assetId}.${extFromMime(mime)}`;
    const finalPath = assetFilePath(projectsDir, projectId, file);
    if (!fs.existsSync(finalPath)) {
        const tmp = `${finalPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buffer);
        fs.renameSync(tmp, finalPath);
    }
    const metaFile = path.join(projectsDir, projectId, "assets", `${assetId}.json`);
    if (!fs.existsSync(metaFile)) {
        fs.writeFileSync(metaFile, `${JSON.stringify({ assetId, file, mime, bytes: buffer.length, createdAt: new Date().toISOString() }, null, 2)}\n`);
    }
    return { assetId, file, bytes: buffer.length, mime };
}

export async function saveAssetFromUrl(url, projectsDir, projectId, mime) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载产物失败: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = (response.headers.get("content-type") || mime || "application/octet-stream").split(";")[0].trim();
    return saveAssetFromBuffer(buffer, projectsDir, projectId, contentType);
}

export function serveAsset(req, res, projectsDir, projectId, file) {
    let filePath;
    try {
        filePath = assetFilePath(projectsDir, projectId, file);
    } catch {
        res.writeHead(400).end();
        return;
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
        return;
    }
    const ext = file.split(".").pop();
    const mime = EXT_TO_MIME[ext] || "application/octet-stream";
    const range = req.headers.range;
    const headers = { "content-type": mime, "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes" };

    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
            if (start <= end) {
                res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
                fs.createReadStream(filePath, { start, end }).pipe(res);
                return;
            }
        }
        res.writeHead(416, { "content-range": `bytes */${stat.size}` }).end();
        return;
    }

    res.writeHead(200, { ...headers, "content-length": stat.size });
    fs.createReadStream(filePath).pipe(res);
}

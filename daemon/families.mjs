// 画布语义 → provider 契约。按 family 写，不按模型写：
// 平台加新模型时，同一 family 的端点直接可用；陌生 family 走 raw body 兜底。
// 参考 notes/solgrid-findings.md 的实测结论（首尾帧必须 adaptive、wan 用 input.media 等）。

function sizeToPixels(size) {
    const text = String(size || "");
    const pair = /^(\d+)[x*](\d+)$/.exec(text);
    if (pair) return { width: Number(pair[1]), height: Number(pair[2]) };
    const ratio = /^(\d+):(\d+)$/.exec(text);
    if (ratio) return { width: 1024, height: Math.round((1024 * Number(ratio[2])) / Number(ratio[1])) };
    return { width: 1024, height: 1024 };
}

// qwen-image / wan-image 的像素范围：512*512 ~ 2048*2048，长宽比 1:8 ~ 8:1
function clampImageSize(size) {
    const { width, height } = sizeToPixels(size);
    const scale = Math.min(2048 / Math.max(width, height), Math.max(512 / Math.min(width, height), 1), 1.9);
    const w = Math.max(512, Math.min(2048, Math.round((width * scale) / 8) * 8));
    const h = Math.max(512, Math.min(2048, Math.round((height * scale) / 8) * 8));
    return `${w}*${h}`;
}

function alibabaImage({ params, mediaUrls }) {
    const content = [{ text: String(params.prompt || "").trim() }];
    for (const url of mediaUrls.slice(0, 3)) content.push({ image: url });
    return {
        input: { messages: [{ role: "user", content }] },
        parameters: { size: clampImageSize(params.size), n: Math.max(1, Math.min(6, Number(params.count) || 1)) },
    };
}

function wanVideo({ params, mediaUrls }) {
    const mode = params.videoMode === "reference" || mediaUrls.length > 2 ? "reference" : "frames";
    const media = [];
    if (mode === "frames") {
        if (mediaUrls[0]) media.push({ type: "first_frame", url: mediaUrls[0] });
        if (mediaUrls[1]) media.push({ type: "last_frame", url: mediaUrls[1] });
    } else {
        for (const url of mediaUrls.slice(0, 5)) media.push({ type: "reference_image", url });
    }
    const body = {
        input: { prompt: String(params.prompt || "").trim(), ...(media.length ? { media } : {}) },
        parameters: {
            resolution: String(params.resolution || "720P").toUpperCase().includes("1080") ? "1080P" : "720P",
            duration: Math.max(2, Math.min(15, Math.round(Number(params.seconds) || 5))),
        },
    };
    return body;
}

function seedanceVideo({ params, mediaUrls }) {
    const mode = params.videoMode === "reference" || mediaUrls.length > 2 ? "reference" : "frames";
    const content = [{ type: "text", text: String(params.prompt || "").trim() }];
    mediaUrls.slice(0, 9).forEach((url, index) => {
        const role = mode === "frames" ? (index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image") : "reference_image";
        content.push({ type: "image_url", image_url: { url }, role });
    });
    const body = {
        content,
        resolution: String(params.resolution || "720p").toLowerCase() === "1080p" ? "1080p" : String(params.resolution || "720p").toLowerCase(),
        duration: Math.max(4, Math.min(15, Math.round(Number(params.seconds) || 5))),
        generate_audio: params.generateAudio === "true" || params.generateAudio === true,
    };
    // 首尾帧模式要求 adaptive
    body.ratio = mode === "frames" ? "adaptive" : String(params.ratio || "adaptive");
    return body;
}

const FAMILIES = [
    { id: "alibaba-image", match: (provider, endpoint) => provider === "alibaba" && endpoint.startsWith("/v1/image/"), build: alibabaImage },
    { id: "alibaba-wan-video", match: (provider, endpoint) => provider === "alibaba" && /^\/v1\/video\/wan2\.7-(i2v|t2v|r2v)$/.test(endpoint), build: wanVideo },
    { id: "bytedance-seedance", match: (provider, endpoint) => provider === "bytedance" && endpoint.startsWith("/v1/video/seedance"), build: seedanceVideo },
];

export function buildBody({ provider, endpoint, params, mediaUrls }) {
    if (params?.rawBody && typeof params.rawBody === "object") return { family: "raw", body: params.rawBody };
    const family = FAMILIES.find((item) => item.match(provider, endpoint));
    if (!family) {
        throw Object.assign(new Error(`暂不支持的模型族：${provider} ${endpoint}。请在节点里用 raw JSON 填写请求体。`), { code: "unsupported_family" });
    }
    const prompt = String(params?.prompt || "").trim();
    if (!prompt) throw Object.assign(new Error("prompt 不能为空"), { code: "missing_prompt" });
    return { family: family.id, body: family.build({ params, mediaUrls }) };
}

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
// 画布的 vquality 是 "480"/"720"/"1080"（不带 p），平台枚举要 "480p"/"720P"
function resolutionTier(value) {
    const match = /(\d{3,4})/.exec(String(value || ""));
    return match ? Number(match[1]) : 720;
}

function seedanceResolution(value) {
    const tier = resolutionTier(value);
    if (tier >= 720) return "720p"; // mini 最高 720p，超出按 720p 处理
    return "480p";
}

function wanResolution(value) {
    return resolutionTier(value) >= 1080 ? "1080P" : "720P";
}

function wan3Resolution(value) {
    const tier = resolutionTier(value);
    if (tier >= 1080) return "1080P";
    if (tier >= 720) return "720P";
    return "480P";
}

// 画布视频的 size 是 "宽x高"（auto 表示自适应），据此推断平台 ratio
function ratioFromSize(size) {
    const match = /^(\d+)[x*](\d+)$/.exec(String(size || ""));
    if (!match) return null;
    const value = Number(match[1]) / Number(match[2]);
    const candidates = [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16], ["21:9", 21 / 9]];
    for (const [label, target] of candidates) {
        if (Math.abs(value - target) / target <= 0.06) return label;
    }
    return null;
}

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

function invalid(message) {
    return Object.assign(new Error(message), { code: "invalid_params" });
}

// wan 三个端点契约不同：i2v 只收首尾帧、t2v 不收素材、r2v 收参考图
function wanVideo({ params, mediaUrls, endpoint }) {
    const prompt = String(params.prompt || "").trim();
    const duration = Math.max(2, Math.min(15, Math.round(Number(params.seconds) || 5)));
    const resolution = wanResolution(params.resolution);

    if (endpoint.endsWith("t2v")) {
        if (mediaUrls.length) throw invalid("wan2.7-t2v 是纯文生视频，不接受参考素材。带参考图请改用 wan2.7-i2v（首尾帧）或 wan2.7-r2v（参考图）。");
        return { input: { prompt }, parameters: { resolution, duration } };
    }

    if (endpoint.endsWith("r2v")) {
        if (!mediaUrls.length) throw invalid("wan2.7-r2v 至少需要 1 张参考图。");
        const media = mediaUrls.slice(0, 5).map((url) => ({ type: "reference_image", url }));
        const parameters = { resolution, duration };
        const ratio = ratioFromSize(params.size);
        if (ratio) parameters.ratio = ratio;
        return { input: { prompt, media }, parameters };
    }

    // i2v：只接受首帧/尾帧/续拍片段/驱动音频
    const mode = params.videoMode === "reference" || mediaUrls.length > 2 ? "reference" : "frames";
    if (mode === "reference") {
        throw invalid("wan2.7-i2v 只接受首帧/尾帧，不接受参考图。请把视频模式切到「首尾帧」，或改用 wan2.7-r2v 做参考生视频。");
    }
    if (!mediaUrls.length) throw invalid("wan2.7-i2v 需要一张首帧图。");
    const media = [{ type: "first_frame", url: mediaUrls[0] }];
    if (mediaUrls[1]) media.push({ type: "last_frame", url: mediaUrls[1] });
    return { input: { prompt, media }, parameters: { resolution, duration } };
}

// wan3.0 一个端点同时支持 t2v / 首尾帧 / 全参考；媒体用 input.media[].type 区分。
function wan3Video({ params, mediaUrls }) {
    const prompt = String(params.prompt || "").trim();
    const duration = Math.max(2, Math.min(30, Math.round(Number(params.seconds) || 5)));
    const resolution = wan3Resolution(params.resolution);
    const referenceMode = params.videoMode === "reference" || mediaUrls.length > 2;
    const media = mediaUrls.slice(0, referenceMode ? 10 : 2).map((url, index) => {
        if (!referenceMode) return { type: index === 0 ? "first_frame" : "last_frame", url };
        if (/\.(mp4|mov|webm|mkv)(\?|$)/i.test(url)) return { type: "reference_video", url };
        if (/\.(mp3|wav|m4a|aac|ogg)(\?|$)/i.test(url)) return { type: "reference_audio", url };
        return { type: "reference_image", url };
    });
    const parameters = { resolution, duration };
    if (referenceMode) {
        const ratio = ratioFromSize(params.size);
        parameters.ratio = ["16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio) ? ratio : "adaptive";
    }
    if (params.generateAudio !== undefined) parameters.audio = params.generateAudio === "true" || params.generateAudio === true;
    return media.length ? { input: { prompt, media }, parameters } : { input: { prompt }, parameters };
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
        resolution: seedanceResolution(params.resolution),
        duration: Math.max(4, Math.min(15, Math.round(Number(params.seconds) || 5))),
        generate_audio: params.generateAudio === "true" || params.generateAudio === true,
    };
    // 首尾帧模式要求 adaptive；参考模式沿用画布比例（从 size 推断，未知则自适应）
    body.ratio = mode === "frames" ? "adaptive" : ratioFromSize(params.size) || "adaptive";
    return body;
}

const OPENAI_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

function audioFamily({ params, endpoint }) {
    const prompt = String(params.prompt || "").trim();
    if (!prompt) throw invalid("音频生成需要文本：填在节点的提示词里");
    const voice = String(params.audioVoice || "").trim();
    const format = String(params.audioFormat || "mp3").toLowerCase();
    const speed = Math.max(0.5, Math.min(2, Number(params.audioSpeed) || 1));

    if (endpoint.includes("/text-to-speech")) {
        const voiceId = voice.length >= 10 && !OPENAI_VOICES.has(voice) ? voice : "21m00Tcm4TlvDq8ikWAM";
        return { voice_id: voiceId, text: prompt, model_id: "eleven_multilingual_v2" };
    }

    if (endpoint.includes("/t2a_v2")) {
        const voiceId = voice && !OPENAI_VOICES.has(voice) ? voice : "male-qn-qingse";
        return {
            text: prompt,
            voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 },
            audio_setting: { format: ["mp3", "pcm", "flac", "wav"].includes(format) ? format : "mp3", sample_rate: 32000, bitrate: 128000 },
            stream: false,
        };
    }

    const body = { prompt, output_format: "mp3" };
    const seconds = Number(params.seconds);
    if (seconds > 0) body.duration = Math.min(seconds, 190);
    return body;
}

const FAMILIES = [
    { id: "alibaba-image", match: (provider, endpoint) => provider === "alibaba" && endpoint.startsWith("/v1/image/"), build: alibabaImage },
    { id: "alibaba-wan-video", match: (provider, endpoint) => provider === "alibaba" && /^\/v1\/video\/wan2\.7-(i2v|t2v|r2v)$/.test(endpoint), build: wanVideo },
    { id: "alibaba-wan3-video", match: (provider, endpoint) => provider === "alibaba" && /^\/v1\/video\/wan3(\.\d+)?$/.test(endpoint), build: wan3Video },
    { id: "bytedance-seedance", match: (provider, endpoint) => provider === "bytedance" && endpoint.startsWith("/v1/video/seedance"), build: seedanceVideo },
    { id: "audio", match: (provider, endpoint) => /text-to-speech|t2a_v2|stable-audio\/text-to-audio|\/v1\/music$|\/v1\/sound-generation$/.test(endpoint), build: audioFamily },
];

export function buildBody({ provider, endpoint, params, mediaUrls }) {
    if (params?.rawBody && typeof params.rawBody === "object") return { family: "raw", body: params.rawBody };
    const family = FAMILIES.find((item) => item.match(provider, endpoint));
    if (!family) {
        throw Object.assign(new Error(`暂不支持的模型族：${provider} ${endpoint}。请在节点里用 raw JSON 填写请求体（参数面板有「生成骨架」；MCP 可用 canvas_inspect_tool 返回的 skeleton）。`), { code: "unsupported_family" });
    }
    const prompt = String(params?.prompt || "").trim();
    if (!prompt) throw Object.assign(new Error("prompt 不能为空"), { code: "missing_prompt" });
    return { family: family.id, body: family.build({ params, mediaUrls, endpoint }) };
}

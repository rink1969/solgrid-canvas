// 生成前成本预估：用 catalog 里的 price.rates 估算 Spark 花费（实际以平台结算为准）
export type SolgridPriceRate = {
    meter?: string;
    unitPrice?: number;
    unitSize?: number;
    freeUnits?: number;
    conditions?: Record<string, string> | null;
};

export type SolgridPrice = {
    type?: string;
    amount?: { value?: string | number; currency?: string };
    unit?: string;
    rates?: SolgridPriceRate[];
};

export type SolgridCatalogLike = {
    image?: Array<{ provider: string; endpoint: string; price?: unknown }>;
    video?: Array<{ provider: string; endpoint: string; price?: unknown }>;
    audio?: Array<{ provider: string; endpoint: string; price?: unknown }>;
};

export function findToolPrice(catalog: SolgridCatalogLike | null | undefined, provider: string, endpoint: string): SolgridPrice | null {
    if (!catalog) return null;
    for (const bucket of [catalog.image, catalog.video, catalog.audio]) {
        const match = (bucket || []).find((item) => item.provider === provider && item.endpoint === endpoint);
        if (match?.price && typeof match.price === "object") return match.price as SolgridPrice;
    }
    return null;
}

function normalizeResolution(value: string) {
    const text = value.trim().toUpperCase();
    if (/^\d+$/.test(text)) return `${text}P`;
    return text;
}

/**
 * @param options.outputs 输出数量（图片张数 / 音频条数）
 * @param options.references 参考图数量
 * @param options.seconds 视频时长（秒）
 * @param options.resolution 分辨率（720 / 720P / 1080P）
 */
export function estimateSpark(price: unknown, options: { outputs?: number; references?: number; seconds?: number; resolution?: string } = {}): number | null {
    if (!price || typeof price !== "object") return null;
    const value = price as SolgridPrice;
    const outputs = Math.max(1, Math.round(Number(options.outputs) || 1));
    const references = Math.max(0, Math.round(Number(options.references) || 0));
    const seconds = Math.max(0, Number(options.seconds) || 0);
    const resolution = options.resolution ? normalizeResolution(String(options.resolution)) : "";
    const rates = Array.isArray(value.rates) ? value.rates : [];

    // 同一 meter 可能按 image_tier / resolution 等条件列多档，但一次生成只会命中其中一档。
    // 之前逐条累加会把同 meter 的多档全部算进去（实测 7.8 vs 实扣 3.9）。
    const groups = new Map<string, SolgridPriceRate[]>();
    for (const rate of rates) {
        const meter = String(rate.meter || "");
        const isInputImages = /inputimages?/i.test(meter) && !/output/i.test(meter);
        const isSeconds = /seconds?/i.test(meter) && !/input/i.test(meter);
        const isOutput = /output(images?|videos?)/i.test(meter);
        if (!isInputImages && !isSeconds && !isOutput) continue;
        const key = isInputImages ? "input" : isSeconds ? "seconds" : "output";
        const list = groups.get(key) || [];
        list.push(rate);
        groups.set(key, list);
    }

    let total = 0;
    let matched = false;

    for (const [kind, list] of groups) {
        const units = kind === "input" ? references : kind === "seconds" ? seconds : outputs;
        if (!units) continue;

        // 只取一档：优先匹配已知的 resolution；未知条件（image_tier 等）不参与筛选，
        // 避免“没有依据地多算”，也避免整组被跳过。
        let chosen: SolgridPriceRate | undefined;
        if (resolution) {
            chosen = list.find((rate) => (rate.conditions as Record<string, string> | null)?.resolution && normalizeResolution(String(rate.conditions?.resolution)) === resolution) || list.find((rate) => !(rate.conditions as Record<string, string> | null)?.resolution);
        } else {
            chosen = list.find((rate) => !(rate.conditions as Record<string, string> | null)?.resolution) || list[0];
        }
        if (!chosen) continue;

        const unitSize = Math.max(1, Number(chosen.unitSize) || 1);
        const unitPrice = Number(chosen.unitPrice) || 0;
        const freeUnits = Number(chosen.freeUnits) || 0;
        const billable = Math.max(0, units - freeUnits);
        if (!billable) continue;
        total += Math.ceil(billable / unitSize) * unitPrice;
        matched = true;
    }

    if (!matched && value.amount?.value) {
        const amount = Number(value.amount.value);
        if (!Number.isFinite(amount)) return null;
        const units = /seconds?/i.test(String(value.unit || "")) ? seconds : outputs;
        if (!units) return null;
        total = amount * units;
        matched = true;
    }

    return matched ? Math.round(total * 100) / 100 : null;
}

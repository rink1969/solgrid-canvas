// daemon 侧成本估算：用 catalog 缓存里的 price 结构算一次审批的预估 Spark。
function normalizeResolution(value) {
    const text = String(value || "").trim().toUpperCase();
    return /^\d+$/.test(text) ? `${text}P` : text;
}

function numberFromCost(input) {
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input === "string" && input.trim()) {
        const value = Number(input);
        return Number.isFinite(value) ? value : null;
    }
    if (input && typeof input === "object") return numberFromCost(input.value ?? input.amount ?? input.spark ?? input.cost);
    return null;
}

export function findCatalogPrice(catalog, provider, endpoint) {
    if (!catalog) return null;
    for (const bucket of [catalog.image, catalog.video, catalog.audio]) {
        const match = (bucket || []).find((item) => item.provider === provider && item.endpoint === endpoint);
        if (match?.price && typeof match.price === "object") return match.price;
    }
    return null;
}

export function estimateSpark(price, options = {}) {
    if (!price || typeof price !== "object") return null;
    const outputs = Math.max(1, Math.round(Number(options.outputs) || 1));
    const references = Math.max(0, Math.round(Number(options.references) || 0));
    const seconds = Math.max(0, Number(options.seconds) || 0);
    const resolution = options.resolution ? normalizeResolution(options.resolution) : "";
    const rates = Array.isArray(price.rates) ? price.rates : [];
    const groups = new Map();
    for (const rate of rates) {
        const meter = String(rate.meter || "");
        const isInput = /inputimages?/i.test(meter) && !/output/i.test(meter);
        const isSeconds = /seconds?/i.test(meter) && !/input/i.test(meter);
        const isOutput = /output(images?|videos?)/i.test(meter);
        if (!isInput && !isSeconds && !isOutput) continue;
        const key = isInput ? "input" : isSeconds ? "seconds" : "output";
        const list = groups.get(key) || [];
        list.push(rate);
        groups.set(key, list);
    }
    let total = 0;
    let matched = false;
    for (const [kind, list] of groups) {
        const units = kind === "input" ? references : kind === "seconds" ? seconds : outputs;
        if (!units) continue;
        let chosen;
        if (resolution) {
            chosen = list.find((rate) => rate.conditions?.resolution && normalizeResolution(rate.conditions.resolution) === resolution)
                || list.find((rate) => !rate.conditions?.resolution);
        } else {
            chosen = list.find((rate) => !rate.conditions?.resolution) || list[0];
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
    if (!matched) {
        const amount = numberFromCost(price.amount);
        if (amount === null) return null;
        const units = /seconds?/i.test(String(price.unit || "")) ? seconds : outputs;
        if (!units) return null;
        total = amount * units;
        matched = true;
    }
    return matched ? Math.round(total * 100) / 100 : null;
}

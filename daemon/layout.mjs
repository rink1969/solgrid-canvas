// 产物布点：Agent 只声明"放什么"，坐标由这里算。
// 规则：图片类排成一列、文本类排成一列；从锚点右侧起排；与已有节点冲突时整体下移。
const COLUMNS = {
    image: { width: 320, gapX: 80, order: 0 },
    video: { width: 320, gapX: 80, order: 0 },
    audio: { width: 320, gapX: 80, order: 0 },
    text: { width: 360, gapX: 80, order: 1 },
};

const ROW_GAP = 48;
const ANCHOR_GAP = 120;
const MARGIN = 24;

function overlaps(a, b) {
    return a.x < b.x + b.width + MARGIN && a.x + a.width + MARGIN > b.x && a.y < b.y + b.height + MARGIN && a.y + a.height + MARGIN > b.y;
}

function defaultHeight(kind, item) {
    if (item.height) return Math.max(80, Math.round(item.height));
    if (kind === "text") {
        const chars = String(item.text || "").length;
        return Math.max(160, Math.min(520, 120 + Math.ceil(chars / 24) * 22));
    }
    if (item.width && item.height) return Math.round((item.height / item.width) * COLUMNS[kind === "video" || kind === "audio" ? "video" : "image"].width);
    return 320;
}

/**
 * @param {{anchor: {position:{x:number,y:number}, width:number, height:number}, items: Array<{kind:string, role?:string, width?:number, height?:number, text?:string}>, nodes: Array<{id:string, position:{x:number,y:number}, width:number, height:number}>}} input
 * @returns {Array<{index:number, x:number, y:number, width:number, height:number}>}
 */
export function layoutArtifacts({ anchor, items, nodes = [] }) {
    const columns = new Map();
    const placements = [];
    const occupied = nodes.map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));

    const baseY = anchor.position.y;
    let columnX = anchor.position.x + anchor.width + ANCHOR_GAP;

    for (const [index, item] of items.entries()) {
        const kind = COLUMNS[item.kind] ? item.kind : "text";
        const column = COLUMNS[kind];
        if (!columns.has(column.order)) columns.set(column.order, { x: columnX, cursorY: baseY, width: column.width });
        const slot = columns.get(column.order);
        let width = item.width ? Math.max(120, Math.round(item.width)) : column.width;
        if (width > 640) width = 640;
        const height = defaultHeight(kind, item);

        let placed = null;
        for (let attempt = 0; attempt < 60; attempt++) {
            const candidate = { x: slot.x, y: slot.cursorY, width, height };
            const hit = occupied.find((box) => overlaps(candidate, box));
            if (!hit) {
                placed = candidate;
                break;
            }
            slot.cursorY = hit.y + hit.height + ROW_GAP;
        }
        if (!placed) placed = { x: slot.x, y: slot.cursorY, width, height };

        occupied.push(placed);
        slot.cursorY = placed.y + height + ROW_GAP;
        placements.push({ index, ...placed });
        columnX = slot.x;
        if (column.order === 0) columns.set(1, { x: slot.x + column.width + column.gapX, cursorY: baseY, width: COLUMNS.text.width });
    }

    return placements;
}

/** 估算一组节点的包围盒，供"打组"或后续布局复用 */
export function boundsOf(nodes) {
    if (!nodes.length) return null;
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const right = Math.max(...nodes.map((node) => node.position.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.position.y + node.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

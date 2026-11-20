// 真·局部重绘：按蒙版 bbox 裁出局部，图生图只改局部，再把结果羽化回贴原图。
// 平台没有 mask inpaint 端点，这里用"裁剪 + 蒙版参考图 + 回贴"逼近。
export type InpaintRect = { x: number; y: number; width: number; height: number };

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = src;
    });
}

function createCanvas(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function contextOf(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持 Canvas 2D");
    return context;
}

function alphaBounds(canvas: HTMLCanvasElement, threshold = 8): InpaintRect | null {
    const context = contextOf(canvas);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] <= threshold) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function clampRect(rect: InpaintRect, width: number, height: number): InpaintRect {
    const x = Math.max(0, Math.min(Math.round(rect.x), width - 1));
    const y = Math.max(0, Math.min(Math.round(rect.y), height - 1));
    return { x, y, width: Math.max(1, Math.min(Math.round(rect.width), width - x)), height: Math.max(1, Math.min(Math.round(rect.height), height - y)) };
}

/** 计算裁剪区域，产出两张参考图：局部原图 + 同尺寸黑白蒙版 */
export async function prepareInpaintEdit(sourceUrl: string, maskUrl: string) {
    const [source, mask] = await Promise.all([loadImage(sourceUrl), loadImage(maskUrl)]);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;

    const maskCanvas = createCanvas(width, height);
    contextOf(maskCanvas).drawImage(mask, 0, 0, width, height);
    const bounds = alphaBounds(maskCanvas) || { x: 0, y: 0, width, height };

    const pad = Math.max(24, Math.round(Math.max(bounds.width, bounds.height) * 0.12));
    const rect = clampRect({ x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 }, width, height);

    const sourceCrop = createCanvas(rect.width, rect.height);
    contextOf(sourceCrop).drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);

    // 模型更熟悉"白=要改、黑=保留"的蒙版
    const maskCrop = createCanvas(rect.width, rect.height);
    const maskContext = contextOf(maskCrop);
    maskContext.fillStyle = "#000";
    maskContext.fillRect(0, 0, rect.width, rect.height);
    maskContext.drawImage(maskCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);

    return { rect, sourceCrop: sourceCrop.toDataURL("image/png"), maskCrop: maskCrop.toDataURL("image/png"), imageWidth: width, imageHeight: height };
}

/** 把生成结果按羽化蒙版贴回原图对应区域 */
export async function compositeInpaint(sourceUrl: string, patchUrl: string, maskUrl: string, rect: InpaintRect) {
    const [source, patch, mask] = await Promise.all([loadImage(sourceUrl), loadImage(patchUrl), loadImage(maskUrl)]);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const output = createCanvas(width, height);
    contextOf(output).drawImage(source, 0, 0, width, height);

    const overlay = createCanvas(rect.width, rect.height);
    const overlayContext = contextOf(overlay);
    // 模型可能返回不同宽高比：按 cover 缩放并居中裁剪，避免拉伸变形
    const patchWidth = patch.naturalWidth || patch.width;
    const patchHeight = patch.naturalHeight || patch.height;
    const scale = Math.max(rect.width / patchWidth, rect.height / patchHeight);
    const drawWidth = patchWidth * scale;
    const drawHeight = patchHeight * scale;
    overlayContext.drawImage(patch, (rect.width - drawWidth) / 2, (rect.height - drawHeight) / 2, drawWidth, drawHeight);

    const cropMask = createCanvas(rect.width, rect.height);
    contextOf(cropMask).drawImage(mask, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);

    // 羽化：模糊 alpha 边缘，避免回贴出现硬边界
    const feather = Math.max(6, Math.round(Math.min(rect.width, rect.height) * 0.06));
    const blurred = createCanvas(rect.width, rect.height);
    const blurredContext = contextOf(blurred);
    blurredContext.filter = `blur(${feather}px)`;
    blurredContext.drawImage(cropMask, 0, 0);
    blurredContext.filter = "none";

    overlayContext.globalCompositeOperation = "destination-in";
    overlayContext.drawImage(blurred, 0, 0);

    contextOf(output).drawImage(overlay, rect.x, rect.y);
    return output.toDataURL("image/png");
}

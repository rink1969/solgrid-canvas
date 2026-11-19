// 资产 = 项目目录里的文件：projects/<projectId>/assets/<sha256>.<ext>
// 节点的 storageKey 形如 "asset:<projectId>/<sha256>.<ext>"，页面里用它拼出 daemon 地址。
import { getActiveProjectId } from "@/lib/canvas/active-project";

export const ASSET_PREFIX = "asset:";

export type UploadedAsset = { storageKey: string; url: string; bytes: number; mime: string };

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_FILE = /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

export function isAssetKey(key?: string) {
    return typeof key === "string" && key.startsWith(ASSET_PREFIX);
}

export function assetKeyToUrl(storageKey: string) {
    const rest = storageKey.slice(ASSET_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return "";
    const projectId = rest.slice(0, slash);
    const file = rest.slice(slash + 1);
    if (!PROJECT_ID.test(projectId) || !ASSET_FILE.test(file)) return "";
    return `/api/projects/${projectId}/assets/${file}`;
}

export async function uploadAsset(blob: Blob, mimeType?: string): Promise<UploadedAsset> {
    const projectId = getActiveProjectId();
    const mime = mimeType || blob.type || "application/octet-stream";
    const response = await fetch(`/api/projects/${projectId}/assets?mime=${encodeURIComponent(mime)}`, {
        method: "POST",
        body: blob,
        headers: { "content-type": mime },
    });
    if (!response.ok) throw new Error(`资产上传失败：${response.status}`);
    const saved = (await response.json()) as { file: string; bytes: number; mime: string };
    return {
        storageKey: `${ASSET_PREFIX}${projectId}/${saved.file}`,
        url: `/api/projects/${projectId}/assets/${saved.file}`,
        bytes: saved.bytes,
        mime: saved.mime,
    };
}

export async function fetchAssetBlob(storageKey: string): Promise<Blob | null> {
    const url = assetKeyToUrl(storageKey);
    if (!url) return null;
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
}

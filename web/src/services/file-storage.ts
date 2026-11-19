import localforage from "localforage";

import { assetKeyToUrl, fetchAssetBlob, isAssetKey, uploadAsset } from "@/services/api/assets";
import { withLocalProxy } from "@/stores/use-config-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

// 视频/音频也走项目 assets/；localforage 里只保留旧数据，不再写入
const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, _prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(withLocalProxy(input))).blob() : input;
    const asset = await uploadAsset(blob);
    const localUrl = URL.createObjectURL(blob);
    try {
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(localUrl) : blob.type.startsWith("audio/") ? await readAudioMeta(localUrl) : {};
        return { url: asset.url, storageKey: asset.storageKey, bytes: asset.bytes, mimeType: asset.mime || "application/octet-stream", ...meta };
    } finally {
        URL.revokeObjectURL(localUrl);
    }
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (isAssetKey(storageKey)) return assetKeyToUrl(storageKey) || fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    if (isAssetKey(storageKey)) return fetchAssetBlob(storageKey);
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    if (isAssetKey(storageKey)) {
        const asset = await uploadAsset(blob);
        return asset.url;
    }
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            if (isAssetKey(key)) return;
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}

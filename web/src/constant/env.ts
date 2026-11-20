export const APP_VERSION = __APP_VERSION__ || "dev";

// 插件市场入口已下线；保留常量用于将来接入自己的 registry。
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "";

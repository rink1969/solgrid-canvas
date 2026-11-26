import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig(({ mode }) => {
    // .env.local 里的 CANVAS_TOKEN / CANVAS_DAEMON_URL 只在 dev server 侧使用，
    // 不注入浏览器 bundle：代理负责带上 x-canvas-token。
    const env = loadEnv(mode, webDir, "");
    const daemonTarget = env.CANVAS_DAEMON_URL || "http://127.0.0.1:17371";
    const daemonToken = env.CANVAS_TOKEN || "";

    return {
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localPluginsManifest()],
        resolve: {
            alias: {
                "@": resolve(webDir, "src"),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(localVersion),
            __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
        },
        server: {
            proxy: {
                "/api": {
                    target: daemonTarget,
                    changeOrigin: false,
                    headers: { "x-canvas-client": "web", ...(daemonToken ? { "x-canvas-token": daemonToken } : {}) },
                },
            },
        },
    };
});

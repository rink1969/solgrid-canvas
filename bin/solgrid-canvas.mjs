#!/usr/bin/env node
// solgrid-canvas CLI：daemon / mcp / doctor / install
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.CANVAS_HOME || path.join(os.homedir(), ".solgrid-canvas");
const PORT = Number(process.env.CANVAS_PORT || 17371);
const DAEMON = path.join(ROOT, "daemon", "server.mjs");
const MCP = path.join(ROOT, "daemon", "mcp.mjs");
const SKILL_SRC = path.join(ROOT, "skills", "solgrid-canvas", "SKILL.md");
const IS_WIN = process.platform === "win32";

const [command, ...rest] = process.argv.slice(2);

function log(...args) {
    console.log(...args);
}

function run(bin, args) {
    return spawnSync(IS_WIN ? `${bin} ${args.map((item) => (/[\s"]/.test(item) ? `"${item}"` : item)).join(" ")}` : bin, IS_WIN ? [] : args, {
        shell: IS_WIN,
        stdio: "inherit",
    });
}

function forward(bin, args) {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
}

async function doctor() {
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push([nodeMajor >= 22, `Node ${process.versions.node}（需要 ≥22）`]);

    const solgrid = spawnSync(IS_WIN ? "solgrid --version" : "solgrid", IS_WIN ? [] : ["--version"], { shell: IS_WIN, encoding: "utf8" });
    checks.push([solgrid.status === 0, `solgrid CLI：${solgrid.status === 0 ? (solgrid.stdout || "").trim() : "未安装（npm i -g @solgridai/cli）"}`]);

    checks.push([fs.existsSync(path.join(HOME, "daemon.json")), `daemon token：${path.join(HOME, "daemon.json")}`]);

    let online = false;
    try {
        const response = await fetch(`http://127.0.0.1:${PORT}/health`);
        online = response.ok;
    } catch {
        online = false;
    }
    checks.push([online, `daemon：${online ? `http://127.0.0.1:${PORT}` : "未运行（solgrid-canvas daemon）"}`]);

    const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    checks.push([ffmpeg.status === 0, `ffmpeg：${ffmpeg.status === 0 ? "可用（时间线导出需要）" : "未找到（可选）"}`]);

    for (const [ok, label] of checks) log(`${ok ? "✓" : "✗"} ${label}`);
    const failed = checks.filter(([ok]) => !ok).length;
    log(failed ? `\n${failed} 项需要处理` : "\n环境就绪");
    return failed;
}

function installSkill() {
    if (!fs.existsSync(SKILL_SRC)) return null;
    const targetDir = path.join(os.homedir(), ".agents", "skills", "solgrid-canvas");
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "SKILL.md");
    fs.copyFileSync(SKILL_SRC, target);
    return target;
}

// DSH 的 MCP 由内置 mcp-manager 管理：写 profile 的 cordis.patch.yml 才会生效
function installDsh() {
    const profileDir = path.join(os.homedir(), ".dsh", "profiles", process.env.DSH_PROFILE || "desktop");
    const patchFile = path.join(profileDir, "cordis.patch.yml");
    if (!fs.existsSync(patchFile)) return { ok: false, message: `找不到 DSH 配置：${patchFile}（确认 DSH 已安装/启动过）` };

    const current = fs.readFileSync(patchFile, "utf8");
    if (current.includes("solgrid_canvas")) return { ok: true, message: `DSH 配置里已经有 solgrid_canvas：${patchFile}`, changed: false };

    const block = `
# solgrid-canvas MCP（由 solgrid-canvas install 写入）
- id: mcp-manager
  name: "@deepseek-ai/dsh-mcp-manager"
  config:
    servers:
      solgrid_canvas:
        transport: stdio
        command: '${process.execPath}'
        args: ['${MCP}']
        enabled: true
`;
    const backup = `${patchFile}.bak-${Date.now()}`;
    fs.copyFileSync(patchFile, backup);
    const next = `${current.trimEnd()}\n${block}`;
    fs.writeFileSync(patchFile, next);
    return { ok: true, message: `已写入 DSH 配置：${patchFile}（备份：${path.basename(backup)}），重启 DSH 后生效`, changed: true };
}

function installAgent(agent) {
    if (agent === "codex") {
        log("注册 Codex MCP…");
        run("codex", ["mcp", "add", "solgrid-canvas", "--", process.execPath, MCP, ...mcpCommand]);
    } else if (agent === "claude") {
        log("注册 Claude Code MCP…");
        run("claude", ["mcp", "add", "--scope", "user", "solgrid-canvas", "--", process.execPath, MCP, ...mcpCommand]);
    } else if (agent === "dsh") {
        const result = installDsh();
        log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
        if (!result.ok) return 1;
    } else {
        log("用法：solgrid-canvas install --agent codex|claude|dsh");
        return 1;
    }
    const skillPath = installSkill();
    if (skillPath) log(`技能包已安装：${skillPath}`);
    else log("技能包未找到（仓库缺少 skills/solgrid-canvas/SKILL.md）");
    log("\n完成。重启对应 Agent 后应能看到 canvas_* 工具。");
    return 0;
}

async function main() {
    if (command === "daemon") return forward(process.execPath, [DAEMON]);
    if (command === "mcp") return forward(process.execPath, [MCP]);
    if (command === "doctor") return process.exit(await doctor());
    if (command === "install") {
        const index = rest.indexOf("--agent");
        const agent = index >= 0 ? rest[index + 1] : "";
        return process.exit(installAgent(agent));
    }
    log(`solgrid-canvas

用法：
  solgrid-canvas daemon                    启动本地 daemon
  solgrid-canvas mcp                       以 stdio MCP server 运行（给 Agent 配）
  solgrid-canvas install --agent codex|claude|dsh   注册 MCP 并安装技能包
  solgrid-canvas doctor                    检查 Node / solgrid CLI / daemon / ffmpeg
`);
}

void main();

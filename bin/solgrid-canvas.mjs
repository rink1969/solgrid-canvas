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

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

function listDshProfiles() {
    const dir = path.join(DSH_HOME, "profiles");
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "package.json")))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

// 判断当前跑安装的是哪个 DSH profile：显式参数 > 环境变量 > 只有一个 profile 时自动选
function detectDshProfile(explicit) {
    const profiles = listDshProfiles();
    const candidate = explicit || process.env.DSH_PROFILE || "";
    if (candidate) {
        const patchFile = path.join(DSH_HOME, "profiles", candidate, "cordis.patch.yml");
        if (fs.existsSync(patchFile)) return { name: candidate, profiles };
        return { error: `profile「${candidate}」不存在：${patchFile}\n可用：${profiles.join(", ") || "（无）"}`, profiles };
    }
    if (profiles.length === 1) return { name: profiles[0], profiles };
    if (!profiles.length) return { error: `没有找到 DSH profile：${path.join(DSH_HOME, "profiles")}`, profiles };
    return { error: `检测到多个 DSH profile（${profiles.join(", ")}），请用 --profile 指定当前 Agent 使用的那个`, profiles };
}

// DSH 的 MCP 由内置 mcp-manager 管理：写 profile 的 cordis.patch.yml 才会生效
function installDsh(explicitProfile) {
    const detected = detectDshProfile(explicitProfile);
    if (detected.error) return { ok: false, message: detected.error };
    const profileDir = path.join(DSH_HOME, "profiles", detected.name);
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
    return { ok: true, message: `已写入 DSH 配置：${patchFile}（profile=${detected.name}，备份：${path.basename(backup)}），重启 DSH 后生效`, changed: true, profile: detected.name };
}

function installAgent(agent, options = {}) {
    if (agent === "codex") {
        log("注册 Codex MCP…");
        run("codex", ["mcp", "add", "solgrid-canvas", "--", process.execPath, MCP, ...mcpCommand]);
    } else if (agent === "claude") {
        log("注册 Claude Code MCP…");
        run("claude", ["mcp", "add", "--scope", "user", "solgrid-canvas", "--", process.execPath, MCP, ...mcpCommand]);
    } else if (agent === "dsh") {
        const result = installDsh(options.profile);
        log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
        if (!result.ok) return 1;
    } else {
        log("用法：solgrid-canvas install --agent codex|claude|dsh");
        return 1;
    }
    const envPath = ensureDevEnv();
    if (envPath) log(`开发模式环境变量已写入：${envPath}`);
    const skillPath = installSkill();
    if (skillPath) log(`技能包已安装：${skillPath}`);
    else log("技能包未找到（仓库缺少 skills/solgrid-canvas/SKILL.md）");
    log("\n完成。重启对应 Agent 后应能看到 canvas_* 工具。");
    return 0;
}


// ---- profile 配置同步（A 方案）：desktop 的 provider/默认模型 → ACP profile ----

function patchFile(profile) {
    return path.join(DSH_HOME, "profiles", profile, "cordis.patch.yml");
}

// 顶层 patch 条目按 "- id:" 切块；只处理顶格列表项，缩进行归入当前块
function splitPatch(text) {
    const lines = text.split(/\r?\n/);
    const header = [];
    const blocks = [];
    let current = null;
    for (const line of lines) {
        if (/^- /.test(line)) {
            current = [line];
            blocks.push(current);
            continue;
        }
        if (current) current.push(line);
        else header.push(line);
    }
    return { header, blocks };
}

function blockId(block) {
    const match = block[0].match(/^-\s+id:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/);
    return match ? match[1] : null;
}

function stripTrailingBlank(block) {
    const copy = [...block];
    while (copy.length > 1 && copy[copy.length - 1].trim() === "") copy.pop();
    return copy;
}

const SYNC_IDS = ["agent-default-model", "llm-pi-ai"];

function collectSyncBlocks(sourceText, log) {
    const { blocks } = splitPatch(sourceText);
    const picked = [];
    for (const block of blocks) {
        const id = blockId(block);
        if (!id || !SYNC_IDS.includes(id)) continue;
        if (id === "llm-pi-ai") {
            const body = block.join("\n");
            const providers = body.match(/providers:\s*\{([^}]*)\}/);
            if (providers && providers[1].trim() === "") {
                log(`· ${id}：暂无自定义 provider，跳过`);
                continue;
            }
        }
        picked.push(stripTrailingBlank(block));
    }
    return picked;
}

function syncConfig({ from = "desktop", target = "acp", dryRun = false } = {}) {
    const sourcePath = patchFile(from);
    const targetPath = patchFile(target);
    if (!fs.existsSync(sourcePath)) return { ok: false, message: `找不到源 profile：${sourcePath}` };
    if (!fs.existsSync(targetPath)) return { ok: false, message: `找不到目标 profile：${targetPath}，先启动一次 \`dsh --profile ${target}\`` };

    const sourceText = fs.readFileSync(sourcePath, "utf8");
    const picked = collectSyncBlocks(sourceText, log);
    if (!picked.length) return { ok: true, message: "没有需要同步的配置（provider 为空且无默认模型差异）", changed: false };

    // 目标是 ACP profile 时，把桌面默认模型同时映射成 ACP 服务的默认（acp 行）
    const targetPackage = path.join(DSH_HOME, "profiles", target, "package.json");
    const isAcpProfile = fs.existsSync(targetPackage) && fs.readFileSync(targetPackage, "utf8").includes("dsh-acp-app");
    if (isAcpProfile) {
        const defaultBlock = picked.find((block) => blockId(block) === "agent-default-model");
        if (defaultBlock) {
            const text = defaultBlock.join("\n");
            const provider = text.match(/^\s+provider:\s*["']?([A-Za-z0-9_-]+)/m)?.[1];
            const model = text.match(/^\s+model:\s*["']?([A-Za-z0-9_.-]+)/m)?.[1];
            if (provider && model) {
                picked.push(["- id: acp", '  name: "@deepseek-ai/dsh-acp"', "  config:", `    provider: ${provider}`, `    model: ${model}`]);
            }
        }
    }

    const targetText = fs.readFileSync(targetPath, "utf8");
    const parsed = splitPatch(targetText);
    const existingById = new Map();
    for (const block of parsed.blocks) {
        const id = blockId(block);
        if (id) existingById.set(id, block);
    }

    const report = [];
    const replacements = new Map();
    const hasChanges = picked.some((block) => !existingById.has(blockId(block)) || existingById.get(blockId(block)).join("\n").trim() !== block.join("\n").trim());
    for (const block of picked) {
        const id = blockId(block);
        if (existingById.has(id)) {
            const same = existingById.get(id).join("\n").trim() === block.join("\n").trim();
            if (same) {
                report.push(`= ${id}（已一致）`);
                continue;
            }
            replacements.set(id, block);
            report.push(`~ ${id}（覆盖）`);
        } else {
            report.push(`+ ${id}（新增）`);
        }
    }

    const mergedBlocks = parsed.blocks.map((block) => {
        const id = blockId(block);
        return id && replacements.has(id) ? replacements.get(id) : block;
    });
    for (const block of picked) {
        const id = blockId(block);
        if (id && !existingById.has(id)) mergedBlocks.push(block);
    }

    const isEmptyRoot = parsed.blocks.length === 0 && parsed.header.join("\n").replace(/#[^\n]*/g, "").trim() === "[]";
    const nextText = isEmptyRoot
        ? `${parsed.header.filter((line) => !/^\s*\[\]\s*$/.test(line)).join("\n").trimEnd()}\n${mergedBlocks.map((block) => block.join("\n")).join("\n")}\n`
        : `${parsed.header.join("\n").trimEnd()}\n${mergedBlocks.map((block) => block.join("\n")).join("\n")}\n`;

    if (!hasChanges) {
        log([`目标：${targetPath}`, ...report, "没有变化"].join("\n"));
        return { ok: true, changed: false, message: report.join(", ") };
    }

    if (dryRun) {
        log([`目标：${targetPath}`, ...report, "（--dry-run，未写入）"].join("\n"));
        return { ok: true, changed: true, message: report.join(", ") };
    }

    const backup = `${targetPath}.bak-${Date.now()}`;
    fs.copyFileSync(targetPath, backup);
    fs.writeFileSync(targetPath, nextText);
    log([`已同步到 ${targetPath}`, ...report, `备份：${path.basename(backup)}`, "重启 daemon（或结束当前 ACP 会话）后生效"].join("\n"));
    return { ok: true, changed: true, message: report.join(", ") };
}


// 开发模式需要的 Vite 代理 token（生产模式由 daemon 下发 HttpOnly cookie，不需要）
function ensureDevEnv() {
    const daemonFile = path.join(HOME, "daemon.json");
    if (!fs.existsSync(daemonFile)) return null;
    let token = "";
    try {
        token = JSON.parse(fs.readFileSync(daemonFile, "utf8")).token || "";
    } catch {
        return null;
    }
    if (!token) return null;
    const envPath = path.join(ROOT, "web", ".env.local");
    const content = `# 由 solgrid-canvas CLI 生成（仅 Vite dev server 读取）\nCANVAS_DAEMON_URL=http://127.0.0.1:${PORT}\nCANVAS_TOKEN=${token}\n`;
    fs.writeFileSync(envPath, content);
    return envPath;
}

async function waitHealth(ms = 6000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true;
        } catch {
            /* 等启动 */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
}

async function setup() {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (nodeMajor < 22) {
        log(`✗ Node ${process.versions.node}，需要 ≥22`);
        return 1;
    }
    if (!fs.existsSync(path.join(ROOT, "web", "node_modules"))) {
        log("安装 web 依赖…");
        const install = spawn(IS_WIN ? "npm.cmd" : "npm", ["--prefix", path.join(ROOT, "web"), "install"], { cwd: ROOT, stdio: "inherit", shell: IS_WIN });
        await new Promise((resolve) => install.on("exit", resolve));
    }
    log("构建前端…");
    const build = spawn(IS_WIN ? "npm.cmd" : "npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: IS_WIN });
    const code = await new Promise((resolve) => build.on("exit", resolve));
    if (code !== 0) {
        log("✗ 构建失败");
        return 1;
    }
    if (!(await waitHealth(500))) {
        log("启动 daemon…");
        const child = spawn(process.execPath, [DAEMON], { cwd: ROOT, detached: true, stdio: "ignore", env: { ...process.env, CANVAS_HOME: HOME, CANVAS_PORT: String(PORT) } });
        child.unref();
        if (!(await waitHealth())) {
            log("✗ daemon 启动失败，检查端口占用或日志");
            return 1;
        }
    }
    const envPath = ensureDevEnv();
    log(`✓ daemon 已就绪：http://127.0.0.1:${PORT}`);
    log(`✓ 前端已构建：${path.join(ROOT, "web", "dist")}`);
    if (envPath) log(`✓ 开发环境变量：${envPath}`);
    log("\n下一步：");
    log("  1) 打开画布：npm start（或 npm run dev 进入开发模式）");
    log("  2) 给本地 Agent 装 MCP：node bin/solgrid-canvas.mjs install --agent <codex|claude|dsh>");
    log("  3) 检查环境：node bin/solgrid-canvas.mjs doctor");
    return 0;
}

async function main() {
    if (command === "daemon") return forward(process.execPath, [DAEMON]);
    if (command === "mcp") return forward(process.execPath, [MCP]);
    if (command === "setup") return process.exit(await setup());
    if (command === "doctor") return process.exit(await doctor());
    if (command === "sync-config") {
        const readFlag = (name, fallback) => {
            const index = rest.indexOf(name);
            return index >= 0 ? rest[index + 1] : fallback;
        };
        const detected = detectDshProfile(readFlag("--from", ""));
        if (detected.error) {
            log(`✗ ${detected.error}`);
            return process.exit(1);
        }
        const targetProfile = readFlag("--profile", "acp");
        if (detected.name === targetProfile) {
            log(`✗ 源 profile 和目标 profile 相同（${targetProfile}），请用 --from 指定要复制配置的 profile`);
            return process.exit(1);
        }
        const result = syncConfig({
            from: detected.name,
            target: targetProfile,
            dryRun: rest.includes("--dry-run"),
        });
        if (!result.ok) log(`✗ ${result.message}`);
        return process.exit(result.ok ? 0 : 1);
    }
    if (command === "install") {
        const index = rest.indexOf("--agent");
        const agent = index >= 0 ? rest[index + 1] : "";
        const profileIndex = rest.indexOf("--profile");
        const profile = profileIndex >= 0 ? rest[profileIndex + 1] : "";
        return process.exit(installAgent(agent, { profile }));
    }
    log(`solgrid-canvas

用法：
  solgrid-canvas daemon                    启动本地 daemon
  solgrid-canvas mcp                       以 stdio MCP server 运行（给 Agent 配）
  solgrid-canvas install --agent codex|claude|dsh [--profile <name>]
                                           注册 MCP 并安装技能包（DSH 可指定 profile）
  solgrid-canvas doctor                    检查 Node / solgrid CLI / daemon / ffmpeg
  solgrid-canvas setup                     安装依赖 + 构建前端 + 启动 daemon + 写开发环境变量
  solgrid-canvas sync-config [--from <profile>] [--profile acp] [--dry-run]
                                           把指定 profile 的 provider/默认模型同步到 ACP profile（默认自动探测）
`);
}

void main();

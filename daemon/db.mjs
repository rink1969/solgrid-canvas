// run 账本：用 Node 内置 sqlite（Node ≥22.5）。不做旧数据兼容，表结构直接按当前设计。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDb(root) {
    fs.mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(path.join(root, "canvas.db"));
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            node_id TEXT,
            provider TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            body_json TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            remote_run_id TEXT,
            cost_spark REAL,
            billing_status TEXT,
            error TEXT,
            outputs_json TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
        CREATE TABLE IF NOT EXISTS catalog (
            key TEXT PRIMARY KEY,
            json TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
        );
    `);
    ensureColumn(db, "runs", "built_body_json", "TEXT");
    return db;
}

// 只加不删的轻量迁移：项目未上线，但仍避免旧库缺列直接报错
function ensureColumn(db, table, column, type) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const now = () => new Date().toISOString();

export function createRunStore(db) {
    const insertStmt = db.prepare(`
        INSERT INTO runs (id, project_id, node_id, provider, endpoint, body_json, idempotency_key, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `);
    const getStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
    const nextStmt = db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT 1");
    const updateStmt = db.prepare(`
        UPDATE runs SET status = COALESCE(?, status), remote_run_id = COALESCE(?, remote_run_id), cost_spark = COALESCE(?, cost_spark),
            billing_status = COALESCE(?, billing_status), error = ?,
            built_body_json = COALESCE(?, built_body_json), outputs_json = COALESCE(?, outputs_json),
            started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at)
        WHERE id = ?
    `);
    const listStmt = db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?");
    const listAllStmt = db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?");
    const unfinishedStmt = db.prepare("SELECT * FROM runs WHERE status IN ('submitting', 'running') ORDER BY created_at");

    const hydrate = (row) =>
        row && {
            id: row.id,
            projectId: row.project_id,
            nodeId: row.node_id,
            provider: row.provider,
            endpoint: row.endpoint,
            body: JSON.parse(row.body_json),
            idempotencyKey: row.idempotency_key,
            status: row.status,
            remoteRunId: row.remote_run_id,
            costSpark: row.cost_spark,
            billingStatus: row.billing_status,
            error: row.error,
            builtBody: row.built_body_json ? JSON.parse(row.built_body_json) : null,
            outputs: row.outputs_json ? JSON.parse(row.outputs_json) : null,
            createdAt: row.created_at,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
        };

    return {
        create({ id, projectId, nodeId, provider, endpoint, body, idempotencyKey }) {
            insertStmt.run(id, projectId, nodeId || null, provider, endpoint, JSON.stringify(body ?? {}), idempotencyKey, now());
            return hydrate(getStmt.get(id));
        },
        get(id) {
            return hydrate(getStmt.get(id));
        },
        nextQueued() {
            return hydrate(nextStmt.get());
        },
        update(id, patch) {
            updateStmt.run(
                patch.status ?? null,
                patch.remoteRunId ?? null,
                patch.costSpark ?? null,
                patch.billingStatus ?? null,
                patch.error ?? null,
                patch.builtBody ? JSON.stringify(patch.builtBody) : null,
                patch.outputs ? JSON.stringify(patch.outputs) : null,
                patch.startedAt ?? null,
                patch.finishedAt ?? null,
                id,
            );
            return hydrate(getStmt.get(id));
        },
        list(projectId, limit = 100) {
            const rows = projectId ? listStmt.all(projectId, limit) : listAllStmt.all(limit);
            return rows.map(hydrate);
        },
        unfinished() {
            return unfinishedStmt.all().map(hydrate);
        },
        remove(id) {
            return db.prepare("DELETE FROM runs WHERE id = ?").run(id).changes > 0;
        },
    };
}

export function createOpLog(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ops (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            ts TEXT NOT NULL,
            origin TEXT,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ops_project ON ops(project_id, seq);
    `);
    const insert = db.prepare("INSERT INTO ops (project_id, ts, origin, payload) VALUES (?, ?, ?, ?)");
    const list = db.prepare("SELECT seq, ts, origin, payload FROM ops WHERE project_id = ? ORDER BY seq DESC LIMIT ?");
    return {
        append(projectId, ops, origin) {
            const ts = new Date().toISOString();
            for (const op of ops) insert.run(projectId, ts, origin || "user", JSON.stringify(op));
        },
        list(projectId, limit = 200) {
            return list.all(projectId, limit).map((row) => ({ seq: row.seq, ts: row.ts, origin: row.origin, op: JSON.parse(row.payload) }));
        },
    };
}

export function createCatalogCache(db) {
    const getStmt = db.prepare("SELECT json, fetched_at FROM catalog WHERE key = ?");
    const putStmt = db.prepare("INSERT INTO catalog (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at");
    return {
        get(key, ttlMs) {
            const row = getStmt.get(key);
            if (!row) return null;
            if (ttlMs && Date.now() - row.fetched_at > ttlMs) return null;
            return JSON.parse(row.json);
        },
        put(key, value) {
            putStmt.run(key, JSON.stringify(value), Date.now());
        },
    };
}

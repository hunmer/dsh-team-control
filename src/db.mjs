// db.mjs — SQLite(WAL) schema 与事务助手（node:sqlite，零依赖）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT
);

CREATE TABLE IF NOT EXISTS team (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
  max_members INTEGER NOT NULL DEFAULT 64,
  max_concurrency INTEGER NOT NULL DEFAULT 8,
  failure_policy TEXT NOT NULL DEFAULT 'continue',
  max_attempts INTEGER NOT NULL DEFAULT 3,
  auto_approve_json TEXT,
  auto_takeover INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT, model TEXT, context_mode TEXT,
  default_plan_json TEXT, quota_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_member_team ON member(team_id);

-- 由 event 完全可重建的投影（C2）。只放事件可推导的字段。
CREATE TABLE IF NOT EXISTS member_state (
  member_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0,
  step TEXT, phase TEXT, status TEXT NOT NULL DEFAULT 'queued',
  last TEXT, next TEXT, blockers_json TEXT NOT NULL DEFAULT '[]',
  as_of TEXT, stale INTEGER NOT NULL DEFAULT 0
);

-- 易失运行时信息（租约/进程），刻意不入 member_state，避免破坏 C2 可重建性
CREATE TABLE IF NOT EXISTS member_runtime (
  member_id TEXT PRIMARY KEY, lease_until INTEGER, pid INTEGER,
  started_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, subject TEXT NOT NULL,
  assignee TEXT, status TEXT NOT NULL DEFAULT 'pending',
  plan_json TEXT NOT NULL DEFAULT '[]', write_scopes_json TEXT NOT NULL DEFAULT '[]',
  acceptance TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3, failure_policy TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT, finished_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_team ON task(team_id, status);

CREATE TABLE IF NOT EXISTS dep (
  id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL,
  from_task TEXT NOT NULL, to_task TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'all_success', artifact_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(team_id, from_task, to_task, condition)
);
CREATE INDEX IF NOT EXISTS idx_dep_to ON dep(team_id, to_task);

-- 只增不改（C2）。UNIQUE(member_id, seq) 保证 seq 连续无重复。
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL, member_id TEXT NOT NULL, task_id TEXT,
  seq INTEGER NOT NULL, ts TEXT NOT NULL,
  phase TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  result TEXT, next TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(member_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_event_team ON event(team_id, id);
CREATE INDEX IF NOT EXISTS idx_event_member ON event(member_id, seq);

CREATE TABLE IF NOT EXISTS policy (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  domain TEXT NOT NULL, matcher TEXT NOT NULL,
  ops_json TEXT NOT NULL, mode TEXT NOT NULL,
  constraints_json TEXT, expires_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_team ON policy(team_id, domain);

CREATE TABLE IF NOT EXISTS scope_request (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, member_id TEXT NOT NULL,
  domain TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL,
  diff_size INTEGER, risk TEXT, blocked_step TEXT, fallback TEXT,
  status TEXT NOT NULL DEFAULT 'pending', decision_id TEXT, grant_id TEXT,
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scope_status ON scope_request(team_id, status);

CREATE TABLE IF NOT EXISTS scope_grant (
  id TEXT PRIMARY KEY, request_id TEXT, team_id TEXT NOT NULL, member_id TEXT NOT NULL,
  domain TEXT NOT NULL, matcher TEXT NOT NULL, ops_json TEXT NOT NULL,
  single_use INTEGER NOT NULL DEFAULT 1, expires_at INTEGER,
  granted_by TEXT, used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grant_member ON scope_grant(team_id, member_id, domain);

CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
  request_id TEXT, options_json TEXT, chosen TEXT NOT NULL,
  decided_by TEXT, reason TEXT, evidence TEXT, decided_at TEXT NOT NULL,
  ttl_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  from_member TEXT NOT NULL, to_member TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note',
  correlation_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT NOT NULL, delivered_at TEXT, read_at TEXT, acked_at TEXT,
  ttl_seconds INTEGER, status TEXT NOT NULL DEFAULT 'queued'
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON message(team_id, to_member, sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_corr ON message(correlation_id);

CREATE TABLE IF NOT EXISTS todo (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, member_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', order_no INTEGER NOT NULL DEFAULT 0,
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, team_id TEXT NOT NULL,
  actor TEXT NOT NULL, domain TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  before_hash TEXT, after_hash TEXT, result TEXT NOT NULL DEFAULT 'OK',
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_team ON audit(team_id, id);

-- fs.write 的版本基线（C3/FR-3.6 乐观并发）
CREATE TABLE IF NOT EXISTS file_state (
  path TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
  hash TEXT, size INTEGER, updated_at TEXT NOT NULL
);
`;

const stmtCache = new WeakMap();

/** 返回带语句缓存的查询函数：(sql) => StatementSync */
export function q(db) {
  let m = stmtCache.get(db);
  if (!m) { m = new Map(); stmtCache.set(db, m); }
  return (sql) => {
    let st = m.get(sql);
    if (!st) { st = db.prepare(sql); m.set(sql, st); }
    return st;
  };
}

export function openDb(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');   // 进程崩溃可恢复；AC-9 用 SIGKILL 验证
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec('PRAGMA foreign_keys=OFF;');     // 关系由应用层维护（便于按 run 导出/清理）
  db.exec(DDL);
  // 轻量迁移：老库补列（不重建表）
  ensureColumn(db, 'team', 'auto_takeover', 'INTEGER NOT NULL DEFAULT 0');
  const get = q(db);
  const cur = get('SELECT value FROM meta WHERE key=?').get('schema_version');
  if (!cur) get('INSERT INTO meta (key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

let __txDepth = 0;
/** 事务包装：BEGIN IMMEDIATE / COMMIT / ROLLBACK；支持同进程嵌套（内层复用外层事务） */
export function tx(db, fn) {
  if (__txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  __txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    __txDepth--;
  }
}

export function closeDb(db) { try { db.close(); } catch { /* ignore */ } }

function ensureColumn(db, table, col, decl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  } catch { /* ignore */ }
}

// db.mjs — SQLite(WAL) schema 与事务助手（node:sqlite，零依赖）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 14;

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
  -- 团队默认权限预设（workspace-write / danger-full-access，或宿主自定义名）
  permission_preset TEXT NOT NULL DEFAULT 'workspace-write',
  -- 团队默认 agent 组合预设；NULL = 不指定（沿用宿主默认）
  agent_preset TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT, model TEXT, context_mode TEXT,
  default_plan_json TEXT, quota_json TEXT,
  agent_session_id TEXT, reasoning_effort TEXT,
  -- 成员子会话的直接父会话（Lead）；面板/看板停止时 Host 用它做 user 授权 interrupt
  parent_session_id TEXT,
  -- 成员创建会话时实际使用的 LLM provider；NULL = 继承 Lead / 旧数据
  agent_provider TEXT,
  -- 成员级覆盖；NULL = 继承 team.permission_preset
  permission_preset TEXT,
  -- 成员级 agent 组合预设；NULL = 继承 team.agent_preset
  agent_preset TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_member_team ON member(team_id);
-- idx_member_session 建在迁移之后（老库此时还没有 agent_session_id 列，见 openDb）

-- 由 event 完全可重建的投影（C2）。只放事件可推导的字段。
CREATE TABLE IF NOT EXISTS member_state (
  member_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0,
  step TEXT, phase TEXT, status TEXT NOT NULL DEFAULT 'queued',
  last TEXT, next TEXT, blockers_json TEXT NOT NULL DEFAULT '[]',
  as_of TEXT, stale INTEGER NOT NULL DEFAULT 0
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

-- 权限审批：成员会话在 permission preset 的 approval=ask 下触发的审批。
-- sidecar 只做待办/审计镜像，真正的允许/拒绝由 Host 插件里的 team_approve 决定并回填。
CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  member_id TEXT, session_id TEXT,
  tool_name TEXT NOT NULL DEFAULT '', reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_team ON approval(team_id, status, created_at);

-- agentPreset 目录镜像：Host 插件同步过来，面板只读；删除是「面板排队 → 插件执行」。
CREATE TABLE IF NOT EXISTS preset (
  id TEXT PRIMARY KEY, name TEXT, description TEXT, ord INTEGER,
  source TEXT NOT NULL DEFAULT 'team', file TEXT, broken TEXT,
  doc_json TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS preset_delete (
  id TEXT PRIMARY KEY, requested_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  -- 进入执行 / 完成的时间：看板用它算每个 todo 的实际用时（老库由 ensureColumn 补列）
  started_at TEXT, done_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, team_id TEXT NOT NULL,
  actor TEXT NOT NULL, domain TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  before_hash TEXT, after_hash TEXT, result TEXT NOT NULL DEFAULT 'OK',
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_team ON audit(team_id, id);

-- Trace 瀑布（成员看板）：显式上报的跨度。Worker 步骤跨度由 event 现场推导，不入此表。
-- 幂等：客户端用稳定的 span_id（如 tool:<session>:<callId>）上报 running → done/failed 两次。
CREATE TABLE IF NOT EXISTS span (
  span_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  member_id TEXT, session_id TEXT, parent_id TEXT,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'tool',
  status TEXT NOT NULL DEFAULT 'running',
  start_ms INTEGER NOT NULL, end_ms INTEGER,
  detail TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost REAL,
  input_text TEXT, output_text TEXT, error TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_span_team ON span(team_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_span_parent ON span(team_id, parent_id);

-- 成员产物：Host 插件从成员会话里采集（present 声明的交付文件 / workspace 变更文件），
-- 面板「实时收件箱」按任务展示。同一团队同一路径只留最新一条。
CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  task_id TEXT, member_id TEXT,
  path TEXT NOT NULL, label TEXT,
  source TEXT NOT NULL DEFAULT 'present',
  added INTEGER, deleted INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(team_id, path)
);
CREATE INDEX IF NOT EXISTS idx_artifact_team ON artifact(team_id, created_at);

-- 成员改动：Host 插件在成员 write/edit 落盘后上报的 unified diff，
-- 面板「审阅」页只读展示（审批/合并不在 sidecar 职责内）。
CREATE TABLE IF NOT EXISTS member_change (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  task_id TEXT, member_id TEXT,
  path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'edit',
  diff TEXT NOT NULL DEFAULT '',
  added INTEGER, deleted INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_team ON member_change(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_change_member ON member_change(team_id, member_id);

-- 成员上下文快照：Host 插件从 DSH 会话（token 计量 + 上下文投影 + 会话事件）算出
-- 「上下文窗口被什么占满」，面板「上下文分析」页按成员展示。每个成员只留最新一条；
-- compaction 的 before 侧在写入时从前一条快照里取，因此历史只在这一次切换中用到。
CREATE TABLE IF NOT EXISTS context_snapshot (
  team_id TEXT NOT NULL, member_id TEXT NOT NULL,
  session_id TEXT, model TEXT, provider TEXT,
  limit_tokens INTEGER, used_tokens INTEGER,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  blocks_json TEXT NOT NULL DEFAULT '[]',
  compaction_json TEXT,
  status TEXT, as_of_seq INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_context_team ON context_snapshot(team_id, updated_at);

-- DSH 工作区注册表快照：Host 插件把 ctx.workspaceRegistry.list() 整表推过来，
-- 面板左侧「工作区」下拉据此切换，团队成员选择器只显示当前工作区下的团队。
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- fs.write 的版本基线（C3/FR-3.6 乐观并发）
CREATE TABLE IF NOT EXISTS file_state (
  path TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
  hash TEXT, size INTEGER, updated_at TEXT NOT NULL
);

-- DSH 模型路由目录：Host 插件把 ctx.llm 的 provider/model 映射同步进来，
-- 面板据此勾选可用项；sidecar 不持有任何 LLM 客户端或凭据。
CREATE TABLE IF NOT EXISTS llm_provider (
  provider TEXT PRIMARY KEY, name TEXT,
  source TEXT NOT NULL DEFAULT 'live', error TEXT, synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_route (
  provider TEXT NOT NULL, model TEXT NOT NULL,
  name TEXT, description TEXT, modalities_json TEXT, context_window INTEGER,
  source TEXT NOT NULL DEFAULT 'live',
  -- 适配器声明的可选思考强度（[{id,name,description?}]）与默认值；NULL = 该次同步未知
  efforts_json TEXT, default_effort TEXT,
  -- 用户允许派发给该 route 的 effort 子集；NULL = 全部允许
  allowed_efforts_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, note TEXT,
  synced_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS idx_llm_route_enabled ON llm_route(enabled);

-- ---------- 工作区任务看板（v12） ----------
-- 与 team 内 DAG 的 task 无关：这里一行 = 用户创建的一张看板任务卡。
CREATE TABLE IF NOT EXISTS board_settings (
  workspace_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL DEFAULT '',
  planning_concurrency INTEGER NOT NULL DEFAULT 1,
  inprogress_concurrency INTEGER NOT NULL DEFAULT 1,
  show_task_sessions INTEGER NOT NULL DEFAULT 1,
  plan_provider TEXT, plan_model TEXT, plan_reasoning_effort TEXT,
  lead_provider TEXT, lead_model TEXT, lead_reasoning_effort TEXT,
  plan_permission_preset TEXT NOT NULL DEFAULT 'read-only',
  lead_permission_preset TEXT NOT NULL DEFAULT 'danger-full-access',
  plan_agent_preset TEXT, lead_agent_preset TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_task (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  auto INTEGER NOT NULL DEFAULT 0,
  execution_mode TEXT NOT NULL DEFAULT 'same',
  priority INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  plan_provider TEXT, plan_model TEXT, plan_reasoning_effort TEXT,
  lead_provider TEXT, lead_model TEXT, lead_reasoning_effort TEXT,
  team_models_json TEXT,
  plan_md TEXT, plan_summary TEXT,
  planning_session_id TEXT, lead_session_id TEXT,
  claim_token TEXT, claimed_at TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  resumed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_board_task_ws ON board_task(workspace_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_board_task_plan_session ON board_task(planning_session_id);
CREATE INDEX IF NOT EXISTS idx_board_task_lead_session ON board_task(lead_session_id);

CREATE TABLE IF NOT EXISTS board_task_team (
  task_id TEXT NOT NULL, team_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_board_task_team_team ON board_task_team(team_id);

CREATE TABLE IF NOT EXISTS board_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_event_task ON board_event(task_id, id);
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
  ensureColumn(db, 'team', 'permission_preset', "TEXT NOT NULL DEFAULT 'workspace-write'");
  ensureColumn(db, 'team', 'agent_preset', 'TEXT');
  ensureColumn(db, 'team', 'archived_at', 'TEXT');
  ensureColumn(db, 'team', 'lead_session_id', 'TEXT');
  ensureColumn(db, 'member', 'agent_session_id', 'TEXT');
  ensureColumn(db, 'member', 'reasoning_effort', 'TEXT');
  ensureColumn(db, 'member', 'permission_preset', 'TEXT');
  ensureColumn(db, 'member', 'agent_preset', 'TEXT');
  ensureColumn(db, 'member', 'agent_provider', 'TEXT');
  ensureColumn(db, 'member', 'parent_session_id', 'TEXT');
  ensureColumn(db, 'llm_route', 'efforts_json', 'TEXT');
  ensureColumn(db, 'llm_route', 'default_effort', 'TEXT');
  ensureColumn(db, 'llm_route', 'allowed_efforts_json', 'TEXT');
  ensureColumn(db, 'todo', 'task_id', 'TEXT');
  ensureColumn(db, 'todo', 'started_at', 'TEXT');
  ensureColumn(db, 'todo', 'done_at', 'TEXT');
  ensureColumn(db, 'artifact', 'added', 'INTEGER');
  ensureColumn(db, 'artifact', 'deleted', 'INTEGER');
  ensureColumn(db, 'preset', 'doc_json', 'TEXT');
  ensureColumn(db, 'board_task', 'resumed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'board_settings', 'show_task_sessions', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'preset_delete', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'preset_delete', 'last_error', 'TEXT');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_todo_task ON todo(task_id, order_no)'); } catch { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_member_session ON member(agent_session_id)'); } catch { /* ignore */ }
  const get = q(db);
  const cur = get('SELECT value FROM meta WHERE key=?').get('schema_version');
  if (!cur) get('INSERT INTO meta (key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION));
  else if (Number(cur.value) < SCHEMA_VERSION) {
    if (Number(cur.value) < 8) {
      // v8：移除 worker 四域权限模块，旧库里的策略/scope/决策/租约表一并清掉。
      for (const table of ['policy', 'scope_request', 'scope_grant', 'decision', 'member_runtime']) {
        try { db.exec(`DROP TABLE IF EXISTS ${table}`); } catch { /* ignore */ }
      }
    }
    get('UPDATE meta SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema_version');
  }
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

// board.mjs — 工作区任务看板：状态机、并发槽位、claim/attach、计划与事件
// 只看库，不建会话；会话由 Host 插件按 claim 结果创建。
import { tx } from './db.mjs';
import { ERR, nowIso, newId, json, parseJson, clamp } from './util.mjs';

export const BOARD_STATUSES = ['todo', 'planning', 'planned', 'inprogress', 'done', 'failed'];
const ACTIVE = new Set(['planning', 'planned', 'inprogress']);
const MODES = new Set(['same', 'new']);

const DEFAULT_SETTINGS = {
  planningConcurrency: 1,
  inprogressConcurrency: 1,
  // 默认把看板创建的规划/执行会话挂进 DSH 工作区会话列表
  showTaskSessions: true,
  planProvider: null, planModel: null, planReasoningEffort: null,
  leadProvider: null, leadModel: null, leadReasoningEffort: null,
  planPermissionPreset: 'read-only',
  leadPermissionPreset: 'danger-full-access',
  planAgentPreset: null, leadAgentPreset: null,
};

const asInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(Math.trunc(n), lo, hi) : dflt;
};
const asBool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const text = (v, max = 20000) => String(v ?? '').slice(0, max);
const routeOf = (row, prefix) => ({
  provider: row[`${prefix}_provider`] || null,
  model: row[`${prefix}_model`] || null,
  reasoningEffort: row[`${prefix}_reasoning_effort`] || null,
});

function settingsFromRow(row, workspaceId, workspacePath) {
  if (!row) return { workspaceId, workspacePath: workspacePath || '', ...DEFAULT_SETTINGS, updatedAt: null };
  return {
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path || workspacePath || '',
    planningConcurrency: row.planning_concurrency,
    inprogressConcurrency: row.inprogress_concurrency,
    showTaskSessions: row.show_task_sessions === undefined || row.show_task_sessions === null
      ? true
      : !!row.show_task_sessions,
    planProvider: row.plan_provider || null,
    planModel: row.plan_model || null,
    planReasoningEffort: row.plan_reasoning_effort || null,
    leadProvider: row.lead_provider || null,
    leadModel: row.lead_model || null,
    leadReasoningEffort: row.lead_reasoning_effort || null,
    planPermissionPreset: row.plan_permission_preset,
    leadPermissionPreset: row.lead_permission_preset,
    planAgentPreset: row.plan_agent_preset || null,
    leadAgentPreset: row.lead_agent_preset || null,
    updatedAt: row.updated_at || null,
  };
}

export class Board {
  constructor({ db, get, sse, log = () => {} }) {
    this.db = db;
    this.get = get;
    this.sse = sse;
    this.log = log;
  }

  // ---------- 基础查询 ----------
  workspace(workspaceId) {
    return this.get('SELECT * FROM workspace WHERE id=?').get(String(workspaceId)) || null;
  }

  settingsRow(workspaceId) {
    return this.get('SELECT * FROM board_settings WHERE workspace_id=?').get(String(workspaceId)) || null;
  }

  settings(workspaceId, workspacePath) {
    const ws = this.workspace(workspaceId);
    return {
      ...settingsFromRow(this.settingsRow(workspaceId), String(workspaceId), workspacePath || ws?.path || ''),
      // Host 插件上报的 DSH Web 地址：独立面板据此 window.open 深链打开会话
      dshWebUrl: this.hostWebUrl(),
    };
  }

  // ---------- DSH Web 地址（Host 上报，meta 表存一份） ----------
  hostWebUrl() {
    const row = this.get('SELECT value FROM meta WHERE key=?').get('host_web_url');
    return row?.value || null;
  }

  reportHostWeb(url) {
    const raw = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]{1,300}$/i.test(raw)) throw ERR.bad('url must be an http(s) origin');
    this.get('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('host_web_url', raw);
    return { url: raw };
  }

  saveSettings(workspaceId, body = {}) {
    const ws = this.workspace(workspaceId);
    const cur = this.settings(workspaceId, body.workspacePath || ws?.path || '');
    const s = {
      ...cur,
      planningConcurrency: asInt(body.planningConcurrency, 0, 64, cur.planningConcurrency),
      inprogressConcurrency: asInt(body.inprogressConcurrency, 0, 64, cur.inprogressConcurrency),
      showTaskSessions: body.showTaskSessions !== undefined ? !!asBool(body.showTaskSessions) : cur.showTaskSessions,
      planProvider: body.planProvider !== undefined ? (body.planProvider || null) : cur.planProvider,
      planModel: body.planModel !== undefined ? (body.planModel || null) : cur.planModel,
      planReasoningEffort: body.planReasoningEffort !== undefined ? (body.planReasoningEffort || null) : cur.planReasoningEffort,
      leadProvider: body.leadProvider !== undefined ? (body.leadProvider || null) : cur.leadProvider,
      leadModel: body.leadModel !== undefined ? (body.leadModel || null) : cur.leadModel,
      leadReasoningEffort: body.leadReasoningEffort !== undefined ? (body.leadReasoningEffort || null) : cur.leadReasoningEffort,
      planPermissionPreset: text(body.planPermissionPreset ?? cur.planPermissionPreset, 64) || 'read-only',
      leadPermissionPreset: text(body.leadPermissionPreset ?? cur.leadPermissionPreset, 64) || 'danger-full-access',
      planAgentPreset: body.planAgentPreset !== undefined ? (body.planAgentPreset || null) : cur.planAgentPreset,
      leadAgentPreset: body.leadAgentPreset !== undefined ? (body.leadAgentPreset || null) : cur.leadAgentPreset,
    };
    const t = nowIso();
    this.get(`INSERT INTO board_settings
      (workspace_id, workspace_path, planning_concurrency, inprogress_concurrency, show_task_sessions,
       plan_provider, plan_model, plan_reasoning_effort,
       lead_provider, lead_model, lead_reasoning_effort,
       plan_permission_preset, lead_permission_preset, plan_agent_preset, lead_agent_preset,
       created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        workspace_path=excluded.workspace_path,
        planning_concurrency=excluded.planning_concurrency,
        inprogress_concurrency=excluded.inprogress_concurrency,
        show_task_sessions=excluded.show_task_sessions,
        plan_provider=excluded.plan_provider, plan_model=excluded.plan_model,
        plan_reasoning_effort=excluded.plan_reasoning_effort,
        lead_provider=excluded.lead_provider, lead_model=excluded.lead_model,
        lead_reasoning_effort=excluded.lead_reasoning_effort,
        plan_permission_preset=excluded.plan_permission_preset,
        lead_permission_preset=excluded.lead_permission_preset,
        plan_agent_preset=excluded.plan_agent_preset,
        lead_agent_preset=excluded.lead_agent_preset,
        updated_at=excluded.updated_at`)
      .run(s.workspaceId, s.workspacePath, s.planningConcurrency, s.inprogressConcurrency,
        s.showTaskSessions ? 1 : 0,
        s.planProvider, s.planModel, s.planReasoningEffort,
        s.leadProvider, s.leadModel, s.leadReasoningEffort,
        s.planPermissionPreset, s.leadPermissionPreset, s.planAgentPreset, s.leadAgentPreset,
        t, t);
    return this.settings(workspaceId);
  }

  // ---------- 任务视图 ----------
  teamsOf(taskId) {
    return this.get('SELECT team_id FROM board_task_team WHERE task_id=? ORDER BY created_at').all(taskId).map((r) => r.team_id);
  }

  hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      title: row.title,
      description: row.description,
      status: row.status,
      auto: !!row.auto,
      executionMode: row.execution_mode,
      priority: row.priority,
      position: row.position,
      planRoute: routeOf(row, 'plan'),
      leadRoute: routeOf(row, 'lead'),
      teamModels: parseJson(row.team_models_json, null),
      planMd: row.plan_md || null,
      planSummary: row.plan_summary || null,
      planningSessionId: row.planning_session_id || null,
      leadSessionId: row.lead_session_id || null,
      claimedAt: row.claimed_at || null,
      stopRequested: !!row.stop_requested,
      resumed: !!row.resumed,
      lastError: row.last_error || null,
      archivedAt: row.archived_at || null,
      teams: this.teamsOf(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at || null,
    };
  }

  getTask(id) {
    const row = this.get('SELECT * FROM board_task WHERE id=?').get(String(id));
    if (!row) throw ERR.notFound('board task');
    return this.hydrate(row);
  }

  addEvent(task, kind, detail = null) {
    if (!task) return;
    this.get('INSERT INTO board_event (task_id, workspace_id, kind, detail_json, created_at) VALUES (?,?,?,?,?)')
      .run(task.id, task.workspaceId, kind, detail ? json(detail) : null, nowIso());
    try {
      this.sse?.broadcastSynthetic('board.task', { task });
    } catch { /* ignore */ }
  }

  count(workspaceId, status) {
    return this.get('SELECT COUNT(*) AS n FROM board_task WHERE workspace_id=? AND status=? AND archived_at IS NULL')
      .get(String(workspaceId), status).n;
  }

  view(workspaceId, { archived = false } = {}) {
    const ws = this.workspace(workspaceId);
    const settings = this.settings(workspaceId, ws?.path || '');
    const rows = archived
      ? this.get('SELECT * FROM board_task WHERE workspace_id=? AND archived_at IS NOT NULL ORDER BY updated_at DESC LIMIT 500').all(String(workspaceId))
      : this.get('SELECT * FROM board_task WHERE workspace_id=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 500').all(String(workspaceId));
    const counts = Object.fromEntries(BOARD_STATUSES.map((s) => [s, 0]));
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    return {
      workspace: ws ? { id: ws.id, title: ws.title, path: ws.path } : { id: String(workspaceId), title: '', path: settings.workspacePath },
      settings,
      counts,
      slots: {
        planning: { used: this.count(workspaceId, 'planning'), limit: settings.planningConcurrency },
        inprogress: { used: this.count(workspaceId, 'inprogress'), limit: settings.inprogressConcurrency },
      },
      tasks: rows.map((r) => this.hydrate(r)),
    };
  }

  live() {
    // 活跃任务用于推进；终态但仍有 lead 会话的任务也带上，插件重启后
    // 才能继续监听用户追问（done→inprogress）。
    const rows = this.get(`SELECT * FROM board_task WHERE archived_at IS NULL AND (
      status IN ('planning','planned','inprogress') OR (status IN ('done','failed') AND lead_session_id IS NOT NULL)
    ) ORDER BY updated_at DESC LIMIT 200`).all();
    return { tasks: rows.map((r) => this.hydrate(r)) };
  }

  bySession(sessionId) {
    const sid = String(sessionId);
    const row = this.get('SELECT * FROM board_task WHERE lead_session_id=? OR planning_session_id=? ORDER BY updated_at DESC LIMIT 1').get(sid, sid);
    return row ? this.hydrate(row) : null;
  }

  byTeam(teamId) {
    const row = this.get(`SELECT t.* FROM board_task t JOIN board_task_team bt ON bt.task_id=t.id
      WHERE bt.team_id=? ORDER BY t.updated_at DESC LIMIT 1`).get(String(teamId));
    return row ? this.hydrate(row) : null;
  }

  // ---------- 写 ----------
  createTask(body = {}) {
    const workspaceId = text(body.workspaceId, 200);
    if (!workspaceId) throw ERR.bad('workspaceId required');
    const ws = this.workspace(workspaceId);
    const workspacePath = text(body.workspacePath || ws?.path || '', 4000);
    if (!workspacePath) throw ERR.bad('workspace path not found');
    const title = text(body.title, 500).trim();
    if (!title) throw ERR.bad('title required');
    const mode = MODES.has(body.executionMode) ? body.executionMode : 'same';
    const id = newId('bt');
    const t = nowIso();
    const teamModels = Array.isArray(body.teamModels) ? body.teamModels.slice(0, 100) : null;
    this.get(`INSERT INTO board_task
      (id, workspace_id, workspace_path, title, description, status, auto, execution_mode, priority, position,
       plan_provider, plan_model, plan_reasoning_effort, lead_provider, lead_model, lead_reasoning_effort,
       team_models_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, workspaceId, workspacePath, title, text(body.description, 100000), 'todo', asBool(body.auto), mode,
        asInt(body.priority, -1000, 1000, 0), asInt(body.position, 0, 1e9, 0),
        body.planRoute?.provider || body.planProvider || null,
        body.planRoute?.model || body.planModel || null,
        body.planRoute?.reasoningEffort || body.planReasoningEffort || null,
        body.leadRoute?.provider || body.leadProvider || null,
        body.leadRoute?.model || body.leadModel || null,
        body.leadRoute?.reasoningEffort || body.leadReasoningEffort || null,
        teamModels ? json(teamModels) : null, t, t);
    const task = this.getTask(id);
    this.addEvent(task, 'created', { auto: task.auto, executionMode: mode });
    return task;
  }

  updateTask(id, body = {}) {
    const cur = this.getTask(id);
    if (cur.archivedAt) throw ERR.invalidState('task archived');
    const fields = [];
    const vals = [];
    const set = (col, val) => { fields.push(`${col}=?`); vals.push(val); };
    if (body.title !== undefined) {
      const v = text(body.title, 500).trim();
      if (!v) throw ERR.bad('title required');
      set('title', v);
    }
    if (body.description !== undefined) set('description', text(body.description, 100000));
    if (body.auto !== undefined) set('auto', asBool(body.auto));
    if (body.executionMode !== undefined) {
      if (!MODES.has(body.executionMode)) throw ERR.bad('executionMode must be same|new');
      set('execution_mode', body.executionMode);
    }
    if (body.priority !== undefined) set('priority', asInt(body.priority, -1000, 1000, cur.priority));
    const routeFields = [
      ['planProvider', 'plan_provider', 'planRoute'], ['planModel', 'plan_model', 'planRoute'], ['planReasoningEffort', 'plan_reasoning_effort', 'planRoute'],
      ['leadProvider', 'lead_provider', 'leadRoute'], ['leadModel', 'lead_model', 'leadRoute'], ['leadReasoningEffort', 'lead_reasoning_effort', 'leadRoute'],
    ];
    for (const [k, col, routeKey] of routeFields) {
      const prop = k.replace(/^(plan|lead)/, '');
      const nestedKey = prop ? prop[0].toLowerCase() + prop.slice(1) : '';
      const v = body[k] !== undefined ? body[k] : body[routeKey]?.[nestedKey];
      if (v !== undefined) set(col, v || null);
    }
    if (body.teamModels !== undefined) set('team_models_json', Array.isArray(body.teamModels) ? json(body.teamModels.slice(0, 100)) : null);
    if (!fields.length) return cur;
    set('updated_at', nowIso());
    this.get(`UPDATE board_task SET ${fields.join(', ')} WHERE id=?`).run(...vals, cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'updated', null);
    return task;
  }

  startTask(id, body = {}) {
    const cur = this.getTask(id);
    if (!['todo', 'planned'].includes(cur.status)) throw ERR.invalidState(`cannot start from ${cur.status}`);
    if (cur.archivedAt) throw ERR.invalidState('task archived');
    const mode = MODES.has(body.executionMode) ? body.executionMode : cur.executionMode;
    this.get('UPDATE board_task SET auto=1, execution_mode=?, stop_requested=0, last_error=NULL, updated_at=? WHERE id=?')
      .run(mode, nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'start', { executionMode: mode });
    return task;
  }

  stopTask(id, body = {}) {
    const cur = this.getTask(id);
    if (!ACTIVE.has(cur.status)) throw ERR.invalidState(`cannot stop from ${cur.status}`);
    this.get(`UPDATE board_task SET status='failed', stop_requested=1, claim_token=NULL, claimed_at=NULL,
      last_error=?, updated_at=? WHERE id=?`).run(text(body.reason || 'stopped by user', 1000), nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'stopped', { reason: task.lastError });
    return task;
  }

  retryTask(id) {
    const cur = this.getTask(id);
    if (!['failed', 'done'].includes(cur.status)) throw ERR.invalidState(`cannot retry from ${cur.status}`);
    const next = cur.planMd ? 'planned' : 'todo';
    this.get(`UPDATE board_task SET status=?, auto=1, stop_requested=0, claim_token=NULL, claimed_at=NULL,
      planning_session_id=NULL, lead_session_id=NULL, resumed=0, last_error=NULL, done_at=NULL, updated_at=? WHERE id=?`)
      .run(next, nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'retried', { status: next });
    return task;
  }

  archiveTask(id, body = {}) {
    const cur = this.getTask(id);
    if (ACTIVE.has(cur.status)) throw ERR.invalidState('stop the task before archiving');
    this.get('UPDATE board_task SET archived_at=?, auto=0, updated_at=? WHERE id=?')
      .run(nowIso(), nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'archived', { reason: text(body.reason || '', 500) || null });
    return task;
  }

  deleteTask(id) {
    const cur = this.getTask(id);
    if (ACTIVE.has(cur.status)) throw ERR.invalidState('stop the task before deleting');
    tx(this.db, () => {
      this.get('DELETE FROM board_task_team WHERE task_id=?').run(cur.id);
      this.get('DELETE FROM board_event WHERE task_id=?').run(cur.id);
      this.get('DELETE FROM board_task WHERE id=?').run(cur.id);
    });
    try {
      this.sse?.broadcastSynthetic('board.task', { taskId: cur.id, workspaceId: cur.workspaceId, deleted: true });
    } catch { /* SSE 只是提示，删除已落库 */ }
    return { ok: true, id: cur.id };
  }

  restoreTask(id) {
    const cur = this.getTask(id);
    if (!cur.archivedAt) throw ERR.invalidState('task is not archived');
    this.get("UPDATE board_task SET archived_at=NULL, status='todo', auto=0, resumed=0, updated_at=? WHERE id=?").run(nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'restored', null);
    return task;
  }

  bindTeam(taskId, teamId) {
    const task = this.getTask(taskId);
    this.get('INSERT OR IGNORE INTO board_task_team (task_id, team_id, created_at) VALUES (?,?,?)')
      .run(task.id, String(teamId), nowIso());
    const next = this.getTask(task.id);
    this.addEvent(next, 'team.bound', { teamId: String(teamId) });
    return next;
  }

  // ---------- claim / attach / plan ----------
  claim(kind) {
    if (!['planning', 'inprogress'].includes(kind)) throw ERR.bad('kind must be planning|inprogress');
    const from = kind === 'planning' ? 'todo' : 'planned';
    const stamp = nowIso();
    const rows = this.get(`SELECT * FROM board_task WHERE status=? AND archived_at IS NULL AND stop_requested=0
      ${kind === 'planning' ? 'AND auto=1' : ''} ORDER BY priority DESC, position ASC, created_at ASC`).all(from);
    for (const row of rows) {
      const settings = this.settings(row.workspace_id, row.workspace_path);
      const limit = kind === 'planning' ? settings.planningConcurrency : settings.inprogressConcurrency;
      if (limit <= 0) continue;
      if (this.count(row.workspace_id, kind === 'planning' ? 'planning' : 'inprogress') >= limit) continue;
      const token = newId('claim');
      const out = tx(this.db, () => {
        const used = this.count(row.workspace_id, kind === 'planning' ? 'planning' : 'inprogress');
        if (used >= limit) return null;
        const r = this.get(`UPDATE board_task SET status=?, claim_token=?, claimed_at=?, updated_at=?
          WHERE id=? AND status=?`).run(kind, token, stamp, stamp, row.id, from);
        return r.changes ? this.getTask(row.id) : null;
      });
      if (!out) continue;
      this.addEvent(out, kind === 'planning' ? 'planning.claimed' : 'inprogress.claimed', { claimToken: token });
      const ws = this.workspace(out.workspaceId);
      return { item: { task: out, workspace: { id: out.workspaceId, path: out.workspacePath, title: ws?.title || '' }, settings, fence: token } };
    }
    return { item: null };
  }

  attach(taskId, { kind, sessionId, fence, claimToken } = {}) {
    if (!['planning', 'inprogress'].includes(kind)) throw ERR.bad('kind must be planning|inprogress');
    const sid = text(sessionId, 200);
    if (!sid) throw ERR.bad('sessionId required');
    const cur = this.getTask(taskId);
    if (cur.archivedAt) throw ERR.invalidState('task archived');
    const token = fence || claimToken;
    if (cur.claimToken && token && cur.claimToken !== token) throw ERR.conflict('claim fence mismatch');
    const expected = kind === 'planning' ? 'planning' : 'inprogress';
    if (cur.status !== expected) throw ERR.invalidState(`task is ${cur.status}, expected ${expected}`);
    const col = kind === 'planning' ? 'planning_session_id' : 'lead_session_id';
    const resumed = kind === 'inprogress' ? 0 : cur.resumed ? 1 : 0;
    this.get(`UPDATE board_task SET ${col}=?, resumed=?, claim_token=NULL, claimed_at=NULL, updated_at=? WHERE id=?`).run(sid, resumed, nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, kind === 'planning' ? 'planning.attached' : 'lead.attached', { sessionId: sid });
    return task;
  }

  release(taskId, { kind, error } = {}) {
    const cur = this.getTask(taskId);
    if (!cur) return null;
    const msg = text(error || 'session spawn failed', 2000);
    this.get(`UPDATE board_task SET status='failed', claim_token=NULL, claimed_at=NULL, last_error=?, updated_at=? WHERE id=?`)
      .run(msg, nowIso(), cur.id);
    const task = this.getTask(cur.id);
    this.addEvent(task, 'released', { kind, error: msg });
    return task;
  }

  submitPlan(sessionId, body = {}) {
    const sid = text(sessionId, 200);
    const plan = text(body.plan, 500000);
    if (!sid) throw ERR.bad('sessionId required');
    if (!plan.trim()) throw ERR.bad('plan required');
    const row = this.get('SELECT * FROM board_task WHERE planning_session_id=? AND status=? ORDER BY updated_at DESC LIMIT 1')
      .get(sid, 'planning');
    if (!row) throw ERR.notFound('planning task for session');
    const same = row.execution_mode === 'same';
    this.get(`UPDATE board_task SET status='planned', plan_md=?, plan_summary=?, lead_session_id=?,
      claim_token=NULL, claimed_at=NULL, resumed=0, last_error=NULL, updated_at=? WHERE id=?`)
      .run(plan, text(body.summary, 2000) || null, same ? sid : null, nowIso(), row.id);
    const task = this.getTask(row.id);
    this.addEvent(task, 'planned', { summary: task.planSummary });
    return task;
  }

  setAgentStatus(sessionId, body = {}) {
    const sid = text(sessionId, 200);
    const status = body.status;
    if (!['done', 'failed', 'inprogress'].includes(status)) throw ERR.bad('status must be done|failed|inprogress');
    const row = this.get(`SELECT * FROM board_task WHERE (lead_session_id=? OR planning_session_id=?)
      AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`).get(sid, sid);
    if (!row) throw ERR.notFound('board task for session');
    const allowed = status === 'done' ? ['planned', 'inprogress']
      : status === 'failed' ? ['planning', 'planned', 'inprogress']
        : ['done', 'failed', 'inprogress'];
    if (!allowed.includes(row.status)) throw ERR.invalidState(`cannot set ${status} from ${row.status}`);
    const doneAt = status === 'done' ? nowIso() : null;
    // 只有「从终态回到 inprogress」才算一次用户追问；已经是 inprogress 的
    // 重复上报是幂等 no-op，不能把 resumed 置 1（否则会吞掉下一轮执行 prompt）。
    const resumed = status !== 'inprogress' ? 0 : ['done', 'failed'].includes(row.status) ? 1 : row.resumed ? 1 : 0;
    this.get(`UPDATE board_task SET status=?, resumed=?, last_error=?, done_at=?, claim_token=NULL, claimed_at=NULL, updated_at=? WHERE id=?`)
      .run(status, resumed, status === 'failed' ? text(body.summary, 2000) || 'failed' : null, doneAt, nowIso(), row.id);
    const task = this.getTask(row.id);
    this.addEvent(task, status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'inprogress', { summary: text(body.summary, 2000) || null });
    return task;
  }
}

// core.mjs — 组合根：装配 StateStore/EventStore/Scheduler/Bus/SSE，并承载业务查询
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb, q, tx } from './db.mjs';
import { EventStore, rowToEvent } from './eventstore.mjs';
import { Scheduler, rowToTask } from './scheduler.mjs';
import { MessageBus, rowToMessage } from './bus.mjs';
import { SseHub } from './sse.mjs';
import { LlmCatalog } from './llm.mjs';
import { Board } from './board.mjs';
import { MemoryStore } from './memory.mjs';
import {
  ERR, now, nowIso, newId, json, parseJson, clamp, redactor, REDACTED,
  isSensitiveName, percentile, sha256, truncate,
} from './util.mjs';

const STATUSES = ['queued', 'provisioning', 'idle', 'running', 'blocked', 'done', 'failed', 'interrupted', 'retired'];

/** 默认权限预设：Leader 不指定时成员在 workspace-write 沙箱里跑，越界操作走审批。 */
export const DEFAULT_PERMISSION_PRESET = 'workspace-write';
const PRESET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const normalizePreset = (name) => {
  const v = String(name ?? '').trim();
  if (!v) return DEFAULT_PERMISSION_PRESET;
  if (!PRESET_RE.test(v)) throw ERR.bad('permissionPreset must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  return v;
};
/** agent 组合预设：NULL/空 = 不指定（沿用宿主默认），非空按同一套命名规则校验。 */
const normalizeAgentPreset = (name) => {
  const v = String(name ?? '').trim();
  if (!v) return null;
  if (!PRESET_RE.test(v)) throw ERR.bad('agentPreset must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  return v;
};

export class DshTeam {
  constructor({ home, log = () => {} } = {}) {
    this.home = home;
    this.log = log;
    this.db = openDb(path.join(home, 'team.db'));
    this.get = q(this.db);
    this.llm = new LlmCatalog(this.db, this.get);
    this.sse = null;
    this.events = new EventStore(this.db, { onEvent: (ev) => { try { this.sse?.broadcastEvent(ev); } catch { /* ignore */ } } });
    this.sse = new SseHub({ events: this.events, log });
    this.bus = new MessageBus(this.db, {
      log,
      onDeliver: (m) => { try { this.sse.broadcastSynthetic('message.delivered', { teamId: m.teamId, memberId: m.to, messageId: m.id, to: m.to, status: m.status ?? 'delivered' }, { teamId: m.teamId }); } catch { /* ignore */ } },
      onWake: (memberId) => { try { this.wakeMember(memberId); } catch { /* ignore */ } },
    });
    this.scheduler = new Scheduler({ db: this.db, events: this.events, sse: this.sse, log });
    this.board = new Board({ db: this.db, get: this.get, sse: this.sse, log });
    // 记忆正文只存文件；归属（team/member/scope）记在 team 数据 memory_link。
    this.memory = new MemoryStore({ home, log });
    this.bindMemoryLinks();
    this.registerSecretsFromEnv();
    this.recovered = this.recoverAll();
  }

  registerSecretsFromEnv() {
    for (const [k, v] of Object.entries(process.env)) {
      if (!v || v.length < 6) continue;
      if (isSensitiveName(k)) redactor.addSecret(v);
    }
  }

  // ---------- 团队 ----------
  createTeam({ name, workspace, maxMembers = 64, maxConcurrency = 8, failurePolicy = 'continue', maxAttempts = 3, permissionPreset = DEFAULT_PERMISSION_PRESET, agentPreset = null, leadSessionId = null }) {
    if (!name) throw ERR.bad('name required');
    if (!workspace) throw ERR.bad('workspace required');
    const preset = normalizePreset(permissionPreset);
    const agent = normalizeAgentPreset(agentPreset);
    const abs = path.resolve(workspace);
    fs.mkdirSync(abs, { recursive: true });
    const id = newId('team');
    const t = nowIso();
    this.get(
      `INSERT INTO team (id, name, workspace, max_members, max_concurrency, failure_policy, max_attempts, permission_preset, agent_preset, lead_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, name, abs, Number(maxMembers), Number(maxConcurrency), failurePolicy, Number(maxAttempts), preset, agent, leadSessionId ? String(leadSessionId) : null, t, t);
    return this.teamView(this.get('SELECT * FROM team WHERE id=?').get(id));
  }

  /** 会话（Lead）→ 团队：面板据此在「本会话刚创建团队」时把编排页推出来。 */
  teamByLead(sessionId) {
    const sid = sessionId ? String(sessionId) : '';
    if (!sid) return null;
    const row = this.get(
      'SELECT * FROM team WHERE lead_session_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1'
    ).get(sid);
    return row ? this.teamView(row) : null;
  }

  teamView(t) {
    if (!t) return null;
    return {
      id: t.id, name: t.name, workspace: t.workspace,
      leadSessionId: t.lead_session_id || null,
      maxMembers: Number(t.max_members), maxConcurrency: Number(t.max_concurrency),
      failurePolicy: t.failure_policy, maxAttempts: Number(t.max_attempts),
      permissionPreset: t.permission_preset || DEFAULT_PERMISSION_PRESET,
      agentPreset: t.agent_preset || null,
      archivedAt: t.archived_at || null,
      createdAt: t.created_at,
      ...this.teamRunState(t.id),
    };
  }

  /** 团队运行状态（面板 badge / 停止按钮共用口径）：running > blocked > idle > empty */
  teamRunState(teamId) {
    const row = this.get(
      `SELECT COUNT(*) AS members,
              COALESCE(SUM(CASE WHEN COALESCE(s.status,'idle') IN ('running','provisioning') THEN 1 ELSE 0 END),0) AS running,
              COALESCE(SUM(CASE WHEN s.status='blocked' THEN 1 ELSE 0 END),0) AS blocked
         FROM member m LEFT JOIN member_state s ON s.member_id=m.id
        WHERE m.team_id=? AND COALESCE(s.status,'idle') <> 'retired'`
    ).get(teamId) || {};
    const memberCount = Number(row.members || 0);
    const runningCount = Number(row.running || 0);
    const blockedCount = Number(row.blocked || 0);
    return {
      memberCount, runningCount, blockedCount,
      status: runningCount > 0 ? 'running' : blockedCount > 0 ? 'blocked' : memberCount > 0 ? 'idle' : 'empty',
    };
  }

  getTeam(id) {
    const t = this.get('SELECT * FROM team WHERE id=?').get(id);
    if (!t) throw ERR.notFound('team');
    return t;
  }

  /** 团队列表：默认只列未封存；archived=true 只列已封存（按封存时间倒序） */
  listTeams({ archived = false } = {}) {
    if (!archived) { try { this.autoArchiveSweep(); } catch { /* 自动封存失败不影响列表 */ } }
    const rows = archived
      ? this.get('SELECT * FROM team WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all()
      : this.get('SELECT * FROM team WHERE archived_at IS NULL ORDER BY created_at ASC').all();
    return rows.map((t) => this.teamView(t));
  }

  patchTeam(id, body = {}) {
    const t = this.getTeam(id);
    const map = { name: 'name', workspace: 'workspace', maxMembers: 'max_members', maxConcurrency: 'max_concurrency', failurePolicy: 'failure_policy', maxAttempts: 'max_attempts' };
    const sets = []; const args = [];
    for (const [k, col] of Object.entries(map)) {
      if (body[k] !== undefined) { sets.push(`${col}=?`); args.push(body[k]); }
    }
    if (body.permissionPreset !== undefined) { sets.push('permission_preset=?'); args.push(normalizePreset(body.permissionPreset)); }
    if (body.agentPreset !== undefined) { sets.push('agent_preset=?'); args.push(normalizeAgentPreset(body.agentPreset)); }
    if (!sets.length) return this.teamView(t);
    sets.push('updated_at=?'); args.push(nowIso(), id);
    this.get(`UPDATE team SET ${sets.join(', ')} WHERE id=?`).run(...args);
    return this.teamView(this.getTeam(id));
  }

  /** 停止团队：中断所有活跃成员、在途任务转 paused（保留任务与成员，Lead 可再派发）。 */
  stopTeam(teamId, reason = 'panel stop') {
    this.getTeam(teamId);
    const ids = this.get(
      `SELECT m.id FROM member m JOIN member_state s ON s.member_id=m.id
        WHERE m.team_id=? AND s.status IN ('running','provisioning','blocked')`
    ).all(teamId).map((r) => r.id);
    const stopped = [];
    for (const id of ids) {
      // 竞态下成员可能已自行结束：interrupt 抛 invalidState 时跳过
      try { this.interruptMember(id, reason); stopped.push(id); } catch { /* ignore */ }
    }
    this.get("UPDATE task SET status='paused', updated_at=? WHERE team_id=? AND status='running'").run(nowIso(), teamId);
    return { ...this.teamView(this.getTeam(teamId)), stopped };
  }

  /** 删除团队：在一个事务里清掉所有 team_id 相关行（库无外键，手工级联）。 */
  deleteTeam(teamId, { confirm = false } = {}) {
    const t = this.getTeam(teamId);
    if (!confirm) throw ERR.bad('delete requires confirm=1');
    const memberIds = this.get('SELECT id FROM member WHERE team_id=?').all(teamId).map((r) => r.id);
    const memoryIds = this.get('SELECT memory_id FROM memory_link WHERE team_id=?').all(teamId).map((r) => r.memory_id);
    tx(this.db, () => {
      for (const id of memberIds) this.get('DELETE FROM member_state WHERE member_id=?').run(id);
      for (const table of ['member', 'task', 'dep', 'event', 'approval', 'message', 'todo', 'audit', 'span', 'artifact', 'member_change', 'context_snapshot', 'memory_link']) {
        this.get(`DELETE FROM ${table} WHERE team_id=?`).run(teamId);
      }
      this.get('DELETE FROM team WHERE id=?').run(teamId);
    });
    for (const id of memoryIds) this.memory.unbind(id);
    return { removed: true, id: teamId, name: t.name };
  }

  // ---------- 封存 / 面板设置 ----------
  /** 面板全局设置（meta 表 JSON；默认自动封存开启、7 天） */
  panelSettings() {
    const row = this.get('SELECT value FROM meta WHERE key=?').get('panel_settings');
    const s = parseJson(row ? row.value : null, null) || {};
    const auto = s.autoArchive || {};
    return { autoArchive: { enabled: auto.enabled !== false, days: clamp(Math.round(Number(auto.days) || 7), 1, 365) } };
  }

  patchPanelSettings(body = {}) {
    const next = this.panelSettings();
    const auto = body && typeof body.autoArchive === 'object' ? body.autoArchive : null;
    if (auto) {
      if (auto.enabled !== undefined) next.autoArchive.enabled = !!auto.enabled;
      if (auto.days !== undefined) {
        const days = Math.round(Number(auto.days));
        if (!Number.isFinite(days) || days < 1 || days > 365) throw ERR.bad('autoArchive.days must be 1..365');
        next.autoArchive.days = days;
      }
    }
    this.get('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('panel_settings', json(next));
    return next;
  }

  /** 团队最后活动时间：team.updated_at / 事件 / 任务 / 成员更新时间取最大 */
  teamLastActivity(teamId) {
    const row = this.get(
      `SELECT (SELECT updated_at FROM team WHERE id=?) AS t,
              (SELECT MAX(ts) FROM event WHERE team_id=?) AS e,
              (SELECT MAX(updated_at) FROM task WHERE team_id=?) AS k,
              (SELECT MAX(updated_at) FROM member WHERE team_id=?) AS m`
    ).get(teamId, teamId, teamId, teamId) || {};
    const times = [row.t, row.e, row.k, row.m].filter(Boolean).map((s) => Date.parse(s)).filter((n) => Number.isFinite(n));
    return times.length ? Math.max(...times) : 0;
  }

  /** 自动封存：超过设定天数无活动且没有活跃成员的团队归档；返回本次封存的 id 列表 */
  autoArchiveSweep() {
    const { autoArchive } = this.panelSettings();
    if (!autoArchive.enabled) return [];
    const cutoff = Date.now() - autoArchive.days * 86400000;
    const archived = [];
    for (const row of this.get('SELECT id FROM team WHERE archived_at IS NULL').all()) {
      const run = this.teamRunState(row.id);
      if (run.runningCount > 0 || run.blockedCount > 0) continue; // 正在跑的团队不封存
      if (this.teamLastActivity(row.id) >= cutoff) continue;
      const at = nowIso();
      this.get('UPDATE team SET archived_at=?, updated_at=? WHERE id=?').run(at, at, row.id);
      archived.push(row.id);
    }
    return archived;
  }

  /** 封存团队：先停止活跃成员（避免隐藏一个还在跑的团队），再打 archived_at */
  archiveTeam(teamId) {
    const t = this.getTeam(teamId);
    if (t.archived_at) return this.teamView(t);
    this.stopTeam(teamId, 'archive');
    const at = nowIso();
    this.get('UPDATE team SET archived_at=?, updated_at=? WHERE id=?').run(at, at, teamId);
    return this.teamView(this.getTeam(teamId));
  }

  restoreTeam(teamId) {
    const t = this.getTeam(teamId);
    if (!t.archived_at) return this.teamView(t);
    this.get('UPDATE team SET archived_at=NULL, updated_at=? WHERE id=?').run(nowIso(), teamId);
    return this.teamView(this.getTeam(teamId));
  }

  // ---------- 成员 ----------
  memberRow(id) {
    const m = this.get('SELECT * FROM member WHERE id=?').get(id);
    if (!m) throw ERR.notFound('member');
    return m;
  }

  capacityUsed(teamId) {
    // 只统计真正占位的成员：queued 尚未占位，retired 已释放（否则 queued 会被自己挡住而永不晋升）
    return Number(this.get(
      `SELECT COUNT(*) AS c FROM member m LEFT JOIN member_state s ON s.member_id=m.id
       WHERE m.team_id=? AND COALESCE(s.status,'idle') NOT IN ('retired','queued')`
    ).get(teamId).c);
  }

  addMember(teamId, { name, role = 'teammate', model = null, contextMode = 'isolated', defaultPlan = null, agentSessionId = null, parentSessionId = null, reasoningEffort = null, permissionPreset = null, agentPreset = null, agentProvider = null }) {
    const team = this.getTeam(teamId);
    if (!name) throw ERR.bad('name required');
    const dup = this.get('SELECT id FROM member WHERE team_id=? AND name=?').get(teamId, name);
    if (dup) throw ERR.conflict(`member name already used: ${name}`);
    const used = this.capacityUsed(teamId);
    const over = Number(team.max_members) > 0 && used >= Number(team.max_members);
    const status = over ? 'queued' : 'idle';
    const id = newId('m');
    const t = nowIso();
    this.get(
      `INSERT INTO member (id, team_id, name, role, model, context_mode, default_plan_json, quota_json, agent_session_id, parent_session_id, reasoning_effort, permission_preset, agent_preset, agent_provider, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`
    ).run(id, teamId, name, role, model, contextMode, defaultPlan ? json(defaultPlan) : null, agentSessionId ? String(agentSessionId) : null, parentSessionId ? String(parentSessionId) : null, reasoningEffort ? String(reasoningEffort) : null, permissionPreset ? normalizePreset(permissionPreset) : null, normalizeAgentPreset(agentPreset), agentProvider ? String(agentProvider) : null, t, t);
    this.events.append({
      teamId, memberId: id, taskId: null, phase: 'init', action: 'member.create',
      target: name, result: 'OK', next: status === 'queued' ? 'wait for capacity' : 'wait for task',
      status, blockers: status === 'queued' ? [{ kind: 'quota', detail: `maxMembers=${team.max_members}` }] : [],
      meta: { stepIndex: -1, role, contextMode, sessionId: agentSessionId ? String(agentSessionId) : null },
    });
    if (status === 'idle') this.scheduler.wake(id);
    return this.memberView(id);
  }

  memberView(id) {
    const m = this.get('SELECT * FROM member WHERE id=?').get(id);
    if (!m) return null;
    const st = this.events.state(id) || { seq: 0, step: null, status: 'queued', last: null, next: null, blockers: [], asOf: null, stale: false };
    const team = this.get('SELECT permission_preset, agent_preset FROM team WHERE id=?').get(m.team_id);
    const task = this.get("SELECT * FROM task WHERE assignee=? AND status='running' ORDER BY updated_at DESC LIMIT 1").get(id);
    const last = this.events.lastEvent(id);
    const total = task ? parseJson(this.get('SELECT plan_json FROM task WHERE id=?').get(task.id)?.plan_json, []).length : null;
    const idx = Number.isInteger(last?.meta?.stepIndex) ? last.meta.stepIndex : -1;
    // agent 运行时成员通常没有 plan 步：退化为「成员自管 todo 的完成比例」，再退化为「运行中任务的半步」。
    let pct = total ? clamp((idx + 1) / total, 0, 1) : null;
    if (pct == null) {
      const todos = task
        ? this.get('SELECT status FROM todo WHERE member_id=? AND task_id=?').all(id, task.id)
        : this.get('SELECT status FROM todo WHERE member_id=? ORDER BY created_at DESC LIMIT 20').all(id);
      if (todos.length) pct = clamp(todos.filter((r) => r.status === 'done').length / todos.length, 0, 1);
    }
    if (pct == null && task) pct = 0.5;
    return {
      id: m.id, teamId: m.team_id, name: m.name, role: m.role, model: m.model, contextMode: m.context_mode,
      // 派发时确定、之后不可变的思考强度
      reasoningEffort: m.reasoning_effort ?? null,
      agentProvider: m.agent_provider ?? null,
      createdAt: m.created_at,
      agentSessionId: m.agent_session_id ?? null,
      parentSessionId: m.parent_session_id ?? null,
      permissionPreset: m.permission_preset || team?.permission_preset || DEFAULT_PERMISSION_PRESET,
      agentPreset: m.agent_preset || team?.agent_preset || null,
      status: st.status, currentTaskId: task?.id ?? null,
      step: st.step, seq: st.seq, last: st.last, next: st.next,
      blockers: st.blockers || [], stale: !!st.stale, asOf: st.asOf,
      // 进度比例 0..1（契约 §3.2：优先「已完成 step 数 / 计划 step 总数」）
      pct,
    };
  }

  listMembers(teamId) {
    return this.get('SELECT id FROM member WHERE team_id=? ORDER BY created_at ASC').all(teamId).map((r) => this.memberView(r.id));
  }

  /**
   * 更新成员配置（不重建会话；需要换模型/上下文的调用方随后用新 session 调 registerAgent）。
   * 只改元数据，任务与事件状态保持原样。
   */
  updateMember(id, patch = {}) {
    const m = this.memberRow(id);
    const st = this.events.state(id);
    if (st && st.status === 'retired') throw ERR.invalidState('member is retired');
    if (st && ['running', 'provisioning', 'blocked'].includes(st.status)) {
      throw ERR.invalidState(`member is ${st.status}; interrupt first`);
    }
    const sets = [];
    const vals = [];
    const changed = [];
    const next = (key, column, value) => {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
      sets.push(`${column}=?`);
      vals.push(value);
      changed.push(key);
    };
    next('role', 'role', patch.role == null ? null : String(patch.role));
    next('model', 'model', patch.model ? String(patch.model) : null);
    if (Object.prototype.hasOwnProperty.call(patch, 'contextMode')) {
      const cm = patch.contextMode === 'fork' ? 'fork' : 'fresh';
      if (patch.contextMode != null && !['isolated', 'fresh', 'fork'].includes(patch.contextMode)) {
        throw ERR.bad(`invalid contextMode: ${patch.contextMode}`);
      }
      sets.push('context_mode=?');
      vals.push(cm);
      changed.push('contextMode');
    }
    next('reasoningEffort', 'reasoning_effort', patch.reasoningEffort ? String(patch.reasoningEffort) : null);
    next('permissionPreset', 'permission_preset', patch.permissionPreset ? normalizePreset(patch.permissionPreset) : null);
    next('agentProvider', 'agent_provider', patch.agentProvider ? String(patch.agentProvider) : null);
    if (Object.prototype.hasOwnProperty.call(patch, 'agentPreset')) {
      sets.push('agent_preset=?');
      vals.push(normalizeAgentPreset(patch.agentPreset));
      changed.push('agentPreset');
    }
    if (!sets.length) throw ERR.bad('no updatable fields');
    this.get(`UPDATE member SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...vals, nowIso(), id);
    this.events.append({
      teamId: m.team_id, memberId: id, taskId: null, phase: 'init', action: 'member.update',
      target: m.name, result: 'OK', next: 'config updated', blockers: [],
      // 不带 status：保留成员当前投影状态（idle/interrupted/...）
      meta: { stepIndex: -1, changed, sessionId: m.agent_session_id ?? null },
    });
    return this.memberView(id);
  }

  removeMember(id, { mode = 'retire', confirm = false } = {}) {
    const m = this.memberRow(id);
    const st = this.events.state(id);
    if (st && ['running', 'provisioning', 'blocked'].includes(st.status)) throw ERR.invalidState(`member is ${st.status}; interrupt first`);
    if (mode === 'remove') {
      if (!confirm) throw ERR.bad('remove requires confirm=1');
      this.get('DELETE FROM member WHERE id=?').run(id);
      this.get('DELETE FROM member_state WHERE member_id=?').run(id);
      this.promoteQueued(m.team_id);
      return { removed: true, id };
    }
    this.events.append({
      teamId: m.team_id, memberId: id, taskId: null, phase: 'done', action: 'member.retire',
      target: m.name, result: 'OK', next: null, status: 'retired', blockers: [],
      meta: { stepIndex: -1 },
    });
    this.promoteQueued(m.team_id);
    return this.memberView(id);
  }

  promoteQueued(teamId) {
    const team = this.getTeam(teamId);
    if (Number(team.max_members) === 0) return;
    let used = this.capacityUsed(teamId);
    const queued = this.get(
      `SELECT m.id FROM member m JOIN member_state s ON s.member_id=m.id
       WHERE m.team_id=? AND s.status='queued' ORDER BY m.created_at ASC`
    ).all(teamId);
    for (const qm of queued) {
      if (used >= Number(team.max_members)) break;
      this.events.append({
        teamId, memberId: qm.id, taskId: null, phase: 'init', action: 'member.promote',
        target: qm.id, result: 'OK', next: 'wait for task', status: 'idle', blockers: [],
        meta: { stepIndex: -1 },
      });
      used++;
      this.scheduler.wake(qm.id);
    }
  }

  interruptMember(id, reason = 'lead interrupt') {
    const m = this.memberRow(id);
    const task = this.get("SELECT * FROM task WHERE assignee=? AND status='running' ORDER BY updated_at DESC LIMIT 1").get(id);
    if (task) {
      // 中断是 Lead 的管理动作，不是一次失败尝试：任务转 paused，不计 attempts、
      // 不触发 failurePolicy 重试，也不会被 Host 的派发泵再次认领。
      this.get("UPDATE task SET status='paused', updated_at=? WHERE id=?").run(nowIso(), task.id);
      this.scheduler.emitTaskState(m.team_id, task.id, 'paused', id);
    }
    const ev = this.events.append({
      teamId: m.team_id, memberId: id, taskId: task?.id ?? null, phase: 'wait', action: 'agent.interrupt',
      target: m.name, result: 'OK', next: reason, status: 'interrupted',
      blockers: [{ kind: 'interrupt', detail: reason }], meta: { stepIndex: -1 },
    });
    return { member: this.memberView(id), event: ev, task: task ? rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)) : null };
  }

  resumeMember(id) {
    const m = this.memberRow(id);
    this.events.append({
      teamId: m.team_id, memberId: id, taskId: null, phase: 'init', action: 'agent.resume',
      target: m.name, result: 'OK', next: 'wait for task', status: 'idle', blockers: [],
      meta: { stepIndex: -1 },
    });
    this.scheduler.evaluate(m.team_id);
    return { member: this.memberView(id), resumeFrom: null, task: null };
  }

  assign(memberId, taskId) {
    const m = this.memberRow(memberId);
    const st = this.events.state(memberId);
    if (!st || st.status !== 'idle') throw ERR.invalidState(`member is ${st?.status}; only idle can be assigned`);
    const task = this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) throw ERR.notFound('task');
    if (task.team_id !== m.team_id) throw ERR.bad('cross-team assign');
    if (['done', 'failed', 'skipped', 'aborted'].includes(task.status)) throw ERR.invalidState(`task is ${task.status}`);
    this.get("UPDATE task SET assignee=?, status='ready', updated_at=? WHERE id=?").run(memberId, nowIso(), taskId);
    this.scheduler.evaluate(m.team_id);
    return { member: this.memberView(memberId), task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(taskId)) };
  }

  /** Lead 作废任务：终态 aborted，不计 attempts、不进入 failurePolicy。running 任务会顺带中断成员。 */
  abortTask(taskId, reason = 'lead abort') {
    const task = this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) throw ERR.notFound('task');
    if (['done', 'failed', 'skipped', 'aborted'].includes(task.status)) throw ERR.invalidState(`task is ${task.status}`);
    const m = task.assignee ? this.get('SELECT * FROM member WHERE id=?').get(task.assignee) : null;
    const wasRunning = task.status === 'running';
    const why = String(reason).slice(0, 2000);
    const now = nowIso();
    this.get("UPDATE task SET status='aborted', finished_at=?, updated_at=? WHERE id=?").run(now, now, taskId);
    if (m) {
      this.events.append({
        teamId: m.team_id, memberId: m.id, taskId, phase: 'fail', action: 'task.abort', target: task.subject,
        result: 'ABORTED', next: why, ...(wasRunning ? { status: 'interrupted' } : {}),
        blockers: [{ kind: 'abort', detail: why }], meta: { stepIndex: -1, reason: why },
      });
    }
    this.scheduler.emitTaskState(task.team_id, taskId, 'aborted', task.assignee);
    this.scheduler.evaluate(task.team_id);
    return {
      wasRunning,
      task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(taskId)),
      member: m ? this.memberView(m.id) : null,
    };
  }

  /** 成员被消息唤醒：agent 成员由 Host 插件通过 subagents.sendMessage 唤醒，sidecar 只推进 DAG。 */
  wakeMember(memberId) {
    const m = this.get('SELECT * FROM member WHERE id=?').get(memberId);
    if (!m) return { woken: false, reason: 'member_not_found' };
    this.scheduler.evaluate(m.team_id);
    return { woken: false, reason: 'agent_runtime' };
  }

  // ---------- Agent 运行时：成员是真 DSH sub-agent（Host 插件派发） ----------

  /** 该成员是否为 agent 成员（已绑定 DSH session）。 */
  agentMember(memberId) {
    const m = this.memberRow(memberId);
    if (!m.agent_session_id) throw ERR.bad(`member ${memberId} is not an agent member (no agent session)`);
    return m;
  }

  /**
   * Host 插件在 spawnTeammate 成功后调用：把成员登记进团队并绑定 DSH session。
   * 幂等 upsert——同名成员已存在时只更新 session，不重复建行。
   */
  registerAgent(input = {}) {
    const { teamId, name, sessionId = null, parentSessionId, role, model, contextMode, reasoningEffort, permissionPreset, agentPreset, agentProvider } = input;
    if (!teamId) throw ERR.bad('teamId required');
    if (!name) throw ERR.bad('name required');
    const team = this.getTeam(teamId);
    const existing = this.get('SELECT * FROM member WHERE team_id=? AND name=?').get(teamId, name);
    let id;
    if (existing) {
      id = existing.id;
      // 用「字段是否提供」区分「保持原值」与「显式清空」：重启会话时 null 表示继承 Lead/团队。
      const pick = (v, fallback) => (v !== undefined ? v : fallback);
      this.get(`UPDATE member SET agent_session_id=?, parent_session_id=?, role=?, model=?, context_mode=?, reasoning_effort=?,
        permission_preset=?, agent_preset=?, agent_provider=?, updated_at=? WHERE id=?`)
        .run(
          sessionId != null ? String(sessionId) : existing.agent_session_id,
          pick(parentSessionId, existing.parent_session_id),
          pick(role, existing.role),
          pick(model, existing.model),
          pick(contextMode === 'isolated' ? 'fresh' : contextMode, existing.context_mode),
          pick(reasoningEffort, existing.reasoning_effort),
          pick(permissionPreset ? normalizePreset(permissionPreset) : permissionPreset, existing.permission_preset),
          pick(agentPreset === undefined ? undefined : normalizeAgentPreset(agentPreset), existing.agent_preset),
          pick(agentProvider, existing.agent_provider),
          nowIso(), id,
        );
    } else {
      id = this.addMember(teamId, { name, role: role || 'teammate', model, contextMode: contextMode || 'fresh', agentSessionId: sessionId, parentSessionId, reasoningEffort, permissionPreset, agentPreset, agentProvider }).id;
    }
    const st = this.events.state(id);
    // 重新报到（Host/DSH 重启后 sub-agent session 仍活着）：只要没有在途任务就回到 idle
    if (!st || !['running', 'blocked'].includes(st.status)) {
      this.events.append({
        teamId, memberId: id, taskId: null, phase: 'init', action: 'agent.spawn',
        target: name, result: 'OK', next: 'wait for task', status: 'idle', blockers: [],
        meta: { stepIndex: -1, sessionId: sessionId != null ? String(sessionId) : null, model: model ?? null },
      });
    }
    return { member: this.memberView(id) };
  }

  /** 该团队里可以接活的 agent 成员（idle 且没有在跑的任务）。 */
  pickIdleAgent(teamId, memberId = null) {
    const sql = memberId
      ? `SELECT m.id FROM member m JOIN member_state s ON s.member_id=m.id
         WHERE m.id=? AND m.team_id=? AND m.agent_session_id IS NOT NULL AND s.status='idle'
           AND m.id NOT IN (SELECT assignee FROM task WHERE team_id=? AND status='running' AND assignee IS NOT NULL)`
      : `SELECT m.id FROM member m JOIN member_state s ON s.member_id=m.id
         WHERE m.team_id=? AND m.agent_session_id IS NOT NULL AND s.status='idle'
           AND m.id NOT IN (SELECT assignee FROM task WHERE team_id=? AND status='running' AND assignee IS NOT NULL)
         ORDER BY m.created_at ASC`;
    const r = memberId ? this.get(sql).get(memberId, teamId, teamId) : this.get(sql).get(teamId, teamId);
    return r ? this.memberView(r.id) : null;
  }

  /** agent 团队的就绪视图（人工/调试用，供 Host 校对）。 */
  agentReady(teamId) {
    const team = this.getTeam(teamId);
    const dag = this.scheduler.dag(teamId);
    const idleMembers = this.get(
      `SELECT m.id FROM member m JOIN member_state s ON s.member_id=m.id
       WHERE m.team_id=? AND m.agent_session_id IS NOT NULL AND s.status='idle' ORDER BY m.created_at ASC`
    ).all(teamId).map((r) => this.memberView(r.id));
    const readyTasks = dag.nodes
      .filter((n) => n.ready && (n.status === 'ready' || n.status === 'pending'))
      .map((n) => ({ taskId: n.taskId, subject: n.subject, assignee: n.assignee, planSize: n.planSize }));
    return { teamId, asOf: nowIso(), version: this.scheduler.version(teamId), idleMembers, readyTasks };
  }

  /**
   * Host 调度器取活：原子认领一条 ready 任务给一个 idle agent 成员。
   * 认领即置 running（含事件/SSE），随后由 Host 用 sendMessage 把任务交给该成员。
   */
  dispatchAgentTask(teamId) {
    const team = this.getTeam(teamId);
    this.scheduler.evaluate(teamId);
    const running = Number(this.get("SELECT COUNT(*) AS c FROM task WHERE team_id=? AND status='running'").get(teamId).c);
    const maxConc = Number(team.max_concurrency) || 8;
    if (running >= maxConc) return { dispatched: false, reason: 'concurrency', running, maxConcurrency: maxConc };
    const candidates = this.get(
      "SELECT * FROM task WHERE team_id=? AND status='ready' ORDER BY priority ASC, created_at ASC"
    ).all(teamId);
    let settled = 0;
    for (const row of candidates) {
      const task = rowToTask(row);
      if (!this.scheduler.readiness(task, team.workspace).ready) continue;
      // 建任务后留 settle 窗口，让 Lead 有机会先声明依赖
      if (Date.now() - Date.parse(task.createdAt) < this.scheduler.settleMs) { settled++; continue; }
      const member = this.pickIdleAgent(teamId, task.assignee || null);
      if (!member) {
        // 说清楚「为什么派不出去」：团队里到底有没有 idle 的 agent 成员、是不是被指定 assignee 卡住
        const idleTotal = Number(this.get(
          `SELECT COUNT(*) AS c FROM member m JOIN member_state s ON s.member_id=m.id
           WHERE m.team_id=? AND m.agent_session_id IS NOT NULL AND s.status='idle'`
        ).get(teamId).c);
        return {
          dispatched: false, reason: 'no_idle_agent', taskId: task.id,
          ...(task.assignee ? { wantedAssignee: task.assignee } : {}),
          idleMembers: idleTotal,
          hint: task.assignee
            ? `任务指定了 assignee ${task.assignee}，但它现在不空闲；用 team_control({action:"assign"}) 换人或先让它收工`
            : (idleTotal
              ? '有 idle 成员但都被未收尾的 running 任务占着；等一次心跳或再调一次 team_dispatch'
              : '团队里没有 idle 的 agent 成员：确认成员会话还活着（team_status），必要时 team_control resume 或补一个成员'),
        };
      }
      this.get("UPDATE task SET status='running', assignee=?, attempts=attempts+1, attempted_at=?, updated_at=? WHERE id=?")
        .run(member.id, nowIso(), nowIso(), task.id);
      this.events.append({
        teamId, memberId: member.id, taskId: task.id,
        phase: 'init', action: 'task.dispatch', target: task.subject, result: 'OK',
        next: 'agent turn', status: 'running', blockers: [],
        meta: { stepIndex: -1, step: 'S0', stepTotal: 0, taskId: task.id, attempt: task.attempts + 1, sessionId: member.agentSessionId },
      });
      this.scheduler.emitTaskState(teamId, task.id, 'running', member.id);
      try { this.sse.broadcastSynthetic('member.state', { teamId, memberId: member.id, status: 'running' }, { teamId, memberId: member.id }); } catch { /* ignore */ }
      return { dispatched: true, task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)), member: this.memberView(member.id) };
    }
    // 自动泵（Host 侧 dispatchLoop）可能已经先认领了一波：running>0 时别说成「没有 ready 任务」，
    // 否则 Lead 会以为依赖写错了。
    const hint = settled
      ? `任务刚建好，还在 ${this.scheduler.settleMs}ms 建图窗口里（ADR-005）；稍后重试或再调 team_dispatch 即可`
      : (running ? `已有 ${running} 个任务在跑，等它们收工后会自动派发；用 team_status(detail:"dag") 看进度` : null);
    return { dispatched: false, reason: 'no_ready_task', ...(running ? { running } : {}), ...(settled ? { settled } : {}), ...(hint ? { hint } : {}) };
  }

  /** 成员状态上报（Host 监听 agent/status 后回写）；idle/failed 且有待跑任务时兜底收尾。 */
  agentStatus(memberId, body = {}) {
    const m = this.agentMember(memberId);
    this.assertSessionOwner(m, body.sessionId);
    const want = ['idle', 'running', 'blocked', 'failed', 'interrupted'].includes(body.status) ? body.status : 'idle';
    const detail = body.detail != null ? String(body.detail).slice(0, 2000) : null;
    const task = this.get("SELECT * FROM task WHERE assignee=? AND status='running' ORDER BY updated_at DESC LIMIT 1").get(memberId);
    if (want === 'idle' || want === 'failed') {
      if (task) {
        if (want === 'failed') this.scheduler.onTaskFailed({ teamId: m.team_id, memberId, taskId: task.id }, { error: detail || 'agent reported failure' });
        else this.scheduler.onTaskDone({ teamId: m.team_id, memberId, taskId: task.id }, { result: detail || 'agent turn finished' });
        return { member: this.memberView(memberId), task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)), completed: true };
      }
      this.events.append({
        teamId: m.team_id, memberId, taskId: null, phase: 'done', action: 'agent.idle', target: m.name,
        result: 'OK', next: 'wait for task', status: want === 'failed' ? 'failed' : 'idle', blockers: [],
        meta: { stepIndex: -1, detail },
      });
      return { member: this.memberView(memberId), completed: false };
    }
    if (want === 'interrupted') {
      if (task) {
        // Host 在 interrupt 后仍可能上报一次 interrupted/running；保持 paused，避免把任务退回调度池。
        this.get("UPDATE task SET status='paused', updated_at=? WHERE id=?").run(nowIso(), task.id);
        this.scheduler.emitTaskState(m.team_id, task.id, 'paused', memberId);
      }
      this.events.append({
        teamId: m.team_id, memberId, taskId: task?.id ?? null, phase: 'wait', action: 'agent.interrupt', target: m.name,
        result: 'OK', next: detail || 'await lead', status: 'interrupted',
        blockers: [{ kind: 'interrupt', detail: detail || 'interrupted by lead' }],
        meta: { stepIndex: -1, detail },
      });
      return { member: this.memberView(memberId), task: task ? rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)) : null, completed: false };
    }
    this.events.append({
      teamId: m.team_id, memberId, taskId: task?.id ?? null, phase: 'init', action: 'agent.running', target: m.name,
      result: 'RUNNING', next: detail || 'agent turn', status: 'running', blockers: [],
      meta: { stepIndex: -1, detail, taskId: task?.id ?? null },
    });
    return { member: this.memberView(memberId), completed: false };
  }

  /** 成员显式回报任务结果（team_report_task）：精确摘要 + 成败。 */
  agentReport(memberId, body = {}) {
    const m = this.agentMember(memberId);
    this.assertSessionOwner(m, body.sessionId);
    const failed = body.status === 'failed';
    const summary = body.summary != null ? String(body.summary).slice(0, 4000) : null;
    let task = body.taskId ? this.get('SELECT * FROM task WHERE id=?').get(String(body.taskId)) : null;
    if (!task) task = this.get("SELECT * FROM task WHERE assignee=? AND status='running' ORDER BY updated_at DESC LIMIT 1").get(memberId);
    if (!task) {
      this.events.append({
        teamId: m.team_id, memberId, taskId: null, phase: 'done', action: 'agent.report', target: m.name,
        result: failed ? `FAIL:${summary || 'agent reported failure'}` : 'OK', next: null, status: 'idle', blockers: [],
        meta: { stepIndex: -1, summary },
      });
      return { ok: true, task: null, status: failed ? 'failed' : 'done', summary };
    }
    if (task.assignee && task.assignee !== memberId) throw ERR.bad('task is not owned by this member');
    if (body.status === 'blocked') {
      // 阻塞不是失败：任务回到 blocked（不消耗重试），成员置 blocked 并带上阻塞原因，
      // 依赖推进（evaluate）照常跑；Lead 决策后 resume/dispatch 可再发一次。
      this.get("UPDATE task SET status='blocked', updated_at=? WHERE id=?").run(nowIso(), task.id);
      this.scheduler.emitTaskState(m.team_id, task.id, 'blocked', memberId);
      this.events.append({
        teamId: m.team_id, memberId, taskId: task.id, phase: 'wait', action: 'agent.blocked', target: task.subject,
        result: 'BLOCKED', next: 'await lead', status: 'blocked',
        blockers: [{ kind: 'agent', detail: summary || 'agent reported blocked' }],
        meta: { stepIndex: -1, summary },
      });
      this.scheduler.evaluate(m.team_id);
      return { ok: true, task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)), status: 'blocked', summary };
    }
    if (failed) this.scheduler.onTaskFailed({ teamId: m.team_id, memberId, taskId: task.id }, { error: summary || 'agent reported failure' });
    else this.scheduler.onTaskDone({ teamId: m.team_id, memberId, taskId: task.id }, { result: summary });
    return { ok: true, task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)), status: failed ? 'failed' : 'done', summary };
  }

  /** 归属校验：成员绑定了 session 时，上报方必须是同一个 session。 */
  assertSessionOwner(memberRow, sessionId) {
    if (sessionId == null || sessionId === '' || !memberRow.agent_session_id) return;
    if (String(sessionId) !== String(memberRow.agent_session_id)) throw ERR.bad('session does not own this member');
  }

  /** 按 DSH session 找成员（Host 侧只知道 sessionId，不知道 sidecar 成员 id）。 */
  memberBySession(sessionId) {
    if (sessionId == null || sessionId === '') return null;
    const r = this.get('SELECT * FROM member WHERE agent_session_id=?').get(String(sessionId));
    return r ? this.memberView(r.id) : null;
  }

  agentStatusBySession(sessionId, body = {}) {
    const r = this.get('SELECT id FROM member WHERE agent_session_id=?').get(String(sessionId ?? ''));
    if (!r) return { ok: false, reason: 'unknown_session', sessionId: sessionId ?? null };
    return { ok: true, ...this.agentStatus(r.id, { ...body, sessionId }) };
  }

  agentReportBySession(sessionId, body = {}) {
    const r = this.get('SELECT id FROM member WHERE agent_session_id=?').get(String(sessionId ?? ''));
    if (!r) return { ok: false, reason: 'unknown_session', sessionId: sessionId ?? null };
    return this.agentReport(r.id, { ...body, sessionId });
  }

  // ---------- 状态/事件 ----------
  status({ teamId = null, memberId = null } = {}) {
    let members;
    if (memberId) {
      const v = this.memberView(memberId);
      members = v ? [v] : [];
    } else if (teamId) {
      members = this.listMembers(teamId);
    } else {
      members = this.get('SELECT DISTINCT team_id AS t FROM member').all().flatMap((r) => this.listMembers(r.t));
    }
    return {
      asOf: nowIso(),
      version: teamId ? this.scheduler.version(teamId) : this.events.lastEventId(),
      members,
      staleMembers: members.filter((m) => m.stale).map((m) => m.id),
      degraded: members.some((m) => m.stale),
    };
  }

  steps(memberId, since = 0, limit = 200) {
    this.memberRow(memberId);
    return { asOf: nowIso(), version: this.events.maxSeq(memberId), items: this.events.listSteps(memberId, since, limit) };
  }

  blockers(teamId) {
    const out = [];
    for (const m of this.listMembers(teamId)) {
      for (const b of m.blockers || []) out.push({ memberId: m.id, name: m.name, kind: b.kind, id: b.id ?? null, detail: b.detail ?? null });
    }
    for (const n of this.scheduler.dag(teamId).nodes) {
      if (n.status === 'blocked') for (const b of n.blockers || []) out.push({ memberId: null, taskId: n.taskId, kind: 'dep', id: b.id ?? null, detail: b.detail ?? null });
    }
    return { asOf: nowIso(), version: this.scheduler.version(teamId), items: out };
  }

  metrics(teamId) {
    const evCount = this.events.countEvents(teamId);
    const msg = this.bus.counts(teamId);
    const lat = this.bus.latencyStats(teamId);
    const conflicts = Number(this.get("SELECT COUNT(*) AS c FROM audit WHERE team_id=? AND result='CONFLICT'").get(teamId).c);
    const denials = Number(this.get("SELECT COUNT(*) AS c FROM audit WHERE team_id=? AND result='DENIED'").get(teamId).c);
    const approvals = this.get("SELECT status, COUNT(*) AS c FROM approval WHERE team_id=? GROUP BY status").all(teamId);
    const approvalCount = (st) => Number(approvals.find((r) => r.status === st)?.c || 0);
    const writes = Number(this.get("SELECT COUNT(*) AS c FROM audit WHERE team_id=? AND domain='fs' AND result='OK'").get(teamId).c);
    return {
      asOf: nowIso(), version: this.scheduler.version(teamId),
      eventCount: evCount, messageCount: msg.total, messagesAcked: msg.acked,
      deliveryP50: lat.p50, deliveryP95: lat.p95, deliverySamples: lat.count,
      conflicts, denials, writes,
      approvals: approvals.reduce((n, r) => n + Number(r.c), 0),
      approvalsPending: approvalCount('pending'), approvalsAllowed: approvalCount('allowed'), approvalsRejected: approvalCount('rejected') + approvalCount('expired') + approvalCount('cancelled'),
      conflictRate: writes + conflicts > 0 ? Number((conflicts / (writes + conflicts)).toFixed(4)) : 0,
      sseClients: this.sse.size,
    };
  }

  history(teamId, { since = 0, member = null, limit = 500 } = {}) {
    return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.events.history(teamId, { since, member, limit }) };
  }

  // ---------- Trace 瀑布（成员看板）：显式 span + Worker 步骤事件 ----------

  /** span 行 → API 形状。 */
  spanView(r) {
    if (!r) return null;
    return {
      spanId: r.span_id, teamId: r.team_id,
      memberId: r.member_id ?? null, sessionId: r.session_id ?? null, parentId: r.parent_id ?? null,
      name: r.name, kind: r.kind, status: r.status,
      startMs: Number(r.start_ms), endMs: r.end_ms == null ? null : Number(r.end_ms),
      detail: r.detail ?? null, model: r.model ?? null,
      tokensIn: r.tokens_in == null ? null : Number(r.tokens_in),
      tokensOut: r.tokens_out == null ? null : Number(r.tokens_out),
      cost: r.cost == null ? null : Number(r.cost),
      input: r.input_text ?? null, output: r.output_text ?? null, error: r.error ?? null,
      meta: parseJson(r.meta_json, {}),
    };
  }

  /**
   * 上报跨度（幂等 upsert）。单条或 {spans:[...]} 批量均可。
   * Agent 侧在工具开始时先报 running，结束时用同一个 spanId 再报 done/failed。
   */
  appendSpans(input = {}) {
    const teamId = String(input.teamId || '');
    if (!teamId) throw ERR.bad('teamId required');
    this.getTeam(teamId);
    const sessionId = input.sessionId ? String(input.sessionId) : null;
    const memberId = input.memberId ? String(input.memberId) : null;
    const list = Array.isArray(input.spans) ? input.spans : [input];
    const t = nowIso();
    const items = tx(this.db, () => {
      const out = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const name = String(raw.name || '').trim().slice(0, 200);
        if (!name) continue;
        const spanId = String(raw.spanId || newId('span')).trim().slice(0, 200);
        const status = ['running', 'done', 'failed'].includes(raw.status) ? raw.status : 'running';
        const kind = ['agent', 'subagent', 'llm', 'tool', 'step', 'task'].includes(raw.kind) ? raw.kind : 'tool';
        const startRaw = Number(raw.startMs ?? raw.start);
        const start = Number.isFinite(startRaw) && startRaw > 0 ? Math.round(startRaw) : now();
        const endRaw = Number(raw.endMs ?? raw.end);
        const end = Number.isFinite(endRaw) && endRaw > 0 ? Math.round(endRaw) : null;
        const meta = redactor.obj(raw.meta && typeof raw.meta === 'object' ? raw.meta : {});
        this.get(
          `INSERT INTO span (span_id, team_id, member_id, session_id, parent_id, name, kind, status, start_ms, end_ms,
             detail, model, tokens_in, tokens_out, cost, input_text, output_text, error, meta_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(span_id) DO UPDATE SET
             status=excluded.status, end_ms=excluded.end_ms, detail=excluded.detail, model=excluded.model,
             tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out, cost=excluded.cost,
             input_text=excluded.input_text, output_text=excluded.output_text, error=excluded.error,
             meta_json=excluded.meta_json, updated_at=excluded.updated_at`,
        ).run(
          spanId, teamId,
          raw.memberId != null ? String(raw.memberId) : memberId,
          raw.sessionId != null ? String(raw.sessionId) : sessionId,
          raw.parentId != null ? String(raw.parentId) : null,
          name, kind, status, start, end,
          raw.detail != null ? String(raw.detail).slice(0, 500) : null,
          raw.model != null ? String(raw.model).slice(0, 120) : null,
          Number.isFinite(Number(raw.tokensIn)) ? Math.round(Number(raw.tokensIn)) : null,
          Number.isFinite(Number(raw.tokensOut)) ? Math.round(Number(raw.tokensOut)) : null,
          Number.isFinite(Number(raw.cost)) ? Number(raw.cost) : null,
          raw.input != null ? truncate(String(raw.input), 4000) : null,
          raw.output != null ? truncate(String(raw.output), 4000) : null,
          raw.error != null ? truncate(String(raw.error), 2000) : null,
          json(meta), t, t,
        );
        out.push(this.spanView(this.get('SELECT * FROM span WHERE span_id=?').get(spanId)));
      }
      return out;
    });
    for (const span of items) {
      try { this.sse.broadcastSynthetic('span.append', { teamId, span }, { teamId, memberId: span.memberId }); } catch { /* ignore */ }
    }
    return { ok: true, items };
  }

  /** 某团队/成员/会话的显式 span 列表（按开始时间升序）。 */
  listSpans({ teamId, memberId = null, sessionId = null, since = 0, limit = 2000 } = {}) {
    if (!teamId) throw ERR.bad('teamId required');
    this.getTeam(teamId);
    let sql = 'SELECT * FROM span WHERE team_id=? AND start_ms>=?';
    const args = [teamId, Number(since) || 0];
    if (memberId) { sql += ' AND member_id=?'; args.push(String(memberId)); }
    if (sessionId) { sql += ' AND session_id=?'; args.push(String(sessionId)); }
    sql += ' ORDER BY start_ms ASC, rowid ASC LIMIT ?';
    args.push(clamp(Math.round(Number(limit) || 2000), 1, 5000));
    return {
      asOf: nowIso(), version: this.scheduler.version(teamId),
      items: this.get(sql).all(...args).map((r) => this.spanView(r)),
    };
  }

  /**
   * Trace 瀑布树：把「Worker 计划步骤事件 + 显式上报 span」拼成 ui-trace-waterfall 的输入。
   * 返回的 start/end 均为相对 originMs 的毫秒数；running 节点不带 end，客户端按 now 拉长。
   */
  trace(teamId, { limit = 4000, windowMs = 0, untilMs = 0 } = {}) {
    const team = this.getTeam(teamId);
    const members = this.listMembers(teamId);
    // agent 成员的 span 只带 sessionId：先建 session → member 映射，把它们的工具调用挂到成员节点下
    const sessionToMember = new Map();
    for (const m of members) if (m.agentSessionId) sessionToMember.set(String(m.agentSessionId), m.id);
    const maxRows = clamp(Math.round(Number(limit) || 4000), 1, 40000);
    const nowMs = now();
    const windowSize = Math.max(0, Number(windowMs) || 0);
    const cutoff = windowSize > 0 ? nowMs - windowSize : 0;
    // 上界（往前翻页）：只取这段时间之前的记录；0 = 不设上界，一路到最早
    const until = Number(untilMs) > 0 ? Math.round(Number(untilMs)) : 0;
    const all = [];
    const byId = new Map();
    const add = (n) => {
      if (!n || byId.has(n.id)) return byId.get(n.id);
      n.children = [];
      byId.set(n.id, n);
      all.push(n);
      return n;
    };

    // 1) Worker 计划步骤：同一 (member, stepIndex) 首条 RUNNING 起算，末条终态收尾
    // 统一先取「最晚的一批」再翻成升序：翻页（until）和窗口都只是加一个上下界条件
    const evWhere = ['team_id=?'];
    const evArgs = [teamId];
    if (cutoff) { evWhere.push('ts >= ?'); evArgs.push(new Date(cutoff).toISOString()); }
    if (until) { evWhere.push('ts <= ?'); evArgs.push(new Date(until).toISOString()); }
    const evRows = this.get(
      `SELECT member_id, task_id, seq, ts, phase, action, target, result, meta_json
         FROM event WHERE ${evWhere.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    ).all(...evArgs, maxRows).reverse();
    const stepKey = (memberId, taskId, idx) => memberId + '\u0000' + (taskId || '') + '\u0000' + idx;
    const stepMap = new Map();
    for (const r of evRows) {
      if (!r.member_id) continue;
      const meta = parseJson(r.meta_json, {});
      const idx = meta.stepIndex;
      if (!Number.isInteger(idx) || idx < 0) continue;
      const ts = Date.parse(r.ts) || 0;
      const key = stepKey(r.member_id, r.task_id, idx);
      let s = stepMap.get(key);
      if (!s) {
        s = {
          id: `step:${r.member_id}:${r.task_id || 'none'}:${idx}`,
          name: meta.step || `S${idx + 1}`,
          kind: 'tool', status: 'done', startMs: ts, endMs: ts,
          parentId: `member:${r.member_id}`,
          detail: [r.phase, r.action, r.target].filter(Boolean).join(' · ') || null,
          error: null,
        };
        stepMap.set(key, s);
        add(s);
      }
      if (ts > s.endMs) s.endMs = ts;
      if (ts && ts < s.startMs) s.startMs = ts;
      // escape.probes 是 C1 证据行，不参与步骤成败判定
      if (r.action === 'escape.probes') continue;
      const result = String(r.result || '');
      if (result.startsWith('FAIL')) { s.status = 'failed'; s.error = String(meta.error || result).slice(0, 500); }
      else if (result === 'RUNNING') { s.status = 'running'; s.error = null; }
      else if (result) { s.status = 'done'; s.error = null; }
    }

    // 2) 显式 span（工具调用等）
    // 方向必须和事件侧一致：先取最晚的一批再翻转。原先按 start_ms 升序截断，跨度一多就只剩最老的
    // 那批、最新调用反而丢失，翻页也会从最老的一端开始。
    const spanLimit = clamp(maxRows, 1, 20000);
    const spanWhere = ['team_id=?'];
    const spanArgs = [teamId];
    if (cutoff) { spanWhere.push('COALESCE(end_ms, start_ms) >= ?'); spanArgs.push(cutoff); }
    if (until) { spanWhere.push('start_ms <= ?'); spanArgs.push(until); }
    const spans = this.get(
      `SELECT * FROM span WHERE ${spanWhere.join(' AND ')} ORDER BY start_ms DESC LIMIT ?`,
    ).all(...spanArgs, spanLimit).reverse();
    // 父节点可能落在更早的一批里（翻页），或干脆被 limit 截断：沿 parent_id 向上补齐祖先，
    // 保证每一批都能自成一棵完整的树。否则同一批里子节点会被兜底挂到 root 上，和前一批的
    // 结构对不上，前端合并后会重复渲染。
    const structural = new Set();
    {
      const known = new Set(spans.map((r) => r.span_id));
      const queue = spans.slice();
      const extra = [];
      while (queue.length && extra.length < 2000) {
        const pid = String(queue.pop().parent_id || '').replace(/^span:/, '');
        // member:/session: 是虚拟节点（总是全量创建），不需要补
        if (!pid || known.has(pid) || pid.startsWith('member:') || pid.startsWith('session:')) continue;
        const parent = this.get('SELECT * FROM span WHERE team_id=? AND span_id=?').get(teamId, pid);
        if (!parent) continue;
        known.add(pid);
        extra.push(parent);
        queue.push(parent);
      }
      // 只为补结构带上来的祖先，不参与 originMs 的计算：否则一个横跨全过程的 agent span
      // 会把每一批的原点都拽到最早，翻页就一次跳到头、分不出来「还有更早的」了
      for (const r of extra) structural.add(`span:${r.span_id}`);
      spans.push(...extra);
    }
    for (const row of spans) {
      const v = this.spanView(row);
      const sid = v.sessionId ? String(v.sessionId) : null;
      const mappedMember = v.memberId || (sid ? sessionToMember.get(sid) : null);
      const parent = v.parentId
        ? (v.parentId.startsWith('span:') || v.parentId.startsWith('member:') || v.parentId.startsWith('session:')
          ? v.parentId : `span:${v.parentId}`)
        : (mappedMember ? `member:${mappedMember}` : sid ? `session:${sid}` : null);
      add({
        id: `span:${v.spanId}`, name: v.name,
        kind: ['agent', 'subagent', 'llm', 'tool'].includes(v.kind) ? v.kind : 'tool',
        status: v.status, startMs: v.startMs, endMs: v.endMs, parentId: parent,
        detail: v.detail, model: v.model, tokensIn: v.tokensIn, tokensOut: v.tokensOut,
        cost: v.cost, currency: v.meta?.currency || null, input: v.input, output: v.output, error: v.error,
      });
    }

    // 3) 会话节点（Lead 进程）——没有成员归属的 span 挂到这里
    const sessionIds = [...new Set(spans.map((r) => r.session_id).filter(Boolean))]
      .filter((sid) => !sessionToMember.has(String(sid)));
    for (const sid of sessionIds) {
      // 只为补结构带上来的祖先行不算进去：否则会话节点的时间范围会被拽到很早
      const mine = spans.filter((r) => r.session_id === sid && !structural.has(`span:${r.span_id}`));
      const startMs = Math.min(...mine.map((r) => Number(r.start_ms)));
      const running = mine.some((r) => r.status === 'running');
      const endMs = running ? null : Math.max(...mine.map((r) => (r.end_ms == null ? Number(r.start_ms) : Number(r.end_ms))));
      // 会话 id 形如 session-xxxx：去掉前缀再截短，避免所有会话都显示成 "Lead · session-"
      const short = String(sid).replace(/^session[-_]/, '').slice(0, 6) || String(sid).slice(0, 6);
      add({
        id: `session:${sid}`, name: `Lead · ${short}`, kind: 'agent',
        status: running ? 'running' : 'done', startMs, endMs, parentId: null,
        detail: `${mine.length} 个调用`,
      });
    }

    // 4) 成员节点（先建，时间范围随后由子节点推出）
    const memberNodes = new Map();
    for (const m of members) {
      const n = add({
        id: `member:${m.id}`, name: m.name || m.id, kind: 'subagent',
        status: m.status === 'failed' ? 'failed' : m.status === 'running' ? 'running' : 'done',
        startMs: null, endMs: null, parentId: null, model: m.model || null,
        detail: [m.role, m.model, m.step].filter(Boolean).join(' · ') || m.status,
      });
      memberNodes.set(m.id, n);
    }

    // 5) 挂树 + 补成员时间范围；成员已不在 running 时收尾悬挂的步骤
    const root = { id: `run:${teamId}`, name: team.name || teamId, kind: 'agent', status: 'done', startMs: null, endMs: null, parentId: null, children: [] };
    for (const n of all) {
      const parent = (n.parentId && byId.get(n.parentId)) || root;
      n.parentId = parent.id;
      parent.children.push(n);
    }
    for (const [mid, n] of memberNodes) {
      const kids = n.children;
      // 补结构用的祖先不参与时间范围：否则成员会被拽到很早，分页原点失效、一次就翻到头
      const realKids = kids.filter((k) => !structural.has(k.id));
      // 只剩「补结构」的祖先时，宁可不给范围（下面兜底到原点），也不要把它当成本批的真实跨度
      const rangeKids = realKids;
      const live = members.find((m) => m.id === mid);
      if (live && live.status !== 'running') {
        for (const k of kids) {
          if (k.status === 'running') { k.status = live.status === 'failed' ? 'failed' : 'done'; if (k.endMs == null) k.endMs = k.startMs; }
        }
      }
      const starts = rangeKids.map((k) => k.startMs).filter((v) => Number.isFinite(v));
      const ends = rangeKids.map((k) => k.endMs).filter((v) => Number.isFinite(v));
      const anyRunning = rangeKids.some((k) => k.status === 'running');
      n.startMs = starts.length ? Math.min(...starts) : null;
      n.endMs = anyRunning ? null : (ends.length ? Math.max(...ends) : null);
      if (n.startMs == null) { n.startMs = null; n.endMs = null; }
    }

    // 6) 相对时间轴 + 根节点
    const realStarts = all.filter((n) => !structural.has(n.id)).map((n) => n.startMs).filter((v) => Number.isFinite(v));
    const starts = realStarts.length ? realStarts : all.map((n) => n.startMs).filter((v) => Number.isFinite(v));
    const minStart = starts.length ? Math.min(...starts) : nowMs;
    const originMs = cutoff > 0 ? Math.max(cutoff, Math.min(minStart, nowMs)) : minStart;
    const running = all.some((n) => n.status === 'running');
    const maxEnd = all.reduce((m, n) => (Number.isFinite(n.endMs) ? Math.max(m, n.endMs) : m), originMs);
    root.startMs = originMs;
    root.endMs = running ? null : maxEnd;
    root.status = running ? 'running' : 'done';
    root.detail = `${members.length} 成员 · ${stepMap.size} 步骤 · ${spans.length} 跨度`;
    // 币种跟着 span 走（LLM 调用上报时写入 meta.currency）；根节点带一个，UI 按它渲染 ¥/$
    root.currency = all.map((n) => n.currency).find(Boolean) || null;
    // root 不在 all 里，显式给出相对时间（起点恒为 0；结束时收尾到最晚子节点）
    root._s = 0;
    root._e = running ? null : Math.max(0, Math.round(maxEnd - originMs));

    for (const n of all) {
      if (n.startMs == null) { n.startMs = originMs; n.endMs = originMs; }
      n._s = n.startMs == null ? 0 : Math.max(0, Math.round(n.startMs - originMs));
      n._e = n.endMs == null ? null : Math.max(n._s, Math.round(n.endMs - originMs));
    }
    const toSpan = (n) => {
      const span = {
        id: n.id, name: n.name, kind: n.kind, status: n.status, start: n._s,
        detail: n.detail || undefined, model: n.model || undefined,
        tokensIn: n.tokensIn ?? undefined, tokensOut: n.tokensOut ?? undefined, cost: n.cost ?? undefined,
        currency: n.currency || undefined,
        input: n.input || undefined, output: n.output || undefined, error: n.error || undefined,
        children: n.children
          .slice()
          .sort((a, b) => a._s - b._s)
          .map(toSpan),
      };
      if (n._e != null) span.end = n._e;
      return span;
    };
    const rootSpan = toSpan(root);
    const count = (n) => 1 + n.children.reduce((acc, c) => acc + count(c), 0);
    // 还有比本批原点更早的记录吗？翻页入口据此决定「还能往前拉」还是「已经到底」。
    // 用 originMs（已排除补结构用的祖先），不能再用 until：直到最后一批，until 之前总有更早的行
    const edgeMs = originMs;
    const hasOlder = !!(this.get('SELECT 1 AS x FROM span WHERE team_id=? AND start_ms < ? LIMIT 1').get(teamId, edgeMs)
      || this.get('SELECT 1 AS x FROM event WHERE team_id=? AND ts < ? LIMIT 1').get(teamId, new Date(edgeMs).toISOString()));
    return {
      asOf: nowIso(), version: this.scheduler.version(teamId),
      teamId, originMs, now: nowMs, windowMs: windowSize, cutoffMs: cutoff || null,
      untilMs: until || null, hasOlder,
      root: rootSpan,
      stats: {
        members: members.length, steps: stepMap.size, spans: spans.length,
        nodes: count(rootSpan),
        running: all.filter((n) => n.status === 'running').length,
        failed: all.filter((n) => n.status === 'failed').length,
        durationMs: running ? nowMs - originMs : Math.max(0, maxEnd - originMs),
      },
    };
  }

  verify(teamId = null) {
    const mismatches = this.events.verifyAll(teamId);
    return { ok: mismatches.length === 0, asOf: nowIso(), mismatches };
  }

  /**
   * FR-6.2 reconcile：事件流/审计记录 vs 磁盘实际，输出差异报告。
   * 以 audit 的最后一次 after_hash 为期望值，与磁盘当前内容比对。
   */
  reconcile(teamId) {
    const team = this.getTeam(teamId);
    const rows = this.get(
      `SELECT target, after_hash, MAX(id) AS id FROM audit
       WHERE team_id=? AND domain='fs' AND action IN ('write','delete') AND result='OK'
       GROUP BY target`
    ).all(teamId);
    const diffs = [];
    for (const r of rows) {
      const abs = path.resolve(team.workspace, r.target);
      const exists = fs.existsSync(abs);
      const actual = exists ? sha256(fs.readFileSync(abs)) : null;
      if (actual !== r.after_hash) {
        diffs.push({ target: r.target, expectedHash: r.after_hash, actualHash: actual, state: exists ? 'modified' : 'missing' });
      }
    }
    const fileStates = this.get('SELECT * FROM file_state WHERE path IS NOT NULL').all();
    const untracked = [];
    const seen = new Set(rows.map((r) => r.target));
    for (const f of fileStates) {
      if (seen.has(f.path)) continue;
      const abs = path.resolve(team.workspace, f.path);
      const exists = fs.existsSync(abs);
      // file_state 是全局表（path 作主键，跨团队共享）：别的团队 writes 过的文件不该算本团队的
      // 差异。只有真实存在于本团队 workspace 里、却没有本团队审计记录的才算「漏记改动」。
      if (!exists) continue;
      const actual = sha256(fs.readFileSync(abs));
      if (actual !== f.hash) untracked.push({ target: f.path, expectedHash: f.hash, actualHash: actual, state: 'modified' });
    }
    return { asOf: nowIso(), teamId, checked: rows.length + untracked.length, diffs: [...diffs, ...untracked], ok: diffs.length === 0 && untracked.length === 0 };
  }

  // ---------- 审批（permission preset 的 approval=ask 触发） ----------
  approvalView(r) {
    if (!r) return null;
    return {
      id: r.id, teamId: r.team_id, memberId: r.member_id, sessionId: r.session_id,
      toolName: r.tool_name, reason: r.reason, status: r.status,
      decidedBy: r.decided_by, decidedAt: r.decided_at,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  listApprovals({ teamId = null, status = null } = {}) {
    let sql = 'SELECT * FROM approval WHERE 1=1'; const args = [];
    if (teamId) { sql += ' AND team_id=?'; args.push(teamId); }
    if (status) { sql += ' AND status=?'; args.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    return { asOf: nowIso(), version: this.events.lastEventId(teamId || null), items: this.get(sql).all(...args).map((r) => this.approvalView(r)) };
  }

  /** Host 插件在把审批转给 Lead 之前先登记一条 pending（面板可见 / 重启后可收敛）。 */
  createApproval(input = {}) {
    const { id, teamId, memberId = null, sessionId = null, toolName = '', reason = '' } = input;
    if (!id) throw ERR.bad('id required');
    this.getTeam(teamId);
    const m = memberId ? this.memberRow(memberId) : null;
    if (m && m.team_id !== teamId) throw ERR.bad('cross-team approval');
    const t = nowIso();
    const safeTool = redactor.str(String(toolName || '')).slice(0, 200);
    const safeReason = redactor.str(String(reason || '')).slice(0, 2000);
    this.get(
      `INSERT INTO approval (id, team_id, member_id, session_id, tool_name, reason, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'pending', ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`
    ).run(String(id), teamId, m?.id ?? null, sessionId != null ? String(sessionId) : null, safeTool, safeReason, t, t);
    if (m) {
      const st = this.events.state(m.id);
      this.events.append({
        teamId, memberId: m.id, taskId: null,
        phase: 'wait', action: 'approval.request', target: safeTool || 'tool',
        result: 'PENDING', next: 'await lead decision',
        status: st?.status || 'idle',
        blockers: [{ kind: 'approval', id: String(id), detail: safeTool }],
        meta: { stepIndex: -1, approvalId: String(id), sessionId: sessionId != null ? String(sessionId) : null },
      });
    }
    return this.approvalView(this.get('SELECT * FROM approval WHERE id=?').get(String(id)));
  }

  /** 记录插件侧的最终决定（真正放行/拒绝发生在插件，这里只落审计镜像）。 */
  decideApproval(id, body = {}) {
    const row = this.get('SELECT * FROM approval WHERE id=?').get(String(id));
    if (!row) throw ERR.notFound('approval');
    const raw = String(body.decision || body.status || '').toLowerCase();
    const status = ['allowed', 'approved', 'allow'].includes(raw) ? 'allowed'
      : ['cancelled', 'canceled'].includes(raw) ? 'cancelled'
        : ['expired'].includes(raw) ? 'expired' : 'rejected';
    const t = nowIso();
    this.get('UPDATE approval SET status=?, decided_by=?, decided_at=?, updated_at=? WHERE id=?')
      .run(status, body.decidedBy != null ? String(body.decidedBy).slice(0, 200) : null, t, t, String(id));
    if (row.member_id) {
      const st = this.events.state(row.member_id);
      this.events.append({
        teamId: row.team_id, memberId: row.member_id, taskId: null,
        phase: 'wait', action: 'approval.decide', target: row.tool_name || 'tool',
        result: status === 'allowed' ? 'ALLOWED' : 'REJECTED', next: null,
        status: st?.status || 'idle', blockers: [],
        meta: { stepIndex: -1, approvalId: String(id), reason: body.reason != null ? String(body.reason).slice(0, 500) : null },
      });
    }
    return this.approvalView(this.get('SELECT * FROM approval WHERE id=?').get(String(id)));
  }

  // ---------- agentPreset 目录（Host 插件同步；删除由面板排队、插件执行） ----------
  presetView(r) {
    if (!r) return null;
    return { id: r.id, name: r.name, description: r.description, order: r.ord, source: r.source, file: r.file, broken: r.broken, updatedAt: r.updated_at };
  }

  getPreset(id) {
    const row = this.get('SELECT * FROM preset WHERE id=?').get(String(id));
    if (!row) throw ERR.notFound('preset');
    let doc = null;
    if (row.doc_json) { try { doc = JSON.parse(row.doc_json); } catch { doc = null; } }
    return { preset: this.presetView(row), doc };
  }

  /** 插件把 host + team 两边的预设目录整体推过来；这里按 id 覆盖并清掉已消失的 team 行。 */
  syncPresets(input = {}) {
    const presets = Array.isArray(input.presets) ? input.presets : [];
    const t = nowIso();
    const keep = new Set();
    tx(this.db, () => {
      for (const p of presets) {
        const id = String(p?.id || '').trim();
        if (!id) continue;
        keep.add(id);
        this.get(
          `INSERT INTO preset (id, name, description, ord, source, file, broken, doc_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, ord=excluded.ord,
             source=excluded.source, file=excluded.file, broken=excluded.broken,
             doc_json=excluded.doc_json, updated_at=excluded.updated_at`
        ).run(id, p.name != null ? String(p.name) : null, p.description != null ? String(p.description) : null,
          Number.isFinite(Number(p.order)) ? Number(p.order) : null, p.source === 'team' ? 'team' : 'host',
          p.file != null ? String(p.file) : null, p.broken != null ? String(p.broken) : null,
          p.doc ? JSON.stringify(p.doc) : null, t);
      }
      const rows = this.get('SELECT id FROM preset').all();
      for (const r of rows) if (!keep.has(r.id)) this.get('DELETE FROM preset WHERE id=?').run(r.id);
    });
    return this.listPresets();
  }

  listPresets() {
    const items = this.get('SELECT * FROM preset ORDER BY source DESC, ord ASC, id ASC').all().map((r) => this.presetView(r));
    const pendingDeletes = this.get('SELECT id FROM preset_delete ORDER BY requested_at ASC').all().map((r) => r.id);
    return { asOf: nowIso(), items, pendingDeletes };
  }

  /** 面板点删除：只对团队自建（source='team'）排队，等插件下一次同步执行。 */
  requestPresetDelete(id) {
    const row = this.get('SELECT * FROM preset WHERE id=?').get(String(id));
    if (!row) throw ERR.notFound('preset');
    if (row.source !== 'team') throw ERR.bad('内置预设只读，不能从面板删除');
    this.get(`INSERT INTO preset_delete (id, requested_at, attempts, last_error) VALUES (?,?,0,NULL)
      ON CONFLICT(id) DO UPDATE SET requested_at=excluded.requested_at, attempts=0, last_error=NULL`).run(String(id), nowIso());
    return { id: String(id), pending: true };
  }

  pendingPresetDeletes() {
    return {
      items: this.get('SELECT * FROM preset_delete ORDER BY requested_at ASC').all()
        .map((r) => ({ id: r.id, requestedAt: r.requested_at, attempts: Number(r.attempts) || 0, lastError: r.last_error })),
    };
  }

  /** 成功 → 删队列与目录行；失败 → 累加 attempts 并留错误，插件达到重试上限后停止。 */
  ackPresetDelete(id, body = {}) {
    const key = String(id);
    const row = this.get('SELECT * FROM preset_delete WHERE id=?').get(key);
    if (!row) return { id: key, removed: false, missing: true };
    if (body.error != null) {
      const attempts = (Number(row.attempts) || 0) + 1;
      this.get('UPDATE preset_delete SET attempts=?, last_error=? WHERE id=?').run(attempts, String(body.error).slice(0, 1000), key);
      return { id: key, removed: false, attempts, error: String(body.error) };
    }
    tx(this.db, () => {
      this.get('DELETE FROM preset_delete WHERE id=?').run(key);
      this.get('DELETE FROM preset WHERE id=?').run(key);
    });
    return { id: key, removed: true };
  }

  // ---------- 消息 ----------
  sendMessage(input = {}) {
    const teamId = input.teamId || this.memberRow(input.from).team_id;
    const out = this.bus.send({ ...input, teamId });
    return out;
  }

  listMessages(teamId, filter = {}) { return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.bus.list(teamId, filter) }; }
  ackMessage(id, state) { return this.bus.ack(id, state); }

  // ---------- 显式记忆（正文文件持久化；归属记在 team 数据 memory_link） ----------
  memorySpace(teamId, scope, memberId) {
    return `${scope}:${String(teamId)}:${scope === 'member' ? String(memberId || '') : ''}`;
  }
  memoryLink(id) {
    return this.get('SELECT * FROM memory_link WHERE memory_id=?').get(String(id)) || null;
  }
  memoryMeta(link) {
    if (!link) return { scope: null, teamId: null, ownerMemberId: null, source: { kind: 'unknown', memberId: null, taskId: null } };
    return {
      scope: link.scope,
      teamId: link.team_id,
      ownerMemberId: link.scope === 'member' ? (link.member_id ?? null) : null,
      source: { kind: link.member_id ? 'member' : 'lead', memberId: link.member_id ?? null, taskId: link.task_id ?? null },
    };
  }
  memoryEnrich(rec, link) { return { ...this.memory.view(rec), ...this.memoryMeta(link) }; }
  /** 读：shared 凭 id 全开；无 link 的孤儿文件（删团队/手写）panel 与 Lead 可读，private 只 panel。 */
  memoryReadable(rec, link, actor) {
    if (rec.visibility === 'shared') return true;
    if (actor.kind === 'panel') return true;
    if (!link) return actor.kind === 'lead' && rec.visibility !== 'private';
    if (actor.kind === 'lead') return actor.teamId === link.team_id;
    if (link.scope === 'team') return actor.teamId === link.team_id;
    return link.member_id === actor.memberId;
  }
  memoryWritable(rec, link, actor) {
    if (actor.kind === 'panel') return true;
    if (!link) return actor.kind === 'lead';
    if (actor.kind === 'lead') return actor.teamId === link.team_id;
    if (link.scope === 'team') return actor.teamId === link.team_id;
    return link.member_id === actor.memberId;
  }
  /** 启动/reindex 时把 memory_link 的空间灌回文件索引（只影响同 key upsert 的归并）。 */
  bindMemoryLinks() {
    try {
      for (const l of this.get('SELECT * FROM memory_link').all()) {
        this.memory.bind(l.memory_id, this.memorySpace(l.team_id, l.scope, l.member_id));
      }
    } catch { /* 旧库表缺失时不影响启动 */ }
  }
  broadcastMemory(link, action) {
    try {
      this.sse.broadcastSynthetic('memory.updated', {
        teamId: link?.team_id ?? null, memoryId: link?.memory_id ?? null, scope: link?.scope ?? null, action,
      }, { teamId: link?.team_id ?? null });
    } catch { /* ignore */ }
  }

  /** 解析调用者身份：无 session = 面板；命中成员 = member；否则视为该队 Lead。 */
  memoryActor(teamId, sessionId) {
    const tid = teamId == null || teamId === '' ? null : String(teamId);
    const sid = sessionId == null || sessionId === '' ? null : String(sessionId);
    if (!sid) return { kind: 'panel', memberId: null, teamId: tid };
    const m = this.memberBySession(sid);
    if (m) return { kind: 'member', memberId: m.id, teamId: m.teamId };
    if (tid) {
      const t = this.get('SELECT * FROM team WHERE id=?').get(tid);
      if (t && t.lead_session_id && String(t.lead_session_id) !== sid) throw ERR.denied('session is not the lead of this team');
    }
    return { kind: 'lead', memberId: null, teamId: tid };
  }

  listMemories(teamId, filter = {}, sessionId = null) {
    const tid = teamId == null || teamId === '' ? null : String(teamId);
    if (!tid) throw ERR.bad('teamId required');
    this.getTeam(tid);
    const actor = this.memoryActor(tid, sessionId);
    let rows = this.get('SELECT * FROM memory_link WHERE team_id=?').all(tid);
    if (actor.kind === 'member') {
      rows = rows.filter((l) => (l.scope === 'team' ? l.team_id === actor.teamId : l.member_id === actor.memberId));
    }
    if (filter.scope) rows = rows.filter((l) => l.scope === String(filter.scope));
    if (filter.memberId) rows = rows.filter((l) => l.member_id === String(filter.memberId));
    const linkById = new Map(rows.map((l) => [l.memory_id, l]));
    const out = this.memory.list({ ...filter, ids: new Set(linkById.keys()) });
    return {
      asOf: nowIso(),
      total: out.total,
      items: out.items.map((item) => ({ ...item, ...this.memoryMeta(linkById.get(item.id)) })),
    };
  }

  getMemory(id, teamId = null, sessionId = null) {
    const rec = this.memory.get(id);
    const link = this.memoryLink(rec.id);
    const actor = this.memoryActor(teamId ?? link?.team_id ?? null, sessionId);
    if (!this.memoryReadable(rec, link, actor)) throw ERR.denied('memory is not visible to this actor');
    return { memory: this.memoryEnrich(rec, link) };
  }

  writeMemory(body = {}, sessionId = null) {
    const teamId = body.teamId == null || body.teamId === '' ? null : String(body.teamId);
    if (!teamId) throw ERR.bad('teamId required');
    this.getTeam(teamId);
    const actor = this.memoryActor(teamId, sessionId);
    const scope = body.scope === 'team' ? 'team' : 'member';
    let ownerMemberId = null;
    if (scope === 'member') {
      ownerMemberId = body.memberId ? String(body.memberId) : actor.memberId;
      if (!ownerMemberId) throw ERR.bad('memberId required for member scope');
      if (actor.kind === 'member' && ownerMemberId !== actor.memberId) throw ERR.denied('members can only write their own space');
      const row = this.get('SELECT id FROM member WHERE id=? AND team_id=?').get(ownerMemberId, teamId);
      if (!row) throw ERR.bad('member is not in this team');
    } else if (actor.kind === 'member' && actor.teamId !== teamId) {
      throw ERR.denied('members can only write memories of their own team');
    }
    const visibility = body.visibility == null || body.visibility === ''
      ? (scope === 'team' ? 'team' : 'private')
      : String(body.visibility);
    if (scope === 'team' && visibility === 'private') throw ERR.bad('team scope cannot be private');
    const space = this.memorySpace(teamId, scope, ownerMemberId);
    const taskId = body.taskId ?? body.source?.taskId ?? null;
    const out = this.memory.write({
      space, key: body.key, value: body.value, kind: body.kind, title: body.title,
      tags: body.tags, visibility, expectedVersion: body.expectedVersion,
    });
    // team 空间的 member_id 记录上传者（仅溯源，不参与 owner 判定）；member 空间记录 owner。
    const linkMemberId = scope === 'member' ? ownerMemberId : (actor.kind === 'member' ? actor.memberId : null);
    this.get(`INSERT INTO memory_link (memory_id, team_id, scope, member_id, task_id, created_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET team_id=excluded.team_id, scope=excluded.scope,
        member_id=excluded.member_id, task_id=excluded.task_id`)
      .run(out.memory.id, teamId, scope, linkMemberId, taskId == null ? null : String(taskId), nowIso());
    const link = this.memoryLink(out.memory.id);
    this.broadcastMemory(link, out.created ? 'create' : 'update');
    return { memory: this.memoryEnrich(this.memory.records.get(out.memory.id), link), created: out.created };
  }

  updateMemory(id, patch = {}, teamId = null, sessionId = null) {
    const rec = this.memory.get(id);
    const link = this.memoryLink(rec.id);
    const actor = this.memoryActor(teamId ?? link?.team_id ?? null, sessionId);
    if (!this.memoryWritable(rec, link, actor)) throw ERR.denied('not allowed to update this memory');
    this.memory.update(id, patch);
    this.broadcastMemory(link, 'update');
    return { memory: this.memoryEnrich(this.memory.records.get(id), link) };
  }

  shareMemory(id, visibility, teamId = null, sessionId = null) {
    const rec = this.memory.get(id);
    const link = this.memoryLink(rec.id);
    const actor = this.memoryActor(teamId ?? link?.team_id ?? null, sessionId);
    if (!this.memoryWritable(rec, link, actor)) throw ERR.denied('not allowed to share this memory');
    this.memory.share(id, visibility);
    this.broadcastMemory(link, 'share');
    return { memory: this.memoryEnrich(this.memory.records.get(id), link) };
  }

  deleteMemory(id, teamId = null, sessionId = null) {
    const rec = this.memory.get(id);
    const link = this.memoryLink(rec.id);
    const actor = this.memoryActor(teamId ?? link?.team_id ?? null, sessionId);
    if (!this.memoryWritable(rec, link, actor)) throw ERR.denied('not allowed to delete this memory');
    this.broadcastMemory(link, 'delete');
    this.memory.remove(id);
    this.get('DELETE FROM memory_link WHERE memory_id=?').run(String(id));
    return { id: String(id), removed: true };
  }

  reindexMemories() {
    const out = this.memory.reindex();
    const links = this.get('SELECT * FROM memory_link').all();
    let bound = 0;
    for (const l of links) {
      if (this.memory.bind(l.memory_id, this.memorySpace(l.team_id, l.scope, l.member_id))) bound++;
    }
    const linked = new Set(links.map((l) => l.memory_id));
    const orphans = out.ids.filter((id) => !linked.has(id));
    return { ...out, links: links.length, bound, orphans };
  }

  /**
   * 清理无归属（orphan）记忆文件：团队删除/手写文件没有 memory_link。
   * 必须 confirm=true；body.ids 省略时清全部 orphan。只删文件，不动 link（本来也没有）。
   */
  pruneMemories(body = {}) {
    if (body?.confirm !== true) throw ERR.bad('prune requires confirm=true');
    const linked = new Set(this.get('SELECT memory_id FROM memory_link').all().map((r) => r.memory_id));
    const orphans = [...this.memory.records.keys()].filter((id) => !linked.has(id));
    const wanted = Array.isArray(body?.ids) ? body.ids.map(String) : orphans;
    const targets = wanted.filter((id) => orphans.includes(id));
    const removed = [];
    for (const id of targets) {
      try { this.memory.remove(id); removed.push(id); } catch { /* 单个失败不阻塞其余 */ }
    }
    return { removed, count: removed.length, orphans: orphans.length };
  }

  // ---------- 产物 ----------
  artifactView(r) {
    const num = (v) => (v == null ? null : Number(v));
    return { id: r.id, teamId: r.team_id, taskId: r.task_id ?? null, memberId: r.member_id ?? null, path: r.path, label: r.label ?? '', source: r.source, added: num(r.added), deleted: num(r.deleted), createdAt: r.created_at };
  }
  listArtifacts(teamId, { taskId = null, limit = 200 } = {}) {
    let sql = 'SELECT * FROM artifact WHERE team_id=?'; const args = [teamId];
    if (taskId) { sql += ' AND task_id=?'; args.push(taskId); }
    sql += ' ORDER BY created_at DESC LIMIT ?'; args.push(Math.max(1, Math.min(500, Number(limit) || 200)));
    return { asOf: nowIso(), items: this.get(sql).all(...args).map((r) => this.artifactView(r)).reverse() };
  }
  /** 成员会话里的交付文件（present 声明 / workspace 变更）。同团队同路径覆盖为最新。 */
  addArtifacts(input = {}) {
    const teamId = input.teamId;
    this.getTeam(teamId);
    if (!Array.isArray(input.items)) throw ERR.bad('items must be an array');
    const t = nowIso();
    const saved = [];
    for (const item of input.items.slice(0, 50)) {
      const p = item && item.path != null ? String(item.path).trim() : '';
      if (!p) continue;
      const path_ = p.slice(0, 400);
      const id = newId('art');
      const added = item.added == null || !Number.isFinite(Number(item.added)) ? null : Math.max(0, Number(item.added));
      const deleted = item.deleted == null || !Number.isFinite(Number(item.deleted)) ? null : Math.max(0, Number(item.deleted));
      this.get(`INSERT INTO artifact (id, team_id, task_id, member_id, path, label, source, added, deleted, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(team_id, path) DO UPDATE SET task_id=excluded.task_id, member_id=excluded.member_id, label=excluded.label, source=excluded.source, added=COALESCE(excluded.added, artifact.added), deleted=COALESCE(excluded.deleted, artifact.deleted), created_at=excluded.created_at`)
        .run(id, teamId, input.taskId ?? null, input.memberId ?? null, path_, String(item.label ?? '').slice(0, 300), item.source === 'workspace' ? 'workspace' : 'present', added, deleted, t);
      saved.push(this.artifactView(this.get('SELECT * FROM artifact WHERE team_id=? AND path=?').get(teamId, path_)));
    }
    try { this.sse.broadcastSynthetic('artifact.added', { teamId, taskId: input.taskId ?? null, count: saved.length }, { teamId }); } catch { /* ignore */ }
    return { items: saved };
  }

  // ---------- 成员改动（审阅） ----------
  // Host 插件在成员的 write/edit 落盘后上报 unified diff；面板「审阅」页只读展示。
  changeView(r) {
    const num = (v) => (v == null ? null : Number(v));
    return {
      id: r.id, teamId: r.team_id, taskId: r.task_id ?? null, memberId: r.member_id ?? null,
      path: r.path, kind: r.kind || 'edit', diff: r.diff || '',
      added: num(r.added), deleted: num(r.deleted), createdAt: r.created_at,
    };
  }
  listChanges(teamId, { taskId = null, memberId = null, limit = 200 } = {}) {
    this.getTeam(teamId);
    let sql = 'SELECT * FROM member_change WHERE team_id=?';
    const args = [teamId];
    if (taskId) { sql += ' AND task_id=?'; args.push(taskId); }
    if (memberId) { sql += ' AND member_id=?'; args.push(memberId); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    args.push(Math.max(1, Math.min(500, Number(limit) || 200)));
    return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.get(sql).all(...args).reverse().map((r) => this.changeView(r)) };
  }
  /** 成员的写/改：每次工具调用一条，diff 超长按行截断（保留头部，标注省略行数）。 */
  addChanges(input = {}) {
    const teamId = input.teamId;
    this.getTeam(teamId);
    if (!Array.isArray(input.items)) throw ERR.bad('items must be an array');
    const memberId = input.memberId ?? null;
    const t = nowIso();
    const saved = [];
    let taskId = input.taskId ?? null;
    // 插件不知道任务归属时：按成员当前在跑的任务补上，审阅页才能按任务分组
    if (!taskId && memberId) {
      const running = this.get("SELECT id FROM task WHERE team_id=? AND assignee=? AND status='running' ORDER BY updated_at DESC LIMIT 1").get(teamId, memberId);
      taskId = running ? running.id : null;
    }
    for (const item of input.items.slice(0, 50)) {
      const p = item && typeof item.path === 'string' ? item.path.trim() : '';
      if (!p) continue;
      let diff = typeof item.diff === 'string' ? item.diff : '';
      const MAX_LINES = 2000;
      const lines = diff.split('\n');
      if (lines.length > MAX_LINES) diff = lines.slice(0, MAX_LINES).join('\n') + `\n… （diff 过长，省略 ${lines.length - MAX_LINES} 行）`;
      if (diff.length > 400_000) diff = diff.slice(0, 400_000) + '\n… （diff 过长已截断）';
      const added = item.added == null || !Number.isFinite(Number(item.added)) ? null : Math.max(0, Number(item.added));
      const deleted = item.deleted == null || !Number.isFinite(Number(item.deleted)) ? null : Math.max(0, Number(item.deleted));
      const id = newId('chg');
      this.get(`INSERT INTO member_change (id, team_id, task_id, member_id, path, kind, diff, added, deleted, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, teamId, taskId, memberId, p.slice(0, 1000), item.kind === 'add' || item.kind === 'delete' ? item.kind : 'edit', diff, added, deleted, t);
      saved.push(this.changeView(this.get('SELECT * FROM member_change WHERE id=?').get(id)));
    }
    if (saved.length) {
      try { this.sse.broadcastSynthetic('change.added', { teamId, taskId, memberId, count: saved.length, last: saved[saved.length - 1] }, { teamId, memberId }); } catch { /* ignore */ }
    }
    return { items: saved };
  }

  // ---------- 成员上下文分析 ----------
  // Host 插件从成员 DSH 会话里算出「上下文窗口被什么占满」推过来，面板「上下文分析」页按成员展示。
  contextView(r) {
    if (!r) return null;
    const num = (v) => (v == null ? null : Number(v));
    return {
      teamId: r.team_id, memberId: r.member_id, sessionId: r.session_id ?? null,
      model: r.model ?? null, provider: r.provider ?? null,
      limit: num(r.limit_tokens), used: num(r.used_tokens),
      breakdown: parseJson(r.breakdown_json, {}),
      blocks: parseJson(r.blocks_json, []),
      compaction: parseJson(r.compaction_json, null),
      status: r.status ?? null,
      asOfSeq: num(r.as_of_seq),
      updatedAt: r.updated_at,
    };
  }
  listContexts(teamId, { memberId = null } = {}) {
    this.getTeam(teamId);
    let sql = 'SELECT * FROM context_snapshot WHERE team_id=?';
    const args = [teamId];
    if (memberId) { sql += ' AND member_id=?'; args.push(memberId); }
    sql += ' ORDER BY updated_at DESC LIMIT 200';
    // 排行用的用量口径：LLM 跨度里累计的输入/输出 token 与花费（Host 侧按会话上报）。
    // 没有成员归属的跨度就是 Lead 会话（与 trace 视图把 session 节点标成 lead 的口径一致）。
    const usage = new Map();
    const rows = this.get(`SELECT COALESCE(member_id,'lead') AS owner, SUM(COALESCE(tokens_in,0)) AS ti, SUM(COALESCE(tokens_out,0)) AS tout, SUM(COALESCE(cost,0)) AS cost
                           FROM span WHERE team_id=? AND kind='llm' GROUP BY COALESCE(member_id,'lead')`).all(teamId);
    for (const r of rows) {
      const input = Number(r.ti) || 0;
      const output = Number(r.tout) || 0;
      usage.set(String(r.owner), { input, output, total: input + output, cost: Number(r.cost) || 0 });
    }
    const zero = { input: 0, output: 0, total: 0, cost: 0 };
    return {
      asOf: nowIso(),
      items: this.get(sql).all(...args).map((r) => ({ ...this.contextView(r), usage: usage.get(r.member_id) ?? zero })),
      // Lead 没有上下文快照（Host 只上报成员），但用量要一起参与排行。
      lead: usage.get('lead') ?? zero,
    };
  }
  /**
   * 写入一条成员上下文快照。
   * compaction 的 before 侧来自**上一条快照的 blocks**：成员在被压缩之前的样子，
   * 就是压缩前最后一次上报的样子。同一次 compaction 反复上报时沿用已还原的 before。
   */
  reportContext(input = {}) {
    const teamId = input.teamId;
    this.getTeam(teamId);
    if (!input.memberId) throw ERR.bad('memberId required');
    const memberId = String(input.memberId);
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const t = nowIso();
    const prev = this.get('SELECT * FROM context_snapshot WHERE team_id=? AND member_id=?').get(teamId, memberId);
    const normalizeBlock = (b) => {
      if (!b || typeof b !== 'object') return null;
      const id = b.id == null ? '' : String(b.id).slice(0, 120);
      if (!id) return null;
      return {
        id,
        label: String(b.label ?? id).slice(0, 160),
        kind: String(b.kind ?? 'chat').slice(0, 20),
        tokens: Math.max(0, Math.round(Number(b.tokens) || 0)),
        ...(b.detail ? { detail: String(b.detail).slice(0, 300) } : {}),
        ...(Array.isArray(b.items) && b.items.length
          ? { items: b.items.slice(0, 12).map((i) => ({ label: String(i?.label ?? '').slice(0, 120) })).filter((i) => i.label) }
          : {}),
      };
    };
    const blocks = (Array.isArray(input.blocks) ? input.blocks.slice(0, 40).map(normalizeBlock) : []).filter(Boolean);
    const asOfSeq = num(input.asOfSeq);
    let compaction = null;
    const raw = input.compaction;
    if (raw && typeof raw === 'object') {
      const prevCompaction = prev ? parseJson(prev.compaction_json, null) : null;
      const atSeq = num(raw.atSeq);
      const sameCompaction = atSeq != null && prevCompaction && Number(prevCompaction.atSeq) === atSeq;
      const before = sameCompaction
        ? (Array.isArray(prevCompaction.before) ? prevCompaction.before : [])
        : (prev ? parseJson(prev.blocks_json, []).filter((b) => b && b.kind !== 'summary') : []);
      compaction = {
        atSeq,
        summary: raw.summary || 'summary',
        shadowedTokens: num(raw.shadowedTokens),
        before,
        // 系统提示与工具 schema 不会被压缩进去，其余（记忆/文件/工具结果/对话）都会折进摘要
        summarized: before.filter((b) => b.kind !== 'system' && b.kind !== 'tools').map((b) => b.id),
        dropped: [],
        at: raw.at || t,
      };
    }
    this.get(`INSERT INTO context_snapshot (team_id, member_id, session_id, model, provider, limit_tokens, used_tokens, breakdown_json, blocks_json, compaction_json, status, as_of_seq, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(team_id, member_id) DO UPDATE SET session_id=excluded.session_id, model=excluded.model, provider=excluded.provider,
                 limit_tokens=excluded.limit_tokens, used_tokens=excluded.used_tokens, breakdown_json=excluded.breakdown_json,
                 blocks_json=excluded.blocks_json, compaction_json=excluded.compaction_json, status=excluded.status,
                 as_of_seq=excluded.as_of_seq, updated_at=excluded.updated_at`)
      .run(teamId, memberId, input.sessionId == null ? null : String(input.sessionId), input.model ?? null, input.provider ?? null,
        num(input.limit), num(input.used), json(input.breakdown && typeof input.breakdown === 'object' ? input.breakdown : {}),
        json(blocks), compaction ? json(compaction) : null, input.status ?? null, asOfSeq, t);
    const saved = this.contextView(this.get('SELECT * FROM context_snapshot WHERE team_id=? AND member_id=?').get(teamId, memberId));
    try { this.sse.broadcastSynthetic('context.update', { teamId, memberId, used: saved.used, limit: saved.limit }, { teamId, memberId }); } catch { /* ignore */ }
    return { item: saved };
  }

  // ---------- DSH 工作区 ----------
  // Host 插件把 ctx.workspaceRegistry.list() 整表推过来；面板左侧按工作区切换，团队列表按工作区过滤。
  workspaceView(r) {
    if (!r) return null;
    return { id: r.id, title: r.title ?? '', path: r.path ?? '', position: Number(r.position) || 0, updatedAt: r.updated_at ?? null };
  }

  listWorkspaces() {
    const rows = this.get('SELECT * FROM workspace ORDER BY position ASC, title ASC').all();
    return { asOf: new Date().toISOString(), items: rows.map((r) => this.workspaceView(r)) };
  }

  reportWorkspaces(input = {}) {
    const items = Array.isArray(input.items) ? input.items : [];
    const t = new Date().toISOString();
    tx(this.db, () => {
      const keep = new Set();
      items.slice(0, 200).forEach((item, i) => {
        const id = String(item?.id ?? '').trim();
        if (!id) return;
        keep.add(id);
        const title = String(item?.title ?? '').trim().slice(0, 200) || id;
        const path = String(item?.path ?? '').trim().slice(0, 1000);
        this.get(`INSERT INTO workspace (id, title, path, position, updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, path=excluded.path, position=excluded.position, updated_at=excluded.updated_at`)
          .run(id, title, path, i, t);
      });
      // 注册表里已删除的工作区：本地同步删掉，避免下拉里留幽灵项
      for (const row of this.get('SELECT id FROM workspace').all()) {
        if (!keep.has(row.id)) this.get('DELETE FROM workspace WHERE id=?').run(row.id);
      }
    });
    const saved = this.get('SELECT * FROM workspace ORDER BY position ASC, title ASC').all().map((r) => this.workspaceView(r));
    try { this.sse.broadcastSynthetic('workspace.update', { count: saved.length }, {}); } catch { /* ignore */ }
    return { asOf: t, items: saved };
  }

  // ---------- 待办 ----------
  todoView(r) {
    return { id: r.id, teamId: r.team_id, taskId: r.task_id ?? null, memberId: r.member_id, title: r.title, status: r.status, orderNo: Number(r.order_no), blockedBy: parseJson(r.blocked_by_json, []), createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at ?? null, doneAt: r.done_at ?? null };
  }
  listTodos({ teamId, memberId = null, taskId = null } = {}) {
    let sql = 'SELECT * FROM todo WHERE team_id=?'; const args = [teamId];
    if (memberId) { sql += ' AND member_id=?'; args.push(memberId); }
    if (taskId) { sql += ' AND task_id=?'; args.push(taskId); }
    sql += ' ORDER BY order_no ASC, created_at ASC';
    return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.get(sql).all(...args).map((r) => this.todoView(r)) };
  }
  createTodo(input = {}) {
    this.getTeam(input.teamId);
    if (!input.title) throw ERR.bad('title required');
    const id = newId('todo'); const t = nowIso();
    const status = input.status || 'open';
    const startedAt = ['active', 'blocked', 'done'].includes(status) ? t : null;
    const doneAt = status === 'done' ? t : null;
    this.get('INSERT INTO todo (id, team_id, task_id, member_id, title, status, order_no, blocked_by_json, created_at, started_at, done_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.teamId, input.taskId ?? null, input.memberId ?? null, input.title, status, Number(input.orderNo) || 0, json(input.blockedBy || []), t, startedAt, doneAt, t);
    return this.todoView(this.get('SELECT * FROM todo WHERE id=?').get(id));
  }

  /**
   * 设置 / 整体替换一个任务的执行计划清单（todo）。
   * Leader 建计划、成员推进步骤、验收后更新状态都走这里；落盘后发 task.todo 事件，
   * 面板主页的 Plan 区域通过 SSE / GET /api/todos?task= 实时刷新。
   */
  setTaskTodos(taskId, items, { by = null } = {}) {
    const task = this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) throw ERR.notFound('task');
    if (!Array.isArray(items)) throw ERR.bad('items must be an array');
    if (items.length > 50) throw ERR.bad('items must be <= 50');
    const ALLOWED = ['open', 'active', 'done', 'blocked', 'skipped'];
    const rows = items.map((item, i) => {
      const title = String(item?.title ?? '').trim();
      if (!title) throw ERR.bad(`items[${i}].title required`);
      const status = String(item?.status || 'open');
      if (!ALLOWED.includes(status)) throw ERR.bad(`items[${i}].status invalid: ${status}`);
      return { title, status, orderNo: i, blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : [] };
    });
    const t = nowIso();
    // todo_write 每次整份替换，但行本身要延续：按 title 找回旧行，保留 id / created_at，
    // 以及 started_at / done_at（看板据此还原每个 todo 的实际用时与「一次勾多个」的批次）。
    const previous = this.get('SELECT * FROM todo WHERE task_id=?').all(taskId);
    const pool = new Map();
    for (const r of previous) {
      const list = pool.get(r.title) || [];
      list.push(r);
      pool.set(r.title, list);
    }
    const used = new Set();
    tx(this.db, () => {
      for (const row of rows) {
        const prev = (pool.get(row.title) || []).shift();
        const id = prev?.id || newId('todo');
        const createdAt = prev?.created_at || t;
        const finished = row.status === 'done';
        // 重新打开（done → 其它）时清掉上一轮的计时，避免把两轮算在一起
        const reopened = !!prev?.done_at && !finished;
        const working = row.status === 'active' || row.status === 'blocked' || finished;
        const startedAt = reopened ? (working ? t : null) : (prev?.started_at ?? (working ? (prev?.created_at || t) : null));
        const doneAt = finished ? (prev?.done_at || t) : null;
        const memberId = task.assignee ?? prev?.member_id ?? null;
        if (prev) {
          this.get('UPDATE todo SET member_id=?, status=?, order_no=?, blocked_by_json=?, started_at=?, done_at=?, updated_at=? WHERE id=?')
            .run(memberId, row.status, row.orderNo, json(row.blockedBy), startedAt, doneAt, t, id);
        } else {
          this.get('INSERT INTO todo (id, team_id, task_id, member_id, title, status, order_no, blocked_by_json, created_at, started_at, done_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, task.team_id, taskId, memberId, row.title, row.status, row.orderNo, json(row.blockedBy), createdAt, startedAt, doneAt, t);
        }
        used.add(id);
      }
      for (const r of previous) if (!used.has(r.id)) this.get('DELETE FROM todo WHERE id=?').run(r.id);
    });
    const done = rows.filter((r) => r.status === 'done').length;
    // 事件流按成员分片（seq / member_state 都挂在 member 上），未派发的任务没有成员可归属。
    // 「Leader 先写好计划、任务还在排队」是常态，不能因此 400：跳过事件即可，计划已落库，
    // 任务被派发时 task.state 会触发面板刷新；写者本身是成员时则归到写者名下。
    const eventMember = (() => {
      const isMember = (id) => id && this.get('SELECT id FROM member WHERE id=? AND team_id=?').get(id, task.team_id);
      if (isMember(task.assignee)) return task.assignee;
      return isMember(by) ? by : null;
    })();
    if (eventMember) {
      this.events.append({
        teamId: task.team_id, memberId: eventMember, taskId,
        phase: 'step', action: 'task.todo', target: `${done}/${rows.length} done`,
        result: 'OK', blockers: [], meta: { stepIndex: -1, by, total: rows.length, done },
      });
    }
    return this.listTodos({ teamId: task.team_id, taskId });
  }
  patchTodo(id, body = {}) {
    const r = this.get('SELECT * FROM todo WHERE id=?').get(id);
    if (!r) throw ERR.notFound('todo');
    const t = nowIso();
    const sets = []; const args = [];
    if (body.title !== undefined) { sets.push('title=?'); args.push(body.title); }
    if (body.status !== undefined) {
      const status = String(body.status);
      sets.push('status=?'); args.push(status);
      if (status === 'done') {
        if (!r.done_at) { sets.push('done_at=?'); args.push(t); }
        if (!r.started_at) { sets.push('started_at=?'); args.push(t); }
      } else {
        if (r.done_at) sets.push('done_at=NULL');
        if (status === 'active' && !r.started_at) { sets.push('started_at=?'); args.push(t); }
        if (status !== 'active' && status !== 'blocked') sets.push('started_at=NULL');
      }
    }
    if (body.orderNo !== undefined) { sets.push('order_no=?'); args.push(Number(body.orderNo)); }
    if (body.blockedBy !== undefined) { sets.push('blocked_by_json=?'); args.push(json(body.blockedBy)); }
    if (sets.length) { sets.push('updated_at=?'); args.push(t, id); this.get(`UPDATE todo SET ${sets.join(',')} WHERE id=?`).run(...args); }
    return this.todoView(this.get('SELECT * FROM todo WHERE id=?').get(id));
  }

  // ---------- 审计 / 报告 ----------
  auditList(teamId, limit = 200) {
    return this.get('SELECT * FROM audit WHERE team_id=? ORDER BY id DESC LIMIT ?').all(teamId, Math.min(2000, Number(limit) || 200)).map((r) => ({
      id: Number(r.id), ts: r.ts, actor: r.actor, domain: r.domain, action: r.action, target: r.target,
      beforeHash: r.before_hash, afterHash: r.after_hash, result: r.result, detail: parseJson(r.detail_json, null),
    }));
  }

  /** AC-12：报告必须能还原「谁在何时改了哪个文件、hash 前后值」 */
  report(teamId) {
    const team = this.teamView(this.getTeam(teamId));
    const members = this.listMembers(teamId);
    const tasks = this.get('SELECT * FROM task WHERE team_id=? ORDER BY created_at ASC').all(teamId).map(rowToTask);
    const audit = this.auditList(teamId, 500);
    const metrics = this.metrics(teamId);
    const approvals = this.get('SELECT * FROM approval WHERE team_id=? ORDER BY created_at ASC').all(teamId);
    const events = this.events.countEvents(teamId);
    const lines = [];
    lines.push(`# dsh-team 运行报告：${team.name}`);
    lines.push('');
    lines.push(`- teamId: \`${team.id}\``);
    lines.push(`- workspace: \`${team.workspace}\``);
    lines.push(`- 生成时间: ${nowIso()}`);
    lines.push(`- 事件总数: ${events}`);
    lines.push(`- 成员: ${members.length} / 任务: ${tasks.length} / 审计: ${audit.length}`);
    lines.push(`- 写冲突: ${metrics.conflicts} / 审批: ${metrics.approvals}（通过 ${metrics.approvalsAllowed}，拒绝 ${metrics.approvalsRejected}）`);
    lines.push(`- 消息: ${metrics.messageCount}（已 ack ${metrics.messagesAcked}），投递 p95 ${metrics.deliveryP95 ?? '-'}ms`);
    lines.push('');
    lines.push('## 成员');
    lines.push('| 成员 | 角色 | 状态 | seq | step | 最后动作 | 下一步 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const m of members) lines.push(`| ${m.name} | ${m.role ?? ''} | ${m.status} | ${m.seq} | ${m.step ?? '-'} | ${m.last ?? '-'} | ${m.next ?? '-'} |`);
    lines.push('');
    lines.push('## 任务 / DAG');
    lines.push('| 任务 | 主题 | 状态 | assignee | attempts | steps |');
    lines.push('|---|---|---|---|---|---|');
    for (const t of tasks) lines.push(`| \`${t.id}\` | ${t.subject} | ${t.status} | ${t.assignee ?? '-'} | ${t.attempts} | ${t.plan.length} |`);
    lines.push('');
    lines.push('## 审批（permission preset 触发）');
    if (!approvals.length) lines.push('_无_');
    else {
      lines.push('| 时间 | 成员 | 工具 | 原因 | 结论 | 决策人 | 决策时间 |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const a of approvals) lines.push(`| ${a.created_at} | ${a.member_id ?? '-'} | ${a.tool_name || '-'} | ${a.reason || '-'} | ${a.status} | ${a.decided_by ?? '-'} | ${a.decided_at ?? '-'} |`);
    }
    lines.push('');
    lines.push('## 审计（谁在何时改了哪个文件 / hash 前后值）');
    lines.push('| 时间 | actor | 域 | 动作 | 目标 | before_hash | after_hash | 结果 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const a of audit) {
      lines.push(`| ${a.ts} | ${a.actor} | ${a.domain} | ${a.action} | ${a.target} | ${a.beforeHash ?? '-'} | ${a.afterHash ?? '-'} | ${a.result} |`);
    }
    lines.push('');
    lines.push('> 本报告由 dsh-team 生成；敏感值已按 FR-3.8 替换为 `<redacted>`。');
    return redactor.str(lines.join('\n'));
  }

  // ---------- 恢复 ----------
  recoverAll() {
    const teams = this.get('SELECT id FROM team').all();
    let recovered = 0;
    for (const t of teams) {
      try {
        const r = this.scheduler.recover(t.id);
        recovered += r.requeued;
      } catch (e) { this.log({ level: 'error', msg: 'recover failed', teamId: t.id, err: String(e.message) }); }
    }
    // 进程重启后，插件内存里的等待队列已经不存在：pending 审批统一收敛为 expired，
    // 避免面板出现「点了也没用」的幽灵审批。
    let expired = 0;
    try {
      const rows = this.get("SELECT id, team_id, member_id, tool_name FROM approval WHERE status='pending'").all();
      for (const r of rows) {
        this.get("UPDATE approval SET status='expired', decided_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), r.id);
        expired++;
      }
    } catch (e) { this.log({ level: 'error', msg: 'expire pending approvals failed', err: String(e.message) }); }
    if (expired) this.log({ level: 'info', msg: 'expired pending approvals', count: expired });
    this.events.verifyAll(null);
    return recovered;
  }

  close() {
    try { this.scheduler.shutdown(); } catch { /* ignore */ }
    try { this.sse.close(); } catch { /* ignore */ }
    closeDb(this.db);
  }
}

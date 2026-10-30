// core.mjs — 组合根：装配 StateStore/EventStore/PermBroker/Scheduler/Runner/Bus/SSE，并承载业务查询
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb, q, tx } from './db.mjs';
import { EventStore, rowToEvent } from './eventstore.mjs';
import { PermBroker } from './broker.mjs';
import { Scheduler, rowToTask } from './scheduler.mjs';
import { WorkerRunner } from './runner.mjs';
import { MessageBus, rowToMessage } from './bus.mjs';
import { SseHub } from './sse.mjs';
import { LlmCatalog } from './llm.mjs';
import {
  ERR, now, nowIso, newId, json, parseJson, clamp, redactor, REDACTED,
  isSensitiveName, percentile, sha256, truncate,
} from './util.mjs';
import { DOMAINS, OPS_BY_DOMAIN } from './policy.mjs';

const STATUSES = ['queued', 'provisioning', 'idle', 'running', 'blocked', 'done', 'failed', 'interrupted', 'retired'];

/** 成员运行时：worker = 沙箱 Node 进程（sidecar 内派发）；agent = 真 DSH sub-agent（Host 插件派发） */
export const RUNTIMES = ['worker', 'agent'];
const runtimeOf = (team) => (team && team.runtime) || 'worker';
/** status() 里附加 runtime；未知团队退回 'worker'，不让一次查询失败。 */
const safeRuntimeOf = (core, teamId) => {
  try { return runtimeOf(core.getTeam(teamId)); } catch { return 'worker'; }
};

export class DshTeam {
  constructor({ home, log = () => {}, leaseMs = 15000 } = {}) {
    this.home = home;
    this.log = log;
    this.db = openDb(path.join(home, 'team.db'));
    this.get = q(this.db);
    this.llm = new LlmCatalog(this.db, this.get);
    this.sse = null;
    this.events = new EventStore(this.db, { onEvent: (ev) => { try { this.sse?.broadcastEvent(ev); } catch { /* ignore */ } } });
    this.broker = new PermBroker(this.db, { events: this.events, log });
    this.sse = new SseHub({ events: this.events, log });
    this.runner = new WorkerRunner({ db: this.db, events: this.events, broker: this.broker, bus: null, home, leaseMs, log });
    this.bus = new MessageBus(this.db, {
      log,
      onDeliver: (m) => { try { this.sse.broadcastSynthetic('message.delivered', { teamId: m.teamId, memberId: m.to, messageId: m.id, to: m.to, status: 'delivered' }, { teamId: m.teamId }); } catch { /* ignore */ } },
      onWake: (memberId) => { try { this.wakeMember(memberId); } catch { /* ignore */ } },
    });
    this.runner.bus = this.bus;
    this.scheduler = new Scheduler({ db: this.db, events: this.events, runner: this.runner, sse: this.sse, broker: this.broker, log });
    this.runner.attach({
      onTaskDone: (ctx, args) => this.scheduler.onTaskDone(ctx, args),
      onTaskFailed: (ctx, args) => this.scheduler.onTaskFailed(ctx, args),
      onWorkerGone: (memberId, why) => this.onWorkerGone(memberId, why),
    });
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
  createTeam({ name, workspace, maxMembers = 64, maxConcurrency = 8, failurePolicy = 'continue', maxAttempts = 3, autoApprove = null, runtime = 'worker', leadSessionId = null }) {
    if (!name) throw ERR.bad('name required');
    if (!workspace) throw ERR.bad('workspace required');
    if (!RUNTIMES.includes(runtime)) throw ERR.bad(`runtime must be one of ${RUNTIMES.join('|')}`);
    const abs = path.resolve(workspace);
    fs.mkdirSync(abs, { recursive: true });
    const id = newId('team');
    const t = nowIso();
    this.get(
      `INSERT INTO team (id, name, workspace, max_members, max_concurrency, failure_policy, max_attempts, auto_approve_json, runtime, lead_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, name, abs, Number(maxMembers), Number(maxConcurrency), failurePolicy, Number(maxAttempts), autoApprove ? json(autoApprove) : null, runtime, leadSessionId ? String(leadSessionId) : null, t, t);
    this.seedDefaultPolicies(id);
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

  /** 默认策略：工作区读允许、写默认拒绝；deny 规则展示 deny>allow（PRD FR-3 表） */
  seedDefaultPolicies(teamId) {
    const mk = (subjectType, subjectId, domain, matcher, ops, mode, constraints = null) => {
      const id = newId('pol');
      this.get(
        `INSERT INTO policy (id, team_id, subject_type, subject_id, domain, matcher, ops_json, mode, constraints_json, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`
      ).run(id, teamId, subjectType, subjectId, domain, matcher, json(ops), mode, constraints ? json(constraints) : null, nowIso());
      return id;
    };
    mk('team', teamId, 'fs', '**', ['read', 'list'], 'allow');
    mk('team', teamId, 'fs', '.git/**', ['write', 'delete', 'rename', 'read'], 'deny');
    mk('team', teamId, 'fs', '**/.env*', ['read', 'write'], 'deny');
    mk('team', teamId, 'env', '**', ['read'], 'deny', { sensitive: true });
    return this.listPolicies(teamId);
  }

  teamView(t) {
    if (!t) return null;
    return {
      id: t.id, name: t.name, workspace: t.workspace,
      leadSessionId: t.lead_session_id || null,
      maxMembers: Number(t.max_members), maxConcurrency: Number(t.max_concurrency),
      failurePolicy: t.failure_policy, maxAttempts: Number(t.max_attempts),
      autoApprove: parseJson(t.auto_approve_json, null),
      autoTakeover: Number(t.auto_takeover) === 1,
      runtime: runtimeOf(t),
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
    if (body.runtime !== undefined && !RUNTIMES.includes(body.runtime)) throw ERR.bad(`runtime must be one of ${RUNTIMES.join('|')}`);
    const map = { name: 'name', workspace: 'workspace', maxMembers: 'max_members', maxConcurrency: 'max_concurrency', failurePolicy: 'failure_policy', maxAttempts: 'max_attempts', runtime: 'runtime' };
    const sets = []; const args = [];
    for (const [k, col] of Object.entries(map)) {
      if (body[k] !== undefined) { sets.push(`${col}=?`); args.push(body[k]); }
    }
    if (body.autoApprove !== undefined) { sets.push('auto_approve_json=?'); args.push(body.autoApprove ? json(body.autoApprove) : null); }
    if (body.autoTakeover !== undefined) { sets.push('auto_takeover=?'); args.push(body.autoTakeover ? 1 : 0); }
    if (!sets.length) return this.teamView(t);
    sets.push('updated_at=?'); args.push(nowIso(), id);
    this.get(`UPDATE team SET ${sets.join(', ')} WHERE id=?`).run(...args);
    return this.teamView(this.getTeam(id));
  }

  /** 停止团队：中断所有活跃成员、在途任务回 ready（保留团队与成员，可再次派发）。 */
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
    this.get("UPDATE task SET status='ready', updated_at=? WHERE team_id=? AND status='running'").run(nowIso(), teamId);
    return { ...this.teamView(this.getTeam(teamId)), stopped };
  }

  /** 删除团队：先杀掉 worker 进程/租约，再在一个事务里清掉所有 team_id 相关行（库无外键，手工级联）。 */
  deleteTeam(teamId, { confirm = false } = {}) {
    const t = this.getTeam(teamId);
    if (!confirm) throw ERR.bad('delete requires confirm=1');
    const memberIds = this.get('SELECT id FROM member WHERE team_id=?').all(teamId).map((r) => r.id);
    for (const id of memberIds) {
      try { this.runner.killWorker(id, { hard: true }); } catch { /* ignore */ }
      try { this.runner.clearLease(id); } catch { /* ignore */ }
    }
    tx(this.db, () => {
      for (const id of memberIds) {
        this.get('DELETE FROM member_state WHERE member_id=?').run(id);
        this.get('DELETE FROM member_runtime WHERE member_id=?').run(id);
      }
      for (const table of ['member', 'task', 'dep', 'event', 'policy', 'scope_request', 'scope_grant', 'decision', 'message', 'todo', 'audit', 'span', 'artifact']) {
        this.get(`DELETE FROM ${table} WHERE team_id=?`).run(teamId);
      }
      this.get('DELETE FROM team WHERE id=?').run(teamId);
    });
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

  addMember(teamId, { name, role = 'worker', model = null, contextMode = 'isolated', defaultPlan = null, agentSessionId = null }) {
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
      `INSERT INTO member (id, team_id, name, role, model, context_mode, default_plan_json, quota_json, agent_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,?)`
    ).run(id, teamId, name, role, model, contextMode, defaultPlan ? json(defaultPlan) : null, agentSessionId ? String(agentSessionId) : null, t, t);
    this.events.append({
      teamId, memberId: id, taskId: null, phase: 'init', action: 'member.create',
      target: name, result: 'OK', next: status === 'queued' ? 'wait for capacity' : 'wait for task',
      status, blockers: status === 'queued' ? [{ kind: 'quota', detail: `maxMembers=${team.max_members}` }] : [],
      meta: { stepIndex: -1, role, contextMode, runtime: runtimeOf(team), sessionId: agentSessionId ? String(agentSessionId) : null },
    });
    if (status === 'idle') this.scheduler.wake(id);
    return this.memberView(id);
  }

  memberView(id) {
    const m = this.get('SELECT * FROM member WHERE id=?').get(id);
    if (!m) return null;
    const st = this.events.state(id) || { seq: 0, step: null, status: 'queued', last: null, next: null, blockers: [], asOf: null, stale: false };
    const rt = this.runner.runtime(id);
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
      createdAt: m.created_at,
      agentSessionId: m.agent_session_id ?? null,
      status: st.status, leaseUntil: rt.leaseUntil, currentTaskId: task?.id ?? null,
      step: st.step, seq: st.seq, last: st.last, next: st.next,
      blockers: st.blockers || [], stale: !!st.stale, asOf: st.asOf,
      // 进度比例 0..1（契约 §3.2：优先「已完成 step 数 / 计划 step 总数」）
      pct,
    };
  }

  listMembers(teamId) {
    return this.get('SELECT id FROM member WHERE team_id=? ORDER BY created_at ASC').all(teamId).map((r) => this.memberView(r.id));
  }

  removeMember(id, { mode = 'retire', confirm = false } = {}) {
    const m = this.memberRow(id);
    const st = this.events.state(id);
    if (st && ['running', 'provisioning', 'blocked'].includes(st.status)) throw ERR.invalidState(`member is ${st.status}; interrupt first`);
    if (mode === 'remove') {
      if (!confirm) throw ERR.bad('remove requires confirm=1');
      this.get('DELETE FROM member WHERE id=?').run(id);
      this.get('DELETE FROM member_state WHERE member_id=?').run(id);
      this.get('DELETE FROM member_runtime WHERE member_id=?').run(id);
      this.promoteQueued(m.team_id);
      return { removed: true, id };
    }
    this.events.append({
      teamId: m.team_id, memberId: id, taskId: null, phase: 'done', action: 'member.retire',
      target: m.name, result: 'OK', next: null, status: 'retired', blockers: [],
      meta: { stepIndex: -1 },
    });
    this.runner.killWorker(id, { hard: true });
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
    this.memberRow(id);
    const ev = this.runner.interrupt(id, reason);
    return { member: this.memberView(id), event: ev };
  }

  resumeMember(id) {
    const out = this.runner.resume(id);
    return { member: this.memberView(id), resumeFrom: out.resumeFrom, task: rowToTask(out.task) };
  }

  assign(memberId, taskId) {
    const m = this.memberRow(memberId);
    const st = this.events.state(memberId);
    if (!st || st.status !== 'idle') throw ERR.invalidState(`member is ${st?.status}; only idle can be assigned`);
    const task = this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) throw ERR.notFound('task');
    if (task.team_id !== m.team_id) throw ERR.bad('cross-team assign');
    if (['done', 'failed', 'skipped'].includes(task.status)) throw ERR.invalidState(`task is ${task.status}`);
    this.get("UPDATE task SET assignee=?, status='ready', updated_at=? WHERE id=?").run(memberId, nowIso(), taskId);
    this.scheduler.evaluate(m.team_id);
    return { member: this.memberView(memberId), task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(taskId)) };
  }

  /**
   * FR-4.2：idle 成员被消息唤醒。
   * - 有 ready 任务 → 交给调度器立即派发；
   * - 无任务 → 拉起一个「收件 worker」，在 step 边界消费信箱并回执，随后回到 idle。
   */
  wakeMember(memberId) {
    const m = this.get('SELECT * FROM member WHERE id=?').get(memberId);
    if (!m) return { woken: false, reason: 'member_not_found' };
    // agent 团队的成员是 DSH sub-agent，由 Host 插件用 sendMessage 唤醒，sidecar 不拉 worker
    if (runtimeOf(this.get('SELECT * FROM team WHERE id=?').get(m.team_id)) === 'agent') {
      return { woken: false, reason: 'agent_runtime' };
    }
    const existing = this.runner.workers.get(memberId);
    if (existing && !existing.exited) return { woken: false, reason: 'running' };
    const st = this.events.state(memberId);
    if (!st || st.status !== 'idle') return { woken: false, reason: st?.status || 'unknown' };
    const ready = this.get("SELECT id FROM task WHERE assignee=? AND status='ready'").get(memberId);
    if (ready) { this.scheduler.evaluate(m.team_id); return { woken: true, via: 'scheduler', taskId: ready.id }; }
    const wakeTask = {
      id: `wake_${memberId}`,
      subject: 'inbox',
      plan: [{ step: 'S1', phase: 'msg', action: 'drain', target: 'inbox', op: { kind: 'noop' } }],
      write_scopes_json: '[]',
    };
    this.events.append({
      teamId: m.team_id, memberId, taskId: null, phase: 'init', action: 'wake',
      target: 'message', result: 'OK', next: 'drain inbox', status: 'running', blockers: [],
      meta: { stepIndex: -1, stepTotal: 1, reason: 'message' },
    });
    this.runner.start(memberId, null, { taskOverride: wakeTask });
    return { woken: true, via: 'worker' };
  }

  onWorkerGone(memberId, why) {    try {
      const m = this.get('SELECT id, team_id FROM member WHERE id=?').get(memberId);
      if (!m) return;
      const tasks = this.get("SELECT id FROM task WHERE assignee=? AND status='running'").all(memberId);
      for (const t of tasks) this.get("UPDATE task SET status='ready', updated_at=? WHERE id=?").run(nowIso(), t.id);
      this.scheduler.evaluate(m.team_id);
    } catch (e) { this.log({ level: 'error', msg: 'onWorkerGone', err: String(e.message) }); }
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
    const { teamId, name, sessionId = null, role = 'teammate', model = null, contextMode = 'fresh' } = input;
    if (!teamId) throw ERR.bad('teamId required');
    if (!name) throw ERR.bad('name required');
    const team = this.getTeam(teamId);
    const existing = this.get('SELECT * FROM member WHERE team_id=? AND name=?').get(teamId, name);
    let id;
    if (existing) {
      id = existing.id;
      this.get('UPDATE member SET agent_session_id=?, role=COALESCE(?, role), model=COALESCE(?, model), updated_at=? WHERE id=?')
        .run(sessionId != null ? String(sessionId) : existing.agent_session_id, role || null, model || null, nowIso(), id);
    } else {
      id = this.addMember(teamId, { name, role, model, contextMode, agentSessionId: sessionId }).id;
    }
    const st = this.events.state(id);
    // 重新报到（Host/DSH 重启后 sub-agent session 仍活着）：只要没有在途任务就回到 idle
    if (!st || !['running', 'blocked'].includes(st.status)) {
      this.events.append({
        teamId, memberId: id, taskId: null, phase: 'init', action: 'agent.spawn',
        target: name, result: 'OK', next: 'wait for task', status: 'idle', blockers: [],
        meta: { stepIndex: -1, runtime: runtimeOf(team), sessionId: sessionId != null ? String(sessionId) : null, model: model ?? null },
      });
    }
    return { member: this.memberView(id), runtime: runtimeOf(team) };
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
    return { teamId, runtime: runtimeOf(team), asOf: nowIso(), version: this.scheduler.version(teamId), idleMembers, readyTasks };
  }

  /**
   * Host 调度器取活：原子认领一条 ready 任务给一个 idle agent 成员。
   * 认领即置 running（含事件/SSE），随后由 Host 用 sendMessage 把任务交给该成员。
   */
  dispatchAgentTask(teamId) {
    const team = this.getTeam(teamId);
    if (runtimeOf(team) !== 'agent') throw ERR.bad('team runtime is not agent');
    this.scheduler.evaluate(teamId);
    const running = Number(this.get("SELECT COUNT(*) AS c FROM task WHERE team_id=? AND status='running'").get(teamId).c);
    const maxConc = Number(team.max_concurrency) || 8;
    if (running >= maxConc) return { dispatched: false, reason: 'concurrency', running, maxConcurrency: maxConc };
    const candidates = this.get(
      "SELECT * FROM task WHERE team_id=? AND status='ready' ORDER BY priority ASC, created_at ASC"
    ).all(teamId);
    for (const row of candidates) {
      const task = rowToTask(row);
      if (!this.scheduler.readiness(task, team.workspace).ready) continue;
      // 建任务后留 settle 窗口，让 Lead 有机会先声明依赖
      if (Date.now() - Date.parse(task.createdAt) < this.scheduler.settleMs) continue;
      const member = this.pickIdleAgent(teamId, task.assignee || null);
      if (!member) return { dispatched: false, reason: 'no_idle_agent' };
      this.get("UPDATE task SET status='running', assignee=?, attempts=attempts+1, attempted_at=?, updated_at=? WHERE id=?")
        .run(member.id, nowIso(), nowIso(), task.id);
      this.events.append({
        teamId, memberId: member.id, taskId: task.id,
        phase: 'init', action: 'task.dispatch', target: task.subject, result: 'OK',
        next: 'agent turn', status: 'running', blockers: [],
        meta: { stepIndex: -1, step: 'S0', stepTotal: 0, taskId: task.id, attempt: task.attempts + 1, runtime: 'agent', sessionId: member.agentSessionId },
      });
      this.scheduler.emitTaskState(teamId, task.id, 'running', member.id);
      try { this.sse.broadcastSynthetic('member.state', { teamId, memberId: member.id, status: 'running' }, { teamId, memberId: member.id }); } catch { /* ignore */ }
      return { dispatched: true, task: rowToTask(this.get('SELECT * FROM task WHERE id=?').get(task.id)), member: this.memberView(member.id) };
    }
    return { dispatched: false, reason: 'no_ready_task' };
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
        this.get("UPDATE task SET status='ready', updated_at=? WHERE id=?").run(nowIso(), task.id);
        this.scheduler.emitTaskState(m.team_id, task.id, 'ready', memberId);
      }
      this.events.append({
        teamId: m.team_id, memberId, taskId: task?.id ?? null, phase: 'wait', action: 'agent.interrupt', target: m.name,
        result: 'OK', next: detail || 'await lead', status: 'interrupted',
        blockers: [{ kind: 'interrupt', detail: detail || 'interrupted by lead' }],
        meta: { stepIndex: -1, detail },
      });
      this.scheduler.evaluate(m.team_id);
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
        meta: { stepIndex: -1, summary, runtime: 'agent' },
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
      ...(teamId ? { runtime: safeRuntimeOf(this, teamId) } : {}),
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
    const grants = Number(this.get('SELECT COUNT(*) AS c FROM scope_grant WHERE team_id=?').get(teamId).c);
    const writes = Number(this.get("SELECT COUNT(*) AS c FROM audit WHERE team_id=? AND domain='fs' AND result='OK'").get(teamId).c);
    return {
      asOf: nowIso(), version: this.scheduler.version(teamId),
      eventCount: evCount, messageCount: msg.total, messagesAcked: msg.acked,
      deliveryP50: lat.p50, deliveryP95: lat.p95, deliverySamples: lat.count,
      conflicts, denials, grants, writes,
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
  trace(teamId, { limit = 4000, windowMs = 0 } = {}) {
    const team = this.getTeam(teamId);
    const members = this.listMembers(teamId);
    // agent 成员的 span 只带 sessionId：先建 session → member 映射，把它们的工具调用挂到成员节点下
    const sessionToMember = new Map();
    for (const m of members) if (m.agentSessionId) sessionToMember.set(String(m.agentSessionId), m.id);
    const maxRows = clamp(Math.round(Number(limit) || 4000), 1, 40000);
    const nowMs = now();
    const windowSize = Math.max(0, Number(windowMs) || 0);
    const cutoff = windowSize > 0 ? nowMs - windowSize : 0;
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
    const evRows = (cutoff
      ? this.get(
        `SELECT member_id, task_id, seq, ts, phase, action, target, result, meta_json
           FROM event WHERE team_id=? AND ts >= ? ORDER BY id DESC LIMIT ?`,
      ).all(teamId, new Date(cutoff).toISOString(), maxRows)
      : this.get(
        `SELECT member_id, task_id, seq, ts, phase, action, target, result, meta_json
           FROM event WHERE team_id=? ORDER BY id DESC LIMIT ?`,
      ).all(teamId, maxRows)).reverse();
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
    const spans = cutoff
      ? this.get('SELECT * FROM span WHERE team_id=? AND COALESCE(end_ms, start_ms) >= ? ORDER BY start_ms ASC LIMIT ?')
        .all(teamId, cutoff, clamp(maxRows, 1, 20000))
      : this.get('SELECT * FROM span WHERE team_id=? ORDER BY start_ms ASC LIMIT ?')
        .all(teamId, clamp(maxRows, 1, 20000));
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
      const mine = spans.filter((r) => r.session_id === sid);
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
      const live = members.find((m) => m.id === mid);
      if (live && live.status !== 'running') {
        for (const k of kids) {
          if (k.status === 'running') { k.status = live.status === 'failed' ? 'failed' : 'done'; if (k.endMs == null) k.endMs = k.startMs; }
        }
      }
      const starts = kids.map((k) => k.startMs).filter((v) => Number.isFinite(v));
      const ends = kids.map((k) => k.endMs).filter((v) => Number.isFinite(v));
      const anyRunning = kids.some((k) => k.status === 'running');
      n.startMs = starts.length ? Math.min(...starts) : null;
      n.endMs = anyRunning ? null : (ends.length ? Math.max(...ends) : null);
      if (n.startMs == null) { n.startMs = null; n.endMs = null; }
    }

    // 6) 相对时间轴 + 根节点
    const starts = all.map((n) => n.startMs).filter((v) => Number.isFinite(v));
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
    return {
      asOf: nowIso(), version: this.scheduler.version(teamId),
      teamId, originMs, now: nowMs, windowMs: windowSize, cutoffMs: cutoff || null,
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
      const actual = exists ? sha256(fs.readFileSync(abs)) : null;
      if (actual !== f.hash) untracked.push({ target: f.path, expectedHash: f.hash, actualHash: actual, state: exists ? 'modified' : 'missing' });
    }
    return { asOf: nowIso(), teamId, checked: rows.length + untracked.length, diffs: [...diffs, ...untracked], ok: diffs.length === 0 && untracked.length === 0 };
  }

  // ---------- 策略 ----------
  createPolicy(input = {}) {
    const { teamId, subjectType, subjectId, domain, matcher, ops, mode = 'allow', constraints = null, expiresAt = null } = input;
    this.getTeam(teamId);
    if (!['team', 'member', 'role', 'task'].includes(subjectType)) throw ERR.bad('invalid subjectType');
    if (!subjectId) throw ERR.bad('subjectId required');
    if (!DOMAINS.includes(domain)) throw ERR.bad('invalid domain');
    if (!matcher) throw ERR.bad('matcher required');
    const opList = Array.isArray(ops) ? ops : [];
    if (!opList.length || opList.some((o) => !OPS_BY_DOMAIN[domain].includes(o))) throw ERR.bad(`ops must be subset of ${OPS_BY_DOMAIN[domain].join(',')}`);
    if (!['allow', 'deny'].includes(mode)) throw ERR.bad('mode must be allow|deny');
    const id = newId('pol');
    this.get(
      `INSERT INTO policy (id, team_id, subject_type, subject_id, domain, matcher, ops_json, mode, constraints_json, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, teamId, subjectType, subjectId, domain, matcher, json(opList), mode, constraints ? json(constraints) : null, expiresAt, nowIso());
    return this.policyView(this.get('SELECT * FROM policy WHERE id=?').get(id));
  }

  policyView(r) {
    return {
      id: r.id, teamId: r.team_id, subjectType: r.subject_type, subjectId: r.subject_id,
      domain: r.domain, matcher: r.matcher, ops: parseJson(r.ops_json, []), mode: r.mode,
      constraints: parseJson(r.constraints_json, null),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at), createdAt: r.created_at,
    };
  }

  listPolicies(teamId) {
    return this.get('SELECT * FROM policy WHERE team_id=? ORDER BY created_at ASC').all(teamId).map((r) => this.policyView(r));
  }

  deletePolicy(id) {
    const p = this.get('SELECT * FROM policy WHERE id=?').get(id);
    if (!p) throw ERR.notFound('policy');
    this.get('DELETE FROM policy WHERE id=?').run(id);
    return { ok: true, id };
  }

  permissionMatrix(teamId) {
    this.getTeam(teamId);
    return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.broker.matrix(teamId) };
  }

  // ---------- 审批 ----------
  scopeRequestView(r) {
    if (!r) return null;
    return {
      id: r.id, teamId: r.team_id, memberId: r.member_id, domain: r.domain, target: r.target,
      reason: r.reason, diffSize: r.diff_size, risk: r.risk, blockedStep: r.blocked_step,
      fallback: r.fallback, status: r.status, decisionId: r.decision_id, grantId: r.grant_id,
      createdAt: r.created_at, decidedAt: r.decided_at,
    };
  }

  listScopeRequests({ teamId, status = null } = {}) {
    let sql = 'SELECT * FROM scope_request WHERE 1=1'; const args = [];
    if (teamId) { sql += ' AND team_id=?'; args.push(teamId); }
    if (status) { sql += ' AND status=?'; args.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    return { asOf: nowIso(), version: this.events.lastEventId(teamId || null), items: this.get(sql).all(...args).map((r) => this.scopeRequestView(r)) };
  }

  createScopeRequest(input = {}) {
    const m = this.memberRow(input.memberId);
    const ctx = { teamId: m.team_id, memberId: m.id, role: m.role, taskId: input.taskId ?? null, workspace: this.getTeam(m.team_id).workspace, stepIndex: -1 };
    // 同步返回 pending 状态（不阻塞 HTTP）；Worker 侧走 RPC 的阻塞语义
    const { domain, target, reason, diffSize = null, risk = null, blockedStep = null, fallback = null } = input;
    if (!DOMAINS.includes(domain)) throw ERR.bad('invalid domain');
    if (!target) throw ERR.bad('target required');
    const id = newId('sr');
    this.get(
      `INSERT INTO scope_request (id, team_id, member_id, domain, target, reason, diff_size, risk, blocked_step, fallback, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`
    ).run(id, m.team_id, m.id, domain, target, String(reason || ''), diffSize, risk, blockedStep, fallback, nowIso());
    this.events.append({
      teamId: m.team_id, memberId: m.id, taskId: input.taskId ?? null,
      phase: 'wait', action: 'scope.request', target, result: 'BLOCKED',
      next: `await decision for ${id}`, status: 'blocked',
      blockers: [{ kind: 'scope_request', id, detail: `${domain}:${target}` }],
      meta: { stepIndex: -1, requestId: id, domain },
    });
    return this.scopeRequestView(this.get('SELECT * FROM scope_request WHERE id=?').get(id));
  }

  decideScopeRequest(id, body = {}) {
    const req = this.get('SELECT * FROM scope_request WHERE id=?').get(id);
    if (!req) throw ERR.notFound('scope_request');
    const m = this.get('SELECT * FROM member WHERE id=?').get(req.member_id);
    const ctx = { teamId: req.team_id, memberId: req.member_id, role: m?.role, taskId: null, workspace: this.getTeam(req.team_id).workspace, stepIndex: -1 };
    const out = this.broker.decide(ctx, id, body);
    this.scheduler.evaluate(req.team_id);
    return {
      scopeRequest: this.scopeRequestView(this.get('SELECT * FROM scope_request WHERE id=?').get(id)),
      decision: out.decision,
      grant: out.grant,
    };
  }

  // ---------- 消息 ----------
  sendMessage(input = {}) {
    const teamId = input.teamId || this.memberRow(input.from).team_id;
    const out = this.bus.send({ ...input, teamId });
    return out;
  }

  listMessages(teamId, filter = {}) { return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.bus.list(teamId, filter) }; }
  ackMessage(id, state) { return this.bus.ack(id, state); }

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
    return { id: r.id, teamId: r.team_id, taskId: r.task_id ?? null, memberId: r.member_id, title: r.title, status: r.status, orderNo: Number(r.order_no), blockedBy: parseJson(r.blocked_by_json, []), createdAt: r.created_at, updatedAt: r.updated_at };
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
    this.get('INSERT INTO todo (id, team_id, task_id, member_id, title, status, order_no, blocked_by_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.teamId, input.taskId ?? null, input.memberId ?? null, input.title, input.status || 'open', Number(input.orderNo) || 0, json(input.blockedBy || []), t, t);
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
    tx(this.db, () => {
      this.get('DELETE FROM todo WHERE task_id=?').run(taskId);
      for (const row of rows) {
        const id = newId('todo');
        this.get('INSERT INTO todo (id, team_id, task_id, member_id, title, status, order_no, blocked_by_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, task.team_id, taskId, task.assignee ?? null, row.title, row.status, row.orderNo, json(row.blockedBy), t, t);
      }
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
    const sets = []; const args = [];
    if (body.title !== undefined) { sets.push('title=?'); args.push(body.title); }
    if (body.status !== undefined) { sets.push('status=?'); args.push(body.status); }
    if (body.orderNo !== undefined) { sets.push('order_no=?'); args.push(Number(body.orderNo)); }
    if (body.blockedBy !== undefined) { sets.push('blocked_by_json=?'); args.push(json(body.blockedBy)); }
    if (sets.length) { sets.push('updated_at=?'); args.push(nowIso(), id); this.get(`UPDATE todo SET ${sets.join(',')} WHERE id=?`).run(...args); }
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
    const decisions = this.get('SELECT * FROM decision WHERE team_id=? ORDER BY decided_at ASC').all(teamId);
    const events = this.events.countEvents(teamId);
    const lines = [];
    lines.push(`# dsh-team 运行报告：${team.name}`);
    lines.push('');
    lines.push(`- teamId: \`${team.id}\``);
    lines.push(`- workspace: \`${team.workspace}\``);
    lines.push(`- 生成时间: ${nowIso()}`);
    lines.push(`- 事件总数: ${events}`);
    lines.push(`- 成员: ${members.length} / 任务: ${tasks.length} / 审计: ${audit.length}`);
    lines.push(`- 写冲突: ${metrics.conflicts} / 权限拒绝: ${metrics.denials} / 授权: ${metrics.grants}`);
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
    lines.push('## 决策（落盘对象）');
    if (!decisions.length) lines.push('_无_');
    else {
      lines.push('| 时间 | 类型 | 结论 | 决策人 | 理由 |');
      lines.push('|---|---|---|---|---|');
      for (const d of decisions) lines.push(`| ${d.decided_at} | ${d.kind} | ${d.chosen} | ${d.decided_by} | ${redactor.str(String(d.reason ?? ''))} |`);
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
    // 进程重启后，内存里等待决策的 scope 请求已经没有任何 Worker 在等：
    // 留着会让面板出现「点了也没用的幽灵审批」，统一收敛为 expired。
    let expired = 0;
    try {
      const rows = this.get("SELECT id, team_id, member_id, target FROM scope_request WHERE status='pending'").all();
      for (const r of rows) {
        this.get("UPDATE scope_request SET status='expired', decided_at=? WHERE id=?").run(nowIso(), r.id);
        this.audit({ teamId: r.team_id, actor: 'system', domain: 'scope', action: 'recover', target: r.target, result: 'EXPIRED', detail: { requestId: r.id, memberId: r.member_id, reason: 'sidecar restart' } });
        expired++;
      }
    } catch (e) { this.log({ level: 'error', msg: 'expire pending scopes failed', err: String(e.message) }); }
    if (expired) this.log({ level: 'info', msg: 'expired pending scope requests', count: expired });
    this.events.verifyAll(null);
    return recovered;
  }

  close() {
    try { this.runner.shutdown(); } catch { /* ignore */ }
    try { this.scheduler.shutdown(); } catch { /* ignore */ }
    try { this.sse.close(); } catch { /* ignore */ }
    closeDb(this.db);
  }
}

// core.mjs — 组合根：装配 StateStore/EventStore/PermBroker/Scheduler/Runner/Bus/SSE，并承载业务查询
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb, q } from './db.mjs';
import { EventStore, rowToEvent } from './eventstore.mjs';
import { PermBroker } from './broker.mjs';
import { Scheduler, rowToTask } from './scheduler.mjs';
import { WorkerRunner } from './runner.mjs';
import { MessageBus, rowToMessage } from './bus.mjs';
import { SseHub } from './sse.mjs';
import {
  ERR, now, nowIso, newId, json, parseJson, clamp, redactor, REDACTED,
  isSensitiveName, percentile, sha256,
} from './util.mjs';
import { DOMAINS, OPS_BY_DOMAIN } from './policy.mjs';

const STATUSES = ['queued', 'provisioning', 'idle', 'running', 'blocked', 'done', 'failed', 'interrupted', 'retired'];

export class DshTeam {
  constructor({ home, log = () => {}, leaseMs = 15000 } = {}) {
    this.home = home;
    this.log = log;
    this.db = openDb(path.join(home, 'team.db'));
    this.get = q(this.db);
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
  createTeam({ name, workspace, maxMembers = 64, maxConcurrency = 8, failurePolicy = 'continue', maxAttempts = 3, autoApprove = null }) {
    if (!name) throw ERR.bad('name required');
    if (!workspace) throw ERR.bad('workspace required');
    const abs = path.resolve(workspace);
    fs.mkdirSync(abs, { recursive: true });
    const id = newId('team');
    const t = nowIso();
    this.get(
      `INSERT INTO team (id, name, workspace, max_members, max_concurrency, failure_policy, max_attempts, auto_approve_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, name, abs, Number(maxMembers), Number(maxConcurrency), failurePolicy, Number(maxAttempts), autoApprove ? json(autoApprove) : null, t, t);
    this.seedDefaultPolicies(id);
    return this.teamView(this.get('SELECT * FROM team WHERE id=?').get(id));
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
      maxMembers: Number(t.max_members), maxConcurrency: Number(t.max_concurrency),
      failurePolicy: t.failure_policy, maxAttempts: Number(t.max_attempts),
      autoApprove: parseJson(t.auto_approve_json, null),
      autoTakeover: Number(t.auto_takeover) === 1,
      createdAt: t.created_at,
    };
  }

  getTeam(id) {
    const t = this.get('SELECT * FROM team WHERE id=?').get(id);
    if (!t) throw ERR.notFound('team');
    return t;
  }

  listTeams() { return this.get('SELECT * FROM team ORDER BY created_at ASC').all().map((t) => this.teamView(t)); }

  patchTeam(id, body = {}) {
    const t = this.getTeam(id);
    const map = { name: 'name', workspace: 'workspace', maxMembers: 'max_members', maxConcurrency: 'max_concurrency', failurePolicy: 'failure_policy', maxAttempts: 'max_attempts' };
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

  addMember(teamId, { name, role = 'worker', model = null, contextMode = 'isolated', defaultPlan = null }) {
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
      `INSERT INTO member (id, team_id, name, role, model, context_mode, default_plan_json, quota_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?)`
    ).run(id, teamId, name, role, model, contextMode, defaultPlan ? json(defaultPlan) : null, t, t);
    this.events.append({
      teamId, memberId: id, taskId: null, phase: 'init', action: 'member.create',
      target: name, result: 'OK', next: status === 'queued' ? 'wait for capacity' : 'wait for task',
      status, blockers: status === 'queued' ? [{ kind: 'quota', detail: `maxMembers=${team.max_members}` }] : [],
      meta: { stepIndex: -1, role, contextMode },
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
    return {
      id: m.id, teamId: m.team_id, name: m.name, role: m.role, model: m.model, contextMode: m.context_mode,
      status: st.status, leaseUntil: rt.leaseUntil, currentTaskId: task?.id ?? null,
      step: st.step, seq: st.seq, last: st.last, next: st.next,
      blockers: st.blockers || [], stale: !!st.stale, asOf: st.asOf,
      // 进度比例 0..1（契约 §3.2：已完成 step 数 / 计划 step 总数）
      pct: total ? clamp((idx + 1) / total, 0, 1) : null,
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

  // ---------- 待办 ----------
  todoView(r) {
    return { id: r.id, teamId: r.team_id, memberId: r.member_id, title: r.title, status: r.status, orderNo: Number(r.order_no), blockedBy: parseJson(r.blocked_by_json, []), createdAt: r.created_at, updatedAt: r.updated_at };
  }
  listTodos({ teamId, memberId = null } = {}) {
    let sql = 'SELECT * FROM todo WHERE team_id=?'; const args = [teamId];
    if (memberId) { sql += ' AND member_id=?'; args.push(memberId); }
    sql += ' ORDER BY order_no ASC, created_at ASC';
    return { asOf: nowIso(), version: this.scheduler.version(teamId), items: this.get(sql).all(...args).map((r) => this.todoView(r)) };
  }
  createTodo(input = {}) {
    this.getTeam(input.teamId);
    if (!input.title) throw ERR.bad('title required');
    const id = newId('todo'); const t = nowIso();
    this.get('INSERT INTO todo (id, team_id, member_id, title, status, order_no, blocked_by_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.teamId, input.memberId ?? null, input.title, input.status || 'open', Number(input.orderNo) || 0, json(input.blockedBy || []), t, t);
    return this.todoView(this.get('SELECT * FROM todo WHERE id=?').get(id));
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

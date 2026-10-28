// scheduler.mjs — DAG 依赖自动派发（FR-2）：依赖满足即 ready，主动唤醒，不依赖 Lead 轮询
import fs from 'node:fs';
import path from 'node:path';
import { q } from './db.mjs';
import { ERR, nowIso, newId, json, parseJson } from './util.mjs';

const TERMINAL = ['done', 'failed', 'skipped'];

export function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id, teamId: r.team_id, subject: r.subject, assignee: r.assignee ?? null,
    status: r.status, plan: parseJson(r.plan_json, []), writeScopes: parseJson(r.write_scopes_json, []),
    acceptance: r.acceptance ?? null, attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts), failurePolicy: r.failure_policy ?? null,
    priority: Number(r.priority), attemptedAt: r.attempted_at, finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

export class Scheduler {
  constructor({ db, events, runner, sse, broker, log = () => {}, settleMs = 200, tickMs = 150 }) {
    this.db = db;
    this.get = q(db);
    this.events = events;
    this.runner = runner;
    this.sse = sse;
    this.broker = broker;
    this.log = log;
    this.settleMs = settleMs;   // 建任务后先留一个「声明依赖」的窗口，避免建任务即启动的竞态
    this.timers = new Set();
    this._busy = new Set();
    this._tick = setInterval(() => this.tickAll(), tickMs);
    this._tick.unref?.();
  }

  tickAll() {
    try {
      for (const r of this.get('SELECT id FROM team').all()) {
        try { this.evaluate(r.id); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // ---------- 建图 ----------
  createTask(input) {
    const { teamId, subject, assignee = null, plan = [], writeScopes = [], acceptance = null, priority = 0, failurePolicy = null, maxAttempts = null, deps = [] } = input;
    const team = this.get('SELECT * FROM team WHERE id=?').get(teamId);
    if (!team) throw ERR.notFound('team');
    if (!subject) throw ERR.bad('subject required');
    if (assignee && !this.get('SELECT id FROM member WHERE id=? AND team_id=?').get(assignee, teamId)) throw ERR.notFound('assignee');
    const id = newId('task');
    const t = nowIso();
    this.get(
      `INSERT INTO task (id, team_id, subject, assignee, status, plan_json, write_scopes_json, acceptance,
        attempts, max_attempts, failure_policy, priority, created_at, updated_at)
       VALUES (?,?,?,?,'pending',?,?,?,0,?,?,?,?,?)`
    ).run(id, teamId, subject, assignee, json(plan), json(writeScopes), acceptance,
      Number(maxAttempts ?? team.max_attempts), failurePolicy, Number(priority) || 0, t, t);
    // 支持建任务时原子声明依赖（deps: [{from, condition, artifactPath}]，from 为上游任务）
    const added = [];
    try {
      for (const d of Array.isArray(deps) ? deps : []) {
        added.push(this.addDep({ from: d.from, to: id, condition: d.condition || 'all_success', artifactPath: d.artifactPath ?? null, defer: true }));
      }
      if (this.findCycle(teamId)) throw ERR.cycle('dependency would create a cycle');
    } catch (e) {
      for (const d of added) this.get('DELETE FROM dep WHERE id=?').run(d.id);
      this.get('DELETE FROM task WHERE id=?').run(id);
      throw e;
    }
    const task = rowToTask(this.get('SELECT * FROM task WHERE id=?').get(id));
    this.evaluate(teamId);
    return task;
  }

  addDep({ from, to, condition = 'all_success', artifactPath = null, defer = false }) {
    if (!from || !to) throw ERR.bad('from and to required');
    if (from === to) throw ERR.cycle('self dependency');
    const a = this.get('SELECT * FROM task WHERE id=?').get(from);
    const b = this.get('SELECT * FROM task WHERE id=?').get(to);
    if (!a || !b) throw ERR.notFound('task');
    if (a.team_id !== b.team_id) throw ERR.bad('tasks belong to different teams');
    const allowed = ['all_success', 'any_success', 'on_failure', 'artifact_exists'];
    if (!allowed.includes(condition)) throw ERR.bad(`condition must be one of ${allowed.join('|')}`);
    if (condition === 'artifact_exists' && !artifactPath) throw ERR.bad('artifactPath required for artifact_exists');
    const depId = Number(this.get(
      `INSERT INTO dep (team_id, from_task, to_task, condition, artifact_path, created_at) VALUES (?,?,?,?,?,?)`
    ).run(a.team_id, from, to, condition, artifactPath, nowIso()).lastInsertRowid);
    const cyc = this.findCycle(a.team_id);
    if (cyc) {
      this.get('DELETE FROM dep WHERE id=?').run(depId);
      throw ERR.cycle(`dependency would create a cycle: ${cyc.join(' → ')}`);
    }
    if (!defer) this.evaluate(a.team_id);
    return { id: depId, teamId: a.team_id, from, to, condition, artifactPath };
  }

  removeDep(id) {
    const d = this.get('SELECT * FROM dep WHERE id=?').get(id);
    if (!d) throw ERR.notFound('dep');
    this.get('DELETE FROM dep WHERE id=?').run(id);
    this.evaluate(d.team_id);
    return { ok: true };
  }

  /** 环检测：返回环路径或 null（FR-2.6） */
  findCycle(teamId) {
    const deps = this.get('SELECT from_task, to_task FROM dep WHERE team_id=?').all(teamId);
    const adj = new Map();
    for (const d of deps) {
      if (!adj.has(d.from_task)) adj.set(d.from_task, []);
      adj.get(d.from_task).push(d.to_task);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const stack = [];
    const dfs = (n) => {
      color.set(n, GRAY); stack.push(n);
      for (const m of adj.get(n) || []) {
        const c = color.get(m) || WHITE;
        if (c === GRAY) { const i = stack.indexOf(m); return stack.slice(i).concat(m); }
        if (c === WHITE) { const r = dfs(m); if (r) return r; }
      }
      color.set(n, BLACK); stack.pop();
      return null;
    };
    for (const n of adj.keys()) if ((color.get(n) || WHITE) === WHITE) { const r = dfs(n); if (r) return r; }
    return null;
  }

  // ---------- 依赖求值 ----------
  depsOf(taskId) {
    return this.get('SELECT * FROM dep WHERE to_task=?').all(taskId).map((d) => ({
      id: Number(d.id), from: d.from_task, to: d.to_task, condition: d.condition, artifactPath: d.artifact_path,
    }));
  }

  depSatisfied(dep, workspace) {
    const src = this.get('SELECT * FROM task WHERE id=?').get(dep.from);
    const st = src?.status || 'pending';
    switch (dep.condition) {
      case 'all_success': return st === 'done';
      case 'any_success': return st === 'done';
      case 'on_failure': return st === 'failed';
      case 'artifact_exists': {
        if (!dep.artifactPath) return false;
        try { return fs.existsSync(path.resolve(workspace, dep.artifactPath)); } catch { return false; }
      }
      default: return false;
    }
  }

  /** 任务可执行与否 + 阻塞原因 */
  readiness(task, workspace) {
    const deps = this.depsOf(task.id);
    if (!deps.length) return { ready: true, blockers: [] };
    const blockers = [];
    const states = [];
    for (const d of deps) {
      const src = this.get('SELECT status FROM task WHERE id=?').get(d.from);
      states.push({ dep: d, status: src?.status || 'pending', ok: this.depSatisfied(d, workspace) });
    }
    if (task.status === 'done' || task.status === 'skipped') return { ready: false, blockers: [] };

    // any_success / on_failure：只要有一条满足即可
    const trigger = states.filter((s) => s.dep.condition === 'any_success' || s.dep.condition === 'on_failure');
    const required = states.filter((s) => !trigger.includes(s));
    for (const s of required) if (!s.ok) blockers.push({ kind: 'dep', id: s.dep.id, detail: `${s.dep.from} (${s.dep.condition}) is ${s.status}` });
    if (trigger.length) {
      const anyOk = trigger.some((s) => s.ok);
      if (!anyOk) {
        const allTerminal = trigger.every((s) => TERMINAL.includes(s.status));
        blockers.push({ kind: 'dep', id: trigger[0].dep.id, detail: `${trigger.map((t) => `${t.dep.from}:${t.status}`).join(',')}${allTerminal ? ' (unsatisfiable)' : ''}` });
      }
    }
    return { ready: blockers.length === 0, blockers };
  }

  // ---------- 自动派发 ----------
  evaluate(teamId) {
    if (!teamId) return { started: [], ready: [], blocked: [] };
    if (this._busy.has(teamId)) return { started: [], ready: [], blocked: [] };
    this._busy.add(teamId);
    const started = []; const ready = []; const blocked = [];
    try {
      const team = this.get('SELECT * FROM team WHERE id=?').get(teamId);
      if (!team) return { started, ready, blocked };
      let tasks = this.get("SELECT * FROM task WHERE team_id=? AND status IN ('pending','ready') ORDER BY priority ASC, created_at ASC").all(teamId);

      // 1) 依赖求值 → ready / blocked
      for (const t of tasks) {
        const task = rowToTask(t);
        const r = this.readiness(task, team.workspace);
        if (r.ready && task.status === 'pending') {
          this.get("UPDATE task SET status='ready', updated_at=? WHERE id=?").run(nowIso(), task.id);
          this.emitTaskState(teamId, task.id, 'ready', task.assignee);
          ready.push(task.id);
        } else if (!r.ready && r.blockers.some((b) => String(b.detail || '').includes('unsatisfiable'))) {
          this.get("UPDATE task SET status='blocked', updated_at=? WHERE id=?").run(nowIso(), task.id);
          this.emitTaskState(teamId, task.id, 'blocked', task.assignee);
          blocked.push(task.id);
        }
      }

      // 2) 并发控制 + 派发
      const running = this.get("SELECT COUNT(*) AS c FROM task WHERE team_id=? AND status='running'").get(teamId);
      const maxConc = Number(team.max_concurrency) || 8;
      let slots = Math.max(0, maxConc - Number(running.c));
      const candidates = this.get(
        "SELECT * FROM task WHERE team_id=? AND status='ready' ORDER BY priority ASC, created_at ASC"
      ).all(teamId);
      for (const row of candidates) {
        if (slots <= 0) break;
        const task = rowToTask(row);
        // 依赖可能是在任务已置 ready 之后才声明的：派发前必须再求值一次，不满足就降级
        const r = this.readiness(task, team.workspace);
        if (!r.ready) {
          const unsatisfiable = r.blockers.some((b) => String(b.detail || '').includes('unsatisfiable'));
          this.get('UPDATE task SET status=?, updated_at=? WHERE id=?').run(unsatisfiable ? 'blocked' : 'pending', nowIso(), task.id);
          this.emitTaskState(teamId, task.id, unsatisfiable ? 'blocked' : 'pending', task.assignee);
          continue;
        }
        // 建任务后留 settle 窗口：让 Lead 有机会先声明依赖，再派发
        if (Date.now() - Date.parse(task.createdAt) < this.settleMs) continue;
        const assignee = task.assignee || this.pickIdleMember(teamId);
        if (!assignee) break;
        const st = this.get('SELECT status FROM member_state WHERE member_id=?').get(assignee);
        if (!st || st.status !== 'idle') continue;
        if (this.runner.workers.get(assignee) && !this.runner.workers.get(assignee).exited) continue;
        try {
          this.startTask(teamId, task, assignee);
          started.push(task.id);
          slots--;
        } catch (e) {
          this.log({ level: 'error', msg: 'start task failed', taskId: task.id, err: String(e.message) });
        }
      }
    } finally {
      this._busy.delete(teamId);
    }
    return { started, ready, blocked };
  }

  pickIdleMember(teamId) {
    const rows = this.get(
      `SELECT m.id FROM member m JOIN member_state s ON s.member_id = m.id
       WHERE m.team_id=? AND s.status='idle' AND m.id NOT IN (
         SELECT assignee FROM task WHERE team_id=? AND status='running' AND assignee IS NOT NULL
       ) ORDER BY m.created_at ASC`
    ).all(teamId, teamId);
    return rows[0]?.id ?? null;
  }

  startTask(teamId, task, assignee) {
    const team = this.get('SELECT * FROM team WHERE id=?').get(teamId);
    const plan = task.plan || [];
    this.get("UPDATE task SET status='running', assignee=?, attempts=attempts+1, attempted_at=?, updated_at=? WHERE id=?")
      .run(assignee, nowIso(), nowIso(), task.id);
    this.get("UPDATE member SET updated_at=? WHERE id=?").run(nowIso(), assignee);
    const m = this.get('SELECT * FROM member WHERE id=?').get(assignee);
    // 成员进入 running：事件驱动（C2），stepIndex=-1 表示尚未开始任何 step
    this.events.append({
      teamId, memberId: assignee, taskId: task.id,
      phase: 'init', action: 'task.start', target: task.subject,
      result: 'OK', next: plan[0] ? `${plan[0].action || plan[0].op?.kind || 'step'} ${plan[0].target ?? ''}`.trim() : 'no steps',
      status: 'running', blockers: [],
      meta: { stepIndex: -1, step: 'S0', stepTotal: plan.length, taskId: task.id, attempt: task.attempts + 1 },
    });
    this.emitTaskState(teamId, task.id, 'running', assignee);
    this.runner.start(assignee, task.id, { resumeFrom: 0 });
    this.log({ level: 'info', msg: 'task started', teamId, taskId: task.id, memberId: assignee, plan: plan.length });
    return true;
  }

  // ---------- 完成/失败回调（Runner 调用） ----------
  onTaskDone(ctx, args = {}) {
    const { teamId, memberId, taskId } = ctx;
    const task = this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) {
      // 收件 worker（唤醒模式）：消费完消息后回到 idle
      this.events.append({
        teamId, memberId, taskId: null, phase: 'done', action: 'wake.done', target: 'inbox',
        result: 'OK', next: null, status: 'idle', blockers: [], meta: { stepIndex: 0, step: 'S1', stepTotal: 1 },
      });
      this.evaluate(teamId);
      return;
    }
    const plan = parseJson(task.plan_json, []);
    this.get("UPDATE task SET status='done', finished_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), taskId);
    this.events.append({
      teamId, memberId, taskId,
      phase: 'done', action: 'task.done', target: task.subject, result: 'OK', next: null,
      status: 'idle', blockers: [],
      meta: { stepIndex: plan.length - 1, step: `S${plan.length}`, stepTotal: plan.length, resultSummary: args?.result ?? null },
    });
    this.emitTaskState(teamId, taskId, 'done', memberId);
    this.log({ level: 'info', msg: 'task done', teamId, taskId, memberId });
    this.evaluate(teamId);
  }

  onTaskFailed(ctx, args = {}) {
    const { teamId, memberId, taskId } = ctx;
    const task = this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) {
      this.events.append({
        teamId, memberId, taskId: null, phase: 'fail', action: 'wake.fail', target: 'inbox',
        result: `FAIL:${args?.error ?? 'error'}`, next: null, status: 'idle', blockers: [],
        meta: { stepIndex: 0, step: 'S1', stepTotal: 1 },
      });
      return;
    }
    const retryable = args?.retryable !== false;
    const attempts = Number(task.attempts);
    const maxAttempts = Number(task.max_attempts) || 1;
    const policy = task.failure_policy || this.get('SELECT failure_policy FROM team WHERE id=?').get(teamId)?.failure_policy || 'continue';

    if (retryable && attempts < maxAttempts) {
      const delay = Math.min(8000, 100 * 2 ** (attempts - 1));
      this.get("UPDATE task SET status='pending', updated_at=? WHERE id=?").run(nowIso(), taskId);
      this.events.append({
        teamId, memberId, taskId, phase: 'fail', action: 'task.retry', target: task.subject,
        result: `FAIL:${args?.error ?? 'error'}`, next: `retry in ${delay}ms (attempt ${attempts}/${maxAttempts})`,
        status: 'idle', blockers: [], meta: { stepIndex: -1, error: String(args?.error ?? ''), delay, attempt: attempts },
      });
      this.emitTaskState(teamId, taskId, 'pending', memberId);
      const t = setTimeout(() => { this.timers.delete(t); try { this.evaluate(teamId); } catch { /* ignore */ } }, delay);
      t.unref?.();
      this.timers.add(t);
      return;
    }

    const finalStatus = policy === 'skip' ? 'skipped' : 'failed';
    this.get('UPDATE task SET status=?, finished_at=?, updated_at=? WHERE id=?').run(finalStatus, nowIso(), nowIso(), taskId);
    this.events.append({
      teamId, memberId, taskId, phase: 'fail', action: 'task.fail', target: task.subject,
      result: `FAIL:${args?.error ?? 'error'}`, next: policy === 'continue' ? 'continue other branches' : policy,
      status: 'failed', blockers: [{ kind: 'task', id: taskId, detail: String(args?.error ?? 'failed') }],
      meta: { stepIndex: -1, error: String(args?.error ?? ''), policy, attempts, maxAttempts },
    });
    this.emitTaskState(teamId, taskId, finalStatus, memberId);
    this.log({ level: 'warn', msg: 'task failed', teamId, taskId, memberId, policy });

    if (policy === 'abort_team') this.abortTeam(teamId, `task ${taskId} failed (abort_team)`);
    this.evaluate(teamId);
  }

  abortTeam(teamId, reason) {
    for (const t of this.get("SELECT id, assignee FROM task WHERE team_id=? AND status IN ('pending','ready','blocked')").all(teamId)) {
      this.get("UPDATE task SET status='failed', finished_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), t.id);
    }
    for (const m of this.get('SELECT id FROM member WHERE team_id=?').all(teamId)) {
      const st = this.events.state(m.id);
      if (st && ['running', 'blocked'].includes(st.status)) {
        try { this.runner.interrupt(m.id, reason); } catch { /* ignore */ }
      }
    }
  }

  emitTaskState(teamId, taskId, status, memberId) {
    if (!this.sse) return;
    try {
      this.sse.broadcastSynthetic('task.state', { teamId, memberId: memberId ?? null, taskId, status }, { teamId, memberId: memberId ?? null });
    } catch { /* ignore */ }
  }

  /** 消息唤醒 idle 成员 / 新成员空闲时推进队列 */
  wake(memberId) {
    const m = this.get('SELECT * FROM member WHERE id=?').get(memberId);
    if (!m) return;
    this.evaluate(m.team_id);
  }

  // ---------- DAG 视图 ----------
  dag(teamId) {
    const team = this.get('SELECT * FROM team WHERE id=?').get(teamId);
    if (!team) throw ERR.notFound('team');
    const tasks = this.get('SELECT * FROM task WHERE team_id=? ORDER BY created_at ASC').all(teamId).map(rowToTask);
    const deps = this.get('SELECT * FROM dep WHERE team_id=?').all(teamId).map((d) => ({
      id: Number(d.id), from: d.from_task, to: d.to_task, condition: d.condition, artifactPath: d.artifact_path,
    }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const nodes = tasks.map((t) => {
      const r = this.readiness(t, team.workspace);
      return {
        taskId: t.id, subject: t.subject, status: t.status, assignee: t.assignee,
        attempts: t.attempts, planSize: t.plan.length,
        dependsOn: deps.filter((d) => d.to === t.id).map((d) => d.from),
        ready: r.ready && (t.status === 'ready' || t.status === 'pending'),
        blocked: t.status === 'blocked' || (!r.ready && !TERMINAL.includes(t.status)),
        blockers: r.blockers,
      };
    });
    const ready = nodes.filter((n) => n.ready).map((n) => n.taskId);
    return {
      teamId, asOf: nowIso(), version: this.version(teamId),
      nodes, edges: deps, ready, criticalPath: this.criticalPath(tasks, deps),
      members: this.get('SELECT id, name FROM member WHERE team_id=?').all(teamId),
      workspace: team.workspace,
    };
  }

  criticalPath(tasks, deps) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const incoming = new Map(tasks.map((t) => [t.id, deps.filter((d) => d.to === t.id).map((d) => d.from)]));
    const weight = (id) => Math.max(1, (byId.get(id)?.plan?.length || 0));
    const memo = new Map();
    const depth = (id, seen = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      let best = 0; let bestPath = [];
      for (const p of incoming.get(id) || []) {
        const r = depth(p, seen);
        if (r.len > best) { best = r.len; bestPath = r.path; }
      }
      const out = { len: best + weight(id), path: [...bestPath, id] };
      memo.set(id, out);
      return out;
    };
    let best = { len: 0, path: [] };
    for (const t of tasks) { const r = depth(t.id); if (r.len > best.len) best = r; }
    return best.path;
  }

  version(teamId) {
    const r = this.get('SELECT COALESCE(MAX(id),0) AS m FROM event WHERE team_id=?').get(teamId);
    return Number(r.m);
  }

  /** 重启恢复：running 任务回 ready，不静默丢（FR-6.5） */
  recover(teamId) {
    const rows = this.get("SELECT * FROM task WHERE team_id=? AND status='running'").all(teamId);
    for (const t of rows) this.get("UPDATE task SET status='ready', updated_at=? WHERE id=?").run(nowIso(), t.id);
    for (const m of this.get('SELECT id FROM member WHERE team_id=?').all(teamId)) {
      const st = this.events.state(m.id);
      if (st && ['running', 'provisioning', 'blocked'].includes(st.status)) {
        this.events.append({
          teamId, memberId: m.id, taskId: null, phase: 'recover', action: 'sidecar.restart',
          target: m.id, result: 'OK', next: 'requeue task', status: 'interrupted',
          blockers: [{ kind: 'recover', detail: 'sidecar restarted' }],
          meta: { stepIndex: st.seq ? -1 : -1, previousStatus: st.status },
        });
      }
    }
    const out = this.evaluate(teamId);
    return { requeued: rows.length, ...out };
  }

  shutdown() {
    clearInterval(this._tick);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

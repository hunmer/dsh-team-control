// runner.mjs — 成员进程管理：拉起 / 租约 / 同步中断（C5）/ 恢复 / 僵尸检测
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { q } from './db.mjs';
import { ERR, now, nowIso, json, parseJson } from './util.mjs';

const WORKER_SRC = new URL('./worker/worker.mjs', import.meta.url);

export class WorkerRunner {
  constructor({ db, events, broker, bus, home, leaseMs = 15000, graceMs = 2500, log = () => {} }) {
    this.db = db;
    this.events = events;
    this.broker = broker;
    this.bus = bus;
    this.home = home;
    this.leaseMs = leaseMs;
    this.graceMs = graceMs;
    this.log = log;
    this.get = q(db);
    this.workers = new Map();   // memberId → {child, ctx, resumeFrom, interruptRequested, exited}
    this.hooks = {
      onTaskDone: () => {},
      onTaskFailed: () => {},
      onWorkerGone: () => {},
      workspaceOf: (teamId) => this.get('SELECT workspace FROM team WHERE id=?').get(teamId)?.workspace,
    };
    this._sweep = setInterval(() => this.sweepLeases(), 2000);
    this._sweep.unref?.();
  }

  attach(hooks) { Object.assign(this.hooks, hooks || {}); }

  // ---------- 运行时/租约 ----------
  runtime(memberId) {
    const r = this.get('SELECT * FROM member_runtime WHERE member_id=?').get(memberId);
    return r ? { memberId, leaseUntil: r.lease_until == null ? null : Number(r.lease_until), pid: r.pid == null ? null : Number(r.pid), startedAt: r.started_at } : { memberId, leaseUntil: null, pid: null, startedAt: null };
  }

  touch(memberId, pid = null) {
    const lease = now() + this.leaseMs;
    const prev = this.runtime(memberId);
    this.get(
      `INSERT INTO member_runtime (member_id, lease_until, pid, started_at, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(member_id) DO UPDATE SET lease_until=excluded.lease_until,
         pid=COALESCE(excluded.pid, member_runtime.pid), started_at=COALESCE(member_runtime.started_at, excluded.started_at),
         updated_at=excluded.updated_at`
    ).run(memberId, lease, pid, nowIso(), nowIso());
    return lease;
  }

  clearLease(memberId) {
    this.get("UPDATE member_runtime SET lease_until=NULL, pid=NULL, updated_at=? WHERE member_id=?").run(nowIso(), memberId);
  }

  /** FR-6.4：租约超时 2 周期 → suspected_dead（事件驱动，状态一致） */
  sweepLeases() {
    const limit = now() - this.leaseMs * 2;
    const rows = this.get(
      `SELECT r.member_id AS id, r.lease_until AS lease, s.status AS status
       FROM member_runtime r JOIN member_state s ON s.member_id = r.member_id
       WHERE r.lease_until IS NOT NULL AND r.lease_until < ?
         AND s.status IN ('running','blocked','provisioning')`
    ).all(limit);
    for (const row of rows) {
      if (this.workers.get(row.id)?.interruptRequested) continue;
      try {
        const m = this.get('SELECT team_id FROM member WHERE id=?').get(row.id);
        this.events.append({
          teamId: m.team_id, memberId: row.id, taskId: this.currentTaskId(row.id),
          phase: 'recover', action: 'lease.timeout', target: row.id, result: 'FAIL:suspected_dead',
          next: 'await resume or requeue', status: 'interrupted', blockers: [{ kind: 'lease', detail: 'lease expired' }],
          meta: { leaseUntil: row.lease, missed: 2 },
        });
        this.clearLease(row.id);
        // 超时的成员如果还挂着 scope 申请，必须一并收敛，否则面板会留下点了也没用的幽灵审批
        try { this.broker.releasePending(row.id, 'lease timeout'); } catch { /* ignore */ }
        this.killWorker(row.id, { hard: true });
        this.log({ level: 'warn', msg: 'lease timeout', memberId: row.id });
        this.hooks.onWorkerGone(row.id, 'suspected_dead');
        // FR-6.4 可配自动接管
        const tk = this.get('SELECT auto_takeover FROM team WHERE id=?').get(m.team_id);
        if (tk && Number(tk.auto_takeover) === 1) {
          const t = setTimeout(() => {
            try { this.resume(row.id); this.log({ level: 'info', msg: 'auto takeover', memberId: row.id }); }
            catch (e) { this.log({ level: 'warn', msg: 'auto takeover failed', memberId: row.id, err: String(e.message) }); }
          }, 60);
          t.unref?.();
        }
      } catch (e) { this.log({ level: 'error', msg: 'sweep failed', err: String(e.message) }); }
    }
  }

  currentTaskId(memberId) {
    const t = this.get("SELECT id FROM task WHERE assignee=? AND status='running' ORDER BY updated_at DESC LIMIT 1").get(memberId);
    return t?.id ?? null;
  }

  // ---------- 启动 ----------
  bundleDir(memberId) {
    const dir = path.join(this.home, 'workers', memberId);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'worker.mjs');
    fs.copyFileSync(WORKER_SRC, dest);
    return dir;
  }

  start(memberId, taskId, { resumeFrom = 0, taskOverride = null } = {}) {
    const existing = this.workers.get(memberId);
    if (existing && !existing.exited) throw ERR.invalidState(`worker already running for ${memberId}`);
    const member = this.get('SELECT * FROM member WHERE id=?').get(memberId);
    if (!member) throw ERR.notFound('member');
    const team = this.get('SELECT * FROM team WHERE id=?').get(member.team_id);
    if (!team) throw ERR.notFound('team');
    const task = taskOverride || this.get('SELECT * FROM task WHERE id=?').get(taskId);
    if (!task) throw ERR.notFound('task');
    const effectiveTaskId = task.id ?? taskId;

    const ctx = {
      teamId: team.id, memberId, role: member.role, taskId: effectiveTaskId,
      workspace: team.workspace, stepIndex: -1,
      resumeFrom: Math.max(0, Number(resumeFrom) || 0),
    };
    const projection = this.broker.buildEnvProjection(ctx);
    const dir = this.bundleDir(memberId);
    const args = [
      '--permission',
      `--allow-fs-read=${dir}`,
      path.join(dir, 'worker.mjs'),
      `--member=${memberId}`,
      `--team=${team.id}`,
      `--task=${taskId}`,
    ];
    const child = spawn(process.execPath, args, {
      cwd: team.workspace,
      env: projection.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const rec = { child, ctx, resumeFrom: ctx.resumeFrom, taskOverride, interruptRequested: false, exited: false, killed: false, queue: Promise.resolve(), lineBuf: '' };
    this.workers.set(memberId, rec);
    this.touch(memberId, child.pid);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      rec.lineBuf += chunk;
      if (rec.lineBuf.length > 4 * 1024 * 1024) rec.lineBuf = '';
      let i;
      while ((i = rec.lineBuf.indexOf('\n')) >= 0) {
        const line = rec.lineBuf.slice(0, i);
        rec.lineBuf = rec.lineBuf.slice(i + 1);
        if (!line.trim()) continue;
        let fr;
        try { fr = JSON.parse(line); } catch { this.log({ level: 'warn', msg: 'bad rpc frame', memberId, raw: line.slice(0, 200) }); continue; }
        // 心跳走带外通道：scope.request 可能阻塞数分钟，若 ping 排在同一串行队列后面，
        // 成员会被误判为租约超时（suspected_dead），长审批场景直接失效。
        if (fr && fr.op === 'ping') {
          try {
            this.touch(ctx.memberId);
            this.send(rec, { id: fr.id, ok: true, data: { leaseUntil: this.runtime(ctx.memberId).leaseUntil } });
          } catch { /* ignore */ }
          continue;
        }
        rec.queue = rec.queue.then(() => this.handleRpc(rec, fr)).catch((e) => {
          this.log({ level: 'error', msg: 'rpc handler failed', memberId, op: fr?.op, err: String(e?.stack || e) });
        });
      }
    });

    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i);
        errBuf = errBuf.slice(i + 1);
        const clean = this.broker.redactText(line);
        if (clean.trim()) this.log({ level: 'info', msg: 'worker', memberId, line: clean.slice(0, 500) });
      }
      if (errBuf.length > 64 * 1024) errBuf = errBuf.slice(-4096);
    });

    child.on('error', (e) => {
      this.log({ level: 'error', msg: 'worker spawn error', memberId, err: String(e.message) });
    });

    child.on('close', (code, signal) => {
      rec.exited = true;
      rec.exitCode = code;
      // 只清理属于本记录的 map 项：resume 可能已经用同一个 memberId 起了新 worker
      if (this.workers.get(memberId) === rec) this.workers.delete(memberId);
      this.clearLease(memberId);
      const st = this.events.state(memberId);
      const terminal = ['interrupted', 'idle', 'failed', 'done', 'retired'];
      if (rec.interruptRequested || terminal.includes(st?.status)) {
        this.log({ level: 'info', msg: 'worker exited', memberId, code, signal });
      } else {
        this.log({ level: 'warn', msg: 'worker died unexpectedly', memberId, code, signal });
        try {
          this.events.append({
            teamId: team.id, memberId, taskId, phase: 'recover', action: 'worker.exit',
            target: memberId, result: `FAIL:exit_${code}`, next: 'requeue or resume',
            status: 'interrupted', blockers: [{ kind: 'worker', detail: `exit ${code}` }],
            meta: { exitCode: code, signal },
          });
        } catch { /* ignore */ }
        this.hooks.onWorkerGone(memberId, 'worker_exit');
      }
    });
    return { memberId, taskId, resumeFrom: ctx.resumeFrom, pid: child.pid };
  }

  // ---------- 中断（C5：先同步落库，再发信号） ----------
  interrupt(memberId, reason = 'lead interrupt') {
    const member = this.get('SELECT * FROM member WHERE id=?').get(memberId);
    if (!member) throw ERR.notFound('member');
    // 只有活跃成员才可中断：对 idle/done 成员写 interrupted 会制造「无任务可恢复」的僵尸态
    const st = this.events.state(memberId);
    if (!st || !['running', 'blocked', 'provisioning'].includes(st.status)) {
      throw ERR.invalidState(`member is ${st?.status || 'unknown'}; nothing to interrupt`);
    }
    const taskId = this.currentTaskId(memberId);
    const stepIndex = this.workers.get(memberId)?.ctx?.stepIndex ?? this.events.resumeAnchor(memberId).stepIndex;
    // 同步事务：任何 await 之前完成
    const ev = this.events.append({
      teamId: member.team_id, memberId, taskId,
      phase: 'interrupt', action: 'interrupt', target: memberId, result: 'OK',
      next: 'await resume', status: 'interrupted', blockers: [],
      meta: { stepIndex, reason },
    });
    this.clearLease(memberId);
    this.broker.releasePending(memberId, reason);
    const rec = this.workers.get(memberId);
    if (rec) {
      rec.interruptRequested = true;
      try { rec.child.stdin.write(JSON.stringify({ type: 'control', action: 'interrupt' }) + '\n'); } catch { /* ignore */ }
      const child = rec.child;
      const t = setTimeout(() => { try { if (!rec.exited) { rec.killed = true; child.kill('SIGKILL'); } } catch { /* ignore */ } }, this.graceMs);
      t.unref?.();
    }
    // 任务回到 ready，不静默丢（FR-6.5）
    if (taskId) this.get("UPDATE task SET status='ready', updated_at=? WHERE id=? AND status='running'").run(nowIso(), taskId);
    return ev;
  }

  killWorker(memberId, { hard = false } = {}) {
    const rec = this.workers.get(memberId);
    if (!rec) return false;
    rec.interruptRequested = true;
    try { rec.child.stdin.write(JSON.stringify({ type: 'control', action: 'interrupt' }) + '\n'); } catch { /* ignore */ }
    if (hard) { try { rec.child.kill('SIGKILL'); } catch { /* ignore */ } }
    return true;
  }

  /** FR-6.1：从最后 event 的 stepIndex + 1 继续 */
  resume(memberId) {
    const member = this.get('SELECT * FROM member WHERE id=?').get(memberId);
    if (!member) throw ERR.notFound('member');
    // 刚 interrupt 的旧进程可能还在 grace 期内：直接硬杀并摘除记录，否则 start() 会拒绝
    const existing = this.workers.get(memberId);
    if (existing && !existing.exited) {
      existing.interruptRequested = true;
      existing.exited = true;
      try { existing.child.kill('SIGKILL'); } catch { /* ignore */ }
      this.workers.delete(memberId);
    }
    const anchor = this.events.resumeAnchor(memberId);
    const task = this.get(
      "SELECT * FROM task WHERE assignee=? AND status IN ('running','ready','pending') ORDER BY updated_at DESC LIMIT 1"
    ).get(memberId);
    if (!task) throw ERR.invalidState('no resumable task for member');
    this.get("UPDATE task SET status='running', updated_at=? WHERE id=?").run(nowIso(), task.id);
    const ev = this.events.append({
      teamId: member.team_id, memberId, taskId: task.id,
      phase: 'resume', action: 'resume', target: `S${anchor.stepIndex + 2}`,
      result: 'OK', next: 'continue from last completed step', status: 'running', blockers: [],
      meta: { stepIndex: anchor.stepIndex, resumeFrom: anchor.stepIndex + 1, fromSeq: anchor.seq },
    });
    this.touch(memberId);
    this.start(memberId, task.id, { resumeFrom: anchor.stepIndex + 1 });
    return { member, task, resumeFrom: anchor.stepIndex + 1, event: ev };
  }

  // ---------- RPC 分发 ----------
  async handleRpc(rec, fr) {
    const { ctx } = rec;
    this.touch(ctx.memberId);
    const reply = (data) => this.send(rec, { id: fr.id, ok: true, data });
    const fail = (e) => this.send(rec, {
      id: fr.id, ok: false,
      error: { code: e.code || 'E_RPC', message: String(e.message || e), detail: e.detail ?? null },
    });
    try {
      const data = await this.dispatch(rec, fr.op, fr.args || {});
      reply(data);
    } catch (e) {
      if (!(e && e.code)) this.log({ level: 'error', msg: 'rpc error', memberId: ctx.memberId, op: fr.op, err: String(e?.stack || e) });
      fail(e);
    }
  }

  send(rec, obj) {
    try { if (!rec.exited) rec.child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
  }

  async dispatch(rec, op, args) {
    const { ctx } = rec;
    const m = this.get('SELECT * FROM member WHERE id=?').get(ctx.memberId);
    const team = this.get('SELECT * FROM team WHERE id=?').get(ctx.teamId);
    ctx.workspace = team?.workspace;
    ctx.role = m?.role;
    const task = rec.taskOverride || this.get('SELECT * FROM task WHERE id=?').get(ctx.taskId);
    switch (op) {
      case 'bootstrap': {
        // taskOverride（唤醒用的内存任务）只有 plan，没有 plan_json —— 两种形状都要认
        const plan = task && task.plan_json != null
          ? parseJson(task.plan_json, [])
          : (Array.isArray(task?.plan) ? task.plan : []);
        return {
          member: { id: ctx.memberId, name: m?.name, role: m?.role, teamId: ctx.teamId },
          task: {
            id: ctx.taskId, subject: task?.subject,
            plan,
            writeScopes: task && task.write_scopes_json != null ? parseJson(task.write_scopes_json, []) : (Array.isArray(task?.writeScopes) ? task.writeScopes : []),
            acceptance: task?.acceptance,
          },
          resumeFrom: rec.resumeFrom,
          env: { member: m?.name, teamId: ctx.teamId },
          limits: { maxRetries: 5, retryBaseMs: 40, leaseMs: this.leaseMs },
        };
      }
      case 'step.begin': {
        ctx.stepIndex = Number(args.index);
        const pending = this.bus.takeForDelivery(ctx.memberId);
        return { pending, interrupted: !!rec.interruptRequested };
      }
      case 'event.append': {
        const meta = { ...(args.meta || {}) };
        if (meta.stepIndex == null) meta.stepIndex = ctx.stepIndex;
        const ev = this.events.append({
          teamId: ctx.teamId, memberId: ctx.memberId, taskId: ctx.taskId,
          phase: args.phase, action: args.action, target: args.target,
          result: args.result, next: args.next, status: args.status ?? null,
          blockers: args.blockers ?? null, meta,
        });
        return { seq: ev.seq };
      }
      case 'fs.read': return this.broker.fsRead(ctx, args);
      case 'fs.write': return this.broker.fsWrite(ctx, args);
      case 'fs.delete': return this.broker.fsDelete(ctx, args);
      case 'fs.rename': return this.broker.fsRename(ctx, args);
      case 'fs.list': return this.broker.fsList(ctx, args);
      case 'exec.run': return await this.broker.execRun(ctx, args);
      case 'net.fetch': return await this.broker.netFetch(ctx, args);
      case 'env.read': return this.broker.envRead(ctx, args);
      case 'env.list': return this.broker.envList(ctx, args);
      case 'msg.poll': return { messages: this.bus.poll(ctx.memberId, args.since) };
      case 'msg.send': return this.bus.send({ teamId: ctx.teamId, from: ctx.memberId, ...args });
      case 'msg.request': return await this.bus.request({ teamId: ctx.teamId, from: ctx.memberId, ...args });
      case 'msg.ack': return this.bus.ack(args.id, args.state || 'acked');
      case 'scope.request': {
        const data = await this.broker.scopeRequest(ctx, args);
        return data;
      }
      case 'ping': return { leaseUntil: this.runtime(ctx.memberId).leaseUntil };
      case 'task.done': {
        this.hooks.onTaskDone(ctx, args);
        return { ok: true };
      }
      case 'task.fail': {
        this.hooks.onTaskFailed(ctx, args);
        return { ok: true };
      }
      default:
        throw ERR.bad(`unknown rpc op ${op}`);
    }
  }

  shutdown() {
    clearInterval(this._sweep);
    for (const [id] of this.workers) this.killWorker(id, { hard: true });
  }
}

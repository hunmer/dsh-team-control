// sse.mjs — SSE Hub：事件 → 订阅者推送；lastEventId 断线续传（FR-5.4 / AC-10）
import { nowIso } from './util.mjs';

/** event → SSE 帧类型与载荷（PRD 只允许 7 种类型） */
export function frameForEvent(ev) {
  const base = { id: ev.id, teamId: ev.teamId, memberId: ev.memberId, taskId: ev.taskId, ts: ev.ts };
  if (ev.phase === 'recover' && ev.action === 'lease.timeout') {
    return { type: 'lease.warn', payload: { ...base, memberId: ev.memberId, leaseUntil: ev.meta?.leaseUntil ?? null, missed: ev.meta?.missed ?? 2, result: ev.result } };
  }
  if (ev.phase === 'wait' && ev.action === 'scope.request') {
    return { type: 'scope.request', payload: { ...base, requestId: ev.meta?.requestId ?? null, domain: ev.meta?.domain ?? null, target: ev.target } };
  }
  if (ev.phase === 'decision') {
    return { type: 'decision', payload: { ...base, requestId: ev.meta?.requestId ?? null, decision: ev.result, decidedBy: ev.meta?.decidedBy ?? null, grantId: ev.meta?.grantId ?? null } };
  }
  if (ev.phase === 'msg' && ev.action === 'deliver') {
    return { type: 'message.delivered', payload: { ...base, messageId: ev.meta?.messageId ?? null, to: ev.memberId, status: 'delivered' } };
  }
  if (['init', 'interrupt', 'resume', 'recover'].includes(ev.phase)) {
    return { type: 'member.status', payload: { ...base, status: ev.status, step: ev.meta?.step ?? null, seq: ev.seq, next: ev.next } };
  }
  return { type: 'step.append', payload: { ...base, seq: ev.seq, phase: ev.phase, action: ev.action, target: ev.target, result: ev.result, next: ev.next, status: ev.status } };
}

export class SseHub {
  constructor({ events, log = () => {}, heartbeatMs = 15000 }) {
    this.events = events;
    this.log = log;
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this._hb = setInterval(() => {
      for (const c of this.clients) this.write(c, { comment: 'ping' });
    }, heartbeatMs);
    this._hb.unref?.();
  }

  /** 建立订阅：回放 lastEventId 之后的事件，再进入实时流 */
  subscribe(req, res, { teamId = null, member = null, lastEventId = 0 } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res, teamId, member, closed: false, id: 0 };
    this.clients.add(client);

    const last = Number(lastEventId) || 0;
    if (last > 0) {
      const replay = this.events.history(teamId, { since: last, member, limit: 5000 });
      for (const ev of replay) this.writeEvent(client, ev);
    }

    const cleanup = () => { client.closed = true; this.clients.delete(client); };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    return client;
  }

  writeEvent(client, ev) {
    const { type, payload } = frameForEvent(ev);
    this.write(client, { id: ev.id, event: type, data: payload });
    client.id = Math.max(client.id, Number(ev.id) || 0);
  }

  write(client, { id = null, event = null, data = null, comment = null }) {
    if (client.closed) return;
    try {
      let out = '';
      if (comment) out += `: ${comment}\n\n`;
      else {
        if (id != null) out += `id: ${id}\n`;
        if (event) out += `event: ${event}\n`;
        out += `data: ${JSON.stringify(data)}\n\n`;
      }
      client.res.write(out);
    } catch (e) {
      client.closed = true;
      this.clients.delete(client);
    }
  }

  /** 实时广播（事件落地后调用） */
  broadcastEvent(ev) {
    for (const c of this.clients) {
      if (c.teamId && c.teamId !== ev.teamId) continue;
      if (c.member && c.member !== ev.memberId) continue;
      this.writeEvent(c, ev);
    }
  }

  /** 合成帧（无 event 行与之对应，如 task.state / message.delivered）。id 取当前游标，不推进事件序。 */
  broadcastSynthetic(type, payload, { teamId = null, memberId = null } = {}) {
    const id = this.events.lastEventId(teamId);
    for (const c of this.clients) {
      if (c.teamId && teamId && c.teamId !== teamId) continue;
      if (c.member && memberId && c.member !== memberId) continue;
      this.write(c, { id, event: type, data: { ...payload, id, ts: payload.ts || nowIso() } });
    }
  }

  get size() { return this.clients.size; }

  close() {
    clearInterval(this._hb);
    for (const c of this.clients) { try { c.res.end(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}

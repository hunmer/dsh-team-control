// bus.mjs — 持久信箱：离线保留 / 三态回执 / correlation 请求-响应 / 投递延迟 p95
import { q } from './db.mjs';
import { ERR, now, nowIso, newId, json, parseJson, percentile, redactor } from './util.mjs';

const RANK = { queued: 0, delivered: 1, read: 2, acked: 3, expired: 9 };

export function rowToMessage(r) {
  if (!r) return null;
  // 读时再脱敏一次：防历史脏数据 / 未来新写入路径绕过
  const payload = redactor.obj(parseJson(r.payload_json, {}));
  return {
    id: r.id, teamId: r.team_id, from: r.from_member, to: r.to_member, kind: r.kind,
    correlationId: r.correlation_id, payload,
    sentAt: r.sent_at, deliveredAt: r.delivered_at, readAt: r.read_at, ackedAt: r.acked_at,
    ttlSeconds: r.ttl_seconds == null ? null : Number(r.ttl_seconds), status: r.status,
  };
}

export class MessageBus {
  constructor(db, { log = () => {}, onDeliver = () => {}, onWake = () => {} } = {}) {
    this.db = db;
    this.get = q(db);
    this.log = log;
    this.onDeliver = onDeliver;   // (message) => void  用于 SSE message.delivered
    this.onWake = onWake;         // (memberId, message) => void  用于 idle 成员被消息拉起
  }

  member(teamId, id) { return this.get('SELECT * FROM member WHERE id=? AND team_id=?').get(id, teamId); }

  send({ teamId, from, to, kind = 'note', payload = {}, correlationId = null, ttlSeconds = null }) {
    const team = this.get('SELECT id FROM team WHERE id=?').get(teamId);
    if (!team) throw ERR.notFound('team');
    if (!from) throw ERR.bad('from required');
    if (!to) throw ERR.bad('to required');
    const recipients = to === '*' ? this.get('SELECT id FROM member WHERE team_id=?').all(teamId).map((r) => r.id).filter((x) => x !== from) : [to];
    if (!recipients.length) throw ERR.bad('no recipients');
    // 'lead' 是虚拟收件人（团队没有 lead 成员行）：成员给 Lead 的留言只落信箱，方便面板回看。
    if (to !== 'lead') for (const r of recipients) if (!this.member(teamId, r)) throw ERR.notFound(`member ${r}`);

    const sentAt = nowIso();
    const safePayload = redactor.obj(payload);   // FR-3.8：敏感值在**落库前**脱敏
    const rows = recipients.map((rid) => {
      const id = newId('msg');
      this.get(
        `INSERT INTO message (id, team_id, from_member, to_member, kind, correlation_id, payload_json, sent_at, ttl_seconds, status)
         VALUES (?,?,?,?,?,?,?,?,?,'queued')`
      ).run(id, teamId, from, rid, kind, correlationId, json(safePayload), sentAt, ttlSeconds);
      return rowToMessage(this.get('SELECT * FROM message WHERE id=?').get(id));
    });

    for (const m of rows) {
      // FR-4.2 / AC-7：idle 成员被消息自动唤醒
      const st = this.get('SELECT status FROM member_state WHERE member_id=?').get(m.to);
      if (st && st.status === 'idle') {
        try { this.onWake(m.to, m); } catch (e) { this.log({ level: 'warn', msg: 'wake failed', err: String(e.message) }); }
      }
    }
    return { message: rows[0], messages: rows };
  }

  /** Worker 在 step 边界取走待投递消息（≤1 step 送达） */
  takeForDelivery(memberId) {
    this.expireSweep(memberId);
    const rows = this.get(
      "SELECT * FROM message WHERE to_member=? AND status='queued' ORDER BY sent_at ASC LIMIT 50"
    ).all(memberId);
    const out = [];
    for (const r of rows) {
      const at = nowIso();
      this.get("UPDATE message SET status='delivered', delivered_at=? WHERE id=? AND status='queued'").run(at, r.id);
      const m = rowToMessage(this.get('SELECT * FROM message WHERE id=?').get(r.id));
      out.push(m);
      try { this.onDeliver(m); } catch { /* ignore */ }
    }
    return out;
  }

  poll(memberId, since = null) {
    this.expireSweep(memberId);
    let sql = 'SELECT * FROM message WHERE to_member=?';
    const args = [memberId];
    if (since) { sql += ' AND sent_at>?'; args.push(String(since)); }
    sql += ' ORDER BY sent_at ASC LIMIT 200';
    return this.get(sql).all(...args).map(rowToMessage);
  }

  ack(id, state = 'acked') {
    const r = this.get('SELECT * FROM message WHERE id=?').get(id);
    if (!r) throw ERR.notFound('message');
    const at = nowIso();
    const st = state === 'read' ? 'read' : (state === 'delivered' ? 'delivered' : 'acked');
    if (RANK[st] > RANK[r.status] && r.status !== 'expired') {
      if (st === 'delivered') {
        // agent 团队成员由 Host 插件直接推进成员信箱：只记送达，不冒充已读/已确认
        this.get('UPDATE message SET status=?, delivered_at=COALESCE(delivered_at,?) WHERE id=?')
          .run(st, at, id);
      } else {
        this.get('UPDATE message SET status=?, read_at=COALESCE(read_at,?), acked_at=? WHERE id=?')
          .run(st, at, st === 'acked' ? at : r.acked_at, id);
      }
    }
    return rowToMessage(this.get('SELECT * FROM message WHERE id=?').get(id));
  }

  list(teamId, { correlation = null, member = null, status = null, limit = 200 } = {}) {
    let sql = 'SELECT * FROM message WHERE team_id=?';
    const args = [teamId];
    if (correlation) { sql += ' AND correlation_id=?'; args.push(correlation); }
    if (member) { sql += ' AND (to_member=? OR from_member=?)'; args.push(member, member); }
    if (status) { sql += ' AND status=?'; args.push(status); }
    sql += ' ORDER BY sent_at DESC LIMIT ?';
    args.push(Math.min(1000, Math.max(1, Number(limit) || 200)));
    return this.get(sql).all(...args).map(rowToMessage);
  }

  expireSweep(memberId = null) {
    const t = now();
    const rows = memberId
      ? this.get("SELECT id, sent_at, ttl_seconds FROM message WHERE to_member=? AND status NOT IN ('acked','expired') AND ttl_seconds IS NOT NULL").all(memberId)
      : this.get("SELECT id, sent_at, ttl_seconds FROM message WHERE status NOT IN ('acked','expired') AND ttl_seconds IS NOT NULL").all();
    let n = 0;
    for (const r of rows) {
      if (Date.parse(r.sent_at) + Number(r.ttl_seconds) * 1000 < t) {
        this.get("UPDATE message SET status='expired' WHERE id=?").run(r.id);
        n++;
      }
    }
    return n;
  }

  /** FR-4.6：投递延迟 p50/p95（毫秒） */
  latencyStats(teamId) {
    const rows = this.get(
      "SELECT sent_at, delivered_at FROM message WHERE team_id=? AND delivered_at IS NOT NULL"
    ).all(teamId);
    const lat = rows.map((r) => Date.parse(r.delivered_at) - Date.parse(r.sent_at)).filter((x) => Number.isFinite(x) && x >= 0);
    return {
      count: lat.length,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      max: lat.length ? Math.max(...lat) : null,
    };
  }

  counts(teamId) {
    const r = this.get('SELECT COUNT(*) AS c FROM message WHERE team_id=?').get(teamId);
    const a = this.get("SELECT COUNT(*) AS c FROM message WHERE team_id=? AND status='acked'").get(teamId);
    return { total: Number(r.c), acked: Number(a.c) };
  }

  /**
   * FR-4.4：request/response（correlation + 超时 + 重试）。
   * 请求与响应都持久化，响应方用 msg.send 带同一 correlationId 回。
   */
  async request({ teamId, from, to, payload = {}, kind = 'request', timeoutMs = 5000, retries = 0, retryDelayMs = 200 }) {
    const correlationId = newId('corr');
    const t0 = now();
    let attempt = 0;
    for (;;) {
      attempt++;
      this.send({ teamId, from, to, kind, payload, correlationId, ttlSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)) });
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        const resp = this.get(
          'SELECT * FROM message WHERE correlation_id=? AND from_member=? AND kind IN (?,?) ORDER BY sent_at ASC LIMIT 1'
        ).get(correlationId, to, 'response', 'note');
        if (resp) return { correlationId, response: rowToMessage(resp), attempts: attempt, elapsedMs: now() - t0, timeout: false };
        await new Promise((r) => setTimeout(r, 50));
      }
      if (attempt > retries) return { correlationId, response: null, attempts: attempt, elapsedMs: now() - t0, timeout: true };
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}

// eventstore.mjs — C2：event 只增不改，member_state 可由 event 完全重建
import { tx, q } from './db.mjs';
import { nowIso, parseJson, json, ERR, redactor } from './util.mjs';

const EMPTY = { seq: 0, step: null, phase: null, status: 'queued', last: null, next: null, blockers: [], as_of: null };

/** 纯函数：由 (prevState, event) 推导新投影状态。rebuild 与 append 共用，保证二者不可能分叉。 */
export function project(prev, ev) {
  const meta = ev.meta || {};
  const base = prev || EMPTY;
  const nextStatus = meta.status ?? base.status ?? 'queued';
  const step = meta.step ?? base.step ?? null;
  return {
    seq: ev.seq,
    step,
    phase: ev.phase,
    status: nextStatus,
    last: ev.target != null && ev.target !== '' ? `${ev.action} ${ev.target}` : ev.action,
    next: ev.next ?? null,
    blockers: meta.blockers ?? base.blockers ?? [],
    as_of: ev.ts,
  };
}

export function rowToEvent(r) {
  if (!r) return null;
  const meta = parseJson(r.meta_json, {});
  return {
    id: Number(r.id), teamId: r.team_id, memberId: r.member_id, taskId: r.task_id,
    seq: Number(r.seq), ts: r.ts, phase: r.phase, action: r.action, target: r.target ?? null,
    result: r.result ?? null, next: r.next ?? null,
    status: meta.status ?? null, meta,
  };
}

export function rowToState(r) {
  if (!r) return null;
  return {
    memberId: r.member_id, seq: Number(r.seq), step: r.step, phase: r.phase, status: r.status,
    last: r.last, next: r.next, blockers: parseJson(r.blockers_json, []),
    asOf: r.as_of, stale: !!r.stale,
  };
}

export class EventStore {
  /** @param {(ev:object)=>void} [onEvent] 事务提交后回调（SSE 推送点） */
  constructor(db, { onEvent } = {}) {
    this.db = db;
    this.onEvent = onEvent || null;
    this.get = q(db);
  }

  state(memberId) {
    return rowToState(this.get('SELECT * FROM member_state WHERE member_id=?').get(memberId));
  }

  stateOrEmpty(memberId) {
    return this.state(memberId) || { ...EMPTY, memberId, stale: false, asOf: null };
  }

  maxSeq(memberId) {
    const r = this.get('SELECT COALESCE(MAX(seq),0) AS m FROM event WHERE member_id=?').get(memberId);
    return Number(r.m);
  }

  lastEvent(memberId) {
    return rowToEvent(this.get('SELECT * FROM event WHERE member_id=? ORDER BY seq DESC LIMIT 1').get(memberId));
  }

  /**
   * 唯一写入口。分配 seq、插入 event、同事务内更新 member_state。
   * @returns {object} 完整 event（含 id/seq/ts/status/meta）
   */
  append(input) {
    const {
      teamId, memberId, taskId = null, phase, action, target = null,
      result = 'OK', next = null, status = null, blockers = null, meta = null,
    } = input || {};
    if (!teamId) throw ERR.bad('teamId required');
    if (!memberId) throw ERR.bad('memberId required');
    if (!phase || !action) throw ERR.bad('phase and action required');

    const ev = tx(this.db, () => {
      const seq = this.maxSeq(memberId) + 1;
      const ts = nowIso();
      // FR-3.8：事件是审计/面板/恢复的共同来源，落库前统一脱敏
      const safeTarget = target == null ? null : redactor.str(String(target));
      const safeResult = result == null ? null : redactor.str(String(result));
      const safeNext = next == null ? null : redactor.str(String(next));
      const metaOut = redactor.obj({ ...(meta || {}) });
      if (status) metaOut.status = status;
      if (blockers) metaOut.blockers = redactor.obj(blockers);

      const prev = this.stateOrEmpty(memberId);
      const proj = project(prev, { seq, ts, phase, action, target: safeTarget, result: safeResult, next: safeNext, meta: metaOut });

      const info = this.get(
        `INSERT INTO event (team_id, member_id, task_id, seq, ts, phase, action, target, result, next, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(teamId, memberId, taskId, seq, ts, phase, action, safeTarget, safeResult, safeNext, json(metaOut));
      const id = Number(info.lastInsertRowid);

      this.get(
        `INSERT INTO member_state (member_id, seq, step, phase, status, last, next, blockers_json, as_of, stale)
         VALUES (?,?,?,?,?,?,?,?,?,0)
         ON CONFLICT(member_id) DO UPDATE SET
           seq=excluded.seq, step=excluded.step, phase=excluded.phase, status=excluded.status,
           last=excluded.last, next=excluded.next, blockers_json=excluded.blockers_json,
           as_of=excluded.as_of, stale=0`
      ).run(memberId, proj.seq, proj.step, proj.phase, proj.status, proj.last, proj.next,
        json(proj.blockers), proj.as_of);

      return {
        id, teamId, memberId, taskId, seq, ts, phase, action, target: safeTarget, result: safeResult, next: safeNext,
        status: proj.status, meta: metaOut,
      };
    });

    if (this.onEvent) {
      try { this.onEvent(ev); } catch { /* 推送失败不能影响主流程 */ }
    }
    return ev;
  }

  /**
   * C2 验证：只读 event，重放生成投影，与 member_state 逐字段比较。
   */
  rebuild(memberId) {
    const evs = this.get('SELECT * FROM event WHERE member_id=? ORDER BY seq ASC').all(memberId).map(rowToEvent);
    let proj = { ...EMPTY };
    const gaps = [];
    let expectSeq = 1;
    for (const ev of evs) {
      if (ev.seq !== expectSeq) gaps.push({ expected: expectSeq, got: ev.seq });
      expectSeq = ev.seq + 1;
      proj = project(proj, ev);
    }
    const rebuilt = {
      memberId, seq: proj.seq, step: proj.step, phase: proj.phase, status: proj.status,
      last: proj.last, next: proj.next, blockers: proj.blockers, asOf: proj.as_of,
    };
    const stored = this.state(memberId);
    const storedComparable = stored && {
      memberId, seq: stored.seq, step: stored.step, phase: stored.phase, status: stored.status,
      last: stored.last, next: stored.next, blockers: stored.blockers, asOf: stored.asOf,
    };
    const norm = (o) => JSON.stringify(o ? { ...o, blockers: o.blockers || [] } : null);
    const equal = norm(rebuilt) === norm(storedComparable);
    return { memberId, equal, rebuilt, stored: storedComparable, gaps, eventCount: evs.length };
  }

  /** 全量对账；不一致则标记 stale=1（FR-5.5） */
  verifyAll(teamId = null) {
    const ids = teamId
      ? this.get('SELECT id FROM member WHERE team_id=?').all(teamId).map((r) => r.id)
      : this.get('SELECT DISTINCT member_id AS id FROM event').all().map((r) => r.id);
    const mismatches = [];
    for (const id of ids) {
      const r = this.rebuild(id);
      const bad = !r.equal || r.gaps.length > 0;
      this.get('UPDATE member_state SET stale=? WHERE member_id=?').run(bad ? 1 : 0, id);
      if (bad) mismatches.push(r);
    }
    return mismatches;
  }

  listSteps(memberId, sinceSeq = 0, limit = 200) {
    return this.get(
      'SELECT * FROM event WHERE member_id=? AND seq>? ORDER BY seq ASC LIMIT ?'
    ).all(memberId, Number(sinceSeq) || 0, Math.min(2000, Math.max(1, Number(limit) || 200))).map(rowToEvent);
  }

  history(teamId, { since = 0, member = null, limit = 500 } = {}) {
    let sql = 'SELECT * FROM event WHERE team_id=? AND id>?';
    const args = [teamId, Number(since) || 0];
    if (member) { sql += ' AND member_id=?'; args.push(member); }
    sql += ' ORDER BY id ASC LIMIT ?';
    args.push(Math.min(5000, Math.max(1, Number(limit) || 500)));
    return this.get(sql).all(...args).map(rowToEvent);
  }

  lastEventId(teamId = null) {
    const r = teamId
      ? this.get('SELECT COALESCE(MAX(id),0) AS m FROM event WHERE team_id=?').get(teamId)
      : this.get('SELECT COALESCE(MAX(id),0) AS m FROM event').get();
    return Number(r.m);
  }

  countEvents(teamId = null) {
    return Number((teamId
      ? this.get('SELECT COUNT(*) AS c FROM event WHERE team_id=?').get(teamId)
      : this.get('SELECT COUNT(*) AS c FROM event').get()).c);
  }

  /** resume 锚点：最大 seq 对应事件里的 stepIndex（C5/FR-6.1） */
  resumeAnchor(memberId) {
    const ev = this.lastEvent(memberId);
    if (!ev) return { seq: 0, stepIndex: -1, step: null, nextIndex: 0 };
    const idx = Number.isInteger(ev.meta?.stepIndex) ? ev.meta.stepIndex : -1;
    return { seq: ev.seq, stepIndex: idx, step: ev.meta?.step ?? null, nextIndex: idx + 1 };
  }
}

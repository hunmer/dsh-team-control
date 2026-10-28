// broker.mjs — 四域唯一 IO 出口（C1/C3/C4/FR-3.5/FR-3.6）
// 铁律：Worker 进程没有任何原生 IO 能力，这里不放行的操作，世界上就不存在那条路径。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tx, q } from './db.mjs';
import {
  ERR, now, nowIso, newId, sha256, json, parseJson, truncate, toPosix,
  resolveInWorkspace, redactor, isSensitiveName, REDACTED, backoffMs,
} from './util.mjs';
import { evaluate, OPS_BY_DOMAIN, matrixSummary, matchTarget } from './policy.mjs';

const SAFE_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
  'TEMP', 'TMP', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'LANG', 'LC_ALL', 'TZ',
];
const MAX_EXEC_OUT = 64 * 1024;
const MAX_NET_BODY = 1024 * 1024;

export class PermBroker {
  constructor(db, { events, log } = {}) {
    this.db = db;
    this.events = events || null;
    this.log = log || (() => {});
    this.get = q(db);
    this.pending = new Map();          // requestId → {resolve, timer, memberId}
    this.envByMember = new Map();      // memberId → {plain: {name:value}, sensitive: Set, allowedRead: {name:bool}}
    this.secretHandles = new Map();    // handle → {name, value}
    this.stats = { conflicts: 0, denials: 0, grants: 0, writes: 0, execs: 0, nets: 0 };
  }

  // ---------- 读取与规则装载 ----------
  team(teamId) { return this.get('SELECT * FROM team WHERE id=?').get(teamId); }
  member(memberId) { return this.get('SELECT * FROM member WHERE id=?').get(memberId); }

  policies(teamId) {
    return this.get('SELECT * FROM policy WHERE team_id=?').all(teamId).map((r) => ({
      id: r.id, kind: 'policy', teamId: r.team_id,
      subjectType: r.subject_type, subjectId: r.subject_id,
      domain: r.domain, matcher: r.matcher, ops: parseJson(r.ops_json, []),
      mode: r.mode, constraints: parseJson(r.constraints_json, {}),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    }));
  }

  activeGrants(teamId, memberId) {
    const rows = memberId
      ? this.get('SELECT * FROM scope_grant WHERE team_id=? AND member_id=?').all(teamId, memberId)
      : this.get('SELECT * FROM scope_grant WHERE team_id=?').all(teamId);
    return rows.map((r) => ({
      id: r.id, kind: 'grant', teamId: r.team_id, requestId: r.request_id,
      subjectType: 'member', subjectId: r.member_id,
      domain: r.domain, matcher: r.matcher, ops: parseJson(r.ops_json, []),
      mode: 'allow', constraints: {},
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
      singleUse: Number(r.single_use), usedAt: r.used_at, grantedBy: r.granted_by,
    }));
  }

  rulesFor(teamId, memberId) {
    return [...this.policies(teamId), ...this.activeGrants(teamId, memberId)];
  }

  /** 单次求值（唯一入口） */
  authorize(ctx, { domain, op, target }) {
    const rules = this.rulesFor(ctx.teamId, ctx.memberId);
    return evaluate(rules, {
      teamId: ctx.teamId, memberId: ctx.memberId, role: ctx.role, taskId: ctx.taskId,
      domain, op, target,
    }, now());
  }

  // ---------- 审计 ----------
  audit({ teamId, actor, domain, action, target, beforeHash = null, afterHash = null, result = 'OK', detail = null }) {
    const d = redactor.obj({ ...(detail || {}), ...(this._stepIndex ? { stepIndex: this._stepIndex } : {}) });
    this.get(
      `INSERT INTO audit (ts, team_id, actor, domain, action, target, before_hash, after_hash, result, detail_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(nowIso(), teamId, actor, domain, action, redactor.str(String(target)), beforeHash, afterHash, result, json(d));
  }

  _auditAndDeny(ctx, { domain, op, target, dec, result = 'DENIED' }) {
    const tgt = domain === 'exec' ? (Array.isArray(target) ? target.join(' ') : String(target)) : String(target);
    this.stats.denials++;
    this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain, action: op, target: tgt, result, detail: { reason: dec.reason, denyRule: dec.denyRule?.id ?? null, effect: dec.effect } });
    if (this.events) {
      try {
        this.events.append({
          teamId: ctx.teamId, memberId: ctx.memberId, taskId: ctx.taskId || null,
          phase: domain, action: op, target: tgt, result: `FAIL:denied`,
          next: `request ${domain} scope for ${tgt}`,
          meta: { stepIndex: ctx.stepIndex ?? -1, denyRule: dec.denyRule?.id ?? null, reason: dec.reason },
        });
      } catch { /* ignore */ }
    }
    const msg = `permission denied: ${domain}.${op} ${tgt} (${dec.reason})`;
    return ERR.denied(msg, { domain, op, target: tgt, reason: dec.reason, denyRule: dec.denyRule?.id ?? null });
  }

  _consumeGrant(ctx, dec, domain, op, target) {
    if (dec.effect !== 'grant' || !dec.grantRule) return null;
    const g = dec.grantRule;
    if (Number(g.singleUse) === 1) {
      this.get('UPDATE scope_grant SET used_at=? WHERE id=? AND used_at IS NULL').run(nowIso(), g.id);
    }
    this.stats.grants++;
    if (this.events) {
      try {
        this.events.append({
          teamId: ctx.teamId, memberId: ctx.memberId, taskId: ctx.taskId || null,
          phase: domain, action: op, target: String(Array.isArray(target) ? target.join(' ') : target),
          result: 'OK', next: null,
          meta: { stepIndex: ctx.stepIndex ?? -1, grantId: g.id, requestId: g.requestId ?? null, viaGrant: true },
        });
      } catch { /* ignore */ }
    }
    return g.id;
  }

  // ---------- env 投影（Worker 只拿到这些） ----------
  buildEnvProjection(ctx) {
    const rules = this.rulesFor(ctx.teamId, ctx.memberId);
    const plain = {};
    const sensitive = new Set();
    const allowedRead = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value == null) continue;
      const dec = evaluate(rules, {
        teamId: ctx.teamId, memberId: ctx.memberId, role: ctx.role, taskId: ctx.taskId,
        domain: 'env', op: 'read', target: name,
      }, now());
      allowedRead[name] = dec.allowed;
      if (!dec.allowed) continue;
      if (isSensitiveName(name) || dec.constraints.sensitive) { sensitive.add(name); redactor.addSecret(value); continue; }
      plain[name] = value;
    }
    for (const n of SAFE_ENV) if (process.env[n] != null) plain[n] = process.env[n];
    const proj = { plain, sensitive, allowedRead };
    this.envByMember.set(ctx.memberId, proj);
    return { env: { ...plain, DSH_TEAM_WORKER: '1' }, sensitive, redacted: [...sensitive] };
  }

  envRead(ctx, { name }) {
    const n = String(name || '');
    const dec = this.authorize(ctx, { domain: 'env', op: 'read', target: n });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'env', op: 'read', target: n, dec });
    const proj = this.envByMember.get(ctx.memberId) || this.buildEnvProjection(ctx);
    const isSensitive = proj.sensitive.has(n) || isSensitiveName(n) || dec.constraints.sensitive;
    if (isSensitive) {
      const value = process.env[n];
      if (value == null) return { name: n, value: null, handle: null, redacted: true };
      redactor.addSecret(value);
      const handle = `dsh-env-handle:${newId('h')}`;
      this.secretHandles.set(handle, { name: n, value });
      // FR-3.8 / AC-13：值绝不出 sidecar；审计里只留占位符
      this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'env', action: 'read', target: n, beforeHash: null, afterHash: null, result: 'OK', detail: { value: REDACTED, handle, sensitive: true } });
      return { name: n, handle, redacted: true, value: REDACTED };
    }
    if (!(n in proj.plain)) return { name: n, value: null, handle: null, redacted: false };
    return { name: n, value: proj.plain[n], handle: null, redacted: false };
  }

  envList(ctx) {
    const proj = this.envByMember.get(ctx.memberId) || this.buildEnvProjection(ctx);
    return { names: Object.keys(proj.plain).sort(), redactedNames: [...proj.sensitive].sort() };
  }

  /** 把 headers/body 里的 handle 换成真值（值不会经过 Worker） */
  resolveHandles(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') {
      if (obj.startsWith('dsh-env-handle:')) return this.secretHandles.get(obj)?.value ?? '';
      return obj;
    }
    if (Array.isArray(obj)) return obj.map((x) => this.resolveHandles(x));
    if (typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = this.resolveHandles(v);
      return out;
    }
    return obj;
  }

  // ---------- fs ----------
  fileState(rel) {
    const r = this.get('SELECT * FROM file_state WHERE path=?').get(rel);
    return r ? { version: Number(r.version), hash: r.hash, size: Number(r.size), updatedAt: r.updated_at } : { version: 0, hash: null, size: 0, updatedAt: null };
  }

  fsRead(ctx, { path: p }) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    const dec = this.authorize(ctx, { domain: 'fs', op: 'read', target: rel });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'fs', op: 'read', target: rel, dec });
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) {
      if (e.code === 'ENOENT') throw ERR.notFound(`file ${rel}`);
      throw ERR.bad(`read failed: ${e.code}`);
    }
    const st = this.fileState(rel);
    const hash = sha256(buf);
    const version = st.version > 0 ? st.version : 0;
    this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'fs', action: 'read', target: rel, beforeHash: hash, afterHash: hash, detail: { bytes: buf.length, version } });
    return { path: rel, content: buf.toString('utf8'), version, hash, size: buf.length };
  }

  fsWrite(ctx, { path: p, content, expectVersion = null, encoding = 'utf8' }) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    const dec = this.authorize(ctx, { domain: 'fs', op: 'write', target: rel });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'fs', op: 'write', target: rel, dec });

    const prev = this.fileState(rel);
    const expect = expectVersion == null ? null : Number(expectVersion);
    if (expect != null && expect !== prev.version) {
      this.stats.conflicts++;
      this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'fs', action: 'write', target: rel, beforeHash: prev.hash, result: 'CONFLICT', detail: { expect, actual: prev.version } });
      throw ERR.version(`version conflict on ${rel}`, { currentVersion: prev.version, currentHash: prev.hash, expectedVersion: expect });
    }

    let beforeBuf = null;
    try { beforeBuf = fs.readFileSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw ERR.bad(`read failed: ${e.code}`); }
    const beforeHash = beforeBuf ? sha256(beforeBuf) : null;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), encoding);

    const grantId = this._consumeGrant(ctx, dec, 'fs', 'write', rel);
    return tx(this.db, () => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.dsh-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, abs);   // Windows 上 MoveFileEx 覆盖语义
      const version = prev.version + 1;
      const hash = sha256(buf);
      this.get(
        `INSERT INTO file_state (path, version, hash, size, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET version=excluded.version, hash=excluded.hash, size=excluded.size, updated_at=excluded.updated_at`
      ).run(rel, version, hash, buf.length, nowIso());
      this.stats.writes++;
      this.audit({
        teamId: ctx.teamId, actor: ctx.memberId, domain: 'fs', action: 'write', target: rel,
        beforeHash, afterHash: hash, result: 'OK',
        detail: { version, bytes: buf.length, grantId },
      });
      return { path: rel, version, hash, bytes: buf.length, grantId };
    });
  }

  fsDelete(ctx, { path: p }) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    const dec = this.authorize(ctx, { domain: 'fs', op: 'delete', target: rel });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'fs', op: 'delete', target: rel, dec });
    let beforeBuf = null;
    try { beforeBuf = fs.readFileSync(abs); } catch (e) { if (e.code === 'ENOENT') throw ERR.notFound(`file ${rel}`); throw ERR.bad(`read failed: ${e.code}`); }
    const beforeHash = sha256(beforeBuf);
    this._consumeGrant(ctx, dec, 'fs', 'delete', rel);
    fs.rmSync(abs);
    const prev = this.fileState(rel);
    this.get(
      `INSERT INTO file_state (path, version, hash, size, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET version=excluded.version, hash=excluded.hash, size=excluded.size, updated_at=excluded.updated_at`
    ).run(rel, prev.version + 1, null, 0, nowIso());
    this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'fs', action: 'delete', target: rel, beforeHash, afterHash: null });
    return { deleted: true, path: rel };
  }

  fsRename(ctx, { from, to }) {
    const a = resolveInWorkspace(ctx.workspace, from);
    const b = resolveInWorkspace(ctx.workspace, to);
    const decFrom = this.authorize(ctx, { domain: 'fs', op: 'rename', target: a.rel });
    if (!decFrom.allowed) throw this._auditAndDeny(ctx, { domain: 'fs', op: 'rename', target: a.rel, dec: decFrom });
    const decTo = this.authorize(ctx, { domain: 'fs', op: 'write', target: b.rel });
    if (!decTo.allowed) throw this._auditAndDeny(ctx, { domain: 'fs', op: 'write', target: b.rel, dec: decTo });
    try { fs.renameSync(a.abs, b.abs); } catch (e) { throw ERR.bad(`rename failed: ${e.code}`); }
    this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'fs', action: 'rename', target: `${a.rel} → ${b.rel}`, beforeHash: null, afterHash: null });
    return { ok: true, from: a.rel, to: b.rel };
  }

  fsList(ctx, { path: p = '.' }) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    const dec = this.authorize(ctx, { domain: 'fs', op: 'list', target: rel === '.' ? '**' : rel });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'fs', op: 'list', target: rel, dec });
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT') throw ERR.notFound(`dir ${rel}`);
      if (e.code === 'ENOTDIR') throw ERR.bad(`not a directory: ${rel}`);
      throw ERR.bad(`list failed: ${e.code}`);
    }
    return { path: rel, entries: ents.map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' })) };
  }

  // ---------- exec ----------
  execRun(ctx, { argv, cwd, timeoutMs }) {
    if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) {
      throw ERR.bad('argv must be a non-empty string array');
    }
    const cwdRes = cwd ? resolveInWorkspace(ctx.workspace, cwd) : { abs: ctx.workspace, rel: '.' };
    const dec = this.authorize(ctx, { domain: 'exec', op: 'spawn', target: argv });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'exec', op: 'spawn', target: argv, dec });

    const c = dec.constraints || {};
    if (Array.isArray(c.argvAllow)) {
      const bad = argv.slice(1).filter((a) => !c.argvAllow.some((pat) => matchTarget('exec', pat, [a]) || pat === a || (pat.endsWith('*') && a.startsWith(pat.slice(0, -1)))));
      if (bad.length) throw this._auditAndDeny(ctx, { domain: 'exec', op: 'spawn', target: argv, dec: { ...dec, reason: `argv not allowed: ${bad.join(',')}` } });
    }
    const maxMs = Math.min(Number(c.maxRuntimeMs ?? 60000), Number(timeoutMs ?? 60000) || 60000);
    const envProj = this.envByMember.get(ctx.memberId) || this.buildEnvProjection(ctx);
    const env = { ...envProj.plain };
    const beforeHash = sha256(argv.join('\0'));

    return new Promise((resolve, reject) => {
      const t0 = now();
      let out = ''; let err = ''; let killed = false;
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd: cwdRes.abs, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { reject(ERR.bad(`spawn failed: ${e.code || e.message}`)); return; }
      const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, maxMs);
      child.stdout.on('data', (b) => { if (out.length < MAX_EXEC_OUT) out += b.toString('utf8'); });
      child.stderr.on('data', (b) => { if (err.length < MAX_EXEC_OUT) err += b.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'exec', action: 'spawn', target: argv.join(' '), beforeHash, result: 'ERROR', detail: { error: e.code } }); reject(ERR.bad(`exec error: ${e.code || e.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = now() - t0;
        this.stats.execs++;
        const stdout = redactor.str(truncate(out, MAX_EXEC_OUT));
        const stderr = redactor.str(truncate(err, MAX_EXEC_OUT));
        const result = killed ? 'TIMEOUT' : (code === 0 ? 'OK' : 'FAIL');
        this._consumeGrant(ctx, dec, 'exec', 'spawn', argv);
        this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'exec', action: 'spawn', target: argv.join(' '), beforeHash, afterHash: sha256(stdout), result, detail: { exitCode: code, durationMs, killed, cwd: cwdRes.rel } });
        if (killed) reject(ERR.timeout(`command timed out after ${maxMs}ms`));
        else resolve({ exitCode: code, stdout, stderr, durationMs, grantId: null });
      });
    });
  }

  // ---------- net ----------
  async netFetch(ctx, { url, method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
    let u;
    try { u = new URL(url); } catch { throw ERR.bad('invalid url'); }
    if (!/^https?:$/.test(u.protocol)) throw ERR.bad('only http(s) allowed');
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const target = `${u.hostname.toLowerCase()}:${port}`;
    const M = String(method || 'GET').toUpperCase();
    const dec = this.authorize(ctx, { domain: 'net', op: 'connect', target });
    if (!dec.allowed) throw this._auditAndDeny(ctx, { domain: 'net', op: 'connect', target, dec });
    const c = dec.constraints || {};
    if (Array.isArray(c.methods) && !c.methods.includes(M)) {
      throw this._auditAndDeny(ctx, { domain: 'net', op: 'connect', target, dec: { ...dec, reason: `method ${M} not allowed` } });
    }
    const realHeaders = this.resolveHandles({ ...headers });
    const beforeHash = sha256(`${M} ${u.toString()}`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(Number(c.maxRuntimeMs ?? timeoutMs), timeoutMs));
    let res; let text = '';
    try {
      res = await fetch(u, {
        method: M, headers: realHeaders,
        body: body == null ? undefined : (typeof body === 'string' ? this.resolveHandles(body) : JSON.stringify(this.resolveHandles(body))),
        redirect: 'manual', signal: ac.signal,
      });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'net', action: 'connect', target, beforeHash, result: 'ERROR', detail: { error: String(e.name) } });
      throw ERR.bad(`fetch failed: ${e.name}${e.cause ? ' ' + (e.cause.code || e.cause.message) : ''}`);
    }
    clearTimeout(timer);
    const safeBody = redactor.str(truncate(text, MAX_NET_BODY));
    const hdrOut = {};
    for (const [k, v] of res.headers) if (!isSensitiveName(k)) hdrOut[k] = v;
    this.stats.nets++;
    this._consumeGrant(ctx, dec, 'net', 'connect', target);
    this.audit({ teamId: ctx.teamId, actor: ctx.memberId, domain: 'net', action: 'connect', target, beforeHash, afterHash: sha256(safeBody), result: res.ok ? 'OK' : 'FAIL', detail: { status: res.status, method: M, bytes: safeBody.length } });
    return { status: res.status, headers: hdrOut, body: safeBody, bytes: safeBody.length, url: u.toString() };
  }

  // ---------- scope request / decision（C4） ----------
  scopeRequest(ctx, { domain, target, reason, diffSize = null, risk = null, blockedStep = null, fallback = null, timeoutMs = 120000 }) {
    if (!OPS_BY_DOMAIN[domain]) throw ERR.bad('invalid domain');
    if (!target) throw ERR.bad('target required');
    const tgt = domain === 'exec' && Array.isArray(target) ? target.join(' ') : String(target);
    const id = newId('sr');
    const created = nowIso();
    this.get(
      `INSERT INTO scope_request (id, team_id, member_id, domain, target, reason, diff_size, risk, blocked_step, fallback, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`
    ).run(id, ctx.teamId, ctx.memberId, domain, tgt, String(reason || ''), diffSize, risk, blockedStep, fallback, created);

    if (this.events) {
      this.events.append({
        teamId: ctx.teamId, memberId: ctx.memberId, taskId: ctx.taskId || null,
        phase: 'wait', action: 'scope.request', target: tgt, result: 'BLOCKED',
        next: `await decision for ${id}`, status: 'blocked',
        blockers: [{ kind: 'scope_request', id, detail: `${domain}:${tgt}` }],
        meta: { stepIndex: ctx.stepIndex ?? -1, requestId: id, domain },
      });
    }

    // D-6 自动批准（decision 仍落盘，decidedBy=auto）
    const team = this.team(ctx.teamId);
    const auto = parseJson(team?.auto_approve_json, null);
    if (auto && Array.isArray(auto.domains) && auto.domains.includes(domain)) {
      const maxDiff = Number(auto.maxDiffSize ?? 0);
      if (maxDiff > 0 && Number(diffSize ?? 0) <= maxDiff) {
        try {
          const out = this.decide({ ...ctx, actor: 'auto' }, id, { decision: 'approved', decidedBy: 'auto', reason: `auto-approved diffSize=${diffSize} <= ${maxDiff}`, ttlSeconds: Number(auto.ttlSeconds ?? 60), singleUse: true });
          return { status: 'approved', requestId: id, decisionId: out.decision.id, grantId: out.grant?.id ?? null, decidedBy: 'auto' };
        } catch { /* 落到人工，不阻断 */ }
      }
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.get("UPDATE scope_request SET status='expired', decided_at=? WHERE id=? AND status='pending'").run(nowIso(), id);
          this.audit({ teamId: ctx.teamId, actor: 'system', domain, action: 'scope.request', target: tgt, result: 'EXPIRED', detail: { requestId: id } });
        } catch { /* ignore */ }
        resolve({ status: 'expired', requestId: id, decisionId: null, grantId: null });
      }, Math.max(1000, Number(timeoutMs) || 120000));
      timer.unref?.();
      this.pending.set(id, { resolve, timer, memberId: ctx.memberId });
    });
  }

  decide(ctx, requestId, { decision, decidedBy = 'lead', reason = null, ttlSeconds = 60, singleUse = true, evidence = null }) {
    if (!['approved', 'denied'].includes(decision)) throw ERR.bad('decision must be approved|denied');
    const out = tx(this.db, () => {
      const req = this.get('SELECT * FROM scope_request WHERE id=?').get(requestId);
      if (!req) throw ERR.notFound('scope_request');
      if (req.status !== 'pending') throw ERR.invalidState(`scope_request already ${req.status}`);
      const t = now();
      const decisionRow = {
        id: newId('dec'), teamId: req.team_id, subject: 'scope_request', kind: 'scope',
        requestId, options: ['approved', 'denied'], chosen: decision,
        decidedBy, reason, evidence, decidedAt: nowIso(), ttlSeconds,
      };
      this.get(
        `INSERT INTO decision (id, team_id, subject, kind, request_id, options_json, chosen, decided_by, reason, evidence, decided_at, ttl_seconds)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(decisionRow.id, req.team_id, 'scope_request', 'scope', requestId, json(decisionRow.options), decision, decidedBy, reason, evidence, decisionRow.decidedAt, ttlSeconds);

      let grant = null;
      if (decision === 'approved') {
        const ops = this._opsForRequest(req);
        grant = {
          id: newId('g'), requestId, teamId: req.team_id, memberId: req.member_id,
          domain: req.domain, matcher: req.domain === 'exec' ? req.target : req.target,
          ops, singleUse: singleUse ? 1 : 0, expiresAt: t + Math.max(1, ttlSeconds) * 1000,
          grantedBy: decidedBy, usedAt: null, createdAt: nowIso(),
        };
        this.get(
          `INSERT INTO scope_grant (id, request_id, team_id, member_id, domain, matcher, ops_json, single_use, expires_at, granted_by, used_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`
        ).run(grant.id, requestId, grant.teamId, grant.memberId, grant.domain, grant.matcher, json(grant.ops), grant.singleUse, grant.expiresAt, grant.grantedBy, grant.createdAt);
      }
      this.get('UPDATE scope_request SET status=?, decision_id=?, grant_id=?, decided_at=? WHERE id=?')
        .run(decision, decisionRow.id, grant?.id ?? null, nowIso(), requestId);

      if (this.events) {
        this.events.append({
          teamId: req.team_id, memberId: req.member_id, taskId: ctx.taskId || null,
          phase: 'decision', action: 'scope.decide', target: req.target,
          result: decision === 'approved' ? 'APPROVED' : 'DENIED',
          next: decision === 'approved' ? 'retry the operation with grant' : 'use fallback',
          status: decision === 'approved' ? 'running' : 'blocked',
          blockers: [],
          meta: { requestId, decisionId: decisionRow.id, grantId: grant?.id ?? null, decidedBy, domain: req.domain, stepIndex: ctx.stepIndex ?? -1 },
        });
      }
      return { request: { ...req, status: decision, decision_id: decisionRow.id, grant_id: grant?.id ?? null }, decision: decisionRow, grant };
    });
    // 提交后才唤醒等待者 + 推送（C4：消息/推送只是通知）
    const waiter = this.pending.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(requestId);
      try { waiter.resolve({ status: decision, requestId, decisionId: out.decision.id, grantId: out.grant?.id ?? null, decidedBy }); } catch { /* ignore */ }
    }
    return out;
  }

  _opsForRequest(req) {
    if (req.domain === 'fs') {
      const act = String(req.reason || '').toLowerCase();
      if (act.includes('delete')) return ['delete'];
      if (act.includes('rename')) return ['rename'];
      return ['write'];
    }
    if (req.domain === 'exec') return ['spawn'];
    if (req.domain === 'net') return ['connect'];
    return ['read', 'write'];
  }

  /** 成员被打断/失败时，让它挂起的 scope 请求立即收敛（不遗留 pending + 不让 Worker 空等） */
  releasePending(memberId, reason = 'member released') {
    for (const [id, w] of [...this.pending.entries()]) {
      if (w.memberId !== memberId) continue;
      clearTimeout(w.timer);
      this.pending.delete(id);
      try { this.get("UPDATE scope_request SET status='expired', decided_at=? WHERE id=? AND status='pending'").run(nowIso(), id); } catch { /* ignore */ }
      // teamId 从 row 读，避免 audit 因 team_id NOT NULL 失败
      try {
        const row = this.get('SELECT team_id FROM scope_request WHERE id=?').get(id);
        this.audit({ teamId: row?.team_id ?? null, actor: 'system', domain: 'scope', action: 'release', target: id, result: 'EXPIRED', detail: { memberId, reason } });
      } catch { /* ignore */ }
      try { w.resolve({ status: 'expired', requestId: id, decisionId: null, grantId: null, released: reason }); } catch { /* ignore */ }
    }
  }

  // ---------- 权限矩阵 ----------
  matrix(teamId) {
    const members = this.get('SELECT * FROM member WHERE team_id=?').all(teamId);
    return members.map((m) => {
      const rules = this.rulesFor(teamId, m.id);
      return {
        memberId: m.id, name: m.name, role: m.role,
        matrix: matrixSummary(rules, { teamId, memberId: m.id, role: m.role }),
        rules: rules.filter((r) => (r.subjectType === 'member' && r.subjectId === m.id) || r.subjectType === 'team' || (r.subjectType === 'role' && r.subjectId === m.role))
          .map((r) => ({ id: r.id, kind: r.kind, domain: r.domain, matcher: r.matcher, ops: r.ops, mode: r.mode, subjectType: r.subjectType, subjectId: r.subjectId, expiresAt: r.expiresAt ?? null })),
      };
    });
  }

  /** 供日志/事件统一脱敏（FR-3.8） */
  redactText(s) { return redactor.str(String(s ?? '')); }

  /** 从仓库路径推导 rel（供 report/audit 用） */
  rel(ctx, p) { return resolveInWorkspace(ctx.workspace, p).rel; }
}

export { backoffMs, toPosix };

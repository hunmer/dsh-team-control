// tests/lib/harness.mjs — 真实进程测试底座：起真 sidecar、真 HTTP/SSE、真子进程 Worker
// 约定：禁止 mock sidecar、禁止 mock crash；所有测试在 os.tmpdir() 下自建 workspace/data。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const REPO = path.resolve(here, '..', '..');
export const BIN = path.join(REPO, 'bin', 'dsh-team.mjs');

export const sha256 = (data) => crypto.createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
export function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** 建临时 workspace + data 目录（不污染仓库） */
export function mkTmp(prefix = 'dsh-team-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const dataDir = path.join(root, 'data');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } };
  return {
    root, dataDir, ws,
    file: (rel) => path.join(ws, rel),
    read: (rel) => fs.readFileSync(path.join(ws, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(ws, rel)),
    // 清理是收尾动作，不能让它把「断言通过」变成 FAIL：Windows 上句柄释放有延迟，重试后放弃
    cleanup: () => {
      if (process.env.KEEP_TMP) { console.log(`[kept] ${root}`); return; }
      for (let i = 0; i < 8; i++) {
        try { fs.rmSync(root, { recursive: true, force: true }); return; } catch (e) {
          if (i === 7) { console.warn(`[warn] 临时目录清理失败（${e.code || e.message}），已保留：${root}`); return; }
          sleepSync(120);
        }
      }
    },
  };
}

/**
 * 起一个真实 sidecar 子进程。
 * @returns {Promise<{url,token,port,pid,child,stdout,stderr,api,close,hardKill,waitExit}>}
 */
export async function startSidecar({ dataDir, ws, env = {}, port = 0, cwd = undefined } = {}) {
  const args = [BIN, 'up', '--port', String(port), '--data', dataDir];
  const childEnv = { ...process.env, ...env };
  delete childEnv.DSH_TEAM_TOKEN;   // 测试一律用 --data 生成的独立 token
  const child = spawn(process.execPath, args, {
    cwd: cwd || REPO,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let outBuf = '';
  child.stdout.on('data', (d) => {
    outBuf += d;
    let i;
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
      stdout.push(line);
      if (line.trim() && !line.startsWith('{')) stderr.push(line);
    }
  });
  child.stderr.on('data', (d) => { stderr.push(...String(d).split('\n').filter(Boolean)); });

  const ready = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`sidecar ready timeout\nSTDERR:\n${stderr.slice(-20).join('\n')}`)), 20000);
    const iv = setInterval(() => {
      const line = stdout.find((l) => l.trim().startsWith('{') && l.includes('"event":"ready"'));
      if (!line) return;
      clearInterval(iv); clearTimeout(to);
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`bad ready line: ${line}`)); }
    }, 20);
    child.on('exit', (code) => { clearInterval(iv); clearTimeout(to); reject(new Error(`sidecar exited early code=${code}\n${stderr.slice(-20).join('\n')}`)); });
  });

  const api = apiClient(ready.url, ready.token);
  const waitExit = (ms = 8000) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
  const close = async () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    const exited = await waitExit(4000);
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* ignore */ } await waitExit(3000); }
  };
  const hardKill = async () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } await waitExit(5000); };
  return { ...ready, child, stdout, stderr, api, close, hardKill, waitExit, dataDir };
}

export function apiClient(baseUrl, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const call = async (method, p, body) => {
    const res = await fetch(baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) {
      const err = new Error(`${method} ${p} → ${res.status} ${json?.error?.code || ''} ${json?.error?.message || text.slice(0, 200)}`);
      err.status = res.status; err.body = json ?? text; throw err;
    }
    return json ?? text;
  };
  return {
    url: baseUrl,
    get: (p) => call('GET', p),
    post: (p, body) => call('POST', p, body ?? {}),
    patch: (p, body) => call('PATCH', p, body ?? {}),
    del: (p) => call('DELETE', p),
    raw: async (p) => {
      const res = await fetch(baseUrl + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      return { status: res.status, text: await res.text(), headers: res.headers };
    },
  };
}

/** 轮询直到 fn 返回 truthy 或超时 */
export async function waitFor(label, fn, { timeout = 20000, interval = 50 } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - t0 > timeout) {
      throw new Error(`waitFor(${label}) timeout after ${timeout}ms${lastErr ? `; last error: ${lastErr.message}` : ''}`);
    }
    await sleep(interval);
  }
}

/** SSE 客户端：收集帧、支持 lastEventId 续传与条件等待 */
export function sseOpen(baseUrl, token, params = {}) {
  const url = new URL('/api/events', baseUrl);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  if (token) url.searchParams.set('token', token);
  const ac = new AbortController();
  const frames = [];
  const waiters = [];
  let closed = false;
  const notify = () => { for (const w of [...waiters]) { try { w(); } catch { /* ignore */ } } };
  const done = (async () => {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const frame = parseFrame(raw);
          if (frame) { frames.push(frame); notify(); }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally { closed = true; notify(); }
  })();
  done.catch(() => { /* surfaced via frames */ });
  return {
    url: url.toString(),
    frames,
    get closed() { return closed; },
    get lastId() { return frames.length ? frames[frames.length - 1].id : 0; },
    close() { try { ac.abort(); } catch { /* ignore */ } },
    async waitFor(pred, { timeout = 10000, label = 'sse-frame' } = {}) {
      const t0 = Date.now();
      for (;;) {
        const hit = frames.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > timeout) throw new Error(`SSE wait timeout: ${label} (got ${frames.length} frames: ${frames.slice(-3).map((f) => f.event).join(',')})`);
        await new Promise((r) => { waiters.push(r); setTimeout(() => { const i = waiters.indexOf(r); if (i >= 0) waiters.splice(i, 1); r(); }, 50); });
      }
    },
  };
}

function parseFrame(raw) {
  const lines = raw.split('\n');
  let id = 0; let event = null; const data = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id: ')) id = Number(line.slice(4));
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (!event || !data.length) return null;
  let payload = null;
  try { payload = JSON.parse(data.join('\n')); } catch { payload = data.join('\n'); }
  return { id, event, payload };
}

/** 只读打开侧车数据库做对账（event 只增 / state 一致性） */
export function readDb(dataDir) {
  const file = path.join(dataDir, 'team.db');
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { db = new DatabaseSync(file); }
  return {
    db,
    all: (sql, ...a) => db.prepare(sql).all(...a),
    get: (sql, ...a) => db.prepare(sql).get(...a),
    close: () => { try { db.close(); } catch { /* ignore */ } },
  };
}

/** 统一收尾：跑 fn，打印 PASS/FAIL 并设置退出码 */
export async function runAc(id, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`PASS ${id} ${detail ? '— ' + detail : ''} (${Date.now() - t0}ms)`);
    process.exitCode = 0;
  } catch (e) {
    console.error(`FAIL ${id} — ${e?.stack || e}`);
    process.exitCode = 1;
  }
}

export { fs, path, os };

// @local/dsh-team-ui — Host half：把本地 sidecar 的 REST/SSE 以**同源**路径代理给 Web UI。
//
// 为什么需要 Host 代理：
// - 面板在 http://127.0.0.1:3080，sidecar 在 :4317，浏览器直连会撞 CORS；
// - 更关键的是 sidecar token（PRD D-11）不能下发给浏览器。代理在 Host 侧注入
//   Authorization，浏览器只看到同源路径 /dsh-team-api/**。
//
// 信任模型：该前缀路由不额外鉴权，与 DSH Web UI 一样只监听本机回环地址；
// sidecar token 仍然不出 Host。远程暴露 DSH 时需要在外层加访问控制。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-team-ui';
export const inject = ['webServer'];

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PREFIX = '/dsh-team-api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveConfig(config) {
  const c = config || {};
  const baseUrl = String(c.baseUrl || process.env.DSH_TEAM_URL || 'http://127.0.0.1:4317').replace(/\/+$/, '');
  let port = 4317;
  try { port = Number(new URL(baseUrl).port) || 4317; } catch { /* keep default */ }
  return {
    baseUrl,
    port,
    home: path.resolve(c.home || process.env.DSH_TEAM_HOME || path.join(os.homedir(), '.dsh', 'team')),
    autoStart: c.autoStart !== false,
    entry: path.resolve(c.sidecarEntry || path.join(PKG_DIR, '..', 'bin', 'dsh-team.mjs')),
    startTimeoutMs: Number(c.startTimeoutMs) || 20000,
    requestTimeoutMs: Number(c.requestTimeoutMs) || 60000,
  };
}

const readToken = (home) => { try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim() || null; } catch { return null; } };

async function isUp(baseUrl) {
  try {
    const res = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch { return false; }
}

function spawnSidecar(s) {
  const child = spawn(process.execPath, [s.entry, 'up', '--port', String(s.port), '--data', s.home], {
    cwd: path.dirname(s.entry),
    env: { ...process.env },
    stdio: 'ignore',
    windowsHide: true,
  });
  const state = { child, error: null };
  child.on('error', (e) => { state.error = e; });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) state.error = new Error(`sidecar 进程退出 code=${code}${signal ? ` signal=${signal}` : ''}`);
  });
  return state;
}

async function ensureSidecar(s) {
  if (!s.token) s.token = readToken(s.home);
  if (await isUp(s.baseUrl)) return s;
  if (!s.autoStart) throw new Error(`dsh-team sidecar 不可达：${s.baseUrl}。请先运行 dsh-team up，或在插件 config 里设 autoStart: true。`);
  if (!s.starting) {
    s.starting = (async () => {
      const spawned = spawnSidecar(s);
      s.spawned = spawned;
      const deadline = Date.now() + s.startTimeoutMs;
      while (Date.now() < deadline) {
        if (spawned.error) throw spawned.error;
        if (await isUp(s.baseUrl)) return;
        await sleep(150);
      }
      throw new Error(`dsh-team sidecar 启动超时（${s.startTimeoutMs}ms）：${s.baseUrl}`);
    })().finally(() => { s.starting = null; });
  }
  await s.starting;
  for (let i = 0; i < 20 && !s.token; i++) { s.token = readToken(s.home); if (!s.token) await sleep(50); }
  return s;
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function sendError(res, status, code, message) {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 返回 webServer 路由的 handler：/dsh-team-api/** → sidecar /api/** */
function proxyHandler(s) {
  return async (req, res) => {
    // 只服务回环地址：DSH 可开启远程访问，这条路由不在其鉴权链上，
    // 必须以网络层限制兜底（sidecar 本身也只监听 127.0.0.1）。
    const remote = req.socket?.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return sendError(res, 403, 'E_LOCAL_ONLY', `dsh-team proxy is loopback-only (remote=${remote})`);
    }
    try {
      await ensureSidecar(s);
      const incoming = new URL(req.url, 'http://127.0.0.1');
      const upstreamPath = incoming.pathname.replace(new RegExp('^' + ROUTE_PREFIX), '/api') + incoming.search;
      const headers = { Authorization: `Bearer ${s.token || ''}` };
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.body = await readBody(req);
        headers['Content-Type'] = req.headers['content-type'] || 'application/json';
      }
      const isSse = upstreamPath.startsWith('/api/events');
      if (isSse) {
        const upstream = await fetch(s.baseUrl + upstreamPath, { method: 'GET', headers });
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const reader = upstream.body.getReader();
        (async () => {
          try { for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } }
          catch { /* client gone */ }
          finally { try { res.end(); } catch { /* ignore */ } }
        })();
        req.on('close', () => { try { reader.cancel(); } catch { /* ignore */ } });
        return;
      }
      init.signal = AbortSignal.timeout(s.requestTimeoutMs);
      const upstream = await fetch(s.baseUrl + upstreamPath, init);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (e) {
      const down = /不可达|启动超时|ECONN|ENOENT/.test(String(e.message));
      sendError(res, down ? 503 : 502, down ? 'E_SIDECAR_DOWN' : 'E_SIDECAR_UPSTREAM', String(e.message));
    }
  };
}

export function apply(ctx, config) {
  const s = resolveConfig(config);
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: proxyHandler(s) });
    return () => {
      try { dispose(); } catch { /* ignore */ }
      const child = s.spawned?.child;
      if (child && child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
    };
  }, 'dsh-team-ui.route()');
}

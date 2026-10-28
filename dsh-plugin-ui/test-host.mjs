// Host 半边自测：假 ctx 捕获路由 → 起本地 HTTP 服务器 → 验证同源代理（含 SSE 与错误路径）。
// 用法：node dsh-plugin-ui/test-host.mjs
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { apply } from './index.js';

const home = path.join(os.homedir(), '.dsh', 'team');
const baseUrl = 'http://127.0.0.1:4317';
let failed = 0;
const check = (name, fn) => { try { const d = fn(); console.log(`PASS ${name}${d ? ' — ' + d : ''}`); } catch (e) { failed++; console.error(`FAIL ${name} — ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

function mount(config) {
  let route = null; const disposers = [];
  const ctx = {
    webServer: {
      register(r) { route = r; return () => { route = null; }; },
    },
    effect(fn) { const c = fn(); if (typeof c === 'function') disposers.push(c); },
  };
  apply(ctx, config);
  return { get route() { return route; }, dispose: () => disposers.reverse().forEach((d) => { try { d(); } catch { /* ignore */ } }) };
}

const host = mount({ baseUrl, home, autoStart: false });
check('注册 prefix 路由', () => {
  assert(host.route, 'route not registered');
  assert(host.route.kind === 'prefix', `kind=${host.route.kind}`);
  assert(host.route.path === '/dsh-team-api', `path=${host.route.path}`);
  return host.route.path;
});

const server = http.createServer((req, res) => host.route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => {
  const res = await fetch(origin + p);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
};

try {
  const teams = await get('/dsh-team-api/teams');
  check('代理 GET /teams（token 由 Host 注入）', () => {
    assert(teams.status === 200, `HTTP ${teams.status} ${teams.text.slice(0, 120)}`);
    assert(Array.isArray(teams.body.items), 'items');
    return `${teams.body.items.length} teams`;
  });
  const teamId = teams.body.items[0] && teams.body.items[0].id;
  if (teamId) {
    const st = await get('/dsh-team-api/status?team=' + encodeURIComponent(teamId));
    check('代理 GET /status', () => {
      assert(st.status === 200, `HTTP ${st.status}`);
      assert(Array.isArray(st.body.members), 'members');
      return st.body.members.map((m) => m.name + ':' + m.status).join(', ');
    });
    const dag = await get('/dsh-team-api/dag?team=' + encodeURIComponent(teamId));
    check('代理 GET /dag', () => {
      assert(dag.status === 200, `HTTP ${dag.status}`);
      assert(Array.isArray(dag.body.nodes), 'nodes');
      return `nodes=${dag.body.nodes.length}`;
    });
    // SSE：拿到响应头 + 至少一个 chunk（`: connected`）
    const ac = new AbortController();
    const sseRes = await fetch(`${origin}/dsh-team-api/events?team=${encodeURIComponent(teamId)}`, { signal: ac.signal });
    let first = '';
    try {
      const reader = sseRes.body.getReader();
      const { value } = await reader.read();
      first = new TextDecoder().decode(value || new Uint8Array());
      await reader.cancel();
    } catch { /* ignore */ }
    ac.abort();
    check('代理 SSE /events（流式）', () => {
      assert(sseRes.status === 200, `HTTP ${sseRes.status}`);
      assert(String(sseRes.headers.get('content-type')).includes('text/event-stream'), `ctype=${sseRes.headers.get('content-type')}`);
      assert(first.length > 0, 'no first chunk');
      return first.trim().slice(0, 40);
    });
  } else {
    console.log('[skip /status,/dag,/events] 没有团队');
  }

  // 侧车不可达 → 503 E_SIDECAR_DOWN
  const dead = mount({ baseUrl: 'http://127.0.0.1:43999', home, autoStart: false });
  const deadServer = http.createServer((req, res) => dead.route.handler(req, res));
  await new Promise((r) => deadServer.listen(0, '127.0.0.1', r));
  const deadOrigin = `http://127.0.0.1:${deadServer.address().port}`;
  const res = await fetch(deadOrigin + '/dsh-team-api/teams');
  const text = await res.text();
  check('侧车不可达时返回 503 + 可执行错误', () => {
    assert(res.status === 503, `HTTP ${res.status}`);
    assert(text.includes('E_SIDECAR_DOWN'), text.slice(0, 120));
    return '503 E_SIDECAR_DOWN';
  });
  await new Promise((r) => deadServer.close(r));
  dead.dispose();
} finally {
  await new Promise((r) => server.close(r));
  host.dispose();
}

check('dispose 后路由已注销', () => { assert(host.route === null, 'route still registered'); return 'ok'; });
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed ? 1 : 0);

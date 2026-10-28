// Host 半边自测：假 ctx 捕获路由 → 起本地 HTTP 服务器 → 验证同源代理（数据 / 面板 / SSE / 错误路径）。
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
  const routes = []; const disposers = [];
  const ctx = {
    webServer: {
      register(r) { routes.push(r); return () => { const i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1); }; },
    },
    effect(fn) { const c = fn(); if (typeof c === 'function') disposers.push(c); },
  };
  apply(ctx, config);
  return { routes, dispose: () => disposers.reverse().forEach((d) => { try { d(); } catch { /* ignore */ } }) };
}

/** 按 path 前缀把请求分发到对应路由（模拟 webServer 的前缀匹配） */
function serve(app) {
  return (req, res) => {
    const hit = app.routes.find((r) => r.kind === 'prefix' && (req.url === r.path || req.url.startsWith(r.path + '/')))
      || app.routes.find((r) => r.kind === 'exact' && req.url.split('?')[0] === r.path);
    if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'E_NO_ROUTE' } })); return; }
    hit.handler(req, res);
  };
}

const host = mount({ baseUrl, home, autoStart: false });
check('注册两条 prefix 路由（数据 + 面板）', () => {
  const paths = host.routes.map((r) => r.path).sort();
  assert(host.routes.every((r) => r.kind === 'prefix'), 'kind');
  assert(paths.includes('/dsh-team-api'), `missing /dsh-team-api: ${paths}`);
  assert(paths.includes('/panel'), `missing /panel: ${paths}`);
  return paths.join(', ');
});

const server = http.createServer(serve(host));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => {
  const res = await fetch(origin + p);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, ctype: res.headers.get('content-type') };
};

try {
  const teams = await get('/dsh-team-api/api/teams');
  check('代理 GET /api/teams（token 由 Host 注入）', () => {
    assert(teams.status === 200, `HTTP ${teams.status} ${teams.text.slice(0, 120)}`);
    assert(Array.isArray(teams.body.items), 'items');
    return `${teams.body.items.length} teams`;
  });

  const panel = await get('/dsh-team-api/panel');
  check('代理 GET /panel（iframe 复用同一份页面）', () => {
    assert(panel.status === 200, `HTTP ${panel.status}`);
    assert(String(panel.ctype).includes('text/html'), `ctype=${panel.ctype}`);
    assert(panel.text.includes('/panel/app.js'), 'panel.html 资源引用');
    return `${panel.text.length}B html`;
  });

  const panelJs = await get('/panel/app.js');
  check('根路径 /panel/app.js（iframe 内绝对引用）', () => {
    assert(panelJs.status === 200, `HTTP ${panelJs.status}`);
    assert(String(panelJs.ctype).includes('javascript'), `ctype=${panelJs.ctype}`);
    assert(panelJs.text.includes('API_BASE') && panelJs.text.includes('EMBEDDED'), '缺少同源嵌入模式');
    return `${panelJs.text.length}B`;
  });

  const blocked = await get('/dsh-team-api/teams');
  check('只转发 /api 与 /panel（其余 404）', () => {
    assert(blocked.status === 404, `HTTP ${blocked.status}`);
    assert(String(blocked.text).includes('E_NOT_PROXIED'), blocked.text.slice(0, 100));
    return '404 E_NOT_PROXIED';
  });

  const teamId = teams.body.items[0] && teams.body.items[0].id;
  if (teamId) {
    const st = await get('/dsh-team-api/api/status?team=' + encodeURIComponent(teamId));
    check('代理 GET /api/status', () => {
      assert(st.status === 200, `HTTP ${st.status}`);
      assert(Array.isArray(st.body.members), 'members');
      return st.body.members.map((m) => m.name + ':' + m.status).join(', ');
    });
    const ac = new AbortController();
    const sseRes = await fetch(`${origin}/dsh-team-api/api/events?team=${encodeURIComponent(teamId)}`, { signal: ac.signal });
    let first = '';
    try {
      const reader = sseRes.body.getReader();
      const { value } = await reader.read();
      first = new TextDecoder().decode(value || new Uint8Array());
      await reader.cancel();
    } catch { /* ignore */ }
    ac.abort();
    check('代理 SSE /api/events（流式）', () => {
      assert(sseRes.status === 200, `HTTP ${sseRes.status}`);
      assert(String(sseRes.headers.get('content-type')).includes('text/event-stream'), `ctype=${sseRes.headers.get('content-type')}`);
      assert(first.length > 0, 'no first chunk');
      return first.trim().slice(0, 40);
    });
  } else {
    console.log('[skip /status,/events] 没有团队');
  }

  const dead = mount({ baseUrl: 'http://127.0.0.1:43999', home, autoStart: false });
  const deadServer = http.createServer(serve(dead));
  await new Promise((r) => deadServer.listen(0, '127.0.0.1', r));
  const deadOrigin = `http://127.0.0.1:${deadServer.address().port}`;
  const res = await fetch(deadOrigin + '/dsh-team-api/api/teams');
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

check('dispose 后路由已注销', () => { assert(host.routes.length === 0, `still ${host.routes.length}`); return 'ok'; });
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed ? 1 : 0);

// tests/panel-contract.mjs — 面板数据契约验证：把面板实际消费的每个端点跑一遍，校验字段/类型/语义
// （不是 AC；面板视觉渲染需真人浏览器，这里验证「数据契约 + 静态资源 + SSE」）
import { mkTmp, startSidecar, sseOpen, waitFor, assert } from './lib/harness.mjs';

const tmp = mkTmp('panel-contract');
let s; let sse;
const results = [];
const check = (name, fn) => { try { const d = fn(); results.push({ name, ok: true, d }); } catch (e) { results.push({ name, ok: false, e: e.message }); } };

try {
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  const team = await s.api.post('/api/teams', { name: 'panel-team', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 });
  await s.api.post('/api/policies', { teamId: team.id, subjectType: 'team', subjectId: team.id, domain: 'fs', matcher: '**', ops: ['write'], mode: 'allow' });
  const m1 = await s.api.post(`/api/teams/${team.id}/members`, { name: 'panel-alpha', role: 'writer' });
  const m2 = await s.api.post(`/api/teams/${team.id}/members`, { name: 'panel-beta', role: 'reader' });

  const done = await s.api.post('/api/tasks', {
    teamId: team.id, subject: 'panel done task', assignee: m1.id,
    plan: [{ step: 'S1', phase: 'write', action: 'write', target: 'p.txt', op: { kind: 'fs.write', args: { path: 'p.txt', content: 'panel\n' } } }],
  });
  await waitFor('done', async () => (await s.api.get(`/api/tasks/${done.id}`)).status === 'done', { timeout: 20000 });

  const running = await s.api.post('/api/tasks', {
    teamId: team.id, subject: 'panel long task', assignee: m1.id,
    plan: Array.from({ length: 8 }, (_, i) => ({ step: `S${i + 1}`, phase: 'wait', action: 'sleep', target: `t${i}`, op: { kind: 'sleep', args: { ms: 120 } } })),
  });
  await waitFor('running', async () => (await s.api.get(`/api/status?member=${m1.id}`)).members[0].status === 'running', { timeout: 15000 });

  // 让 m2 产生一次越界申请 + 一条消息 + 一个 todo
  const sr = await s.api.post('/api/scope-requests', { memberId: m2.id, domain: 'fs', target: 'config/x.json', reason: 'panel contract', diffSize: 12, risk: 'low', blockedStep: 'S2', fallback: 'outbox' });
  await s.api.post('/api/messages', { teamId: team.id, from: 'lead', to: m2.id, kind: 'note', payload: { hello: 'panel' }, correlationId: 'corr-1' });
  await s.api.post('/api/todos', { teamId: team.id, memberId: m2.id, title: 'panel todo' });

  sse = sseOpen(s.url, s.token, { team: team.id });
  await sse.waitFor(() => sse.frames.length > 0, { timeout: 5000 });

  // ---------- 静态资源（Vite 构建产物：/panel/assets/app-*.js + panel-*.css） ----------
  const htmlRes = await s.api.raw('/panel');
  const html = htmlRes.text;
  const assets = [...html.matchAll(/(?:src|href)="(\/panel\/assets\/[^"]+)"/g)].map((m) => m[1]);
  for (const p of ['/panel', ...assets]) {
    const r = await s.api.raw(p);
    check(`static ${p}`, () => { assert(r.status === 200, `HTTP ${r.status}`); assert(r.text.length > 100, 'empty body'); return `${r.text.length}B`; });
  }

  // ---------- 面板消费的每个端点 ----------
  const teams = await s.api.get('/api/teams');
  check('GET /api/teams', () => { assert(Array.isArray(teams.items) && teams.items.length === 1, 'items'); assert(teams.items[0].id && teams.items[0].name, 'id/name'); return 'ok'; });

  const status = await s.api.get(`/api/status?team=${team.id}`);
  check('GET /api/status', () => {
    assert(Array.isArray(status.members) && status.members.length === 2, 'members');
    for (const m of status.members) {
      for (const k of ['id', 'name', 'role', 'status', 'step', 'seq', 'last', 'next', 'blockers', 'stale', 'asOf', 'pct']) assert(k in m, `missing ${k}`);
      assert(Array.isArray(m.blockers), 'blockers array');
      assert(m.pct === null || (typeof m.pct === 'number' && m.pct >= 0 && m.pct <= 1), `pct 必须是 0..1 比例，实际 ${m.pct}`);
    }
    assert(Array.isArray(status.staleMembers), 'staleMembers');
    assert(typeof status.asOf === 'string' && status.asOf.includes('T'), 'asOf ISO');
    return `members=${status.members.length} pct=${status.members.map((x) => x.pct).join(',')}`;
  });

  const dag = await s.api.get(`/api/dag?team=${team.id}`);
  check('GET /api/dag', () => {
    assert(Array.isArray(dag.nodes) && dag.nodes.length === 2, 'nodes');
    for (const n of dag.nodes) for (const k of ['taskId', 'subject', 'status', 'assignee', 'dependsOn', 'ready', 'blocked', 'attempts', 'planSize']) assert(k in n, `node missing ${k}`);
    assert(Array.isArray(dag.edges) && Array.isArray(dag.ready) && Array.isArray(dag.criticalPath), 'edges/ready/criticalPath');
    return `nodes=${dag.nodes.length} ready=${dag.ready.length}`;
  });

  const steps = await s.api.get(`/api/steps?member=${m1.id}&limit=500`);
  check('GET /api/steps', () => {
    assert(steps.items.length > 0, 'events');
    for (const e of steps.items) for (const k of ['seq', 'ts', 'phase', 'action', 'target', 'result', 'next', 'meta']) assert(k in e, `event missing ${k}`);
    return `${steps.items.length} events`;
  });

  const matrix = await s.api.get(`/api/permission-matrix?team=${team.id}`);
  check('GET /api/permission-matrix', () => {
    assert(Array.isArray(matrix.items) && matrix.items.length === 2, 'items');
    const item = matrix.items[0];
    for (const k of ['memberId', 'name', 'role', 'matrix', 'rules']) assert(k in item, `missing ${k}`);
    for (const d of ['fs', 'exec', 'net', 'env']) {
      assert(Array.isArray(item.matrix[d]), `matrix.${d} array`);
      for (const p of item.matrix[d]) for (const k of ['op', 'target', 'allowed', 'effect']) assert(k in p, `probe missing ${k}`);
    }
    return `rules=${item.rules.length}`;
  });

  // 允许写时矩阵应显示 fs.write allow
  check('matrix 反映 allow 规则', () => {
    const item = matrix.items.find((x) => x.memberId === m1.id);
    const w = item.matrix.fs.find((p) => p.op === 'write');
    assert(w.allowed === true, `fs.write 应 allow，实际 ${JSON.stringify(w)}`);
    return 'allow';
  });

  const reqs = await s.api.get(`/api/scope-requests?team=${team.id}&status=pending`);
  check('GET /api/scope-requests', () => {
    assert(reqs.items.length === 1, 'pending count');
    const r = reqs.items[0];
    for (const k of ['id', 'memberId', 'domain', 'target', 'reason', 'diffSize', 'risk', 'blockedStep', 'fallback', 'createdAt', 'status']) assert(k in r, `missing ${k}`);
    assert(r.status === 'pending', 'status');
    return r.id;
  });

  const msgs = await s.api.get(`/api/messages?team=${team.id}`);
  check('GET /api/messages', () => {
    assert(msgs.items.length === 1, 'count');
    const m = msgs.items[0];
    for (const k of ['id', 'from', 'to', 'kind', 'status', 'sentAt', 'payload', 'correlationId']) assert(k in m, `missing ${k}`);
    assert(m.correlationId === 'corr-1', 'correlation');
    return m.status;
  });

  const todos = await s.api.get(`/api/todos?team=${team.id}`);
  check('GET /api/todos', () => { assert(todos.items.length === 1 && todos.items[0].title === 'panel todo', 'todo'); return 'ok'; });

  const policies = await s.api.get(`/api/policies?team=${team.id}`);
  check('GET /api/policies', () => { assert(policies.items.length >= 4, 'policies'); assert(policies.items[0].matcher, 'matcher'); return `${policies.items.length}`; });

  const report = await s.api.get(`/api/report?team=${team.id}`);
  check('GET /api/report', () => { assert(typeof report === 'string' && report.includes('before_hash') && report.includes('panel-alpha'), 'markdown'); return `${report.length}B`; });

  const hist = await s.api.get(`/api/events/history?team=${team.id}`);
  check('GET /api/events/history', () => { assert(hist.items.length > 0, 'history'); return `${hist.items.length}`; });

  check('SSE 帧契约', () => {
    assert(sse.frames.length > 0, 'frames');
    for (const f of sse.frames) {
      assert(typeof f.event === 'string' && f.event.length > 0, 'event name');
      assert(typeof f.id === 'number' && f.id > 0, 'numeric id');
      assert(f.payload && typeof f.payload === 'object', 'payload object');
      assert(typeof f.payload.ts === 'string', 'payload.ts');
    }
    return `${sse.frames.length} frames`;
  });

  // 面板从不引用 dev-mock
  check('panel 不依赖 dev-mock/外链', () => {
    assert(!html.includes('dev-mock'), 'dev-mock leaked');
    assert(!/src="https?:\/\//.test(html), 'external script');
    assert(assets.some((p) => p.endsWith('.js')) && assets.some((p) => p.endsWith('.css')), 'assets linked');
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? ' — ' + (r.d || '') : ' — ' + r.e}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('PANEL CONTRACT ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  try { sse?.close(); } catch { /* ignore */ }
  if (s) await s.close();
  tmp.cleanup();
}

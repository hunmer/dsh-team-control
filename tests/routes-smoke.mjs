// tests/routes-smoke.mjs — 全 REST 路由冒烟：任何路由都不允许 500（非 AC，防止未覆盖路径的拼写/装配错误）
import { mkTmp, startSidecar, waitFor, assert } from './lib/harness.mjs';

const tmp = mkTmp('routes-smoke');
let s;
const out = [];
const hit = async (name, method, path, body, expectStatus = 200) => {
  const res = await fetch(s.url + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text route */ }
  const ok = res.status === expectStatus;
  out.push({ name, ok, info: `${res.status}${ok ? '' : ' ' + text.slice(0, 160)}` });
  return { status: res.status, json, text };
};

try {
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });

  // 免 token 访问（鉴权已移除，sidecar 仅监听回环）
  const noAuth = await fetch(s.url + '/api/teams');
  out.push({ name: 'no-token access allowed', ok: noAuth.status === 200, info: String(noAuth.status) });
  await hit('404 route', 'GET', '/api/nope', undefined, 404);

  await hit('health', 'GET', '/api/health');

  // 模型路由目录（Host 插件推送 → 面板勾选）
  await hit('GET llm catalog (empty)', 'GET', '/api/llm/catalog');
  await hit('GET llm models (empty)', 'GET', '/api/llm/models');
  await hit('POST llm catalog', 'POST', '/api/llm/catalog', {
    providers: [{ id: 'p', name: 'P' }],
    models: [{ provider: 'p', model: 'm', name: 'M' }],
  });
  await hit('PATCH llm route', 'PATCH', '/api/llm/routes', { provider: 'p', model: 'm', enabled: false, note: 'smoke' });
  await hit('GET llm models?all=1', 'GET', '/api/llm/models?all=1');

  const team = (await hit('POST /api/teams', 'POST', '/api/teams', { name: 'routes', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 })).json;
  await hit('GET /api/teams', 'GET', '/api/teams');
  await hit('GET /api/teams/{id}', 'GET', `/api/teams/${team.id}`);
  await hit('PATCH /api/teams/{id}', 'PATCH', `/api/teams/${team.id}`, { maxConcurrency: 3, autoTakeover: true });
  // 封存 / 恢复 / 面板设置
  await hit('GET /api/settings', 'GET', '/api/settings');
  await hit('PATCH /api/settings', 'PATCH', '/api/settings', { autoArchive: { enabled: true, days: 9 } });
  await hit('PATCH /api/settings days=0(400)', 'PATCH', '/api/settings', { autoArchive: { days: 0 } }, 400);
  const archivedTeam = (await hit('POST /api/teams/{id}/archive', 'POST', `/api/teams/${team.id}/archive`, {})).json;
  assert(archivedTeam.archivedAt, 'archive 返回 archivedAt');
  const activeIds = (await hit('GET /api/teams', 'GET', '/api/teams')).json.items.map((t) => t.id);
  assert(!activeIds.includes(team.id), '已封存团队不在默认列表');
  const archivedIds = (await hit('GET /api/teams?archived=1', 'GET', '/api/teams?archived=1')).json.items.map((t) => t.id);
  assert(archivedIds.includes(team.id), '已封存团队出现在 archived=1 列表');
  const restored = (await hit('POST /api/teams/{id}/restore', 'POST', `/api/teams/${team.id}/restore`, {})).json;
  assert(restored.archivedAt == null, 'restore 清空 archivedAt');
  await hit('PATCH /api/settings 复位', 'PATCH', '/api/settings', { autoArchive: { enabled: true, days: 7 } });
  await hit('POST /api/policies', 'POST', '/api/policies', { teamId: team.id, subjectType: 'team', subjectId: team.id, domain: 'fs', matcher: '**', ops: ['write', 'delete'], mode: 'allow' });
  const pols = (await hit('GET /api/policies', 'GET', `/api/policies?team=${team.id}`)).json;
  await hit('DELETE /api/policies/{id}', 'DELETE', `/api/policies/${pols.items.find((p) => p.matcher === '**' && p.domain === 'fs' && p.mode === 'allow').id}`);
  await hit('GET /api/permission-matrix', 'GET', `/api/permission-matrix?team=${team.id}`);

  const m1 = (await hit('POST member', 'POST', `/api/teams/${team.id}/members`, { name: 'r1', role: 'w' })).json;
  const m2 = (await hit('POST member2', 'POST', `/api/teams/${team.id}/members`, { name: 'r2' })).json;
  await hit('GET members', 'GET', `/api/teams/${team.id}/members`);
  await hit('GET member', 'GET', `/api/members/${m1.id}`);

  // 依赖 + 任务（内联 deps）
  const a = (await hit('POST task A', 'POST', '/api/tasks', {
    teamId: team.id, subject: 'A', assignee: m1.id,
    plan: Array.from({ length: 8 }, (_, i) => ({ step: `S${i + 1}`, phase: 'wait', action: 'sleep', target: `a${i}`, op: { kind: 'sleep', args: { ms: 120 } } })),
  })).json;
  const b = (await hit('POST task B (deps)', 'POST', '/api/tasks', { teamId: team.id, subject: 'B', assignee: m2.id, plan: [{ step: 'S1', phase: 'wait', action: 'sleep', target: 'b', op: { kind: 'sleep', args: { ms: 50 } } }], deps: [{ from: a.id, condition: 'all_success' }] })).json;
  await hit('GET /api/tasks', 'GET', `/api/tasks?team=${team.id}`);
  await hit('GET /api/tasks/{id}', 'GET', `/api/tasks/${a.id}`);
  await hit('GET /api/dag', 'GET', `/api/dag?team=${team.id}`);
  const dep = (await hit('POST /api/deps (cycle 应 400)', 'POST', '/api/deps', { from: b.id, to: a.id }, 400));
  assert(dep.json.error.code === 'E_CYCLE', '反向依赖必须报 E_CYCLE');
  await hit('GET /api/status', 'GET', `/api/status?team=${team.id}`);
  await hit('GET /api/steps', 'GET', `/api/steps?member=${m1.id}`);
  await hit('GET /api/blockers', 'GET', `/api/blockers?team=${team.id}`);
  await hit('GET /api/metrics', 'GET', `/api/metrics?team=${team.id}`);
  await hit('GET /api/verify', 'GET', `/api/verify?team=${team.id}`);
  await hit('GET /api/reconcile', 'GET', `/api/reconcile?team=${team.id}`);
  await hit('GET /api/events/history', 'GET', `/api/events/history?team=${team.id}`);

  // 消息 + 待办
  const msg = (await hit('POST /api/messages', 'POST', '/api/messages', { teamId: team.id, from: 'lead', to: m2.id, payload: { a: 1 }, correlationId: 'c1' })).json;
  await hit('GET /api/messages', 'GET', `/api/messages?team=${team.id}&correlation=c1`);
  await hit('POST /api/messages/{id}/ack', 'POST', `/api/messages/${msg.message.id}/ack`, { state: 'acked' });
  const todo = (await hit('POST /api/todos', 'POST', '/api/todos', { teamId: team.id, memberId: m1.id, title: 't' })).json;
  await hit('GET /api/todos', 'GET', `/api/todos?team=${team.id}`);
  await hit('PATCH /api/todos/{id}', 'PATCH', `/api/todos/${todo.id}`, { status: 'done' });
  await hit('POST /api/tasks/{id}/todos（整体替换）', 'POST', `/api/tasks/${a.id}/todos`, {
    by: 'smoke', items: [{ title: 'plan-1', status: 'done' }, { title: 'plan-2', status: 'active' }],
  });
  await hit('GET /api/todos?task=', 'GET', `/api/todos?team=${team.id}&task=${a.id}`);

  // 审批（人工创建 + 决策）
  const sr = (await hit('POST scope-request', 'POST', '/api/scope-requests', { memberId: m2.id, domain: 'fs', target: 'config/y.json', reason: 'routes', diffSize: 5 })).json;
  await hit('GET scope-requests', 'GET', `/api/scope-requests?team=${team.id}`);
  await hit('POST decide (approved)', 'POST', `/api/scope-requests/${sr.id}/decide`, { decision: 'approved', decidedBy: 'smoke', reason: 'ok', ttlSeconds: 30 });
  await hit('POST decide 二次(应 409)', 'POST', `/api/scope-requests/${sr.id}/decide`, { decision: 'denied', decidedBy: 'smoke' }, 409);

  await hit('GET /api/audit', 'GET', `/api/audit?team=${team.id}`);
  await hit('GET /api/report', 'GET', `/api/report?team=${team.id}`);

  // 中断 / 恢复 / 回收 / 物理删除
  await waitFor('running with progress', async () => {
    const st = await s.api.get(`/api/members/${m1.id}`);
    return st.status === 'running' && st.seq >= 3;
  }, { timeout: 20000 });
  await hit('POST interrupt', 'POST', `/api/members/${m1.id}/interrupt`, { reason: 'smoke' });
  await hit('POST interrupt 二次(应 409)', 'POST', `/api/members/${m1.id}/interrupt`, { reason: 'smoke' }, 409);
  await hit('POST resume', 'POST', `/api/members/${m1.id}/resume`, {});
  await waitFor('idle after resume', async () => (await s.api.get(`/api/members/${m1.id}`)).status === 'idle', { timeout: 25000 });
  await hit('DELETE retire', 'DELETE', `/api/members/${m1.id}?mode=retire`);
  await waitFor('m2 idle', async () => ['idle', 'done'].includes((await s.api.get(`/api/members/${m2.id}`)).status), { timeout: 25000 });
  // 利用 settle 窗口在自动派发前完成 assign
  const c = (await hit('POST task C', 'POST', '/api/tasks', {
    teamId: team.id, subject: 'C', plan: [{ step: 'S1', phase: 'wait', action: 'sleep', target: 'c', op: { kind: 'sleep', args: { ms: 60 } } }],
  })).json;
  await hit('POST assign', 'POST', `/api/members/${m2.id}/assign`, { taskId: c.id });
  await waitFor('C done', async () => (await s.api.get(`/api/tasks/${c.id}`)).status === 'done', { timeout: 20000 });
  await waitFor('m2 idle again', async () => (await s.api.get(`/api/members/${m2.id}`)).status === 'idle', { timeout: 20000 });
  await hit('DELETE remove 无 confirm(400)', 'DELETE', `/api/members/${m2.id}?mode=remove`, undefined, 400);
  await hit('DELETE remove confirm', 'DELETE', `/api/members/${m2.id}?mode=remove&confirm=1`);

  const failed = out.filter((r) => !r.ok);
  for (const r of out) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.info}`);
  console.log(`\n${out.length - failed.length}/${out.length} 路由通过`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('ROUTES SMOKE ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  if (s) await s.close();
  tmp.cleanup();
}

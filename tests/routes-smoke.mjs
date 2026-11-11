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
  await hit('PATCH /api/teams/{id}', 'PATCH', `/api/teams/${team.id}`, { maxConcurrency: 3, permissionPreset: 'danger-full-access' });
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
  // 成员产物（Host 插件推送）
  const taskRow = (await hit('POST /api/tasks', 'POST', '/api/tasks', { teamId: team.id, subject: 'artifact-task' })).json;
  const added = (await hit('POST /api/artifacts', 'POST', '/api/artifacts', {
    teamId: team.id, taskId: taskRow.id, memberId: null,
    items: [{ path: 'outline.md', label: '大纲', source: 'present', added: 12, deleted: 3 }, { path: 'docs/novel.md', label: '正文', source: 'workspace', added: 40, deleted: 0 }],
  })).json;
  assert(added.items.length === 2, 'artifacts 写入 2 条');
  const listed = (await hit('GET /api/artifacts', 'GET', `/api/artifacts?team=${team.id}`)).json.items;
  assert(listed.length === 2 && listed.some((a) => a.path === 'outline.md' && a.label === '大纲'), 'artifacts 可按团队列出');
  assert(listed.find((a) => a.path === 'outline.md').added === 12 && listed.find((a) => a.path === 'outline.md').deleted === 3, 'artifacts 保留新增/删除行数');
  const byTask = (await hit('GET /api/artifacts?task', 'GET', `/api/artifacts?team=${team.id}&task=${taskRow.id}`)).json.items;
  assert(byTask.length === 2, 'artifacts 可按任务过滤');
  // 同路径再写一次：覆盖而不是新增
  await hit('POST /api/artifacts 覆盖', 'POST', '/api/artifacts', { teamId: team.id, taskId: taskRow.id, items: [{ path: 'outline.md', label: '大纲 v2' }] });
  const afterOverwrite = (await hit('GET /api/artifacts 覆盖后', 'GET', `/api/artifacts?team=${team.id}`)).json.items;
  assert(afterOverwrite.length === 2 && afterOverwrite.find((a) => a.path === 'outline.md').label === '大纲 v2', '同路径覆盖为最新');
  assert(afterOverwrite.find((a) => a.path === 'outline.md').added === 12, '覆盖时未带行数则保留旧行数');
  await hit('GET /api/artifacts 缺 team(400)', 'GET', '/api/artifacts', undefined, 400);
  const m1 = (await hit('POST member', 'POST', `/api/teams/${team.id}/members`, { name: 'r1', role: 'w' })).json;
  const m2 = (await hit('POST member2', 'POST', `/api/teams/${team.id}/members`, { name: 'r2' })).json;
  await hit('GET members', 'GET', `/api/teams/${team.id}/members`);
  await hit('GET member', 'GET', `/api/members/${m1.id}`);
  const patchedMember = (await hit('PATCH member', 'PATCH', `/api/members/${m1.id}`, {
    role: 'reviewer', model: 'smoke-model', agentProvider: 'smoke-provider',
    contextMode: 'fresh', reasoningEffort: 'low', permissionPreset: 'read-only',
  })).json;
  assert(patchedMember.model === 'smoke-model' && patchedMember.agentProvider === 'smoke-provider', 'PATCH member 更新模型/provider');
  assert(patchedMember.permissionPreset === 'read-only', 'PATCH member 更新权限预设');
  await hit('PATCH member contextMode(400)', 'PATCH', `/api/members/${m1.id}`, { contextMode: 'bogus' }, 400);

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
  // 停止团队：把 running/provisioning/blocked 成员中断，并把 running 任务转 paused
  const stopped = (await hit('POST /api/teams/{id}/stop', 'POST', `/api/teams/${team.id}/stop`, { reason: 'smoke' })).json;
  assert(Array.isArray(stopped.stopped), 'stop 返回被中断的成员列表');
  assert(stopped.id === team.id, 'stop 返回团队视图');
  await hit('POST /api/teams/{id}/stop 已停止再停', 'POST', `/api/teams/${team.id}/stop`, {});
  await hit('GET /api/steps', 'GET', `/api/steps?member=${m1.id}`);
  await hit('GET /api/blockers', 'GET', `/api/blockers?team=${team.id}`);
  await hit('GET /api/metrics', 'GET', `/api/metrics?team=${team.id}`);
  // 上下文快照：stats（轮数/步数/token/缓存）落库并原样返回
  const ctxReport = (await hit('POST /api/contexts', 'POST', '/api/contexts', {
    teamId: team.id, memberId: m1.id, sessionId: 'sess-ctx', model: 'm', provider: 'p',
    limit: 1000, used: 320, status: 'running',
    stats: { turns: 7, steps: 11, llmMs: 2000, toolMs: 500, ttftMs: 100, decodeMs: 1000, decodeTokens: 200, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0 },
  })).json;
  assert(ctxReport.item.stats.turns === 7 && ctxReport.item.stats.steps === 11, 'contexts 返回 stats 轮数/步数');
  assert(ctxReport.item.stats.cacheReadTokens === 800 && ctxReport.item.stats.inputTokens === 1000, 'contexts 返回 stats token/缓存字段');
  const ctxListed = (await hit('GET /api/contexts', 'GET', `/api/contexts?team=${team.id}`)).json.items.find((x) => x.memberId === m1.id);
  assert(ctxListed?.stats?.decodeTokens === 200, 'contexts 列表携带 stats');
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

  // 审批（插件镜像创建 + Lead 决策）
  const apr = (await hit('POST approval', 'POST', '/api/approvals', { id: 'apr_routes_1', teamId: team.id, memberId: m2.id, toolName: 'exec', reason: 'routes' })).json;
  await hit('GET approvals', 'GET', `/api/approvals?team=${team.id}`);
  await hit('POST approval decide', 'POST', `/api/approvals/${apr.id}/decide`, { decision: 'allowed', decidedBy: 'lead', reason: 'ok' });
  await hit('GET approvals allowed', 'GET', `/api/approvals?team=${team.id}&status=allowed`);

  // agentPreset 目录镜像 + 面板删除队列（Host 插件负责真正反注册）
  await hit('POST presets sync', 'POST', '/api/presets/sync', { presets: [
    { id: 'standard', name: '标准', source: 'host' },
    { id: 'team-smoke', name: '团队自建', source: 'team', file: '/tmp/team-smoke.json', doc: { id: 'team-smoke', plugins: [{ name: 'p1' }] } },
  ] });
  const presets = (await hit('GET presets', 'GET', '/api/presets')).json;
  assert(presets.items.length === 2, '目录镜像两条');
  const one = (await hit('GET preset detail', 'GET', '/api/presets/team-smoke')).json;
  assert(one.doc && one.doc.plugins.length === 1, '镜像保留组合文档');
  await hit('GET missing preset(404)', 'GET', '/api/presets/nope', undefined, 404);
  await hit('DELETE host preset(400)', 'POST', '/api/presets/standard/delete', {}, 400);
  await hit('POST preset delete', 'POST', '/api/presets/team-smoke/delete', {});
  const pending = (await hit('GET preset pending deletes', 'GET', '/api/presets/pending-deletes')).json;
  assert(pending.items.some((p) => p.id === 'team-smoke'), '删除已排队');
  const ackFail = (await hit('POST preset ack error', 'POST', '/api/presets/pending-deletes/team-smoke/ack', { error: '磁盘忙' })).json;
  assert(ackFail.removed === false && ackFail.attempts === 1, '失败 ack 计数 +1');
  const pending2 = (await hit('GET preset pending after error', 'GET', '/api/presets/pending-deletes')).json;
  assert(pending2.items.find((p) => p.id === 'team-smoke').attempts === 1, '队列保留并记 attempts');
  assert(pending2.items.find((p) => p.id === 'team-smoke').lastError === '磁盘忙', '队列保留错误原因');
  await hit('POST preset ack', 'POST', '/api/presets/pending-deletes/team-smoke/ack', {});
  const after = (await hit('GET presets after ack', 'GET', '/api/presets')).json;
  assert(!after.items.some((p) => p.id === 'team-smoke'), 'ack 后目录移除');

  await hit('GET /api/audit', 'GET', `/api/audit?team=${team.id}`);
  await hit('GET /api/report', 'GET', `/api/report?team=${team.id}`);

  // 中断 / 恢复 / 回收 / 物理删除
  await hit('POST interrupt', 'POST', `/api/members/${m1.id}/interrupt`, { reason: 'smoke' });
  await hit('POST interrupt 二次', 'POST', `/api/members/${m1.id}/interrupt`, { reason: 'smoke' });
  await hit('POST resume', 'POST', `/api/members/${m1.id}/resume`, {});
  await hit('DELETE retire', 'DELETE', `/api/members/${m1.id}?mode=retire`);
  await waitFor('m2 idle', async () => ['idle', 'done'].includes((await s.api.get(`/api/members/${m2.id}`)).status), { timeout: 25000 });
  // 利用 settle 窗口在自动派发前完成 assign
  const c = (await hit('POST task C', 'POST', '/api/tasks', {
    teamId: team.id, subject: 'C', plan: [{ step: 'S1', phase: 'wait', action: 'sleep', target: 'c', op: { kind: 'sleep', args: { ms: 60 } } }],
  })).json;
  await hit('POST assign', 'POST', `/api/members/${m2.id}/assign`, { taskId: c.id });
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

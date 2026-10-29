// tests/plugin-trace.mjs — Host 插件工具调用上报链路：tools/execute → POST /api/spans
// 不依赖运行中的 DSH 进程：用假 ctx 捕获插件注册的 waterfall 监听器，直接驱动它。
// 覆盖：① 会话→团队粘性绑定（第一次带 teamId 后，后续无 teamId 的调用也归属该团队）
//       ② running → done 两次 upsert 只留一行 ③ next() 抛错写成 failed
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const handlers = new Map();
  const disposed = [];
  return {
    handlers,
    disposed,
    tools: { register: (tool) => { disposed.push(tool.name); return () => { /* noop */ }; } },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  };
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-trace');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const team = await api.post('/api/teams', { name: 'plugin-trace', workspace: tmp.ws });

    const ctx = mkFakeCtx();
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: true });
    assert.equal(typeof ctx.handlers.get('tools/execute'), 'function', '插件注册了 tools/execute 监听器');
    assert.equal(ctx.disposed.length, 8, '8 个 team_* 工具已注册');

    const drive = ctx.handlers.get('tools/execute');

    // ① 未绑定团队的非 team_* 工具：不上报
    await drive({ name: 'read', callId: 'c0', arguments: { path: 'a.txt' }, agent: { id: 'sess-probe' } }, async () => ({ value: 'x' }));
    await sleep(150);
    assert.equal((await api.get(`/api/spans?team=${team.id}`)).items.length, 0, '无团队归属的工具调用不上报');

    // ② team_status 带 teamId：running → done，且绑定会话
    const exec = (callId, name, args) => ({ name, callId, arguments: args, agent: { id: 'sess-probe' } });
    const out = await drive(exec('c1', 'team_status', { teamId: team.id }), async () => ({ value: { members: [] } }));
    assert.deepEqual(out, { value: { members: [] } }, 'waterfall 透传 next() 结果');

    const spans = await waitFor('span 落库', async () => {
      const r = await api.get(`/api/spans?team=${team.id}`);
      return r.items.length === 1 ? r : null;
    }, { timeout: 4000, interval: 30 });
    assert.equal(spans.items[0].name, 'team_status', 'span.name 是工具名');
    assert.equal(spans.items[0].status, 'done', '结束后 status=done');
    assert.equal(spans.items[0].sessionId, 'sess-probe', 'span 记录会话 id');
    assert.ok(spans.items[0].endMs >= spans.items[0].startMs, 'end >= start');

    // ③ 绑定后：无 teamId 参数的工具也自动归属（同一 spanId 第二次 upsert 只更新一行）
    const before = (await api.get(`/api/spans?team=${team.id}`)).items.length;
    await drive(exec('c2', 'pwsh', { command: 'echo hi' }), async () => ({ value: 'hi' }));
    await waitFor('pwsh span 落库', async () => (await api.get(`/api/spans?team=${team.id}`)).items.length === before + 1,
      { timeout: 4000, interval: 30 });

    // ④ 失败路径
    await drive(exec('c3', 'team_spawn', { teamId: team.id, name: 'x' }), async () => { throw new Error('boom'); })
      .then(() => { throw new Error('应抛出'); }, (e) => assert.equal(e.message, 'boom', '错误原样抛出'));
    const failed = await waitFor('failed span 落库', async () => {
      const r = await api.get(`/api/spans?team=${team.id}`);
      const hit = r.items.find((s) => s.spanId === 'tool:sess-probe:c3');
      return hit && hit.status === 'failed' ? hit : null;
    }, { timeout: 4000, interval: 30 });
    assert.match(failed.error, /boom/, 'failed span 带错误信息');

    // ⑤ 后端 /api/trace 能把这些 span 挂到 session 节点下
    const trace = await api.get(`/api/trace?team=${team.id}`);
    const session = trace.root.children.find((n) => n.id === 'session:sess-probe');
    assert.ok(session, 'trace 里出现 session 节点');
    assert.equal(session.children.length, 3, '3 次上报都进了 trace');

    console.log('PASS plugin-trace — 上报链路：绑定/幂等/失败/trace 挂载 全部通过');
  } finally {
    await sidecar.close();
  }
};

main().catch((e) => {
  console.error('FAIL plugin-trace —', e?.stack || e);
  process.exitCode = 1;
});

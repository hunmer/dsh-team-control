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
    // 插件会读若干可选服务（workspaceRegistry / sessionProjections…）：桩成「都没有」
    get() { return undefined; },
    getService() { return undefined; },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    // 同一事件可能有多个监听器（tools/execute 同时挂了 span 上报与 todo→plan 镜像）
    on(name, fn) {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
    /** 取该事件的第一个监听器（本测试只验 span 上报链路） */
    first(name) { return (handlers.get(name) || [])[0]; },
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
    assert.equal(typeof ctx.first('tools/execute'), 'function', '插件注册了 tools/execute 监听器');
    assert.equal(ctx.disposed.length, 12, '12 个 team_* 工具已注册（含 team_models / team_todo）');

    const drive = ctx.first('tools/execute');

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

    // ⑥ LLM 调用：llm/stream 抓到 usage → 落一条带 tokens + 金额的 llm span
    const driveLlm = ctx.first('llm/stream');
    assert.equal(typeof driveLlm, 'function', '插件注册了 llm/stream 监听器');
    const usage = { inputTokens: 3000, cacheReadTokens: 50000, cacheWriteTokens: 0, outputTokens: 400 };
    const chunks = [{ type: 'text', text: 'hi' }, { type: 'usage', usage }, { type: 'finish', reason: 'stop' }];
    const runLlm = async (sessionId) => {
      const source = (async function* () { yield* chunks; })();
      const wrapped = driveLlm({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId }, () => source);
      const seen = [];
      for await (const c of wrapped) seen.push(c);
      return { wrapped, source, seen };
    };

    // 未归属团队的会话：原样透传，不上报
    const passthrough = await runLlm('sess-other');
    assert.equal(passthrough.wrapped, passthrough.source, '无团队归属时 llm/stream 原样透传');

    const out2 = await runLlm('sess-probe');
    assert.equal(out2.seen.length, 3, 'llm/stream 的 chunk 全部原样下发');
    const llmSpan = await waitFor('llm span 落库', async () => {
      const r = await api.get(`/api/spans?team=${team.id}`);
      const hit = r.items.find((s) => s.kind === 'llm');
      return hit && hit.status === 'done' ? hit : null;
    }, { timeout: 4000, interval: 30 });
    assert.equal(llmSpan.model, 'deepseek-flash');
    assert.equal(llmSpan.tokensIn, 53000, 'tokensIn = 未缓存输入 + 缓存读 + 缓存写');
    assert.equal(llmSpan.tokensOut, 400);
    assert.equal(llmSpan.meta.currency, 'CNY', '币种写进 meta');
    assert.ok(llmSpan.cost > 0, '按单价表折算出金额');

    const trace2 = await api.get(`/api/trace?team=${team.id}`);
    const flat = (n) => [n, ...(n.children ?? []).flatMap(flat)];
    const llmNode = flat(trace2.root).find((n) => n.id === `span:${llmSpan.spanId}`);
    assert.ok(llmNode, 'llm span 进了 trace');
    const sessionNode = flat(trace2.root).find((n) => n.id === 'session:sess-probe');
    assert.ok((sessionNode?.children ?? []).some((n) => n.id === `span:${llmSpan.spanId}`), 'llm span 挂在 session 节点下');
    assert.equal(llmNode.currency, 'CNY', '节点带币种');
    assert.ok(llmNode.cost > 0, '节点带金额');
    assert.equal(trace2.root.currency, 'CNY', '根节点聚合出币种');

    console.log('PASS plugin-trace — 上报链路：绑定/幂等/失败/trace 挂载/LLM 金额 全部通过');
  } finally {
    await sidecar.close();
  }
};

main().catch((e) => {
  console.error('FAIL plugin-trace —', e?.stack || e);
  process.exitCode = 1;
});

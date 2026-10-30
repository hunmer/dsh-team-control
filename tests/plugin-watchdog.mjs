// tests/plugin-watchdog.mjs — 派发后成员会话「根本没跑起来」的兜底（模型路由失败 → 任务永久卡 running）
// 场景：任务已投进成员信箱，但会话一次事件都没有（provider 报错 failed before it finished）。
// 期望：agentStartTimeoutMs 后自动报 failed → sidecar 按重试策略把任务交回 ready；
//       会话只要发过一个事件就撤销监视（长回合不会被误杀）。
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const agents = {
    spawned: [], messages: [], interrupts: [],
    async startActivation(spec) {
      agents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: `msg-${agents.spawned.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage(caller, targetId, content) { agents.messages.push({ caller, target: targetId, content }); return `msg-${agents.messages.length}`; },
    interrupt(targetId, authority) { agents.interrupts.push({ targetId, authority }); },
    list: () => ['spawn', 'fork'],
  };
  const ctx = {
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents,
    handlers,
    get: (name) => {
      if (name === 'subagents') return agents;
      if (name === 'sessions') return { get: (id) => ({ id }) };
      if (name === 'sessionProjections') return { stateOf: () => null };
      return undefined;
    },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
  return ctx;
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-watchdog');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const ctx = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, autoStart: false, reportToolCalls: false,
      agentDispatchMs: 400, agentIdleSettleMs: 300,
      agentStartTimeoutMs: 700,         // 0.7s 没动静就判失败（默认 120s）
    });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    const lead = { agent: { id: 'sess-lead' } };

    const team = (await tool('team_create').execute({ name: 'watchdog', workspace: tmp.ws, runtime: 'agent', maxAttempts: 3 }, lead)).team;
    const spawned = await tool('team_spawn').execute(
      { teamId: team.id, name: 'alice', role: 'writer', prompt: '你是 alice。' }, lead,
    );
    const sessionId = spawned.member.agentSessionId;
    assert(sessionId, '成员绑定会话');

    const created = await tool('team_task').execute({ teamId: team.id, subject: '写一段话', plan: [] }, lead);
    const taskId = created.task?.id || created.taskId;
    assert(taskId, '任务已创建');

    await waitFor('任务被派发（running）', async () => {
      const t = await api.get(`/api/tasks/${taskId}`);
      return t.status === 'running' ? t : null;
    }, { timeout: 8000, interval: 100 });

    // 一次 session/event 都不发：模拟成员会话根本没启动
    await waitFor('超时后任务被交回（不再卡 running）', async () => {
      const t = await api.get(`/api/tasks/${taskId}`);
      return t.status !== 'running' ? t : null;
    }, { timeout: 8000, interval: 100 });

    const events = (await api.get(`/api/events/history?team=${team.id}&limit=200`)).items;
    const retry = events.find((e) => e.action === 'task.retry' && e.taskId === taskId);
    assert(retry, '事件流里有 task.retry');
    assert(String(retry.meta?.error || '').includes('没有任何活动'), `重试原因写清「会话没有活动」，实际：${retry.meta?.error}`);

    // 交回后保底泵会再派一次；此时会话发一个事件，长回合不该被误杀
    await waitFor('任务被重新派发（attempts=2）', async () => {
      const t = await api.get(`/api/tasks/${taskId}`);
      return t.status === 'running' && t.attempts >= 2 ? t : null;
    }, { timeout: 8000, interval: 50 });
    ctx.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 1 } });
    await sleep(1200); // 远超 0.7s 的监视阈值
    assert.equal((await api.get(`/api/tasks/${taskId}`)).status, 'running', '有活动后监视撤销，任务不被误杀');

    console.log('PASS plugin-watchdog — 无活动的派发会被交回重试；有活动则撤销监视');
  } finally {
    await sidecar.close();
  }
};

main().catch((e) => { console.error('FAIL plugin-watchdog —', e?.stack || e); process.exitCode = 1; });

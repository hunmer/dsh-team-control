// tests/plugin-interrupt-notify.mjs — 成员意外中断必须主动通知挂起的 Lead
// 场景：任务已投给成员并 running，sidecar 进程重启 → 启动时 recover 把成员置 interrupted、
//       任务退回调度池。此前任何地方都不会给 Lead 发消息（现场 task_mwgbawyif5cuwf）。
// 期望：插件泵看到 interrupted 后把中断说明推给 Lead 会话；同一个中断不重复打扰。
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  // sessionId → 成员 Agent（真实宿主里 sendMessage 要求 sender 是精确的活跃 Agent）
  const memberAgents = new Map();
  const subagents = {
    spawned: [], messages: [], interrupts: [],
    async startActivation(spec) {
      subagents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: `msg-${subagents.spawned.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage(caller, targetId, content) {
      const text = (Array.isArray(content) ? content : []).map((b) => (b && b.type === 'text' ? b.text : '')).join('');
      subagents.messages.push({ caller, target: String(targetId), content: text });
      return `msg-${subagents.messages.length}`;
    },
    interrupt(targetId, authority) { subagents.interrupts.push({ targetId, authority }); },
    list: () => ['spawn', 'fork'],
  };
  const ctx = {
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents: subagents,
    handlers,
    get: (name) => {
      if (name === 'subagents') return subagents;
      if (name === 'agents') return { get: (id) => memberAgents.get(String(id)) };
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
  return { ctx, subagents, memberAgents };
};

const main = async () => {
  const tmp = mkTmp('dsh-team-interrupt-notify');
  let sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  const port = sidecar.port;
  try {
    const { ctx, subagents, memberAgents } = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, autoStart: false, reportToolCalls: false,
      agentDispatchMs: 300, agentIdleSettleMs: 200,
      forceStopPollMs: 200,             // 中断探测频率（默认 1000ms）
    });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    const lead = { agent: { id: 'sess-lead' } };

    const team = (await tool('team_create').execute({ name: 'notify', workspace: tmp.ws, runtime: 'agent', maxAttempts: 2 }, lead)).team;
    const spawned = await tool('team_spawn').execute(
      { teamId: team.id, name: 'alice', role: 'writer', prompt: '你是 alice。' }, lead,
    );
    const sessionId = String(spawned.member.agentSessionId);
    assert(sessionId, '成员绑定会话');
    memberAgents.set(sessionId, { id: sessionId });

    const created = await tool('team_task').execute({ teamId: team.id, subject: '写一段话', plan: [] }, lead);
    const taskId = created.task?.id || created.taskId;
    assert(taskId, '任务已创建');
    await waitFor('任务被派发（running）', async () => {
      const t = await sidecar.api.get(`/api/tasks/${taskId}`);
      return t.status === 'running' ? t : null;
    }, { timeout: 8000, interval: 100 });

    // 模拟 sidecar 进程重启：同一 dataDir、同一端口；启动时 recover 把在途成员置 interrupted。
    await sidecar.close();
    await sleep(200);
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws, port });

    const leadNotes = () => subagents.messages.filter(
      (m) => String(m.target) === 'sess-lead' && m.content.includes('成员中断'),
    );
    const note = await waitFor('Lead 收到成员中断通知', () => leadNotes()[0] || null, { timeout: 15000, interval: 100 });
    assert(note.content.includes(`teamId=${team.id}`), `通知带 teamId，实际：${note.content}`);
    assert(note.content.includes(`memberId=${spawned.member.id}`), `通知带 memberId，实际：${note.content}`);
    assert(note.content.includes('recover'), `通知写清中断原因（recover），实际：${note.content}`);
    assert(String(note.caller?.id) === sessionId, '通知由成员 Agent 发出（sender 是成员会话）');

    // 同一个中断只通知一次（不断轮询不应该刷屏）
    const before = leadNotes().length;
    await sleep(1200);
    assert.equal(leadNotes().length, before, '同一个中断不重复通知');

    // 另一条中断路径：成员回合以 error 结束（模型路由报错/上游超时）也要通知 Lead
    const team2 = (await tool('team_create').execute({ name: 'notify2', workspace: tmp.ws, runtime: 'agent' }, lead)).team;
    const spawned2 = await tool('team_spawn').execute(
      { teamId: team2.id, name: 'bob', role: 'writer', prompt: '你是 bob。' }, lead,
    );
    const sessionId2 = String(spawned2.member.agentSessionId);
    memberAgents.set(sessionId2, { id: sessionId2 });
    ctx.emit('session/event', { id: sessionId2 }, {
      type: 'turn/end', seq: 7, data: { reason: { kind: 'error', error: { message: 'boom' } } },
    });
    await waitFor('Lead 收到回合失败通知', () => subagents.messages.find(
      (m) => String(m.target) === 'sess-lead' && m.content.includes('模型回合失败：boom'),
    ) || null, { timeout: 8000, interval: 100 });

    console.log('PASS plugin-interrupt-notify — recover 与回合失败两类成员中断都会通知 Lead，且不重复打扰');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((e) => { console.error('FAIL plugin-interrupt-notify —', e?.stack || e); process.exitCode = 1; });

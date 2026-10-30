// tests/plugin-agent.mjs — Host 插件的 agent 成员闭环（不依赖运行中的 DSH：假 ctx + 真 sidecar）。
// 覆盖：① team_create(runtime=agent) 透传 runtime ② team_spawn 调 subagents.startActivation 并把 sessionId 注册回 sidecar
//       ③ team_task 自动 dispatch → sendMessage 收到任务简报（含 taskId 与 team_report_task 指引）
//       ④ 成员 team_report_task(done) → 任务 done、成员回 idle
//       ⑤ 归属校验：别的 session 回报被拒
//       ⑥ agent/status=idle 兜底收尾在途任务，并继续派发下一波
//       ⑦ team_control interrupt 调 subagents.interrupt
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

// 成员会话里内置 todo_write 的清单（content/status 是 DSH 的格式）
const TODOS = [
  { content: '读大纲', status: 'completed' },
  { content: '写评语', status: 'in_progress' },
  { content: '改错字', status: 'pending' },
];

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const agents = {
    spawned: [],
    messages: [],
    interrupts: [],
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
      // 成员用内置 todo_write 时，插件从这里读它的清单并镜像成 sidecar 计划
      if (name === 'sessionProjections') return { stateOf: (_session, key) => (key === 'todos' ? TODOS : null) };
      return undefined;
    },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    /** 一个事件可以有多个监听器（如 agent/status 同时被状态回写与上下文快照监听）。 */
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
  };
  return ctx;
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-agent');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const ctx = mkFakeCtx();
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: false, agentDispatchMs: 600, agentIdleSettleMs: 1200 });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    const lead = { agent: { id: 'sess-lead' } };
    let asAlice = null;

    // ① 建 agent 团队
    const created = await tool('team_create').execute({ name: 'plugin-agent', workspace: tmp.ws, runtime: 'agent' }, lead);
    const team = created.team;
    assert.equal(team.runtime, 'agent', 'team_create 透传 runtime=agent');

    // ② spawn：真调 subagents.startActivation（continuable 子会话）+ 注册回 sidecar
    const spawned = await tool('team_spawn').execute(
      { teamId: team.id, name: 'alice', role: 'encoder', prompt: '你是 alice，负责实现 FS02。' }, lead,
    );
    const sessionId = spawned.member.agentSessionId;
    assert.equal(ctx.agents.spawned.length, 1, 'startActivation 被调用一次');
    const spec = ctx.agents.spawned[0].req;
    assert.equal(spec.provider, 'spawn', '默认 fresh 走 spawn provider');
    assert.equal(spec.delivery, 'parent', '结果投递回 Lead');
    assert.equal(spec.request.parent, lead.agent, '父会话就是调用工具的 Lead');
    assert.equal(spec.childId, sessionId, '子会话 id 由插件预留并注册回 sidecar');
    assert.match(sessionId, /^[0-9a-f-]{36}$/, `sessionId 是随机 UUID，实际 ${sessionId}`);
    assert.equal(spec.request.prompt[0].text.includes('alice'), true, 'prompt 作为初始指令传给成员');
    assert.equal(typeof spec.request.cwd, 'string', '成员 cwd 落在团队工作目录');
    assert.equal(spec.request.cwd, team.workspace, 'cwd 就是 team.workspace');
    assert.equal(spawned.agent.sessionId, sessionId, '返回 agent 诊断信息');
    asAlice = { agent: { id: sessionId } };

    // ③ 建任务 → 自动 dispatch → sendMessage 简报
    const t1 = await tool('team_task').execute({ teamId: team.id, subject: '实现 FS02 编码器' }, lead);
    const t1Status = (await api.get(`/api/tasks/${t1.task.id}`)).status;
    assert.equal(t1Status, 'running', '任务被原子认领');
    await waitFor('任务简报送达', async () => (ctx.agents.messages.length ? true : null), 3000);
    const brief = ctx.agents.messages[0];
    assert.equal(brief.target, sessionId, '消息按成员 session id 投递');
    const text = brief.content[0].text;
    assert(text.includes(`taskId=${t1.task.id}`), '简报带 taskId');
    assert(text.includes('team_report_task'), '简报教成员怎么回报');
    assert(text.includes(team.id), '简报带 teamId');
    // ③b 简报同时落成一条 Lead→成员消息并回填「送达」：面板【消息与回执】靠它和收工回复配对
    const briefMsg = await waitFor('简报落信箱并标记送达', async () => {
      const rows = await api.get(`/api/messages?team=${team.id}`);
      return (rows.items || []).find((m) => m.from === 'lead' && m.to === spawned.member.id && m.status === 'delivered') || null;
    }, 5000);
    assert.match(String(briefMsg.payload?.text || ''), new RegExp(t1.task.id), '简报正文带 taskId');
    assert(Number.isFinite(Date.parse(briefMsg.deliveredAt)), '送达回执带 deliveredAt');
    // t2 先建好但不派发：t1 回报 done 触发的那一轮派发应把它投给刚空出来的成员
    const t2 = await tool('team_task').execute({ teamId: team.id, subject: '写验收用例', dispatch: false }, lead);

    // ④ 成员回报 done
    const rep = await tool('team_report_task').execute(
      { teamId: team.id, taskId: t1.task.id, status: 'done', summary: 'FS02 已实现，见 src/fs02.mjs' }, asAlice,
    );
    assert.equal(rep.status, 'done', '回报后任务 done');
    const afterDone = await api.get(`/api/status?team=${team.id}`);
    assert.equal(afterDone.members[0].status, 'idle', '成员回 idle');

    // ⑤ 归属校验：别的 session 不能替 alice 回报
    // t1 完成后成员回 idle，插件会自动接着派下一波（无需手动 team_dispatch）
    const t2row = await waitFor('t2 被自动派发', async () => {
      const row = await api.get(`/api/tasks/${t2.task.id}`);
      return row.status === 'running' && row.assignee ? row : null;
    }, 8000);
    assert.equal(t2row.assignee, spawned.member.id, '仍是同一个 agent 成员接手');
    // 成员 team_report_task 触发的第二轮派发，发信人必须仍是 Lead 句柄（成员调用不得覆盖它）
    assert.equal(ctx.agents.messages.at(-1).caller, lead.agent, '第二轮派发由 Lead 句柄发出');
    const mallory = await tool('team_report_task').execute(
      { teamId: team.id, taskId: t2.task.id, status: 'done', summary: '偷写' }, { agent: { id: 'sess-mallory' } },
    );
    assert.equal(mallory.ok, false, '未知 session 的回报被拒');
    assert.equal(mallory.reason, 'unknown_session', '拒绝原因可解释');
    assert.equal((await api.get(`/api/tasks/${t2.task.id}`)).status, 'running', '任务没有被别人改掉');
    let smuggled = null;
    try {
      await api.post(`/api/members/${spawned.member.id}/agent-status`, { sessionId: 'sess-mallory', status: 'idle' });
    } catch (e) { smuggled = e; }
    assert(smuggled && smuggled.status === 400, `直连成员接口也校验归属，实际 ${smuggled && smuggled.status}`);

    // ⑤b 成员没建 plan、改用内置 todo_write ⇒ 插件把 todos 投影镜像成 sidecar 计划
    ctx.emit(
      'tools/execute',
      { agent: { id: sessionId }, name: 'todo_write', arguments: { todos: TODOS } },
      async () => ({ value: 'todos written' }),
    );
    const mirrored = await waitFor('todo_write 镜像成计划', async () => {
      const rows = await api.get(`/api/todos?team=${team.id}&task=${t2.task.id}&member=${spawned.member.id}`);
      return rows.items.length === 3 ? rows.items : null;
    }, 8000);
    assert.deepEqual(mirrored.map((i) => i.title), ['读大纲', '写评语', '改错字'], '计划标题来自 todo');
    assert.deepEqual(mirrored.map((i) => i.status), ['done', 'active', 'open'], 'todo 状态映射成计划状态');

    // ⑥ agent/status=idle：维护期的短暂 idle 不立刻收尾（防止把在途任务误判 done），
    //   过了稳定窗口才兜底收尾，并继续派发下一波
    assert.equal((ctx.handlers.get('agent/status') || []).length >= 1, true, '监听 agent/status');
    // 成员这一轮的助手正文先攒着，收工时落库成 member→lead 的回复消息
    ctx.emit(
      'session/event',
      { id: sessionId },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'FS02 已经实现，测试通过。' }] } } },
    );
    ctx.emit('agent/status', { agent: { id: sessionId }, status: 'idle' });
    await sleep(200);
    assert.equal(
      (await api.get(`/api/tasks/${t2.task.id}`)).status, 'running',
      '短暂 idle（维护期）不会把在途任务判完成',
    );
    const done2 = await waitFor('idle 兜底收尾', async () => {
      const s = (await api.get(`/api/tasks/${t2.task.id}`)).status;
      return s === 'done' ? s : null;
    }, { timeout: 20000 });
    assert.equal(done2, 'done', 'agent/status idle 把在途任务收尾');

    // ⑥b 收工时把成员这一轮的助手正文落库成 member→lead 的回复（面板才能配对成双向箭头）
    const reply = await waitFor('成员回复落库', async () => {
      const rows = await api.get(`/api/messages?team=${team.id}`);
      return (rows.items || []).find((m) => m.from === spawned.member.id && m.to === 'lead' && m.kind === 'response') || null;
    }, 8000);
    assert.match(String(reply.payload?.text || ''), /FS02 已经实现/, '回复正文来自成员最后一条助手消息');

    // ⑦ interrupt 走 subagents.interrupt（先把成员跑起来，idle 没得中断）
    const t3 = await tool('team_task').execute({ teamId: team.id, subject: '补一版文档', dispatch: false }, lead);
    await waitFor('t3 自动派发', async () => (
      (await api.get(`/api/tasks/${t3.task.id}`)).status === 'running' ? true : null
    ), 8000);
    const ctl = await tool('team_control').execute(
      { action: 'interrupt', teamId: team.id, memberId: spawned.member.id, reason: '换个方向' }, lead,
    );
    assert.equal(ctx.agents.interrupts.length, 1, 'interrupt 调了 subagents.interrupt');
    assert.equal(ctx.agents.interrupts[0].targetId, sessionId, '中断的目标是成员 session');
    assert.equal(ctx.agents.interrupts[0].authority.kind, 'ancestor', '以 Lead 作为祖先授权');
    assert.equal(ctl.member.status, 'interrupted', '成员同步置 interrupted');
    assert.equal((await api.get(`/api/tasks/${t3.task.id}`)).status, 'ready', '在途任务回到 ready 等下次派发');

    // ⑧ worker 团队仍然走 sidecar 成员（不被 agent 路径影响）
    const wTeam = (await tool('team_create').execute({ name: 'plugin-worker', workspace: tmp.ws }, lead)).team;
    assert.equal(wTeam.runtime, 'worker', '默认 runtime=worker');
    const wMem = await tool('team_spawn').execute({ teamId: wTeam.id, name: 'bob' }, lead);
    assert.equal(wMem.member.agentSessionId, null, 'worker 成员没有 agent session');
    assert.equal(wMem.agent, undefined, 'worker 团队不返回 agent 信息');
    assert.equal(ctx.agents.spawned.length, 1, 'worker 成员的 team_spawn 不调 subagents.startActivation');

    console.log('PASS plugin-agent — agent 成员闭环：spawn/register/dispatch 简报/report/归属校验/idle 兜底/interrupt；worker 团队回归');
    process.exitCode = 0;
  } finally {
    try { await sidecar.close(); } catch { /* ignore */ }
    tmp.cleanup();
  }
};

main().catch((err) => { console.error('FAIL plugin-agent —', err); process.exitCode = 1; });

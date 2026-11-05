// tests/plugin-agent.mjs — Host 插件的 agent 成员闭环（不依赖运行中的 DSH：假 ctx + 真 sidecar）。
// 覆盖：① team_create 透传 permissionPreset ② team_spawn 调 subagents.startActivation、设置权限预设并把 sessionId 注册回 sidecar
//       ③ team_task 自动 dispatch → sendMessage 收到任务简报（含 taskId 与 team_report_task 指引）
//       ④ 成员 team_report_task(done) → 任务 done、成员回 idle
//       ⑤ 归属校验：别的 session 回报被拒
//       ⑥ agent/status=idle 兜底收尾在途任务，并继续派发下一波
//       ⑦ team_control interrupt 调 subagents.interrupt
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    drains: [],
    async startActivation(spec) {
      agents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: `msg-${agents.spawned.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage(caller, targetId, content) { agents.messages.push({ caller, target: targetId, content }); return `msg-${agents.messages.length}`; },
    interrupt(targetId, authority) { agents.interrupts.push({ targetId, authority }); },
    async drainChildren(parent, childIds) { agents.drains.push({ parent, childIds }); return { drained: childIds.length }; },
    list: () => ['spawn', 'fork'],
  };
  const presetDefs = new Map([['standard', { id: 'standard' }], ['reviewer', { id: 'reviewer' }]]);
  const agentPresets = {
    async list() { return [...presetDefs.values()].map((d) => ({ id: d.id })); },
    async register(definition) {
      if (presetDefs.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      presetDefs.set(definition.id, definition);
      return async () => { presetDefs.delete(definition.id); };
    },
  };
  const presets = {
    applied: [],
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    set(session, name) { presets.applied.push({ session: session?.id, name }); },
  };
  const ctx = {
    presets,
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents,
    handlers,
    get: (name) => {
      if (name === 'subagents') return agents;
      if (name === 'sessions') return { get: (id) => ({ id }) };
      if (name === 'permissionPresets') return presets;
      if (name === 'agentPresets') return agentPresets;
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
    const presetDir = path.join(tmp.dataDir, 'presets');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'boot-preset.json'), JSON.stringify({ id: 'boot-preset', plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }] }));
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: false, agentDispatchMs: 600, agentIdleSettleMs: 1200, presetDir });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    const lead = { agent: { id: 'sess-lead' } };
    let asAlice = null;

    // ① 建 agent 团队
    const created = await tool('team_create').execute({ name: 'plugin-agent', workspace: tmp.ws, agentPreset: 'standard' }, lead);
    const team = created.team;
    assert.equal(team.permissionPreset, 'workspace-write', 'team_create 默认 workspace-write');
    assert.equal(team.agentPreset, 'standard', 'team_create 透传 agentPreset');

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
    assert.equal(spawned.permissionPreset, 'workspace-write', 'spawn 继承团队预设');
    assert.equal(spawned.permissionPresetApplied, true, '预设已落到子会话');
    assert.deepEqual(ctx.presets.applied.at(-1), { session: sessionId, name: 'workspace-write' }, 'permissionPresets.set 被调用');
    assert.equal(spec.request.agentPreset, 'standard', '成员继承团队的 agentPreset');
    assert.equal(spawned.agentPreset, 'standard', '返回值回显 agentPreset');
    asAlice = { agent: { id: sessionId } };

    // ②b agentPreset 校验：未知 id 报错；fork 继承父组装，传了只警告不生效
    await assert.rejects(
      () => tool('team_spawn').execute({ teamId: team.id, name: 'ghost', prompt: 'x', agentPreset: 'nope' }, lead),
      /agentPreset「nope」不存在/,
      '未知 agentPreset 被拒绝',
    );
    const forked = await tool('team_spawn').execute(
      { teamId: team.id, name: 'bob-fork', prompt: '你是 bob。', contextMode: 'fork', agentPreset: 'reviewer' }, lead,
    );
    assert.equal(ctx.agents.spawned.at(-1).req.request.agentPreset, undefined, 'fork 不传 agentPreset');
    assert.match(String(forked.agentPresetWarning || ''), /fork/, 'fork 时给出警告');

    // ②c Leader 自建 agentPreset：写固定目录 + 立刻注册；内置同名不可覆盖
    const listed0 = await tool('team_preset').execute({ action: 'list' }, lead);
    assert.equal(listed0.dir, path.join(tmp.dataDir, 'presets'), '预设目录来自配置');
    assert(listed0.presets.some((p) => p.id === 'standard' && p.source === 'host'), '列出宿主预设');
    assert(listed0.presets.some((p) => p.id === 'boot-preset' && p.source === 'team'), '插件启动时加载目录里的预设');
    const saved = await tool('team_preset').execute({
      action: 'save', id: 'strict-reviewer', name: '严格审阅',
      plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }, { name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a strict reviewer.' } }],
    }, lead);
    assert.equal(saved.registered, true, '自建预设立刻注册');
    assert.equal(saved.file, path.join(tmp.dataDir, 'presets', 'strict-reviewer.json'), '写入固定目录');
    const listed1 = await tool('team_preset').execute({ action: 'list' }, lead);
    assert(listed1.presets.some((p) => p.id === 'strict-reviewer' && p.source === 'team'), 'list 标出 team 来源');
    const shown = await tool('team_preset').execute({ action: 'show', id: 'strict-reviewer' }, lead);
    assert.equal(shown.doc.plugins.length, 2, 'show 读回文档');
    await assert.rejects(
      () => tool('team_preset').execute({ action: 'save', id: 'strict-reviewer', plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }] }, lead),
      /覆盖请传 confirm:true/,
      '覆盖同名团队预设需显式 confirm',
    );
    const overwritten = await tool('team_preset').execute({
      action: 'save', id: 'strict-reviewer', description: 'v2', confirm: true,
      plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }],
    }, lead);
    assert.equal(overwritten.registered, true, 'confirm 后可覆盖');
    const custom = await tool('team_spawn').execute({ teamId: team.id, name: 'carol', prompt: '你是 carol。', agentPreset: 'strict-reviewer' }, lead);
    assert.equal(custom.agentPreset, 'strict-reviewer', '自建预设可派发');
    await assert.rejects(
      () => tool('team_preset').execute({ action: 'save', id: 'standard', plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }] }, lead),
      /已由宿主定义/,
      '内置同名预设不可覆盖',
    );
    const temp = await tool('team_preset').execute({ action: 'save', id: 'temp-preset', plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }] }, lead);
    const removed = await tool('team_preset').execute({ action: 'delete', id: 'temp-preset' }, lead);
    assert.equal(removed.removed, true, '自建预设可删除');
    assert.equal(fs.existsSync(temp.file), false, '删除会移除文件');
    const afterDelete = await tool('team_preset').execute({ action: 'list' }, lead);
    assert(!afterDelete.presets.some((p) => p.id === 'temp-preset'), '删除后 list 不再出现');
    await assert.rejects(
      () => tool('team_preset').execute({ action: 'delete', id: 'standard' }, lead),
      /只有团队自建预设可以删除/,
      '内置预设不可删除',
    );
    const synced = await (await fetch(sidecar.url + '/api/presets')).json();
    assert(synced.items.some((p) => p.id === 'strict-reviewer' && p.source === 'team'), '目录同步到 sidecar');
    const syncedDoc = await (await fetch(sidecar.url + '/api/presets/strict-reviewer')).json();
    assert.equal(syncedDoc.doc.plugins.length, 1, '镜像带组合文档（覆盖后 1 个插件）');

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
    assert.equal((await api.get(`/api/tasks/${t3.task.id}`)).status, 'paused', '在途任务转 paused，等 Lead 处置');
    assert.equal((await api.get(`/api/tasks/${t3.task.id}`)).attempts, 1, 'interrupt 不消耗 attempt');

    // ⑦b interrupt 后 DSH 中断自身会再报一次 idle；冻结中的会话不得把成员改回 idle 触发重派
    ctx.emit('agent/status', { agent: { id: sessionId }, status: 'idle' });
    await sleep(400);
    assert.equal((await api.get(`/api/status?member=${spawned.member.id}`)).members[0].status, 'interrupted', 'interrupt 后的 idle 回报不得解冻成员');
    assert.equal((await api.get(`/api/tasks/${t3.task.id}`)).status, 'paused', 'interrupt 后仍保持 paused，不自动重派');

    // ⑦c abort 只需 taskId，把 paused 任务永久作废
    const aborted = await tool('team_control').execute(
      { action: 'abort', teamId: team.id, taskId: t3.task.id, reason: 'lead 决定不做' }, lead,
    );
    assert.equal(aborted.task.status, 'aborted', 'abort 把 paused 任务置为 aborted');
    assert.equal(aborted.wasRunning, false, 'paused 任务 abort 时不在运行');
    assert.equal((await api.get(`/api/tasks/${t3.task.id}`)).status, 'aborted', 'abort 结果已落库');

    // ⑦d team_member update：换模型/上下文会重建会话，旧会话被 drain
    const oldSession = spawned.member.agentSessionId;
    const restarted = await tool('team_member').execute({
      action: 'update', teamId: team.id, memberId: spawned.member.id,
      model: 'next-model', agentProvider: 'next-provider', contextMode: 'fresh', reasoningEffort: 'high',
    }, lead);
    assert.equal(restarted.restarted, true, '模型/上下文变更触发会话重建');
    assert.notEqual(restarted.member.agentSessionId, oldSession, '重建后 agentSessionId 更新');
    assert.equal(restarted.member.model, 'next-model', '新模型已落库');
    assert.equal(restarted.member.agentProvider, 'next-provider', '新 provider 已落库');
    assert.equal(restarted.member.contextMode, 'fresh', '新上下文模式已落库');
    assert.equal(restarted.member.reasoningEffort, 'high', '新思考强度已落库');
    assert.equal(restarted.member.status, 'idle', '重建后的成员等待派发');
    const newSession = restarted.member.agentSessionId;
    const rebuiltSpec = ctx.agents.spawned.at(-1).req;
    assert.equal(rebuiltSpec.childId, newSession, 'startActivation 使用新 session');
    assert.equal(rebuiltSpec.request.agentOptions.provider, 'next-provider', '新 provider 传给子会话');
    assert.equal(rebuiltSpec.request.agentOptions.model, 'next-model', '新 model 传给子会话');
    assert.equal(rebuiltSpec.request.agentOptions.reasoningEffort, 'high', '新 effort 传给子会话');
    assert(ctx.agents.drains.some((d) => d.childIds.includes(oldSession)), '旧会话被 drainChildren 释放');

    // 只改 role 不重建会话
    const spawnedBeforeRole = ctx.agents.spawned.length;
    const roleUpdated = await tool('team_member').execute(
      { action: 'update', teamId: team.id, memberId: spawned.member.id, role: 'reviewer' }, lead,
    );
    assert.equal(roleUpdated.restarted, false, '只改 role 不重建会话');
    assert.equal(ctx.agents.spawned.length, spawnedBeforeRole, '没有新增子会话');
    assert.equal(roleUpdated.member.role, 'reviewer', 'role 已更新');

    // ⑦e team_member retire / remove：释放子会话，remove 必须 confirm
    const retired = await tool('team_member').execute(
      { action: 'retire', teamId: team.id, memberId: custom.member.id }, lead,
    );
    assert.equal(retired.status, 'retired', 'retire 保留成员行并置 retired');
    assert(ctx.agents.drains.some((d) => d.childIds.includes(custom.member.agentSessionId)), 'retire 释放子会话');
    await assert.rejects(
      () => tool('team_member').execute({ action: 'update', teamId: team.id, memberId: custom.member.id, role: 'x' }, lead),
      /retired/,
      'retired 成员不能再 update 复活',
    );

    // ⑧ 第二个团队自定义预设：spawn 继承并可被成员覆盖
    const t2Team = (await tool('team_create').execute({ name: 'plugin-readonly', workspace: tmp.ws, permissionPreset: 'read-only' }, lead)).team;
    assert.equal(t2Team.permissionPreset, 'read-only', 'team_create 透传 permissionPreset');
    const bob = await tool('team_spawn').execute({ teamId: t2Team.id, name: 'bob', prompt: '你是 bob，只读。' }, lead);
    assert.equal(bob.member.permissionPreset, 'read-only', '成员继承团队 read-only 预设');
    assert.equal(bob.permissionPreset, 'read-only', '返回实际生效预设');

    await assert.rejects(
      () => tool('team_member').execute({ action: 'remove', teamId: t2Team.id, memberId: bob.member.id }, lead),
      /confirm:true/,
      'remove 必须显式 confirm',
    );
    const removedBob = await tool('team_member').execute(
      { action: 'remove', teamId: t2Team.id, memberId: bob.member.id, confirm: true }, lead,
    );
    assert.equal(removedBob.removed, true, 'remove 删除成员行');
    assert(ctx.agents.drains.some((d) => d.childIds.includes(bob.member.agentSessionId)), 'remove 释放子会话');
    await assert.rejects(() => api.get(`/api/members/${bob.member.id}`), (err) => err.status === 404, '删除后成员 404');

    console.log('PASS plugin-agent — agent 成员闭环：preset/权限预设落会话/spawn/register/dispatch 简报/report/归属校验/idle 兜底/interrupt');
    process.exitCode = 0;
  } finally {
    try { await sidecar.close(); } catch { /* ignore */ }
    tmp.cleanup();
  }
};

main().catch((err) => { console.error('FAIL plugin-agent —', err); process.exitCode = 1; });

// tests/plugin-board-flags.mjs — 看板任务开关：needPlan=false 直接执行、useTeam=false 用单人提示词
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const created = [];
  const permissions = [];
  const mounted = [];
  const agents = {
    created,
    async create(options) {
      const rec = { options, followups: [], disposed: false };
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId },
        followup(message) { rec.followups.push(message); },
      };
      rec.agent = agent;
      created.push(rec);
      if (typeof options.setup === 'function') await options.setup({});
      return { agent, dispose: async () => { rec.disposed = true; } };
    },
    get(id) { return created.find((r) => r.agent.id === id)?.agent; },
    list: () => [],
  };
  const agentPresets = {
    defaultId: 'standard',
    async list() { return []; },
    async resolve(id) { return { id }; },
    async mount(_ctx, id) { mounted.push(id); },
    async register() { return () => {}; },
  };
  const presets = {
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    set(session, name) { permissions.push({ sessionId: session?.id, name }); },
  };
  const ctx = {
    tools: {
      register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      get: (name) => registry.get(name),
    },
    agents,
    handlers,
    get(name) {
      if (name === 'subagents') return agents;
      if (name === 'agents') return agents;
      if (name === 'permissionPresets') return presets;
      if (name === 'agentPresets') return agentPresets;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'default-m', reasoningEffort: 'high' }) };
      if (name === 'sessions') return { get: (id) => ({ id }) };
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
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
  return { ctx, created, permissions, mounted };
};

const text = (rec, i = 0) => rec.followups[i]?.content?.[0]?.text || '';

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-board-flags');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-bf', title: 'BF', path: tmp.ws }] });
    const { ctx, created } = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, home: tmp.dataDir, autoStart: false,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false,
      reportContext: false, reportWorkspaces: false, reportLlmCatalog: false,
      agentAutoDispatch: false, boardDispatchMs: 200, boardIdleGraceMs: 800,
    });

    const statusTool = ctx.tools.get('board_task_status');
    const planTool = ctx.tools.get('board_plan_submit');

    // 1) needPlan=false：不建规划会话，直接进入执行，prompt 不含规划/团队内容
    const solo = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: '免规划任务', description: '直接干', auto: true,
      needPlan: false, useTeam: false, executionMode: 'same',
    });
    const soloRec = await waitFor('no-plan session', () => created[0]?.followups?.length ? created[0] : null);
    const soloText = text(soloRec);
    assert.match(soloText, /执行 Agent/, '免规划任务直接投执行 prompt');
    assert.match(soloText, /不需要规划/, 'prompt 明确不需要规划');
    assert.match(soloText, /不开启团队/, 'prompt 说明不开启团队');
    assert.doesNotMatch(soloText, /规划 Agent/, '不出现规划角色');
    assert.doesNotMatch(soloText, /dsh-agent-team/, '单人执行不要求加载团队技能');
    assert.doesNotMatch(soloText, /已确认的计划/, '没有规划摘要可注入');
    assert.equal((await api.get(`/api/board/tasks/${solo.id}`)).status, 'inprogress', '直接进入 inprogress');
    assert.equal(created.length, 1, '免规划任务只建一个会话');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: soloRec.agent.id } });

    // 2) needPlan=true + useTeam=false：规划单人化；同会话执行不重复计划内容
    const soloPlan = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: '免团队规划', description: '描述X', auto: true,
      needPlan: true, useTeam: false, executionMode: 'same',
    });
    const planRec = await waitFor('solo planning session', () => created[1]?.followups?.length ? created[1] : null);
    const planText = text(planRec);
    assert.match(planText, /规划 Agent/, '仍然先规划');
    assert.match(planText, /不开启团队/, '规划 prompt 说明不开启团队');
    assert.doesNotMatch(planText, /dsh-agent-team/, '不要求加载团队技能');
    assert.doesNotMatch(planText, /团队与成员建议/, '不要求成员建议');
    assert.doesNotMatch(planText, /可用模型/, '不需要模型白名单');
    assert.equal((await api.get(`/api/board/tasks/${soloPlan.id}`)).status, 'planning', '进入 planning');

    await planTool.execute({ plan: 'PLAN_SOLO_MARKER', summary: '一句话' }, { agent: { id: planRec.agent.id } });
    await waitFor('solo same-session execution', () => planRec.followups.length >= 2);
    const soloExec = text(planRec, 1);
    assert.match(soloExec, /现在开始执行/, '同会话只发开始执行');
    assert.doesNotMatch(soloExec, /PLAN_SOLO_MARKER/, '同会话执行不重复注入计划');
    assert.doesNotMatch(soloExec, /描述X/, '同会话执行不重复注入任务描述');
    assert.doesNotMatch(soloExec, /dsh-agent-team/, '单人执行不要求加载团队技能');
    assert.match(soloExec, /board_task_status/, '保留收尾状态规则');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: planRec.agent.id } });

    // 3) 默认（needPlan/useTeam 都为 true）：规划走团队技能；同会话执行仍不重复计划
    const teamTask = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: '团队任务', auto: true, executionMode: 'same',
    });
    const teamPlanRec = await waitFor('team planning session', () => created[2]?.followups?.length ? created[2] : null);
    assert.match(text(teamPlanRec), /dsh-agent-team/, '默认规划要求加载团队技能');
    await planTool.execute({ plan: 'PLAN_TEAM_MARKER', summary: '一句话' }, { agent: { id: teamPlanRec.agent.id } });
    await waitFor('team same-session execution', () => teamPlanRec.followups.length >= 2);
    const teamExec = text(teamPlanRec, 1);
    assert.match(teamExec, /现在开始执行/, '同会话只发开始执行');
    assert.doesNotMatch(teamExec, /PLAN_TEAM_MARKER/, '同会话不再发送计划摘要');
    assert.match(teamExec, /dsh-agent-team/, '团队执行仍要求加载技能');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: teamPlanRec.agent.id } });

    // 4) 新会话执行：默认团队任务把计划注入新会话；useTeam=false 的新会话用单人规则
    const newTeam = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: '新会话团队', auto: true, executionMode: 'new',
    });
    const newPlanRec = await waitFor('new team planning', () => created[3]?.followups?.length ? created[3] : null);
    await planTool.execute({ plan: 'PLAN_NEW_TEAM', summary: '一句话' }, { agent: { id: newPlanRec.agent.id } });
    const newLeadRec = await waitFor('new team lead', () => created[4]?.followups?.length ? created[4] : null);
    assert.match(text(newLeadRec), /已确认的计划/, '新会话注入计划标题');
    assert.match(text(newLeadRec), /PLAN_NEW_TEAM/, '新会话注入计划正文');
    assert.match(text(newLeadRec), /dsh-agent-team/, '团队任务要求加载技能');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: newLeadRec.agent.id } });

    const newSolo = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: '新会话单人', auto: true, executionMode: 'new',
      needPlan: true, useTeam: false,
    });
    const newSoloPlan = await waitFor('new solo planning', () => created[5]?.followups?.length ? created[5] : null);
    await planTool.execute({ plan: 'PLAN_NEW_SOLO', summary: '一句话' }, { agent: { id: newSoloPlan.agent.id } });
    const newSoloLead = await waitFor('new solo lead', () => created[6]?.followups?.length ? created[6] : null);
    assert.match(text(newSoloLead), /已确认的计划/, '新会话单人执行仍带计划');
    assert.match(text(newSoloLead), /不开启团队/, '新会话单人不开启团队');
    assert.doesNotMatch(text(newSoloLead), /dsh-agent-team/, '新会话单人不加载技能');
    assert.match(text(newSoloLead), /不要调用 team_create/, '新会话单人禁止建队');
    assert.doesNotMatch(text(newSoloLead), /用 team_task 拆解/, '新会话单人不派发团队任务');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: newSoloLead.agent.id } });

    console.log('plugin-board-flags: ok');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });

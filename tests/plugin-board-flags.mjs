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
      const rec = { options, followups: [], steers: [], disposed: false };
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId, seq: 0, eventAt: () => undefined },
        followup(message) { rec.followups.push(message); },
        steer(message) { rec.steers.push(message); },
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
  // prewalk 走 Host 的会话级模型选择：只记录调用，不真正改模型。
  const switches = [];
  const sessionController = {
    agents: {
      selectionFor: () => ({ current: { provider: 'p', model: 'plan-m' } }),
      selectForNextRequest(agent, selection) { switches.push({ sessionId: agent?.id, selection }); },
    },
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
      if (name === 'sessionController') return sessionController;
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
  return { ctx, created, permissions, mounted, switches };
};

const text = (rec, i = 0) => rec.followups[i]?.content?.[0]?.text || '';

// 模拟一次工具执行，依次穿过插件注册的 tools/execute 钩子（prewalk 交接挂在这里）。
const runToolHook = async (ctx, exec, outcome = { isError: false }) => {
  let next = async () => outcome;
  for (const fn of (ctx.handlers.get('tools/execute') || []).slice().reverse()) {
    const prev = next;
    next = () => fn(exec, prev);
  }
  return next();
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-board-flags');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-bf', title: 'BF', path: tmp.ws }] });
    const { ctx, created, permissions, switches } = mkFakeCtx();
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
    assert.equal((await api.get(`/api/board/tasks/${soloPlan.id}`)).status, 'inprogress', '提交计划即进入执行槽位');
    assert.equal(planRec.followups.length, 1, '同会话不再补发执行 prompt');
    assert.match(planText, /board_task_status/, '同会话规划 prompt 自带收尾规则');
    assert.equal(permissions.filter((p) => p.sessionId === planRec.agent.id).at(-1)?.name, 'danger-full-access', '执行切到 danger-full-access');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: planRec.agent.id } });

    // 3) 默认（needPlan/useTeam 都为 true）：规划走团队技能；同会话提交后直接执行
    const teamTask = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: '团队任务', auto: true, executionMode: 'same',
    });
    const teamPlanRec = await waitFor('team planning session', () => created[2]?.followups?.length ? created[2] : null);
    assert.match(text(teamPlanRec), /dsh-agent-team/, '默认规划要求加载团队技能');
    await planTool.execute({ plan: 'PLAN_TEAM_MARKER', summary: '一句话' }, { agent: { id: teamPlanRec.agent.id } });
    assert.equal((await api.get(`/api/board/tasks/${teamTask.id}`)).status, 'inprogress', '团队任务提交计划即进入执行');
    assert.equal(teamPlanRec.followups.length, 1, '团队任务不再补发执行 prompt');
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

    // 5) prewalk（实验性）：提交计划只武装、不切模型；首个 edit 结果之后才交接并注入执行清单
    assert.equal(switches.length, 0, '前面的同会话任务都没开 prewalk，不应切换模型');
    // 未武装的会话即便发生 edit，也不能被切模型
    await runToolHook(ctx, { agent: planRec.agent, name: 'edit', arguments: {} });
    assert.equal(switches.length, 0, '未开启 prewalk 的会话 edit 后仍不切换');
    const prewalkTask = await api.post('/api/board/tasks', {
      workspaceId: 'ws-bf', title: 'prewalk 任务', auto: true, executionMode: 'same',
      needPlan: true, useTeam: false, prewalk: true,
      planRoute: { provider: 'p', model: 'plan-m' },
      leadRoute: { provider: 'p', model: 'exec-m' },
    });
    assert.equal((await api.get(`/api/board/tasks/${prewalkTask.id}`)).prewalk, true, 'prewalk 落库');
    const prewalkPlanRec = await waitFor('prewalk planning', () => (created[7]?.followups?.length ? created[7] : null));
    const prewalkPlan = ['PLAN_PREWALK', '', '- 修改 A 文件的实现', '- 运行相关测试'].join('\n');
    await planTool.execute({ plan: prewalkPlan, summary: '一句话' }, { agent: { id: prewalkPlanRec.agent.id } });
    assert.equal(switches.length, 0, '提交计划时还不切模型（交接不能太早）');
    assert.equal(prewalkPlanRec.steers.length, 0, '提交计划时还不注入继续指令');
    // 失败的 edit 不算「已落到实现」：保持武装、不切模型
    await runToolHook(ctx, { agent: prewalkPlanRec.agent, name: 'edit', arguments: {} }, { isError: true });
    assert.equal(switches.length, 0, '写入失败时不交接');
    assert.equal(prewalkPlanRec.steers.length, 0, '写入失败时不注入继续指令');
    // 第一个成功的 edit 结果 → 交接：切到执行模型 + 注入一条简短的继续指令
    await runToolHook(ctx, { agent: prewalkPlanRec.agent, name: 'edit', arguments: {} });
    const switched = await waitFor('prewalk switch', () => switches.find((x) => x.sessionId === prewalkPlanRec.agent.id) || null);
    assert.equal(switched.selection.provider, 'p', '切换带上 provider');
    assert.equal(switched.selection.model, 'exec-m', '切换目标是执行模型');
    assert.equal(switches.length, 1, '只切一次');
    const checklist = prewalkPlanRec.steers.at(-1)?.content?.[0]?.text || '';
    assert.equal(checklist, '继续', '交接时只注入「继续」');
    assert.equal(created.length, 8, 'prewalk 不新建会话');
    assert.equal(prewalkPlanRec.followups.length, 1, 'prewalk 不补发执行 prompt');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: prewalkPlanRec.agent.id } });

    console.log('plugin-board-flags: ok');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });

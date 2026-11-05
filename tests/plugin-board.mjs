// tests/plugin-board.mjs — 看板 Host 调度：claim 后自动建规划会话、同会话执行、done 后追问翻回
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, startSidecar, waitFor, sleep } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const created = [];
  const permissions = [];
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
      return { agent, dispose: async () => { rec.disposed = true; } };
    },
    get(id) { return created.find((r) => r.agent.id === id)?.agent; },
    list: () => [],
    b: null,
  };
  const agentPresets = {
    async list() { return []; },
    async resolve(id) { return { id }; },
    async mount() {},
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
  return { ctx, created, permissions };
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-board');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-pb', title: 'PB', path: tmp.ws }] });
    const { ctx, created, permissions } = mkFakeCtx();
    apply(ctx, {
      baseUrl: sidecar.url, home: tmp.dataDir, autoStart: false,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false,
      reportContext: false, reportWorkspaces: false, reportLlmCatalog: false,
      agentAutoDispatch: false, boardDispatchMs: 300, boardIdleGraceMs: 800,
    });

    // auto=0：泵不建会话
    const manual = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '手动任务', auto: false, executionMode: 'same',
    });
    await sleep(900);
    assert.equal(created.length, 0, 'auto=0 不自动建会话');

    // same：规划 → 同会话执行
    const task = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '同会话任务', description: '做事', auto: true, executionMode: 'same',
      planRoute: { provider: 'p', model: 'plan-m' },
      leadRoute: { provider: 'p', model: 'lead-m' },
      teamModels: [{ provider: 'p', model: 'm1' }],
    });
    const rec = await waitFor('planning session', () => created[0]?.followups?.length ? created[0] : null);
    assert.equal(rec.options.meta.cwd, tmp.ws, 'cwd 是工作区路径');
    assert.deepEqual(rec.options.agentOptions, { provider: 'p', model: 'plan-m' }, '规划用 planRoute');
    assert.equal(perm(permissions, rec.agent.id), 'read-only', '规划只读');
    assert.match(rec.followups[0].content[0].text, /规划 Agent/, '投了规划 prompt');
    assert.match(rec.followups[0].content[0].text, /dsh-agent-team/, '规划 prompt 要求先加载 dsh-agent-team 技能');
    assert.equal((await api.get(`/api/board/tasks/${task.id}`)).status, 'planning', '任务进入 planning');

    const planTool = ctx.tools.get('board_plan_submit');
    assert(planTool, 'board_plan_submit 已注册');
    await planTool.execute({ plan: '# 计划', summary: '一句话' }, { agent: { id: rec.agent.id } });
    const planned = await api.get(`/api/board/tasks/${task.id}`);
    assert(['planned', 'inprogress'].includes(planned.status), '提交后进入 planned 或被立即 claim');
    assert.equal(planned.leadSessionId, rec.agent.id, 'same 模式 lead 是同一会话');

    await waitFor('same-session execution', () => rec.followups.length >= 2);
    assert.equal(created.length, 1, 'same 模式不新建会话');
    assert.equal(perm(permissions, rec.agent.id), 'danger-full-access', '执行切到 danger-full-access');
    assert.match(rec.followups[1].content[0].text, /现在开始执行/, '投了执行 prompt');
    assert.match(rec.followups[1].content[0].text, /dsh-agent-team/, '执行 prompt 要求先加载 dsh-agent-team 技能');
    assert.equal((await api.get(`/api/board/tasks/${task.id}`)).status, 'inprogress', '任务进入 inprogress');

    const statusTool = ctx.tools.get('board_task_status');
    assert(statusTool, 'board_task_status 已注册');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: rec.agent.id } });
    assert.equal((await api.get(`/api/board/tasks/${task.id}`)).status, 'done', 'Lead 置 done');

    // 用户再次发消息：done -> inprogress
    ctx.emit('session/event', { id: rec.agent.id }, { type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } });
    await waitFor('done -> inprogress', async () => (await api.get(`/api/board/tasks/${task.id}`)).status === 'inprogress');
    await sleep(2500);
    assert.equal(rec.followups.length, 2, '用户追问不重复注入执行 prompt');
    await statusTool.execute({ status: 'done', summary: '完成' }, { agent: { id: rec.agent.id } });

    // new：规划完成后新建 Lead 会话
    const task2 = await api.post('/api/board/tasks', {
      workspaceId: 'ws-pb', title: '新会话任务', auto: true, executionMode: 'new',
    });
    const rec2 = await waitFor('second planning session', () => created[1]?.followups?.length ? created[1] : null);
    assert.notEqual(rec2.agent.id, rec.agent.id, 'new 模式规划会话不同');
    await ctx.tools.get('board_plan_submit').execute({ plan: '# 计划2' }, { agent: { id: rec2.agent.id } });
    const rec3 = await waitFor('new lead session', () => created[2]?.followups?.length ? created[2] : null);
    assert.notEqual(rec3.agent.id, rec2.agent.id, 'new 模式执行会话独立');
    assert.equal(rec3.options.agentOptions?.model, 'default-m', '无 route 时回退到宿主动态模型');
    assert.equal((await api.get(`/api/board/tasks/${task2.id}`)).status, 'inprogress', '新会话任务进入执行');
    await statusTool.execute({ status: 'done', summary: '完成2' }, { agent: { id: rec3.agent.id } });
    ctx.emit('session/event', { id: rec3.agent.id }, { type: 'user/message', data: { content: [{ type: 'text', text: '继续2' }] } });
    await waitFor('new-mode follow-up', async () => (await api.get(`/api/board/tasks/${task2.id}`)).status === 'inprogress');
    await sleep(2500);
    assert.equal(created.length, 3, 'new 模式追问复用已有 Lead 会话');
    assert.equal(rec3.followups.length, 1, 'new 模式追问不再注入执行 prompt');

    // 手动任务 start 后由泵接管
    await api.post(`/api/board/tasks/${manual.id}/start`, {});
    await waitFor('manual start claims', () => created.length >= 4);

    // 重试续跑：已有团队时禁止重复建队，force 才放行
    const teamTool = ctx.tools.get('team_create');
    assert(teamTool, 'team_create 已注册');
    const firstTeam = await teamTool.execute({ name: '续跑团队', workspace: tmp.ws }, { agent: { id: rec3.agent.id } });
    assert(firstTeam.team?.id, '首次建队返回 team');
    const bound = await api.get(`/api/board/tasks/${task2.id}/teams`);
    assert.equal(bound.items.length, 1, '团队自动绑定到任务');
    assert.equal(bound.items[0], firstTeam.team.id, '绑定的是刚创建的团队');

    await statusTool.execute({ status: 'failed', summary: '故意失败' }, { agent: { id: rec3.agent.id } });
    assert.equal((await api.get(`/api/board/tasks/${task2.id}`)).status, 'failed', '任务置 failed');
    await api.post(`/api/board/tasks/${task2.id}/retry`, {});
    const recRetry = await waitFor('retry lead session', () => created.find((r) => {
      const text = r.followups[0]?.content?.[0]?.text || '';
      return text.includes('已关联团队');
    }));
    assert.match(recRetry.followups[0].content[0].text, new RegExp(firstTeam.team.id), '重试 prompt 带上既有团队 id');
    await assert.rejects(
      () => teamTool.execute({ name: '不该新建', workspace: tmp.ws }, { agent: { id: recRetry.agent.id } }),
      /已关联团队/,
      '续跑会话禁止重复建队',
    );
    const forced = await teamTool.execute({ name: '并行新团队', workspace: tmp.ws, force: true }, { agent: { id: recRetry.agent.id } });
    assert(forced.team?.id && forced.team.id !== firstTeam.team.id, 'force 放行并行新团队');
    await statusTool.execute({ status: 'done', summary: '续跑完成' }, { agent: { id: recRetry.agent.id } });

    console.log('plugin-board: ok');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

function perm(list, sessionId) {
  return [...list].reverse().find((p) => p.sessionId === sessionId)?.name;
}

main().catch((e) => { console.error(e); process.exit(1); });

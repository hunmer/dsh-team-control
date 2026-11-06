// tests/plugin-teamid-guard.mjs — teamId 缺失/无效时插件必须显式报错
// 回归（2026-10-31 实测）：模型生成的 team_spawn 调用漏了必填的 teamId，
// 旧实现把 undefined 拼进 URL → GET /api/teams/undefined 404 被 catch 静默回退 worker
// → POST /api/teams/undefined/members 才爆 `team not found`，看不出「参数缺失」这个根因。
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = (opts = {}) => {
  const tools = new Map();
  // 有 subagents 时 team_spawn 才能走完 startActivation → /api/agents/register；用于验证
  // 省略 teamId 时 register 用的是解析后的 team.id，而不是原始 undefined。
  const agents = opts.subagents ? {
    spawned: [],
    async startActivation(spec) {
      agents.spawned.push(spec);
      return { childId: spec.childId, messageId: 'msg-1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage() { return 'msg-1'; },
    interrupt() { /* noop */ },
    list: () => ['spawn', 'fork'],
  } : null;
  return {
    tools,
    ctx: {
      tools: {
        register: (tool) => { tools.set(tool.name, tool); return () => { /* noop */ }; },
        get: (name) => tools.get(name),
      },
      get(name) { return name === 'subagents' ? agents : undefined; },
      getService() { return undefined; },
      effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
      on() { return () => { /* noop */ }; },
    },
  };
};

const rejects = async (promise, re, msg) => {
  await promise.then(
    () => { throw new Error(`${msg}：预期抛错，实际成功`); },
    (e) => assert.match(String(e?.message ?? e), re, msg),
  );
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-teamid');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const team = await sidecar.api.post('/api/teams', { name: 'plugin-teamid', workspace: tmp.ws });

    const fake = mkFakeCtx();
    apply(fake.ctx, {
      baseUrl: sidecar.url, autoStart: false, requestTimeoutMs: 5000,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false, reportContext: false,
      reportWorkspaces: false, reportLlmCatalog: false, agentAutoDispatch: false,
    });
    const spawn = fake.tools.get('team_spawn');
    assert.equal(typeof spawn?.execute, 'function', 'team_spawn 已注册');

    // ① 完全没传 teamId：明确提示缺参数，而不是报「team not found」
    await rejects(spawn.execute({ name: 'a', description: 'd' }, {}), /缺少 teamId/, '缺 teamId 报参数缺失');

    // ② 传了空串 / 字面量 "undefined"：同样挡住（旧实现会把它们拼进 URL）
    await rejects(spawn.execute({ teamId: '', name: 'a' }, {}), /缺少 teamId/, '空串 teamId 报参数缺失');
    await rejects(spawn.execute({ teamId: 'undefined', name: 'a' }, {}), /缺少 teamId/, '字面量 undefined 报参数缺失');

    // ③ teamId 打错（sidecar 404）：明确报「团队不存在或 teamId 无效」，不回退 worker 继续建成员
    await rejects(spawn.execute({ teamId: 'team_nope', name: 'a', description: 'd' }, {}),
      /团队不存在或 teamId 无效: team_nope/, '404 明确报团队不存在');
    assert.equal((await sidecar.api.get(`/api/teams/${team.id}/members`)).items.length, 0, '失败的调用没有往真实团队里建成员');

    // ③b 同会话 team_create 后漏传 teamId：自动落到该会话刚建的团队，不再报「缺少 teamId」
    const create = fake.tools.get('team_create');
    const created = await create.execute(
      { name: 'plugin-teamid-bound', workspace: tmp.ws },
      { agent: { id: 'sess-teamid-bound' } },
    );
    assert.match(created.team.id, /^team_/, 'team_create 返回团队 id');
    await rejects(
      spawn.execute({ name: 'auto', prompt: '你是 auto。' }, { agent: { id: 'sess-teamid-bound' } }),
      /subagents 服务不可用/,
      '漏传 teamId 时回落到会话绑定的团队',
    );

    // ③c 同会话 team_create 后漏传 teamId，且宿主有 subagents：
    //     注册必须落到解析出的团队，不能把 undefined 发给 /api/agents/register 变成 400。
    const bound = mkFakeCtx({ subagents: true });
    apply(bound.ctx, {
      baseUrl: sidecar.url, autoStart: false, requestTimeoutMs: 5000,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false, reportContext: false,
      reportWorkspaces: false, reportLlmCatalog: false, agentAutoDispatch: false,
    });
    const boundLead = { agent: { id: 'sess-teamid-bound-agent' } };
    const boundTeam = (await bound.ctx.tools.get('team_create').execute(
      { name: 'plugin-teamid-bound-agent', workspace: tmp.ws },
      boundLead,
    )).team;
    const auto = await bound.ctx.tools.get('team_spawn').execute(
      { name: 'auto-agent', prompt: '你是 auto-agent。' },
      boundLead,
    );
    assert.equal(auto.member.teamId, boundTeam.id, '漏传 teamId 时成员注册到会话绑定的团队');
    const boundMembers = (await sidecar.api.get(`/api/teams/${boundTeam.id}/members`)).items;
    assert.equal(boundMembers.filter((m) => m.name === 'auto-agent').length, 1, '成员已在目标团队里登记');

    // ④ 合法 teamId 但宿主没有 subagents 服务：明确报错，不静默建 worker 成员
    await rejects(spawn.execute({ teamId: team.id, name: 'probe', prompt: '你是 probe。' }, {}),
      /subagents 服务不可用/, '没有 subagents 时明确报错');
    assert.equal((await sidecar.api.get(`/api/teams/${team.id}/members`)).items.length, 0, '失败调用没有建成员');

    console.log('PASS plugin-teamid-guard — 缺 teamId/无效 teamId/无 subagents 均显式报错，不静默建成员');
  } finally {
    await sidecar.close();
  }
};

main().catch((e) => {
  console.error('FAIL plugin-teamid-guard —', e?.stack || e);
  process.exitCode = 1;
});

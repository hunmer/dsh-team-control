// tests/plugin-models.mjs — Host 模型路由：ctx.llm 目录同步 → team_models 只列启用 → team_spawn 落 agentOptions
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const agents = {
    spawned: [],
    async startActivation(spec) {
      agents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: `m-${agents.spawned.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage() { return 'm'; },
    interrupt() {},
    list: () => ['spawn', 'fork'],
  };
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }, { id: 'empty', name: 'Empty Provider' }],
    listConfigurableProviders: () => [
      { provider: 'deepseek', displayName: 'DeepSeek' },
      { provider: 'openai', displayName: 'OpenAI' },
      { provider: 'dormant', displayName: '未配置的提供商' },
    ],
    async listModels(provider) {
      if (provider === 'deepseek') {
        return [
          { provider, id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'fast', inputModalities: ['text', 'image'] },
          { provider, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ];
      }
      if (provider === 'empty') return [];
      return [{ provider, id: 'gpt-5', name: 'GPT-5', description: 'strong reasoning' }];
    },
  };
  const ctx = {
    tools: { register: (t) => { registry.set(t.name, t); return () => registry.delete(t.name); }, get: (n) => registry.get(n) },
    agents,
    handlers,
    get: (name) => (name === 'subagents' ? agents : name === 'llm' ? llm : undefined),
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  };
  return ctx;
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-models');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const ctx = mkFakeCtx();
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: false, agentDispatchMs: 600 });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    // Lead 走 deepseek/deepseek-chat + low effort，供继承断言
    const lead = { agent: { id: 'sess-lead', options: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' } } };
    const team = (await tool('team_create').execute({ name: 'models', workspace: tmp.ws, runtime: 'agent', maxMembers: 6 }, lead)).team;

    // 目录：Host ctx.llm → sidecar，team_models 只列启用项
    const models = await tool('team_models').execute({}, lead);
    assert.equal(models.total, 3, `team_models 列出 3 条，实际 ${models.total}（${JSON.stringify(models)}）`);
    assert.deepEqual(models.models.map((m) => `${m.provider}/${m.model}`).sort(), ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'openai/gpt-5']);
    assert(models.models.find((m) => m.model === 'deepseek-chat').description === 'fast', 'description 透传');
    assert.deepEqual(models.models.find((m) => m.model === 'deepseek-chat').modalities, ['text', 'image'], 'modalities 是 DSH 的 array 形状（面板 vision 徽标依赖它）');

    // 没模型的 provider（空列表 / 未配置的 dormant）不写进目录，也不会出现在面板
    const catalog = await api.get('/api/llm/catalog');
    assert.deepEqual(catalog.providers.map((p) => p.id).sort(), ['deepseek', 'openai'], `只保留有模型的 provider，实际 ${JSON.stringify(catalog.providers.map((p) => p.id))}`);
    assert.equal(catalog.totals.providers, 2, '空 provider 不计数');
    assert(!catalog.providers.some((p) => p.models.length === 0), '目录里没有空分组');

    // 显式 route + effort → 原样进 agentOptions
    const alice = await tool('team_spawn').execute(
      { teamId: team.id, name: 'alice', prompt: '你是 alice。', agentProvider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }, lead,
    );
    const specA = ctx.agents.spawned[0].req;
    assert.deepEqual(specA.request.agentOptions, { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }, 'agentOptions 落进 startActivation');
    assert.deepEqual(alice.agent.route, { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }, '返回实际生效 route');
    assert.equal(alice.member.model, 'gpt-5', '成员 model 是真实 model id');

    // 与 Lead 同 route：不传 effort 时继承 Lead 的 low（agentOptions 不写 effort）
    const bob = await tool('team_spawn').execute(
      { teamId: team.id, name: 'bob', prompt: '你是 bob。', agentProvider: 'deepseek', model: 'deepseek-chat' }, lead,
    );
    const specB = ctx.agents.spawned[1].req;
    assert.deepEqual(specB.request.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' }, '同 route 不显式写 effort');
    assert.equal(bob.agent.route.reasoningEffort, 'low', '同 route 继承 Lead effort');

    // 换 route 且不传 effort → 清空继承（返回 null，agentOptions 不写）
    const carol = await tool('team_spawn').execute(
      { teamId: team.id, name: 'carol', prompt: '你是 carol。', agentProvider: 'openai', model: 'gpt-5' }, lead,
    );
    const specC = ctx.agents.spawned[2].req;
    assert.deepEqual(specC.request.agentOptions, { provider: 'openai', model: 'gpt-5' }, '换 route 不继承 effort');
    assert.equal(carol.agent.route.reasoningEffort, null, '换 route 时 effort 置空');

    // 完全省略 route → 无 agentOptions，继承 Lead
    const dave = await tool('team_spawn').execute({ teamId: team.id, name: 'dave', prompt: '你是 dave。' }, lead);
    const specD = ctx.agents.spawned[3].req;
    assert.equal(specD.request.agentOptions, undefined, '省略 route 时不写 agentOptions');
    assert.deepEqual(dave.agent.route, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' }, '继承 Lead route');

    // 面板停用 gpt-5 后，再指定该 route 必须被拒
    await api.patch('/api/llm/routes', { provider: 'openai', model: 'gpt-5', enabled: false, note: '先不用' });
    let err = null;
    try {
      await tool('team_spawn').execute({ teamId: team.id, name: 'eve', prompt: '你是 eve。', agentProvider: 'openai', model: 'gpt-5' }, lead);
    } catch (e) { err = e; }
    assert(err, '停用的 route 必须拒绝');
    assert.match(String(err.message), /未启用/, `错误信息应解释，实际：${err.message}`);
    assert.equal(ctx.agents.spawned.length, 4, '被拒的 spawn 不调 startActivation');

    // 继承 Lead 的 route 也过同一道闸门：停用 deepseek-chat 后省略 route 的 spawn 也要被拒
    await api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-chat', enabled: false });
    err = null;
    try {
      await tool('team_spawn').execute({ teamId: team.id, name: 'frank', prompt: '你是 frank。' }, lead);
    } catch (e) { err = e; }
    assert(err, '继承的 route 被停用时必须拒绝');
    assert.match(String(err.message), /未启用/, `错误信息应解释，实际：${err.message}`);
    assert.equal(ctx.agents.spawned.length, 4, '被拒的继承 spawn 不调 startActivation');
    await api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-chat', enabled: true });

    // team_models 立即反映停用
    const models2 = await tool('team_models').execute({ refresh: false }, lead);
    assert.equal(models2.total, 2, '停用后 team_models 只剩 2 条');
    assert(!models2.models.some((m) => m.model === 'gpt-5'), '停用项不出现');

    console.log('PASS plugin-models — ctx.llm 同步/team_models/agentOptions/route 继承与继承清空/停用拦截');
  } finally {
    try { await sidecar.close(); } catch { /* ignore */ }
    tmp.cleanup();
  }
};

main().catch((err) => { console.error('FAIL plugin-models —', err); process.exitCode = 1; });

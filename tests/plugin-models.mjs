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
    // 只有 reasoner 声明了 reasoning efforts（模拟 DSH llm 服务公开的 resolveModelInfo）
    async resolveModelInfo(provider, model) {
      if (model === 'deepseek-reasoner') {
        return {
          provider,
          model,
          reasoning: {
            efforts: [
              // off = 关思考，插件必须在同步时剔除，不进面板也不进 team_models
              { id: 'off', name: 'Off' },
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High', description: '深推理' },
            ],
            defaultEffort: 'medium',
          },
        };
      }
      return { provider, model };
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

    // effort 元数据：适配器声明了 efforts 才会出现在 team_models
    const reasoner = models.models.find((m) => m.model === 'deepseek-reasoner');
    assert.deepEqual(reasoner.efforts, ['low', 'medium', 'high'], 'team_models 报出全部 effort id（剔除 off）');
    assert.equal(reasoner.defaultEffort, 'medium', 'defaultEffort 透传');
    assert.equal(models.models.find((m) => m.model === 'deepseek-chat').efforts, undefined, '未声明 efforts 的 route 不报该字段');

    // PATCH allowedEfforts：只放行子集；非法 id 400
    let badEffort = null;
    try { await api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-reasoner', allowedEfforts: ['ultra'] }); } catch (e) { badEffort = e; }
    assert(badEffort && badEffort.status === 400, `未知 effort 必须 400，实际 ${badEffort && badEffort.status}`);
    let offEffort = null;
    try { await api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-reasoner', allowedEfforts: ['off'] }); } catch (e) { offEffort = e; }
    assert(offEffort && offEffort.status === 400, `off 不是可派发强度，必须 400，实际 ${offEffort && offEffort.status}`);

    await api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-reasoner', allowedEfforts: ['low', 'high'] });
    const narrowed = await tool('team_models').execute({ refresh: false }, lead);
    assert.deepEqual(narrowed.models.find((m) => m.model === 'deepseek-reasoner').efforts, ['low', 'high'], 'team_models 只报允许的 effort');

    // 被禁止的 effort 拒绝派发
    let effortErr = null;
    try {
      await tool('team_spawn').execute({ teamId: team.id, name: 'gina', prompt: '你是 gina。', agentProvider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'medium' }, lead);
    } catch (e) { effortErr = e; }
    assert(effortErr, '被禁止的 effort 必须拒绝');
    assert.match(String(effortErr.message), /已禁止/, `错误信息应解释，实际：${effortErr.message}`);
    assert.equal(ctx.agents.spawned.length, 4, '被拒的 effort spawn 不调 startActivation');

    // 未声明的 effort 拒绝
    let unknownErr = null;
    try {
      await tool('team_spawn').execute({ teamId: team.id, name: 'gina2', prompt: '你是 gina2。', agentProvider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'ultra' }, lead);
    } catch (e) { unknownErr = e; }
    assert(unknownErr && /不支持/.test(String(unknownErr.message)), `未知 effort 应报“不支持”，实际：${unknownErr && unknownErr.message}`);

    // 允许的 effort 正常派发，并记录到成员（面板卡片/team_status 依赖它）
    const hank = await tool('team_spawn').execute(
      { teamId: team.id, name: 'hank', prompt: '你是 hank。', agentProvider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }, lead,
    );
    assert.equal(hank.member.reasoningEffort, 'high', '成员记录实际生效 effort');
    assert.equal(ctx.agents.spawned[4].req.request.agentOptions.reasoningEffort, 'high', 'effort 进 agentOptions');
    const st = await api.get(`/api/status?team=${team.id}`);
    assert.equal(st.members.find((m) => m.name === 'hank').reasoningEffort, 'high', '/api/status 暴露成员 effort');

    // 面板停用 gpt-5 后，再指定该 route 必须被拒
    await api.patch('/api/llm/routes', { provider: 'openai', model: 'gpt-5', enabled: false, note: '先不用' });
    let err = null;
    try {
      await tool('team_spawn').execute({ teamId: team.id, name: 'eve', prompt: '你是 eve。', agentProvider: 'openai', model: 'gpt-5' }, lead);
    } catch (e) { err = e; }
    assert(err, '停用的 route 必须拒绝');
    assert.match(String(err.message), /未启用/, `错误信息应解释，实际：${err.message}`);
    assert.equal(ctx.agents.spawned.length, 5, '被拒的 spawn 不调 startActivation');

    // 继承 Lead 的 route 也过同一道闸门：停用 deepseek-chat 后省略 route 的 spawn 也要被拒
    await api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-chat', enabled: false });
    err = null;
    try {
      await tool('team_spawn').execute({ teamId: team.id, name: 'frank', prompt: '你是 frank。' }, lead);
    } catch (e) { err = e; }
    assert(err, '继承的 route 被停用时必须拒绝');
    assert.match(String(err.message), /未启用/, `错误信息应解释，实际：${err.message}`);
    assert.equal(ctx.agents.spawned.length, 5, '被拒的继承 spawn 不调 startActivation');
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

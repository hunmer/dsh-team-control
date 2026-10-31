// tests/plugin-teamid-guard.mjs — teamId 缺失/无效时插件必须显式报错
// 回归（2026-10-31 实测）：模型生成的 team_spawn 调用漏了必填的 teamId，
// 旧实现把 undefined 拼进 URL → GET /api/teams/undefined 404 被 catch 静默回退 worker
// → POST /api/teams/undefined/members 才爆 `team not found`，看不出「参数缺失」这个根因。
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const tools = new Map();
  return {
    tools,
    ctx: {
      tools: { register: (tool) => { tools.set(tool.name, tool); return () => { /* noop */ }; } },
      get() { return undefined; },
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

    // ④ 正常路径不受影响：带 description 也能建出成员
    const created = await spawn.execute({ teamId: team.id, name: 'probe', description: '回归探针' }, {});
    assert.equal(created?.member?.name, 'probe', 'team_spawn 正常创建成员');
    assert.equal((await sidecar.api.get(`/api/teams/${team.id}/members`)).items.length, 1, '成员落库 1 个');

    console.log('PASS plugin-teamid-guard — 缺 teamId/无效 teamId 显式报错，正常路径不受影响');
  } finally {
    await sidecar.close();
  }
};

main().catch((e) => {
  console.error('FAIL plugin-teamid-guard —', e?.stack || e);
  process.exitCode = 1;
});

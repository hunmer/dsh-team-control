// tests/plugin-memory.mjs — 5 个 team_memory_* 工具的注册、身份透传与权限
// 不拉真 sub-agent：用假 ctx 捕获工具，sidecar 用真进程 + 真 HTTP。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-memory');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const teamA = await sidecar.api.post('/api/teams', { name: 'plug-mem-a', workspace: tmp.ws, leadSessionId: 'sess-lead-a' });
    const alice = await sidecar.api.post(`/api/teams/${teamA.id}/members`, { name: 'alice' });
    const bob = await sidecar.api.post(`/api/teams/${teamA.id}/members`, { name: 'bob' });
    await sidecar.api.post('/api/agents/register', { teamId: teamA.id, name: 'alice', sessionId: 'sess-alice' });
    await sidecar.api.post('/api/agents/register', { teamId: teamA.id, name: 'bob', sessionId: 'sess-bob' });
    const teamB = await sidecar.api.post('/api/teams', { name: 'plug-mem-b', workspace: tmp.ws, leadSessionId: 'sess-lead-b' });
    await sidecar.api.post('/api/agents/register', { teamId: teamB.id, name: 'carol', sessionId: 'sess-carol' });

    const fake = mkFakeCtx();
    apply(fake.ctx, {
      baseUrl: sidecar.url, autoStart: false, requestTimeoutMs: 5000,
      reportToolCalls: false, reportChanges: false, reportLlmCalls: false, reportContext: false,
      reportWorkspaces: false, reportLlmCatalog: false, agentAutoDispatch: false,
    });
    for (const name of ['team_memory_write', 'team_memory_read', 'team_memory_list', 'team_memory_share', 'team_memory_delete']) {
      assert.equal(typeof fake.tools.get(name)?.execute, 'function', `${name} 已注册`);
    }

    const write = fake.tools.get('team_memory_write');
    const read = fake.tools.get('team_memory_read');
    const list = fake.tools.get('team_memory_list');
    const share = fake.tools.get('team_memory_share');
    const del = fake.tools.get('team_memory_delete');

    // ① Lead/面板写团队空间
    const t = await write.execute({ teamId: teamA.id, scope: 'team', key: 'handoff/brief', value: '团队结论', kind: 'handoff' }, {});
    assert.match(t.memory.id, /^mem_/, 'write 返回 mem_ id');
    assert.equal(t.memory.slot, 'handoff/brief', 'write 返回 slot');
    assert.equal(t.memory.visibility, 'team', 'team scope 默认 team 可见');

    // ② 成员写自己的空间，owner 由 session 解析
    const a = await write.execute({ teamId: teamA.id, scope: 'member', key: 'notes/alice', value: 'alice 的坑' }, { agent: { id: 'sess-alice' } });
    assert.equal(a.memory.ownerMemberId, alice.id, '成员写入归属到该 session 的成员');
    const back = await read.execute({ teamId: teamA.id, memoryId: a.memory.id }, { agent: { id: 'sess-alice' } });
    assert.equal(back.memory.value, 'alice 的坑', 'read 按 id 返回正文');

    // ③ 其他成员读不到 private，列表也不可见
    await assert.rejects(
      read.execute({ teamId: teamA.id, memoryId: a.memory.id }, { agent: { id: 'sess-bob' } }),
      /403/,
      'bob 读 alice 的 private 返回 403',
    );
    const bobList = await list.execute({ teamId: teamA.id }, { agent: { id: 'sess-bob' } });
    assert.equal(bobList.items.some((x) => x.id === a.memory.id), false, 'bob 列表看不到 alice 的 private');
    assert.equal(bobList.items.some((x) => x.id === t.memory.id), true, 'bob 列表看得到团队空间');

    // ④ 工具的 member scope 没有 memberId 入口：bob 只能落到自己的空间
    const b = await write.execute({ teamId: teamA.id, scope: 'member', key: 'notes/alice', value: 'bob 的版本' }, { agent: { id: 'sess-bob' } });
    assert.equal(b.memory.ownerMemberId, bob.id, 'bob 写入归属 bob，不会覆盖 alice 的同名 key');
    assert.notEqual(b.memory.id, a.memory.id, '同 key 不同 owner 是两条记忆');

    // ⑤ shared 后其他团队可按 id 读；非 owner/Lead 不能删
    await share.execute({ teamId: teamA.id, memoryId: a.memory.id, visibility: 'shared' }, { agent: { id: 'sess-alice' } });
    const carolRead = await read.execute({ teamId: teamB.id, memoryId: a.memory.id }, { agent: { id: 'sess-carol' } });
    assert.equal(carolRead.memory.value, 'alice 的坑', '其他团队成员凭 id 读 shared');
    await assert.rejects(
      del.execute({ teamId: teamA.id, memoryId: a.memory.id }, { agent: { id: 'sess-bob' } }),
      /403/,
      'bob 不能删 alice 的记忆',
    );
    const removed = await del.execute({ teamId: teamA.id, memoryId: a.memory.id }, { agent: { id: 'sess-lead-a' } });
    assert.equal(removed.removed, true, 'Lead 可删');
    assert.equal(fs.existsSync(path.join(tmp.dataDir, 'memory', 'objects', a.memory.id + '.json')), false, '删除同时移除文件');

    // ⑥ 缺 teamId 时明确报参数错误
    await assert.rejects(write.execute({ key: 'k', value: 'v' }, {}), /缺少 teamId/, '缺 teamId 明确报错');
    console.log('PASS plugin-memory — 5 个工具注册 + 身份/可见性/删除语义');
  } finally {
    try { await sidecar.close(); } catch { /* ignore */ }
    try { tmp.cleanup(); } catch { /* ignore */ }
  }
};

main().catch((e) => { console.error(e); process.exitCode = 1; });

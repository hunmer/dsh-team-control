// tests/plugin-changes.mjs — 审阅数据采集：成员 write/edit 后插件算 unified diff 并上报 /api/changes。
// 覆盖：① 成员新建文件 → kind=add，diff 全是 +；② 成员改文件 → kind=edit，含被删行；
//       ③ 非成员会话（Lead 自己）的写入不上报；④ 工具失败不上报；⑤ 只读/非文件工具不上报。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, startSidecar, waitFor } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const agents = {
    spawned: [],
    async startActivation(spec) {
      agents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: 'm1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
    async sendMessage() { return 'm2'; },
    interrupt() {},
    list: () => ['spawn'],
  };
  const wsBySession = new Map();
  const workingDirectory = { get: (session) => wsBySession.get(session?.id) ?? null };
  const ctx = {
    tools: { register: (tool) => { registry.set(tool.name, tool); return () => registry.delete(tool.name); }, get: (name) => registry.get(name) },
    agents,
    workingDirectory,
    wsBySession,
    handlers,
    get: (name) => {
      if (name === 'subagents') return agents;
      if (name === 'sessions') return { get: (id) => ({ id }) };
      if (name === 'sessionProjections') return { stateOf: () => null };
      if (name === 'workingDirectory') return workingDirectory;
      return undefined;
    },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) {
      const list = handlers.get(name) || [];
      list.push(fn);
      handlers.set(name, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
  };
  return ctx;
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-changes');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const ctx = mkFakeCtx();
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: false });
    const tool = (name) => {
      const t = ctx.tools.get(name);
      assert(t, `工具 ${name} 已注册`);
      return t;
    };
    const lead = { agent: { id: 'sess-lead', cwd: tmp.ws } };
    // tools/execute 的拦截器：按钩子标记认出「文件改动上报」那个
    const execChange = () => {
      const list = ctx.handlers.get('tools/execute') || [];
      const hook = list.find((fn) => fn.dshTeamHook === 'file-change');
      assert(hook, '插件注册了文件改动上报钩子');
      return hook;
    };

    const team = (await tool('team_create').execute({ name: 'chg', workspace: tmp.ws, runtime: 'agent' }, lead)).team;
    const alice = (await tool('team_spawn').execute({ teamId: team.id, name: 'alice', role: 'coder', prompt: '你是 alice' }, lead)).member;
    const asAlice = { agent: { id: alice.agentSessionId, cwd: tmp.ws } };

    // ① 新建文件（write）：插件先读 before=null，执行 next 真正落盘，再读 after
    const file = path.join(tmp.ws, 'notes', 'draft.md');
    const before = fs.existsSync(path.dirname(file)) ? null : null;
    assert.equal(before, null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await execChange()(
      { name: 'write', arguments: { file_path: 'notes/draft.md', content: '# 草稿\n第一行\n第二行\n' }, agent: asAlice.agent },
      async () => { fs.writeFileSync(file, '# 草稿\n第一行\n第二行\n'); return { content: [] }; },
    );

    const first = await waitFor('新增文件上报', async () => {
      const rows = await api.get(`/api/changes?team=${team.id}`);
      const hit = (rows.items || []).find((c) => c.path === 'notes/draft.md');
      return hit || null;
    }, 5000);
    assert.equal(first.kind, 'add', '新文件是 add');
    assert.equal(first.memberId, alice.id, '归属到写文件的那位成员');
    assert.equal(first.added, 4, '新增 4 行（含文件末尾的空行）');
    assert.equal(first.deleted, 0, '没有删除行');
    assert(first.diff.startsWith('--- a/notes/draft.md'), 'diff 头用 a/ 路径：' + first.diff.split('\n')[0]);
    assert(first.diff.includes('+++ b/notes/draft.md'), 'diff 头用 b/ 路径');
    assert(first.diff.includes('+# 草稿'), '新增行带 +');

    // ② 改文件（edit）：删掉一行、改掉一行
    await execChange()(
      { name: 'edit', arguments: { file_path: 'notes/draft.md', old_string: '第二行', new_string: '第三行\n第四行' }, agent: asAlice.agent },
      async () => {
        fs.writeFileSync(file, '# 草稿\n第一行\n第三行\n第四行\n');
        return { content: [] };
      },
    );

    const second = await waitFor('改动上报', async () => {
      const rows = await api.get(`/api/changes?team=${team.id}`);
      return (rows.items || []).filter((c) => c.path === 'notes/draft.md' && c.kind === 'edit')[0] || null;
    }, 5000);
    assert.equal(second.kind, 'edit', '既有文件是 edit');
    assert.equal(second.added, 2, '新增两行');
    assert.equal(second.deleted, 1, '删除一行');
    assert(second.diff.includes('-第二行'), '被删行带 −：' + second.diff);
    assert(second.diff.includes('+第三行'), '新增行带 +');
    assert(second.diff.includes(' 第一行'), '未变行是上下文');

    // ③ Lead 自己的写入不进审阅
    const countBefore = (await api.get(`/api/changes?team=${team.id}`)).items.length;
    await execChange()(
      { name: 'write', arguments: { file_path: 'lead-only.md', content: 'lead\n' }, agent: { id: 'sess-lead', cwd: tmp.ws } },
      async () => { fs.writeFileSync(path.join(tmp.ws, 'lead-only.md'), 'lead\n'); return { content: [] }; },
    );

    // ④ 失败的工具调用不记录
    await execChange()(
      { name: 'write', arguments: { file_path: 'never.md', content: 'x\n' }, agent: asAlice.agent },
      async () => ({ isError: true, error: 'permission denied' }),
    );

    // ⑤ 非文件工具不记录（read 只读，不产生审阅项）
    await execChange()(
      { name: 'read', arguments: { file_path: 'notes/draft.md' }, agent: asAlice.agent },
      async () => ({ content: [] }),
    );

    await new Promise((r) => setTimeout(r, 600));
    const rows = await api.get(`/api/changes?team=${team.id}`);
    assert.equal(rows.items.length, countBefore, 'Lead/失败/只读调用都不新增改动：' + JSON.stringify(rows.items.map((c) => c.path)));
    assert(!rows.items.some((c) => c.path === 'lead-only.md'), 'Lead 的文件不在审阅里');
    assert(!rows.items.some((c) => c.path === 'never.md'), '失败调用不在审阅里');

    // ⑥ 过滤：按成员 / 按交付的 sessionId 都能取到
    const byMember = await api.get(`/api/changes?team=${team.id}&member=${alice.id}`);
    assert.equal(byMember.items.length, 2, '按成员过滤拿到该成员的 2 条');
    const scoped = await api.get(`/api/changes?team=${team.id}&member=nobody`);
    assert.equal(scoped.items.length, 0, '未知成员返回空');

    // ⑦ 真实子会话的 Agent 上没有 cwd 字段：目录得问 workingDirectory 服务，
    //    否则会退回宿主进程 cwd，diff 路径变成相对仓库外的怪形式。
    ctx.wsBySession.set(alice.agentSessionId, tmp.ws);
    await execChange()(
      {
        name: 'write',
        arguments: { file_path: 'notes/from-session.md', content: 'a\nb\n' },
        agent: { id: alice.agentSessionId, session: { id: alice.agentSessionId } },
      },
      async () => { fs.writeFileSync(path.join(tmp.ws, 'notes', 'from-session.md'), 'a\nb\n'); return { content: [] }; },
    );
    const viaWd = await waitFor('按 workingDirectory 解析成员目录', async () => {
      const list = await api.get(`/api/changes?team=${team.id}`);
      return (list.items || []).find((c) => c.path === 'notes/from-session.md') || null;
    }, 5000);
    assert.equal(viaWd.kind, 'add', '成员会话目录下的新文件是 add');
    assert(viaWd.diff.startsWith('--- a/notes/from-session.md'), '路径相对 workspace：' + viaWd.diff.split('\n')[0]);

    // ⑧ spawn 时记下的团队工作目录兜底：workingDirectory 拿不到、Agent 上也没有 cwd 时，
    //    相对路径仍按 team.workspace 解析；否则成员用相对路径写文件会静默丢改动（审阅页漏条）。
    ctx.wsBySession.clear();
    const bob = (await tool('team_spawn').execute({ teamId: team.id, name: 'bob', role: 'coder', prompt: '你是 bob' }, lead)).member;
    await execChange()(
      {
        name: 'write',
        arguments: { file_path: 'notes/rel.md', content: 'rel\n' },
        agent: { id: bob.agentSessionId, session: { id: bob.agentSessionId } },
      },
      async () => { fs.writeFileSync(path.join(tmp.ws, 'notes', 'rel.md'), 'rel\n'); return { content: [] }; },
    );
    const viaSpawnCwd = await waitFor('spawn 记录的 cwd 兜底解析相对路径', async () => {
      const list = await api.get(`/api/changes?team=${team.id}`);
      return (list.items || []).find((c) => c.path === 'notes/rel.md') || null;
    }, 5000);
    assert.equal(viaSpawnCwd.kind, 'add', '没有 workingDirectory 时也能按团队工作目录解析');
    assert.equal(viaSpawnCwd.memberId, bob.id, '归属到 bob');

    console.log('\nplugin-changes 全部通过');
  } finally {
    await sidecar.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });

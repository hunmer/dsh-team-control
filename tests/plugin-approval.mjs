// tests/plugin-approval.mjs — 成员审批转发给 Lead：approval/request → 通知 → team_approve → allowed-once/rejected
import assert from 'node:assert/strict';
import { mkTmp, startSidecar, waitFor } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';

const mkFakeCtx = () => {
  const registry = new Map();
  const handlers = new Map();
  const agents = {
    spawned: [], messages: [],
    async startActivation(spec) {
      agents.spawned.push({ req: spec });
      return { childId: spec.childId, messageId: `m-${agents.spawned.length}`, result: Promise.resolve({}), dispose: async () => {} };
    },
    async sendMessage(caller, targetId, content) { agents.messages.push({ caller, target: targetId, content }); return 'msg'; },
    interrupt() {},
  };
  const presets = { applied: [], names: ['read-only', 'workspace-write', 'danger-full-access'], set(s, n) { presets.applied.push({ session: s?.id, name: n }); } };
  const ctx = {
    agents, handlers, presets,
    tools: { register: (t) => { registry.set(t.name, t); return () => registry.delete(t.name); }, get: (n) => registry.get(n) },
    get(name) {
      if (name === 'subagents') return agents;
      if (name === 'sessions') return { get: (id) => ({ id }) };
      if (name === 'permissionPresets') return presets;
      return undefined;
    },
    effect(fn) { const cleanup = fn(); return () => { try { cleanup?.(); } catch { /* ignore */ } }; },
    on(name, fn) { const l = handlers.get(name) || []; l.push(fn); handlers.set(name, l); return () => {}; },
    emit() { /* not used */ },
  };
  return ctx;
};

const main = async () => {
  const tmp = mkTmp('dsh-team-plugin-approval');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    const ctx = mkFakeCtx();
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: false, approvalTimeoutMs: 60000, autoApproveTools: ['mcp_connector_*'] });
    const tool = (n) => { const t = ctx.tools.get(n); assert(t, `工具 ${n} 已注册`); return t; };
    const lead = { agent: { id: 'sess-lead' } };

    const team = (await tool('team_create').execute({ name: 'plugin-approval', workspace: tmp.ws }, lead)).team;
    const alice = await tool('team_spawn').execute({ teamId: team.id, name: 'alice', prompt: '你是 alice。' }, lead);
    const sessionId = alice.member.agentSessionId;

    // 插件已注册 approval/request 应答者
    const handler = (ctx.handlers.get('approval/request') || [])[0];
    assert.equal(typeof handler, 'function', 'apply 注册 approval/request 监听');

    // ① 成员请求审批 → 通知 Lead
    const p1 = handler({ id: 'req-1', agent: { id: sessionId }, toolName: 'exec', reason: 'npm test' }, async () => 'unavailable');
    await waitFor('审批通知送到 Lead', async () => (ctx.agents.messages.length >= 1 ? true : null), 5000);
    const note = ctx.agents.messages.at(-1);
    assert.equal(note.target, 'sess-lead', '通知发给 Lead');
    const text = note.content[0].text;
    assert(text.includes('req-1'), '通知带 requestId');
    assert(text.includes('team_approve'), '通知教 Lead 怎么批');
    assert(text.includes('alice'), '通知带成员名');
    assert(text.includes('exec'), '通知带工具名');

    // sidecar 已镜像 pending
    await waitFor('审批镜像落库', async () => {
      const r = await api.get(`/api/approvals?team=${team.id}`);
      return r.items.some((i) => i.id === 'req-1' && i.status === 'pending') ? r : null;
    }, 5000);

    // ② Lead 批准 → allowed-once
    const decided = await tool('team_approve').execute({ teamId: team.id, requestId: 'req-1', decision: 'allow' }, lead);
    assert.equal(decided.decision, 'allow', '返回决策');
    assert.equal(await p1, 'allowed-once', '放行本次操作');
    await waitFor('镜像状态 allowed', async () => {
      const i = (await api.get(`/api/approvals?team=${team.id}`)).items.find((x) => x.id === 'req-1');
      return i?.status === 'allowed' ? i : null;
    }, 5000);

    // ②b 低风险命令自动放行：pre-execute 缓存参数 → 审批直接 allowed-once，不通知 Lead
    const pre = (ctx.handlers.get('tools/pre-execute') || [])[0];
    assert.equal(typeof pre, 'function', 'apply 注册 tools/pre-execute 用于审批分类');
    await pre(
      { agent: { id: sessionId }, callId: 'call-auto', name: 'ops_bash', arguments: { command: 'npm test' } },
      async () => ({ decision: 'ask' }),
    );
    const beforeAuto = ctx.agents.messages.length;
    const auto = await handler(
      { id: 'req-auto', agent: { id: sessionId }, toolName: 'ops_bash', callId: 'call-auto', reason: 'sandbox escalation' },
      async () => 'unavailable',
    );
    assert.equal(auto, 'allowed-once', '低风险命令自动放行');
    assert.equal(ctx.agents.messages.length, beforeAuto, '自动放行不打扰 Lead');
    await waitFor('自动放行镜像为 allowed/auto', async () => {
      const i = (await api.get(`/api/approvals?team=${team.id}`)).items.find((x) => x.id === 'req-auto');
      return i?.status === 'allowed' && i?.decidedBy === 'auto' ? i : null;
    }, 5000);

    // ②c 敏感命令仍转 Lead：rm -rf 不允许自动放行
    await pre(
      { agent: { id: sessionId }, callId: 'call-danger', name: 'ops_bash', arguments: { command: 'rm -rf build' } },
      async () => ({ decision: 'ask' }),
    );
    const pDanger = handler(
      { id: 'req-danger', agent: { id: sessionId }, toolName: 'ops_bash', callId: 'call-danger', reason: 'sandbox escalation' },
      async () => 'unavailable',
    );
    await waitFor('敏感命令仍通知 Lead', async () => (ctx.agents.messages.length > beforeAuto ? true : null), 5000);
    await tool('team_approve').execute({ teamId: team.id, requestId: 'req-danger', decision: 'deny', reason: '危险命令' }, lead);
    assert.equal(await pDanger, 'rejected', '敏感命令不自动放行');

    // ②d 只读管道与 PowerShell 只读命令自动放行：含 `|` 不再一律转 Lead
    await pre(
      { agent: { id: sessionId }, callId: 'call-pipe', name: 'ops_bash', arguments: { command: 'git status --short | head -20' } },
      async () => ({ decision: 'ask' }),
    );
    const beforePipe = ctx.agents.messages.length;
    const pipe = await handler(
      { id: 'req-pipe', agent: { id: sessionId }, toolName: 'ops_bash', callId: 'call-pipe', reason: 'sandbox escalation' },
      async () => 'unavailable',
    );
    assert.equal(pipe, 'allowed-once', '只读管道命令自动放行');
    assert.equal(ctx.agents.messages.length, beforePipe, '只读管道不打扰 Lead');

    await pre(
      { agent: { id: sessionId }, callId: 'call-ps', name: 'ops_bash', arguments: { command: 'Get-ChildItem -Force | Select-Object Name,Length' } },
      async () => ({ decision: 'ask' }),
    );
    const ps = await handler(
      { id: 'req-ps', agent: { id: sessionId }, toolName: 'ops_bash', callId: 'call-ps', reason: 'sandbox escalation' },
      async () => 'unavailable',
    );
    assert.equal(ps, 'allowed-once', 'PowerShell 只读命令自动放行');

    // ②e 重定向仍转 Lead：`>` 会写文件，不走自动放行
    await pre(
      { agent: { id: sessionId }, callId: 'call-redirect', name: 'ops_bash', arguments: { command: 'git status > out.txt' } },
      async () => ({ decision: 'ask' }),
    );
    const pRedirect = handler(
      { id: 'req-redirect', agent: { id: sessionId }, toolName: 'ops_bash', callId: 'call-redirect', reason: 'sandbox escalation' },
      async () => 'unavailable',
    );
    await waitFor('重定向命令仍通知 Lead', async () => (ctx.agents.messages.length > beforePipe ? true : null), 5000);
    await tool('team_approve').execute({ teamId: team.id, requestId: 'req-redirect', decision: 'deny', reason: '写文件需审批' }, lead);
    assert.equal(await pRedirect, 'rejected', '重定向命令不自动放行');

    // ②f autoApproveTools 工具白名单：非 shell 工具、无参数缓存也放行
    const mcp = await handler(
      { id: 'req-mcp', agent: { id: sessionId }, toolName: 'mcp_connector_session_tools', reason: 'tool approval' },
      async () => 'unavailable',
    );
    assert.equal(mcp, 'allowed-once', '工具白名单自动放行');
    await waitFor('工具白名单镜像 decidedBy=auto', async () => {
      const i = (await api.get(`/api/approvals?team=${team.id}`)).items.find((x) => x.id === 'req-mcp');
      return i?.status === 'allowed' && i?.decidedBy === 'auto' ? i : null;
    }, 5000);

    // ②g 白名单未命中的非 shell 工具仍转 Lead
    const pOtherTool = handler({ id: 'req-other-tool', agent: { id: sessionId }, toolName: 'fs.write', reason: 'write outside' }, async () => 'unavailable');
    await waitFor('未命中白名单通知 Lead', async () => (ctx.agents.messages.length > beforePipe + 1 ? true : null), 5000);
    await tool('team_approve').execute({ teamId: team.id, requestId: 'req-other-tool', decision: 'deny', reason: '写操作' }, lead);
    assert.equal(await pOtherTool, 'rejected', '未命中工具白名单不自动放行');

    // ③ 拒绝 → rejected
    const p2 = handler({ id: 'req-2', agent: { id: sessionId }, toolName: 'fs.write', reason: '写 /etc/hosts' }, async () => 'unavailable');
    await waitFor('第二条通知', async () => (ctx.agents.messages.length >= 3 ? true : null), 5000);
    await tool('team_approve').execute({ teamId: team.id, requestId: 'req-2', decision: 'deny', reason: '不允许' }, lead);
    assert.equal(await p2, 'rejected', '拒绝本次操作');
    await waitFor('镜像状态 rejected', async () => {
      const i = (await api.get(`/api/approvals?team=${team.id}`)).items.find((x) => x.id === 'req-2');
      return i?.status === 'rejected' ? i : null;
    }, 5000);

    // ④ 非成员请求交回原链路
    const beforeStranger = ctx.agents.messages.length;
    const stranger = await handler({ id: 'req-3', agent: { id: 'sess-stranger' }, toolName: 'exec' }, async () => 'unavailable');
    assert.equal(stranger, 'unavailable', '非成员请求不拦截');
    assert.equal(ctx.agents.messages.length, beforeStranger, '非成员不发通知');

    // ⑤ 非 Lead 不能批
    const p3 = handler({ id: 'req-4', agent: { id: sessionId }, toolName: 'exec' }, async () => 'unavailable');
    await waitFor('第三条通知', async () => (ctx.agents.messages.length > beforeStranger ? true : null), 5000);
    let denied = null;
    try {
      await tool('team_approve').execute({ teamId: team.id, requestId: 'req-4', decision: 'allow' }, { agent: { id: 'sess-other' } });
    } catch (e) { denied = e; }
    assert(denied && /只有该团队的 Lead/.test(denied.message), '非 Lead 被拒');
    await tool('team_approve').execute({ teamId: team.id, requestId: 'req-4', decision: 'deny' }, lead);
    assert.equal(await p3, 'rejected', '收尾拒绝');

    console.log('PASS plugin-approval — 审批转发 Lead、team_approve 放行/拒绝、非成员放行原链路、非 Lead 拒绝');
    process.exitCode = 0;
  } finally {
    try { await sidecar.close(); } catch { /* ignore */ }
    tmp.cleanup();
  }
};

main().catch((err) => { console.error('FAIL plugin-approval —', err); process.exitCode = 1; });

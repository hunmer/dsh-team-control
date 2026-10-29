// tests/ac-15-agent-runtime.mjs — AC-15 agent 运行时：成员 = 真 DSH sub-agent（Host 派发，sidecar 记账）
// ① POST /api/teams {runtime:'agent'}：runtime 落库并在 teamView/status 暴露；非法 runtime 报错。
// ② POST /api/agents/register：成员绑定 agent session、事件 agent.spawn、状态 idle（幂等重报不重复建行）。
// ③ agent 团队不拉起 worker：任务停在 ready（依赖推进照常），idle 成员不会被 sidecar 自动派活。
// ④ POST /api/agents/dispatch：原子认领 → running + 事件 task.dispatch；没活时返回 dispatched=false。
// ⑤ 归属校验：别人的 session / 别人的任务回报被拒（400）。
// ⑥ POST /api/agents/report done：任务 done、成员回 idle、摘要进事件、依赖方立刻 ready。
// ⑦ report blocked：任务 blocked（不消耗重试）、事件 agent.blocked、成员 blocked。
// ⑧ agent/status idle 兜底：成员忘了回报时，idle 信号把在途任务收尾。
// ⑨ /api/agents/ready 供 Host 校对；trace 把该 session 的 span 挂到成员节点下。
// ⑩ worker 团队完全不受影响（回归）。
import { runAc, mkTmp, startSidecar, waitFor, sleep, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-15';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);
const settle = () => sleep(300); // sidecar 建任务后有 200ms 的「声明依赖」窗口

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac15');
  let sidecar = null;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    // ================= ① runtime 落库 =================
    const team = one(await api.post('/api/teams', {
      name: 'ac15-agent', workspace: tmp.ws, runtime: 'agent', maxMembers: 4, maxConcurrency: 1,
    }), 'team');
    assertEqual(team.runtime, 'agent', 'teamView.runtime = agent');
    const tv = await api.get(`/api/teams/${team.id}`);
    assertEqual(tv.runtime, 'agent', 'GET /api/teams/:id 带 runtime');

    let badRuntime = null;
    try { await api.post('/api/teams', { name: 'nope', workspace: tmp.ws, runtime: 'robot' }); } catch (e) { badRuntime = e; }
    assert(badRuntime && badRuntime.status === 400, `非法 runtime 报 400，实际 ${badRuntime && badRuntime.status}`);

    // ================= ② 登记 sub-agent 成员 =================
    const reg = await api.post('/api/agents/register', {
      teamId: team.id, name: 'alice', sessionId: 'ac15-sess-alice', role: 'teammate', model: 'test-model', contextMode: 'fresh',
    });
    const alice = reg.member;
    assertEqual(reg.runtime, 'agent', 'register 回 runtime=agent');
    assertEqual(alice.agentSessionId, 'ac15-sess-alice', '成员绑定 agent session');
    assertEqual(alice.status, 'idle', '登记即 idle');
    assertEqual(alice.model, 'test-model', 'model 落库');

    const reg2 = await api.post('/api/agents/register', { teamId: team.id, name: 'alice', sessionId: 'ac15-sess-alice' });
    assertEqual(reg2.member.id, alice.id, '同名重报幂等（不重复建成员）');

    const st0 = await api.get(`/api/status?team=${team.id}`);
    assertEqual(st0.runtime, 'agent', 'status 带 runtime');
    assertEqual(st0.members.length, 1, '只有 1 个成员');
    assertEqual(st0.members[0].agentSessionId, 'ac15-sess-alice', 'status 暴露 agentSessionId');

    const hist0 = await api.get(`/api/events/history?team=${team.id}&limit=200`);
    assert(hist0.items.some((e) => e.action === 'agent.spawn'), '事件 agent.spawn 已写入');

    // ================= ③ agent 团队不自动拉起 worker =================
    const t1 = one(await api.post('/api/tasks', { teamId: team.id, subject: '规划接口', plan: [] }), 'task');
    await sleep(400); // 远超 settle 窗口
    assertEqual((await api.get(`/api/tasks/${t1.id}`)).status, 'ready', 'agent 团队任务停在 ready（等 Host 派发）');
    const st1 = await api.get(`/api/status?team=${team.id}`);
    assertEqual(st1.members[0].status, 'idle', '没有 worker 被拉起（成员仍 idle）');

    // ================= ④ 认领 + 派发 =================
    const ready = await api.get(`/api/agents/ready?team=${team.id}`);
    assertEqual(ready.runtime, 'agent', 'agents/ready 带 runtime');
    assertEqual(ready.idleMembers.length, 1, 'agents/ready 列出 idle 成员');
    assert(ready.readyTasks.some((t) => t.taskId === t1.id), 'agents/ready 列出 ready 任务');

    const d1 = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(d1.dispatched, true, 'dispatch 认领成功');
    assertEqual(d1.task.id, t1.id, '认领的是本条任务');
    assertEqual(d1.task.status, 'running', '认领即 running');
    assertEqual(d1.member.id, alice.id, '认领给 alice');
    assertEqual(d1.task.assignee, alice.id, '任务 assignee 已绑定');
    await waitFor('成员置 running', async () => (await api.get(`/api/status?team=${team.id}`)).members[0].status === 'running', { timeout: 3000 });

    const hist1 = await api.get(`/api/events/history?team=${team.id}&limit=200`);
    assert(hist1.items.some((e) => e.action === 'task.dispatch' && e.taskId === t1.id), '事件 task.dispatch 已写入');

    const d2 = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(d2.dispatched, false, '没活时 dispatch 返回 false');
    assertEqual(d2.reason, 'concurrency', '并发占满时拒绝（maxConcurrency=1）');

    // ================= ⑤ 归属校验 =================
    const bob = one(await api.post('/api/agents/register', {
      teamId: team.id, name: 'bob', sessionId: 'ac15-sess-bob',
    }), 'member');
    let ghost = null;
    try {
      await api.post('/api/agents/report', { sessionId: 'ac15-sess-ghost', taskId: t1.id, status: 'done', summary: 'x' });
    } catch (e) { ghost = e; }
    // 未知 session 不是 500：sidecar 明确回 ok=false
    const ghostRes = await api.post('/api/agents/report', { sessionId: 'ac15-sess-ghost', taskId: t1.id, status: 'done' });
    assertEqual(ghostRes.ok, false, '未知 session 回报被明确拒绝');
    assertEqual(ghostRes.reason, 'unknown_session', '未知 session 原因');
    assert(ghost === null || ghost === undefined, '未知 session 不抛网络错误');

    let steal = null;
    try {
      await api.post('/api/agents/report', { sessionId: 'ac15-sess-bob', taskId: t1.id, status: 'done', summary: 'steal' });
    } catch (e) { steal = e; }
    assert(steal && steal.status === 400, `别人的任务不能被回报，实际 ${steal && steal.status}`);

    // ================= ⑥ 显式回报完成 =================
    const rep = await api.post('/api/agents/report', {
      sessionId: 'ac15-sess-alice', taskId: t1.id, status: 'done', summary: '接口定稿：src/api.mjs',
    });
    assertEqual(rep.status, 'done', 'report 回报 done');
    assertEqual(rep.summary, '接口定稿：src/api.mjs', '摘要原样保存');
    assertEqual((await api.get(`/api/tasks/${t1.id}`)).status, 'done', '任务 done');
    await waitFor('成员回 idle', async () => (await api.get(`/api/status?team=${team.id}`)).members.find((m) => m.id === alice.id).status === 'idle', { timeout: 3000 });

    const doneEvent = (await api.get(`/api/events/history?team=${team.id}&limit=200`)).items
      .find((e) => e.action === 'task.done' && e.taskId === t1.id);
    assert(doneEvent, '事件 task.done 已写入');
    assert(String(doneEvent.meta?.resultSummary || '').includes('src/api.mjs'), '摘要进事件（面板可见）');

    // 依赖方立即 ready
    const t2 = one(await api.post('/api/tasks', {
      teamId: team.id, subject: '实现接口', plan: [], deps: [{ from: t1.id }],
    }), 'task');
    assertEqual((await api.get(`/api/tasks/${t2.id}`)).status, 'ready', '依赖满足后 t2 ready');

    // concurrency=1：t1 已结束，可以认领 t2；再建一条则因并发占满而拒绝
    await settle();
    const d3 = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(d3.dispatched, true, 't2 被派发');
    assertEqual(d3.task.id, t2.id, '派发的是 t2');
    const t3 = one(await api.post('/api/tasks', { teamId: team.id, subject: '压测', plan: [] }), 'task');
    await settle();
    const d4 = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(d4.dispatched, false, '并发占满时 dispatch 拒绝');
    assertEqual(d4.reason, 'concurrency', '拒绝原因 = concurrency');
    assertEqual(d4.maxConcurrency, 1, '回显 maxConcurrency');

    // ================= ⑦ 阻塞回报 =================
    const blk = await api.post('/api/agents/report', {
      sessionId: 'ac15-sess-alice', taskId: t2.id, status: 'blocked', summary: '缺 API 契约，需要 Lead 决策',
    });
    assertEqual(blk.status, 'blocked', 'report blocked');
    const t2After = await api.get(`/api/tasks/${t2.id}`);
    assertEqual(t2After.status, 'blocked', '任务置 blocked');
    assertEqual(t2After.status === 'failed' ? 1 : 0, 0, 'blocked 不是 failed（不消耗重试）');
    const blkEvent = (await api.get(`/api/events/history?team=${team.id}&limit=200`)).items
      .find((e) => e.action === 'agent.blocked' && e.taskId === t2.id);
    assert(blkEvent, '事件 agent.blocked 已写入');
    assertEqual(blkEvent.meta?.status, 'blocked', '事件状态 blocked');
    assert((blkEvent.meta?.blockers || []).some((b) => String(b.detail).includes('API 契约')), '阻塞原因进事件的 blockers');
    const blkList = await api.get(`/api/blockers?team=${team.id}`);
    assert(blkList.items.some((b) => b.memberId === alice.id && String(b.detail).includes('API 契约')), '/api/blockers 列出成员阻塞原因');

    // ================= ⑧ idle 兜底完成 =================
    const st2 = await api.get(`/api/status?team=${team.id}`);
    const aliceNow = st2.members.find((m) => m.id === alice.id);
    assert(aliceNow.status !== 'running', 'alice 不在 running（t2 已 blocked）');

    // t3 还没有被认领，直接把 alice 报 idle 只应回到 idle，不乱动任务
    const idle1 = await api.post('/api/agents/status', { sessionId: 'ac15-sess-alice', status: 'idle', detail: 'turn finished' });
    assertEqual(idle1.ok, true, 'agent/status 接受 idle');
    assertEqual((await api.get(`/api/tasks/${t3.id}`)).status, 'ready', '无在途任务时 idle 不改动其他任务');

    // 重新派发 t3（先腾出并发：t2 已 blocked 不占并发）
    await settle();
    const d5 = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(d5.dispatched, true, 't3 被派发');
    assertEqual(d5.task.id, t3.id, '派发的是 t3');
    const idle2 = await api.post('/api/agents/status', { sessionId: 'ac15-sess-alice', status: 'idle', detail: '忘了回报' });
    assertEqual(idle2.completed, true, 'idle 兜底把在途任务收尾');
    assertEqual((await api.get(`/api/tasks/${t3.id}`)).status, 'done', '兜底收尾后任务 done');

    // ================= ⑨ ready 视图 + trace 挂载 =================
    await api.post('/api/spans', {
      teamId: team.id, sessionId: 'ac15-sess-alice',
      spans: [{ spanId: 'tool:ac15-sess-alice:c1', name: 'fs.write', kind: 'tool', status: 'done', startMs: Date.now() - 500, endMs: Date.now() - 400 }],
    });
    const tr = await api.get(`/api/trace?team=${team.id}`);
    const memberNode = tr.root.children.find((n) => n.id === `member:${alice.id}`);
    assert(memberNode, 'trace 有成员节点');
    assertEqual(memberNode.kind, 'subagent', '成员节点 kind=subagent');
    assert(memberNode.children.some((n) => n.name === 'fs.write'), '该 session 的工具 span 直接挂到成员节点下');
    const flat = (n, out = []) => { out.push(n); for (const c of n.children || []) flat(c, out); return out; };
    const allNodes = flat(tr.root);
    assert(!allNodes.some((n) => n.id === 'session:ac15-sess-alice'), '绑定成员的 session 不再单独建 Lead 会话节点');

    const readyEnd = await api.get(`/api/agents/ready?team=${team.id}`);
    assert(Array.isArray(readyEnd.readyTasks), 'agents/ready.readyTasks 是数组');
    assert(Array.isArray(readyEnd.idleMembers), 'agents/ready.idleMembers 是数组');

    // ================= ⑩ worker 团队回归 =================
    const wteam = one(await api.post('/api/teams', { name: 'ac15-worker', workspace: tmp.ws, maxMembers: 2, maxConcurrency: 2 }), 'team');
    assertEqual(wteam.runtime, 'worker', '默认 runtime=worker');
    const wm = one(await api.post(`/api/teams/${wteam.id}/members`, { name: 'w1' }), 'member');
    assertEqual(wm.agentSessionId, null, 'worker 成员没有 agent session');
    const wt = one(await api.post('/api/tasks', {
      teamId: wteam.id, subject: 'worker 自动跑', assignee: wm.id,
      plan: [{ step: 'S1', phase: 'verify', action: 'noop', target: 'ok', op: { kind: 'noop' } }],
    }), 'task');
    await waitFor('worker 团队仍自动派发', async () => (await api.get(`/api/tasks/${wt.id}`)).status === 'done', { timeout: 15000 });
    assert(true, 'worker 团队自动派发未受影响');

    return `agent 团队：runtime 落库/register 幂等/dispatch 认领+并发拒绝/归属校验/done+依赖推进/blocked 不消耗重试/idle 兜底/trace 挂成员节点；worker 团队回归正常`;
  } finally {
    if (sidecar) await sidecar.close();
  }
});

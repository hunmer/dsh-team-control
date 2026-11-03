// tests/ac-02-dag.mjs — AC-2 依赖编排：A → (B1 ‖ B2) → C（agent 运行时）
// 断言：依赖未满足时只有 A 可派发；A done 后 B1/B2 同时就绪；C 等 B1+B2 都 done 才就绪。
// 派发走真实的 /api/agents/dispatch → /api/agents/report，不直接改任务状态。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, sleep } from './lib/harness.mjs';

const AC = 'AC-2';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac02');
  const startedAt = Date.now();
  let sidecar = null;
  let ok = false;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', {
      name: 'ac02-dag', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 4,
    }), 'team');

    // 先声明 DAG，再拉起 4 个 agent 成员
    const mkTask = async (subject) => one(await api.post('/api/tasks', {
      teamId: team.id, subject, plan: [{ step: 'S1', detail: `${subject} 的实现步骤` }],
    }), 'task');
    const A = await mkTask('A');
    const B1 = await mkTask('B1');
    const B2 = await mkTask('B2');
    const C = await mkTask('C');
    for (const [from, to] of [[A.id, B1.id], [A.id, B2.id], [B1.id, C.id], [B2.id, C.id]]) {
      await api.post('/api/deps', { from, to, condition: 'all_success' });
    }

    const dag = await api.get(`/api/dag?team=${team.id}`);
    assertEqual(dag.edges.length, 4, 'DAG 边数');
    assert(dag.edges.every((e) => e.condition === 'all_success'), '所有 dep 的 condition=all_success');
    assertEqual(dag.edges.filter((e) => e.to === C.id).length, 2, 'C 应有 2 条入边（join 节点）');
    assertEqual(JSON.stringify(dag.ready), JSON.stringify([A.id]), '初始只有 A 就绪');

    const agents = [];
    for (let i = 1; i <= 4; i++) {
      const r = one(await api.post('/api/agents/register', {
        teamId: team.id, name: `a${i}`, sessionId: `sess_ac02_${i}`, role: 'teammate',
      }), 'member');
      agents.push(r);
    }
    assertEqual(agents.length, 4, '4 个 agent 成员注册成功');
    await sleep(400); // 等 settle 窗口

    const claim = async () => api.post('/api/agents/dispatch', { teamId: team.id });
    const done = async (claimed, summary) => api.post('/api/agents/report', {
      sessionId: claimed.member.agentSessionId, taskId: claimed.task.id, status: 'done', summary,
    });

    // ① 依赖未满足：只有 A 可派发
    const first = await claim();
    assert(first.task && first.task.id === A.id, `第一轮只应派发 A，实际 ${first.task?.subject}`);

    // A 未完成时反复 dispatch 不应派 B
    const early = await api.post('/api/agents/dispatch', { teamId: team.id });
    assert(!early.task, `A 运行中不应派发其它任务，实际 ${early.task?.subject}`);
    const earlyDag = await api.get(`/api/dag?team=${team.id}`);
    assertEqual(earlyDag.ready.length, 0, 'A 运行中无新就绪任务');

    await done(first, 'A ok');
    const afterA = await api.get(`/api/dag?team=${team.id}`);
    const readyAfterA = new Set(afterA.ready);
    assert(readyAfterA.has(B1.id) && readyAfterA.has(B2.id), 'A done 后 B1/B2 同时就绪');
    assert(!readyAfterA.has(C.id), 'C 在 B1/B2 都完成前不得就绪');

    // ② 并行派发 B1/B2
    const [b1, b2] = await Promise.all([claim(), claim()]);
    const got = [b1.task?.id, b2.task?.id].sort();
    assertEqual(JSON.stringify(got), JSON.stringify([B1.id, B2.id].sort()), '两个 B 任务并行派发');
    await done(b1, 'B1 ok');
    const midDag = await api.get(`/api/dag?team=${team.id}`);
    assert(!midDag.ready.includes(C.id), '只完成一个 B 时 C 仍不就绪');
    await done(b2, 'B2 ok');

    // ③ join 后 C 就绪
    await waitFor('C 就绪', async () => (await api.get(`/api/dag?team=${team.id}`)).ready.includes(C.id), { timeout: 5000 });
    const c = await claim();
    assertEqual(c.task?.id, C.id, 'C 最后派发');
    await done(c, 'C ok');

    const finals = (await api.get(`/api/tasks?team=${team.id}`)).items;
    assertEqual(finals.filter((t) => t.status === 'done').length, 4, '4 个任务全 done');

    // ④ 事件流有 task.dispatch / task.done
    const events = [];
    for (const a of agents) events.push(...(await api.get(`/api/steps?member=${a.id}&since=0&limit=500`)).items);
    for (const t of [A, B1, B2, C]) {
      assert(events.some((e) => e.taskId === t.id && e.action === 'task.dispatch'), `${t.subject} 有 task.dispatch 事件`);
      assert(events.some((e) => e.taskId === t.id && e.action === 'task.done'), `${t.subject} 有 task.done 事件`);
    }

    ok = true;
    return `A→(B1‖B2)→C：初始仅 A 就绪，A done 后 B 并行，join 后 C 就绪；4 任务 done；耗时 ${Date.now() - startedAt}ms`;
  } finally {
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

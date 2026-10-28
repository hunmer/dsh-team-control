// tests/ac-02-dag.mjs — AC-2 依赖编排：A → (B1 ‖ B2) → C
// 断言：① 依赖未满足时只有 A 会跑；② A done 后 B1/B2 自动启动且 B.start_ts - A.done_ts ≤ 1000ms；
//       ③ C 在 B1 与 B2 都 done 之后才启动；④ 最终全部 done。全程不调用 assign/start（无人工干预）。
// 时间戳一律取事件流（/api/steps 的 task.start / task.done 的 ts），不用本地时钟冒充。
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

    // 先声明 DAG（建任务 → 建依赖），再拉起成员。依赖尚未声明时不能有成员可派发，
    // 否则任务会在 dep 声明前就跑掉；这是调度器的真实时序约束，测试本身不做任何 assign/start。
    // A 跑 400ms，留出「依赖未满足时 B1/B2/C 是否抢跑」的观测窗口；B1/B2/C 各 250ms 以证明 fan-out 并行
    const mkPlan = (label) => [{
      step: 'S1', phase: 'wait', action: 'sleep', target: label,
      op: { kind: 'sleep', args: { ms: label === 'A' ? 400 : 250 } },
    }];
    const mkTask = async (subject) => one(await api.post('/api/tasks', {
      teamId: team.id, subject, plan: mkPlan(subject),
    }), 'task');

    const A = await mkTask('A');
    const B1 = await mkTask('B1');
    const B2 = await mkTask('B2');
    const C = await mkTask('C');
    assertEqual([A, B1, B2, C].filter(Boolean).length, 4, '4 个任务创建成功');

    for (const [from, to] of [[A.id, B1.id], [A.id, B2.id], [B1.id, C.id], [B2.id, C.id]]) {
      await api.post('/api/deps', { from, to, condition: 'all_success' });
    }

    const dag = await api.get(`/api/dag?team=${team.id}`);
    assertEqual(dag.edges.length, 4, 'DAG 边数');
    assert(dag.edges.every((e) => e.condition === 'all_success'), '所有 dep 的 condition=all_success');
    assertEqual(dag.edges.filter((e) => e.to === C.id).length, 2, 'C 应有 2 条入边（join 节点）');
    assertEqual(dag.nodes.length, 4, 'DAG 节点数');

    // 拉起 4 个成员；此后全靠调度器自动派发（无人工 assign/start）
    const members = [];
    for (let i = 1; i <= 4; i++) {
      members.push(one(await api.post(`/api/teams/${team.id}/members`, { name: `w${i}` }), 'member'));
    }
    assertEqual(members.length, 4, '4 个成员创建成功');

    // ① 依赖未满足期间：只有 A 允许跑。A 跑 400ms，在它的运行窗口内采样两次，B1/B2/C 都不得启动。
    await waitFor('A 被调度器自动启动', async () => {
      const t = one(await api.get(`/api/tasks/${A.id}`), 'task');
      return ['running', 'done'].includes(t.status) ? t : null;
    }, { timeout: 15000, interval: 50 });
    for (const waitMs of [0, 150]) {
      if (waitMs) await sleep(waitMs);
      const early = (await api.get(`/api/tasks?team=${team.id}`)).items;
      const earlyBy = Object.fromEntries(early.map((t) => [t.subject, t.status]));
      if (earlyBy.A === 'done') break;   // A 已跑完则窗口结束，后续由事件级断言覆盖
      assert(['running', 'done'].includes(earlyBy.A), `A 应已启动，实际 ${earlyBy.A}`);
      for (const s of ['B1', 'B2', 'C']) {
        assert(!['running', 'done', 'failed'].includes(earlyBy[s]), `依赖未满足时 ${s} 不得启动，实际 ${earlyBy[s]}`);
      }
    }

    // ④ 最终全部 done
    const finals = await waitFor('DAG 全部任务 done（≤45s）', async () => {
      const r = await api.get(`/api/tasks?team=${team.id}`);
      return r.items.length === 4 && r.items.every((t) => t.status === 'done') ? r.items : null;
    }, { timeout: 45000, interval: 100 });
    assertEqual(finals.filter((t) => t.status === 'done').length, 4, '4 个任务全 done');

    // ===== 用事件流核对时序（/api/steps 里 task.start / task.done 的 ts） =====
    const perMember = await Promise.all(members.map((m) => api.get(`/api/steps?member=${m.id}&since=0&limit=500`)));
    const events = perMember.flatMap((r) => r.items);
    const tsOf = (taskId, action) => events.filter((e) => e.taskId === taskId && e.action === action).map((e) => Date.parse(e.ts));
    const [aStart] = tsOf(A.id, 'task.start');
    const [aDone] = tsOf(A.id, 'task.done');
    const [b1Start] = tsOf(B1.id, 'task.start');
    const [b1Done] = tsOf(B1.id, 'task.done');
    const [b2Start] = tsOf(B2.id, 'task.start');
    const [b2Done] = tsOf(B2.id, 'task.done');
    const [cStart] = tsOf(C.id, 'task.start');
    const [cDone] = tsOf(C.id, 'task.done');
    for (const [label, v] of [['A.start', aStart], ['A.done', aDone], ['B1.start', b1Start], ['B1.done', b1Done],
      ['B2.start', b2Start], ['B2.done', b2Done], ['C.start', cStart], ['C.done', cDone]]) {
      assert(Number.isFinite(v), `事件流缺少 ${label}（task.start/task.done）`);
    }

    // ①（事件级）A 完成前只有 A 启动过
    const starts = events.filter((e) => e.action === 'task.start');
    const offenders = starts.filter((e) => e.taskId !== A.id && Date.parse(e.ts) < aDone);
    assertEqual(offenders.length, 0, `A done 之前不得有其它任务启动，实际: ${offenders.map((e) => e.taskId).join(',')}`);

    // ② B1/B2 在 A done 后自动启动，且延迟 ≤ 1000ms
    for (const [label, st] of [['B1', b1Start], ['B2', b2Start]]) {
      const lag = st - aDone;
      assert(lag >= 0, `${label} 必须在 A done 之后启动，实际 lag=${lag}ms`);
      assert(lag <= 1000, `${label}.start_ts - A.done_ts 应 ≤1000ms，实际 ${lag}ms`);
    }

    // ② fan-out 证据：B1/B2 真并行（运行区间重叠）
    assert(Math.max(b1Start, b2Start) < Math.min(b1Done, b2Done),
      `B1/B2 应并行执行，实际 B1[${b1Start},${b1Done}] B2[${b2Start},${b2Done}]`);

    // ③ C 必须在 B1 与 B2 都 done 之后才启动
    const joinAt = Math.max(b1Done, b2Done);
    assert(cStart >= joinAt, `C 应等 B1+B2 都 done 才启动，实际 C.start=${cStart} < max(B1.done,B2.done)=${joinAt}`);

    const lagB = Math.max(b1Start - aDone, b2Start - aDone);
    const lagC = cStart - joinAt;
    const elapsed = Date.now() - startedAt;
    ok = true;
    return `A→(B1‖B2)→C 全自动：B 启动延迟 ${lagB}ms(≤1000)，B1/B2 并行，C 在 join 后 ${lagC}ms 启动；`
      + `4 任务全 done，全程无 assign/start；耗时 ${elapsed}ms`;
  } catch (e) {
    throw e;
  } finally {
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

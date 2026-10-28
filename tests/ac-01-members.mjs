// tests/ac-01-members.mjs — AC-1 成员规模与配额
// ① maxMembers=0（不限）+ maxConcurrency=8：并发创建 32 成员全部成功（无 E_QUOTA），各跑 1 个 sleep 任务，最终 32 个任务全 done。
// ② maxMembers=4：第 5 人进 queued；retire 一个 idle 成员后 5s 内晋升 idle。
// 全流程真实 sidecar 子进程 + 真实 HTTP + 真实 Worker 进程。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual } from './lib/harness.mjs';

const N = 32;
const AC = 'AC-1';
// 契约 §3 写响应为 {team}/{member}/{task}，当前实现单对象端点直接返回本体；两种形态都接受。
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac01');
  const startedAt = Date.now();
  let sidecar = null;
  let ok = false;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    // ================= 阶段 1：无上限 + 32 成员并发 =================
    const teamU = one(await api.post('/api/teams', {
      name: 'ac01-unlimited', workspace: tmp.ws, maxMembers: 0, maxConcurrency: 8,
    }), 'team');
    assertEqual(teamU.maxMembers, 0, 'team.maxMembers 应为 0（不限）');
    assertEqual(teamU.maxConcurrency, 8, 'team.maxConcurrency');

    // 32 个成员用 Promise.all 真并发创建：任何一个 E_QUOTA 都会让本测试失败
    const created = await Promise.all(Array.from({ length: N }, (_, i) =>
      api.post(`/api/teams/${teamU.id}/members`, { name: `m${i + 1}`, role: 'worker' })
        .then((r) => one(r, 'member'))));
    assertEqual(created.length, N, '并发创建的成员数');
    assertEqual(new Set(created.map((m) => m.id)).size, N, '32 个成员 id 互不相同');
    for (const m of created) {
      assert(m.status === 'idle', `成员 ${m.name} 期望 idle（无上限），实际 ${m.status}`);
    }

    // 每人 1 个 sleep 任务；maxConcurrency=8 负责限制真实并发 Worker 进程数
    const sleepPlan = [{ step: 'S1', phase: 'wait', action: 'sleep', target: 'nap', op: { kind: 'sleep', args: { ms: 200 } } }];
    await Promise.all(created.map((m, i) => api.post('/api/tasks', {
      teamId: teamU.id, subject: `sleep-${i + 1}`, assignee: m.id, plan: sleepPlan,
    })));

    let peakRunning = 0;
    const tasks = await waitFor('32 个 sleep 任务全部 done（≤120s）', async () => {
      const r = await api.get(`/api/tasks?team=${teamU.id}`);
      peakRunning = Math.max(peakRunning, r.items.filter((t) => t.status === 'running').length);
      const done = r.items.filter((t) => t.status === 'done').length;
      return done === N ? r.items : null;
    }, { timeout: 120000, interval: 100 });
    assertEqual(tasks.length, N, '任务总数');
    assertEqual(tasks.filter((t) => t.status === 'done').length, N, 'done 状态任务数');
    assert(peakRunning >= 2, `并发派发未生效：观测到峰值 running=${peakRunning}`);
    assert(peakRunning <= 8, `maxConcurrency=8 被突破：观测到峰值 running=${peakRunning}`);

    const stU = await api.get(`/api/status?team=${teamU.id}`);
    assertEqual(stU.members.filter((m) => m.status === 'idle').length, N, '任务全部完成后 32 成员应回到 idle');

    // ================= 阶段 2：maxMembers=4 配额 + retire 晋升 =================
    const teamQ = one(await api.post('/api/teams', {
      name: 'ac01-quota', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2,
    }), 'team');
    assertEqual(teamQ.maxMembers, 4, 'teamQ.maxMembers');

    const five = [];
    for (let i = 1; i <= 5; i++) {
      five.push(one(await api.post(`/api/teams/${teamQ.id}/members`, { name: `q${i}` }), 'member'));
    }
    for (let i = 0; i < 4; i++) assertEqual(five[i].status, 'idle', `q${i + 1} 在配额内应为 idle`);
    assertEqual(five[4].status, 'queued', '第 5 人超 maxMembers=4 应进 queued（不是报错）');

    const retireTarget = five[0];
    await api.del(`/api/members/${retireTarget.id}?mode=retire`);
    const promoted = await waitFor('第 5 人 retire 后晋升 idle（≤5s）', async () => {
      const r = await api.get(`/api/members/${five[4].id}`);
      const m = one(r, 'member');
      return m.status === 'idle' ? m : null;
    }, { timeout: 5000, interval: 100 });
    assertEqual(promoted.status, 'idle', '晋升后第 5 人状态');
    assertEqual(promoted.name, 'q5', '晋升的应是第 5 人');

    const retired = one(await api.get(`/api/members/${retireTarget.id}`), 'member');
    assertEqual(retired.status, 'retired', 'retire 后状态应为 retired');

    const elapsed = Date.now() - startedAt;
    ok = true;
    return `32 成员并发创建全 idle；32 sleep 任务全 done（峰值 running=${peakRunning}≤8）；`
      + `maxMembers=4 时第 5 人 queued→retire 后晋升 idle；耗时 ${elapsed}ms`;
  } catch (e) {
    throw e;
  } finally {
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

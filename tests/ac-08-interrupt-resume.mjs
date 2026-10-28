// AC-8：interrupt → resume。seq 连续无重复；无僵尸 running；已完成单元不重做。
import { runAc, mkTmp, startSidecar, waitFor, assert, sleep } from './lib/harness.mjs';

const CONTROL_PHASES = new Set(['resume', 'init', 'interrupt', 'done', 'fail', 'decision', 'msg', 'recover', 'env', 'scope']);

await runAc('AC-8', async () => {
  const tmp = mkTmp('ac08');
  let s;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const team = await s.api.post('/api/teams', { name: 'ac8', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 });
    const m = await s.api.post(`/api/teams/${team.id}/members`, { name: 'lab-alpha', role: 'worker' });
    const plan = Array.from({ length: 10 }, (_, i) => ({
      step: `S${i + 1}`, phase: 'wait', action: 'sleep', target: `tick-${i + 1}`,
      op: { kind: 'sleep', args: { ms: 150 } },
    }));
    const task = await s.api.post('/api/tasks', { teamId: team.id, subject: 'long run', assignee: m.id, plan });

    // 跑到第 2 步
    await waitFor('running step2', async () => {
      const st = await s.api.get(`/api/status?member=${m.id}`);
      const mm = st.members[0];
      return mm.status === 'running' && mm.seq >= 4 ? mm : false;
    }, { timeout: 20000 });

    const t0 = Date.now();
    const res = await s.api.post(`/api/members/${m.id}/interrupt`, { reason: 'ac8' });
    const visible = Date.now() - t0;
    const after = await s.api.get(`/api/status?member=${m.id}`);
    assert(res.member.status === 'interrupted', `interrupt 响应状态应为 interrupted，实际 ${res.member.status}`);
    assert(after.members[0].status === 'interrupted', `interrupt 后立即查询应为 interrupted，实际 ${after.members[0].status}`);
    assert(visible < 500, `interrupt 状态可见耗时 ${visible}ms 应 < 500ms`);

    // 不得残留 running 僵尸态
    for (let i = 0; i < 3; i++) {
      await sleep(100);
      const q = await s.api.get(`/api/status?member=${m.id}`);
      assert(q.members[0].status !== 'running', '不得残留 running 僵尸态');
    }

    const before = await s.api.get(`/api/steps?member=${m.id}&limit=500`);
    assert(before.items.some((e) => e.phase === 'interrupt'), '必须落一条 phase=interrupt 的事件');
    const interruptedIdx = Math.max(...before.items.filter((e) => Number.isInteger(e.meta?.stepIndex)).map((e) => e.meta.stepIndex));

    const rs = await s.api.post(`/api/members/${m.id}/resume`, {});
    assert(rs.resumeFrom > 0, `resumeFrom 应 > 0，实际 ${rs.resumeFrom}`);
    assert(rs.member.status === 'running', `resume 后成员应为 running，实际 ${rs.member.status}`);

    await waitFor('done after resume', async () => (await s.api.get(`/api/tasks/${task.id}`)).status === 'done', { timeout: 25000 });

    const steps = await s.api.get(`/api/steps?member=${m.id}&limit=500`);
    const seqs = steps.items.map((e) => e.seq);
    for (let i = 0; i < seqs.length; i++) assert(seqs[i] === i + 1, `seq 必须从 1 连续无空洞：位置 ${i} 为 ${seqs[i]}`);
    assert(new Set(seqs).size === seqs.length, 'seq 不得重复');

    // 每个 plan step 至多完成一次（不重做已完成单元）
    const okCount = new Map();
    for (const e of steps.items) {
      if (CONTROL_PHASES.has(e.phase)) continue;
      if (e.result !== 'OK') continue;
      const idx = e.meta?.stepIndex;
      if (!Number.isInteger(idx) || idx < 0) continue;
      okCount.set(idx, (okCount.get(idx) || 0) + 1);
    }
    for (const [idx, n] of okCount) assert(n === 1, `stepIndex=${idx} 完成了 ${n} 次，说明 resume 重做了单元`);
    assert(okCount.size >= 9, `10 步中应至少完成 9 步（被中断的一步允许未完成），实际 ${okCount.size}`);
    assert(interruptedIdx >= 0, '被中断的 stepIndex 应可识别');

    // 终态：不能是 running
    const fin = await s.api.get(`/api/status?member=${m.id}`);
    assert(fin.members[0].status !== 'running', '事件结束后不得残留 running');
    assert(fin.members[0].currentTaskId === null, '任务结束后 currentTaskId 应为空');

    // C2 对账
    const verify = await s.api.get(`/api/verify?team=${team.id}`);
    assert(verify.ok, `member_state 必须可由 event 重建：${JSON.stringify(verify.mismatches).slice(0, 300)}`);

    return `interrupt 可见 ${visible}ms；resumeFrom=${rs.resumeFrom}；seq=${seqs.length} 连续；完成 ${okCount.size} 步无重复`;
  } finally {
    if (s) await s.close();
    tmp.cleanup();
  }
});

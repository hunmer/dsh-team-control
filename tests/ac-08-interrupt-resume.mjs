// AC-8：agent 运行时 interrupt → resume → 重新派发。seq 连续无重复；无僵尸 running。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, sleep } from './lib/harness.mjs';

const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

await runAc('AC-8', async () => {
  const tmp = mkTmp('ac08');
  let s;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;
    const team = await api.post('/api/teams', { name: 'ac8', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 });
    const m = one(await api.post('/api/agents/register', { teamId: team.id, name: 'lab-alpha', sessionId: 'sess_ac08' }), 'member');
    const task = await api.post('/api/tasks', {
      teamId: team.id, subject: 'long run', assignee: m.id,
      plan: Array.from({ length: 10 }, (_, i) => ({ step: `S${i + 1}`, detail: `第 ${i + 1} 步` })),
    });

    await sleep(400);
    const claimed = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(claimed.task?.id, task.id, '任务派发');
    await waitFor('running', async () => (await api.get(`/api/status?member=${m.id}`)).members[0].status === 'running', { timeout: 5000 });

    const t0 = Date.now();
    const res = await api.post(`/api/members/${m.id}/interrupt`, { reason: 'ac8' });
    const visible = Date.now() - t0;
    assertEqual(res.member.status, 'interrupted', 'interrupt 响应状态');
    const after = await api.get(`/api/status?member=${m.id}`);
    assertEqual(after.members[0].status, 'interrupted', 'interrupt 后立即可见');
    assert(visible < 500, `interrupt 可见耗时 ${visible}ms 应 < 500ms`);

    for (let i = 0; i < 3; i++) {
      await sleep(100);
      const q = await api.get(`/api/status?member=${m.id}`);
      assert(q.members[0].status !== 'running', '不得残留 running 僵尸态');
    }
    assertEqual((await api.get(`/api/tasks/${task.id}`)).status, 'ready', '任务退回 ready');

    const before = await api.get(`/api/steps?member=${m.id}&limit=500`);
    assert(before.items.some((e) => e.action === 'agent.interrupt'), '必须落一条 agent.interrupt 事件');

    const rs = await api.post(`/api/members/${m.id}/resume`, {});
    assertEqual(rs.member.status, 'idle', 'resume 后成员回到 idle');
    assertEqual(rs.resumeFrom, null, 'agent 运行时没有 worker 步进锚点');

    // 重新派发并完成
    const again = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(again.task?.id, task.id, 'resume 后任务可再次派发');
    await api.post('/api/agents/report', { sessionId: 'sess_ac08', taskId: task.id, status: 'done', summary: 'done after resume' });
    assertEqual((await api.get(`/api/tasks/${task.id}`)).status, 'done', '任务完成');

    const steps = await api.get(`/api/steps?member=${m.id}&limit=500`);
    const seqs = steps.items.map((e) => e.seq);
    for (let i = 0; i < seqs.length; i++) assert(seqs[i] === i + 1, `seq 必须从 1 连续无空洞：位置 ${i} 为 ${seqs[i]}`);
    assertEqual(new Set(seqs).size, seqs.length, 'seq 不得重复');

    const fin = await api.get(`/api/status?member=${m.id}`);
    assert(fin.members[0].status !== 'running', '结束后不得残留 running');
    assertEqual(fin.members[0].currentTaskId, null, '任务结束后 currentTaskId 为空');

    const verify = await api.get(`/api/verify?team=${team.id}`);
    assert(verify.ok, `member_state 必须可由 event 重建：${JSON.stringify(verify.mismatches).slice(0, 300)}`);

    return `interrupt 可见 ${visible}ms；resume 回 idle 后重新派发并完成；seq=${seqs.length} 连续；verify ok`;
  } finally {
    if (s) await s.close();
    tmp.cleanup();
  }
});

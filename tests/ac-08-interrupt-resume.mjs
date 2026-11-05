// AC-8：agent 运行时 interrupt → paused（不计 attempts、不自动重派）→ resume/assign → 完成；abort 作废。
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
      teamId: team.id, subject: 'long run', assignee: m.id, failurePolicy: 'retry', maxAttempts: 3,
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
    const paused = await api.get(`/api/tasks/${task.id}`);
    assertEqual(paused.status, 'paused', '任务转 paused 等 Lead 处置');
    assertEqual(paused.attempts, 1, 'interrupt 不计 attempts、不触发 failurePolicy 重试');

    // 超过 retry 退避窗口也不得被自动重派/唤醒
    await sleep(800);
    const still = await api.get(`/api/tasks/${task.id}`);
    assertEqual(still.status, 'paused', 'interrupt 后不得自动重派');
    assertEqual(still.attempts, 1, 'interrupt 后 attempts 不变');
    assertEqual((await api.get(`/api/status?member=${m.id}`)).members[0].status, 'interrupted', '成员保持 interrupted');

    const before = await api.get(`/api/steps?member=${m.id}&limit=500`);
    assert(before.items.some((e) => e.action === 'agent.interrupt'), '必须落一条 agent.interrupt 事件');

    const rs = await api.post(`/api/members/${m.id}/resume`, {});
    assertEqual(rs.member.status, 'idle', 'resume 后成员回到 idle');
    assertEqual(rs.resumeFrom, null, 'agent 运行时没有 worker 步进锚点');

    // paused 任务必须由 Lead 显式重新指派后才可再次派发
    const unassigned = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(unassigned.dispatched, false, 'paused 任务不会被派发泵自动认领');
    const as = await api.post(`/api/members/${m.id}/assign`, { taskId: task.id });
    assertEqual(as.task.status, 'ready', 'Lead 重新指派后任务回 ready');

    const again = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(again.task?.id, task.id, 'assign 后任务可再次派发');
    assertEqual(again.task.attempts, 2, '重新派发才计一次 attempt');
    await api.post('/api/agents/report', { sessionId: 'sess_ac08', taskId: task.id, status: 'done', summary: 'done after resume' });
    assertEqual((await api.get(`/api/tasks/${task.id}`)).status, 'done', '任务完成');

    // Lead 作废：任务转终态 aborted，不计重试
    const t2 = await api.post('/api/tasks', {
      teamId: team.id, subject: 'to abort', assignee: m.id, failurePolicy: 'retry', maxAttempts: 3,
      plan: [{ step: 'S1', detail: '一步' }],
    });
    await sleep(400);
    const claimed2 = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(claimed2.task?.id, t2.id, '作废用例任务派发');
    const ab = await api.post(`/api/tasks/${t2.id}/abort`, { reason: 'ac8 abort' });
    assertEqual(ab.task.status, 'aborted', 'abort 立即作废');
    assertEqual(ab.wasRunning, true, 'abort 时任务在运行');
    assertEqual(ab.task.attempts, 1, 'abort 不计 attempts');
    assertEqual((await api.get(`/api/status?member=${m.id}`)).members[0].status, 'interrupted', 'abort 运行中任务顺带中断成员');

    const rs2 = await api.post(`/api/members/${m.id}/resume`, {});
    assertEqual(rs2.member.status, 'idle', 'abort 后成员可 resume');
    await sleep(500);
    const abAfter = await api.get(`/api/tasks/${t2.id}`);
    assertEqual(abAfter.status, 'aborted', 'abort 后不得被重试/完成覆盖');
    assertEqual(abAfter.attempts, 1, 'abort 后 attempts 不变');

    const steps = await api.get(`/api/steps?member=${m.id}&limit=500`);
    const seqs = steps.items.map((e) => e.seq);
    for (let i = 0; i < seqs.length; i++) assert(seqs[i] === i + 1, `seq 必须从 1 连续无空洞：位置 ${i} 为 ${seqs[i]}`);
    assertEqual(new Set(seqs).size, seqs.length, 'seq 不得重复');

    const fin = await api.get(`/api/status?member=${m.id}`);
    assert(fin.members[0].status !== 'running', '结束后不得残留 running');
    assertEqual(fin.members[0].currentTaskId, null, '任务结束后 currentTaskId 为空');

    const verify = await api.get(`/api/verify?team=${team.id}`);
    assert(verify.ok, `member_state 必须可由 event 重建：${JSON.stringify(verify.mismatches).slice(0, 300)}`);

    return `interrupt 可见 ${visible}ms；paused 不计 attempts、不自动重派；resume/assign 后完成；abort 作废；seq=${seqs.length} 连续；verify ok`;
  } finally {
    if (s) await s.close();
    tmp.cleanup();
  }
});

// AC-9：kill sidecar(SIGKILL) 后重启，状态完整恢复、无静默丢失（真实 kill，禁止 mock crash）
import { runAc, mkTmp, startSidecar, waitFor, assert, sleep } from './lib/harness.mjs';

await runAc('AC-9', async () => {
  const tmp = mkTmp('ac09');
  let s; let s2;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const team = await s.api.post('/api/teams', { name: 'ac9', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 });
    await s.api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'fs', matcher: '**', ops: ['write', 'delete', 'rename'], mode: 'allow',
    });
    const m = await s.api.post(`/api/teams/${team.id}/members`, { name: 'lab-alpha', role: 'worker' });
    const plan = [
      { step: 'S1', phase: 'write', action: 'write', target: 'survive.txt', op: { kind: 'fs.write', args: { path: 'survive.txt', content: 'written-before-crash\n' } } },
      ...Array.from({ length: 12 }, (_, i) => ({ step: `S${i + 2}`, phase: 'wait', action: 'sleep', target: `tick-${i + 1}`, op: { kind: 'sleep', args: { ms: 150 } } })),
    ];
    const task = await s.api.post('/api/tasks', { teamId: team.id, subject: 'survive crash', assignee: m.id, plan });

    await waitFor('progress before kill', async () => {
      const st = await s.api.get(`/api/status?member=${m.id}`);
      return st.members[0].seq >= 4 && st.members[0].status === 'running';
    }, { timeout: 20000 });

    const tasksBefore = await s.api.get(`/api/tasks?team=${team.id}`);
    const stepsBefore = await s.api.get(`/api/steps?member=${m.id}&limit=500`);
    assert(tmp.exists('survive.txt'), 'kill 前应已写入 survive.txt');

    // 真实 SIGKILL（不是 mock crash、不是优雅退出）
    const pid = s.pid;
    await s.hardKill();
    assert(s.child.exitCode !== null || s.child.signalCode !== null, `sidecar(pid=${pid}) 必须已退出`);

    // 等孤儿 worker 因 stdin 断开自行退出
    await sleep(500);

    s2 = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    assert(s2.recovered >= 1, `重启后应恢复 >=1 个任务，实际 recovered=${s2.recovered}`);

    const st = await s2.api.get(`/api/status?team=${team.id}`);
    assert(st.members.length === 1, '成员不得丢失');
    assert(st.members[0].status !== 'running', `重启后不得残留 running，实际 ${st.members[0].status}`);
    assert(['interrupted', 'failed', 'idle', 'done'].includes(st.members[0].status), `重启后成员状态异常：${st.members[0].status}`);

    const tasksAfter = await s2.api.get(`/api/tasks?team=${team.id}`);
    assert(tasksAfter.items.length === tasksBefore.items.length, '任务不得静默丢失');
    const t = tasksAfter.items.find((x) => x.id === task.id);
    assert(t, '任务必须仍存在');
    assert(['ready', 'running', 'done', 'failed'].includes(t.status), `任务状态异常：${t.status}`);
    assert(t.attempts >= 1, 'attempts 必须保留');

    // 事件流完整：不丢、seq 连续
    const stepsAfter = await s2.api.get(`/api/steps?member=${m.id}&limit=500`);
    assert(stepsAfter.items.length >= stepsBefore.items.length, `事件不得丢失：kill前 ${stepsBefore.items.length}，重启后 ${stepsAfter.items.length}`);
    for (let i = 0; i < stepsAfter.items.length; i++) {
      assert(stepsAfter.items[i].seq === i + 1, `seq 必须连续：位置 ${i} 是 ${stepsAfter.items[i].seq}`);
    }

    // C2 对账 + 恢复事件
    const verify = await s2.api.get(`/api/verify?team=${team.id}`);
    assert(verify.ok, `member_state 必须可由 event 重建：${JSON.stringify(verify.mismatches).slice(0, 300)}`);
    assert(stepsAfter.items.some((e) => e.phase === 'recover'), '必须落一条 recover 事件（不允许静默恢复）');

    // 恢复后可以真正继续跑完
    await s2.api.post(`/api/members/${m.id}/resume`, {});
    await waitFor('done after recovery', async () => (await s2.api.get(`/api/tasks/${task.id}`)).status === 'done', { timeout: 25000 });
    assert(tmp.read('survive.txt').includes('written-before-crash'), '崩溃前的写不能丢');

    return `SIGKILL 后恢复 ${s2.recovered} 个任务；kill 前 ${stepsBefore.items.length} 事件全部保留且 seq 连续；resume 后跑完`;
  } finally {
    if (s2) await s2.close();
    if (s && s.child.exitCode === null && s.child.signalCode === null) await s.close();
    tmp.cleanup();
  }
});

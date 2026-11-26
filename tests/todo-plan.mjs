// tests/todo-plan.mjs — 任务级计划清单（todo.task_id）与 dsh_team_todo 的 REST 层
// 断言：① 未派发任务也能写计划（事件流按成员分片，归属不到成员时跳过事件而不是 400）；
//       ② POST /api/tasks/:id/todos 落盘并带 task_id、orderNo 按顺序；GET ?task= 只返回该任务；
//       ③ 再次 POST 是「整体替换」（旧行删除）；④ 校验（>50 条 / 空标题 / 非法 status / 未知任务）；
//       ⑤ 已派发任务写入时事件流出现 action=task.todo、target=`done/total done`、meta.by 记录写入者。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-todo-plan';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);
const PLAN = [{ step: 'S1', phase: 'wait', action: 'sleep', target: 't', op: { kind: 'sleep', args: { ms: 400 } } }];

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-todo');
  let sidecar = null;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', { name: 'todo-plan', workspace: tmp.ws, maxMembers: 2 }), 'team');

    // ---- ① 未派发任务：Leader 先写计划，不能报 400（此前 events.append 强制 memberId 会炸） ----
    const queued = one(await api.post('/api/tasks', { teamId: team.id, subject: '排队中的任务', plan: PLAN }), 'task');
    const w0 = await api.post(`/api/tasks/${queued.id}/todos`, {
      by: 'lead',
      items: [{ title: '读第一章结尾与大纲', status: 'done' }, { title: '列场景清单', status: 'open' }],
    });
    assertEqual(w0.items.length, 2, '未派发任务也能写计划');
    assert(w0.items.every((t) => t.taskId === queued.id), '所有 todo 都带 task_id');

    // ---- ② 结构：orderNo 按提交顺序、状态原样、GET ?task= 过滤 ----
    const w1 = await api.post(`/api/tasks/${queued.id}/todos`, {
      by: 'lead',
      items: [
        { title: '读第一章结尾与大纲', status: 'done' },
        { title: '列场景清单', status: 'done' },
        { title: '写初稿', status: 'active' },
      ],
    });
    assertEqual(w1.items.length, 3, '写入 3 条');
    assertEqual(w1.items.map((t) => t.orderNo).join(','), '0,1,2', 'orderNo 按提交顺序');
    assertEqual(w1.items.map((t) => t.status).join(','), 'done,done,active', '状态原样保存');

    const g1 = await api.get(`/api/todos?team=${team.id}&task=${queued.id}`);
    assertEqual(g1.items.length, 3, 'GET 按 task 过滤出 3 条');

    // 成员级待办不混入任务清单
    await api.post('/api/todos', { teamId: team.id, title: '成员自己的待办' });
    const g2 = await api.get(`/api/todos?team=${team.id}&task=${queued.id}`);
    assertEqual(g2.items.length, 3, '任务清单不受成员待办影响');

    // ---- ③ 整体替换 ----
    const w2 = await api.post(`/api/tasks/${queued.id}/todos`, {
      by: 'lead',
      items: [
        { title: '写初稿', status: 'done' },
        { title: '验收：一致性检查', status: 'blocked', blockedBy: ['等待校对'] },
      ],
    });
    assertEqual(w2.items.length, 2, '替换后条数 = 2');
    assertEqual(w2.items.map((t) => t.title).join('|'), '写初稿|验收：一致性检查', '替换后标题为新清单');
    assertEqual(w2.items[1].blockedBy[0], '等待校对', 'blockedBy 保存');
    const g3 = await api.get(`/api/todos?team=${team.id}&task=${queued.id}`);
    assertEqual(g3.items.length, 2, '替换后 GET 只剩 2 条（旧行已删）');

    // ---- ④ 校验 ----
    for (const [label, body] of [
      ['>50 条', { items: Array.from({ length: 51 }, (_, i) => ({ title: `t${i}` })) }],
      ['空标题', { items: [{ title: '  ' }] }],
      ['非法 status', { items: [{ title: 'x', status: 'bogus' }] }],
    ]) {
      let status = 0;
      try { await api.post(`/api/tasks/${queued.id}/todos`, body); } catch (e) { status = e.status; }
      assertEqual(status, 400, `${label} 必须 400`);
    }
    let missing = 0;
    try { await api.post('/api/tasks/task_not_exist/todos', { items: [{ title: 'x' }] }); } catch (e) { missing = e.status; }
    assertEqual(missing, 404, '未知任务 404');

    // 未派发任务的写入不产生成员事件（事件流没有可归属的成员）
    const h0 = await api.get(`/api/events/history?team=${team.id}&since=0`);
    assertEqual(h0.items.filter((e) => e.action === 'task.todo' && e.taskId === queued.id).length, 0, '未派发任务不写成员事件');

    // ---- ⑤ 已派发任务：事件 target 显示进度、meta.by 记录写入者 ----
    const member = one(await api.post('/api/agents/register', { teamId: team.id, name: 'writer', sessionId: 'sess_todo' }), 'member');
    await new Promise((r) => setTimeout(r, 400));
    const claimed = await api.post('/api/agents/dispatch', { teamId: team.id });
    assertEqual(claimed.task?.id, queued.id, '排队中的任务被派发给 agent');
    const running = queued;
    const w3 = await api.post(`/api/tasks/${running.id}/todos`, {
      by: member.id,
      items: [{ title: '写初稿', status: 'done' }, { title: '验收', status: 'active' }],
    });
    assertEqual(w3.items.length, 2, '运行中任务可写计划');
    const last = await waitFor('task.todo 事件写入事件流', async () => {
      const h = await api.get(`/api/events/history?team=${team.id}&since=0`);
      const rows = h.items.filter((e) => e.action === 'task.todo' && e.taskId === running.id);
      return rows.length ? rows[rows.length - 1] : null;
    });
    assertEqual(last.target, '1/2 done', '事件 target 显示完成进度');
    assertEqual(last.memberId, member.id, '事件归属到成员');
    assertEqual(last.meta.by, member.id, '事件记录写入者');
    assertEqual(last.meta.total, 2, '事件 meta.total');
    assertEqual(last.phase, 'step', '事件 phase=step');

    // ---- ⑥ 成员报告完成：该任务清单自动全部打勾，并写一条 task.todo 事件 ----
    const rep = await api.post('/api/agents/report', {
      sessionId: 'sess_todo', taskId: running.id, status: 'done', summary: '初稿写完，验收通过',
    });
    assertEqual(rep.status, 'done', '成员报告任务完成');
    const g4 = await api.get(`/api/todos?team=${team.id}&task=${running.id}`);
    assertEqual(g4.items.map((t) => t.status).join(','), 'done,done', '报告完成后清单全部打勾');
    assert(g4.items.every((t) => t.doneAt), '打勾项都记录 doneAt');
    const autoTick = await waitFor('自动打勾写 task.todo 事件', async () => {
      const h = await api.get(`/api/events/history?team=${team.id}&since=0`);
      const rows = h.items.filter((e) => e.action === 'task.todo' && e.taskId === running.id);
      return rows.length >= 2 ? rows[rows.length - 1] : null;
    });
    assertEqual(autoTick.target, '2/2 done', '自动打勾事件显示 2/2 done');
    assertEqual(autoTick.memberId, member.id, '自动打勾事件归属成员');

    // ---- ⑦ 报告失败不打勾：未完成就是未完成，不能被标成 done ----
    const t2 = one(await api.post('/api/tasks', { teamId: team.id, subject: '会失败的任务', plan: PLAN }), 'task');
    await api.post(`/api/tasks/${t2.id}/todos`, { items: [{ title: '只做一半', status: 'active' }] });
    await waitFor('成员完成上一任务后回到 idle', async () => {
      const st = await api.get(`/api/status?team=${team.id}`);
      const m = (st.members || []).find((x) => x.id === member.id);
      return m?.status === 'idle' ? m : null;
    });
    const claimed2 = await waitFor('第二个任务派发给同一成员', async () => {
      const r = await api.post('/api/agents/dispatch', { teamId: team.id });
      return r.task?.id === t2.id ? r : null;
    });
    assertEqual(claimed2.task?.id, t2.id, '第二个任务派发给同一成员');
    await api.post('/api/agents/report', {
      sessionId: 'sess_todo', taskId: t2.id, status: 'failed', summary: '这一步做不下去',
    });
    const g5 = await api.get(`/api/todos?team=${team.id}&task=${t2.id}`);
    assertEqual(g5.items.map((t) => t.status).join(','), 'active', '失败报告不改清单状态');

    return 'task_id 关联 / 未派发可写 / 整体替换 / 校验 / 事件进度 / 完成自动打勾 / 失败不打勾 全部通过';
  } finally {
    if (sidecar) await sidecar.close();
    tmp.cleanup();
  }
});

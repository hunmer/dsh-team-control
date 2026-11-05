// tests/ac-18-board.mjs — 工作区任务看板：状态机、并发槽位、claim/attach、同会话/新会话、封存
import { mkTmp, startSidecar, assert, assertEqual, sleep } from './lib/harness.mjs';

const main = async () => {
  const tmp = mkTmp('dsh-team-board');
  const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-board', title: 'Board', path: tmp.ws }] });

    // auto=0：不 claim；start 之后才入队
    let t1 = await api.post('/api/board/tasks', {
      workspaceId: 'ws-board', title: '任务一', description: '只回复 OK', auto: false,
      executionMode: 'same', teamModels: [{ provider: 'p', model: 'm1' }],
    });
    assertEqual(t1.status, 'todo', '新建任务在 todo');
    assertEqual((await api.post('/api/board/claim', { kind: 'planning' })).item, null, 'auto=0 不 claim');
    t1 = await api.post(`/api/board/tasks/${t1.id}/start`, { executionMode: 'same' });
    assertEqual(t1.auto, true, 'start 打开 auto');

    // 并发 1：claim 一个规划后，第二个任务拿不到槽位
    const t2 = await api.post('/api/board/tasks', {
      workspaceId: 'ws-board', title: '任务二', auto: true, executionMode: 'new',
    });
    const c1 = await api.post('/api/board/claim', { kind: 'planning' });
    assert(c1.item, 'claim 到规划槽位');
    assertEqual(c1.item.task.id, t1.id, '先入队的先 claim');
    assertEqual((await api.post('/api/board/claim', { kind: 'planning' })).item, null, '并发 1 只放一个');

    const attached = await api.post(`/api/board/tasks/${t1.id}/attach`, {
      kind: 'planning', sessionId: 'session-plan-1', fence: c1.item.fence,
    });
    assertEqual(attached.planningSessionId, 'session-plan-1', '规划会话已绑定');

    // 规划提交：same 模式把 lead_session_id 写成同一会话
    const planned = await api.post('/api/board/agents/plan', {
      sessionId: 'session-plan-1', plan: '# 计划\n1. 做', summary: '一句话',
    });
    assertEqual(planned.status, 'planned', '提交计划后 planned');
    assertEqual(planned.leadSessionId, 'session-plan-1', 'same 模式复用规划会话');
    assertEqual((await api.get(`/api/board/by-session/session-plan-1`)).id, t1.id, 'by-session 反查');
    assertEqual((await api.post('/api/board/claim', { kind: 'planning' })).item.task.id, t2.id, '规划槽位释放后 claim 第二个');

    // 执行槽位：planned -> inprogress，同会话 attach
    const c2 = await api.post('/api/board/claim', { kind: 'inprogress' });
    assertEqual(c2.item.task.id, t1.id, 'claim 执行槽位');
    await api.post(`/api/board/tasks/${t1.id}/attach`, {
      kind: 'inprogress', sessionId: 'session-plan-1', fence: c2.item.fence,
    });
    assertEqual((await api.get(`/api/board/tasks/${t1.id}`)).status, 'inprogress', '执行中');

    // done -> 用户追问 -> inprogress
    let done = await api.post('/api/board/agents/status', { sessionId: 'session-plan-1', status: 'done', summary: '完成' });
    assertEqual(done.status, 'done', 'Lead 置 done');
    done = await api.post('/api/board/agents/status', { sessionId: 'session-plan-1', status: 'inprogress' });
    assertEqual(done.status, 'inprogress', '用户追问翻回 inprogress');
    await api.post('/api/board/agents/status', { sessionId: 'session-plan-1', status: 'failed', summary: '挂了' });

    // 失败重试：有计划回 planned
    const retried = await api.post(`/api/board/tasks/${t1.id}/retry`);
    assertEqual(retried.status, 'planned', '失败重试回 planned');

    // 活动任务不能封存；先 stop 再 archive；再 restore
    let blocked = false;
    try { await api.post(`/api/board/tasks/${t1.id}/archive`); } catch (e) { blocked = e.status === 409; }
    assert(blocked, '活动任务禁止封存');
    await api.post(`/api/board/tasks/${t1.id}/stop`, { reason: '测试停止' });
    const archived = await api.post(`/api/board/tasks/${t1.id}/archive`);
    assert(archived.archivedAt, '停止后可封存');
    const restored = await api.post(`/api/board/tasks/${t1.id}/restore`);
    assertEqual(restored.status, 'failed', '恢复保留封存前状态');

    // 团队绑定 + by-team
    await api.post(`/api/board/tasks/${t1.id}/teams`, { teamId: 'team-x' });
    assertEqual((await api.get('/api/board/by-team/team-x')).id, t1.id, 'by-team 反查');

    // 设置并发 2：两个 todo 可同时 planning
    await api.put('/api/board/settings', {
      workspaceId: 'ws-board', planningConcurrency: 2, inprogressConcurrency: 2,
      planPermissionPreset: 'read-only', leadPermissionPreset: 'danger-full-access',
    });
    // 清掉前面 claim 但未 attach 的 t2，让两个 todo 同时入队（t1 已封存恢复过，不再复用）
    try { await api.post(`/api/board/tasks/${t2.id}/stop`, { reason: 'reset' }); } catch { /* ignore */ }
    await api.post(`/api/board/tasks/${t2.id}/retry`);
    await api.post('/api/board/tasks', {
      workspaceId: 'ws-board', title: '任务三', auto: true, executionMode: 'new',
    });
    const a = await api.post('/api/board/claim', { kind: 'planning' });
    const b = await api.post('/api/board/claim', { kind: 'planning' });
    assert(a.item && b.item, '并发 2 可同时 claim 两个规划');
    assert(a.item.task.id !== b.item.task.id, 'claim 不同任务');

    const view = await api.get('/api/board?workspaceId=ws-board');
    assertEqual(view.settings.planningConcurrency, 2, '设置已持久化');
    assertEqual(view.settings.showTaskSessions, true, '默认把任务会话挂进工作区会话列表');
    const hidden = await api.put('/api/board/settings', { workspaceId: 'ws-board', showTaskSessions: false });
    assertEqual(hidden.showTaskSessions, false, '可关闭工作区会话显示');
    const shown = await api.put('/api/board/settings', { workspaceId: 'ws-board', showTaskSessions: true });
    assertEqual(shown.showTaskSessions, true, '可重新开启工作区会话显示');
    assertEqual(view.settings.dshWebUrl, null, 'DSH Web 地址默认未上报');
    await api.post('/api/host/web', { url: 'http://127.0.0.1:3080/' });
    const withWeb = await api.get('/api/board?workspaceId=ws-board');
    assertEqual(withWeb.settings.dshWebUrl, 'http://127.0.0.1:3080', 'Host 上报的 DSH Web 地址透出到设置');
    assert(view.tasks.length >= 2, '看板返回任务');

    // 看板 stop 联动绑定团队：在途任务转 paused，成员转 interrupted
    const stopTeam = await api.post('/api/teams', {
      name: 'board-stop-team', workspace: tmp.ws, maxConcurrency: 1,
    });
    const stopMember = await api.post(`/api/teams/${stopTeam.id}/members`, {
      name: 'board-stop-worker', agentSessionId: 'sess-board-stop',
    });
    const teamTask = await api.post('/api/tasks', {
      teamId: stopTeam.id, subject: '看板停止联动',
    });
    await sleep(250);
    const claim = await api.post('/api/agents/dispatch', { teamId: stopTeam.id });
    assertEqual(claim.dispatched, true, '看板联动用例任务已派发');
    await api.put('/api/board/settings', {
      workspaceId: 'ws-board', planningConcurrency: 5, inprogressConcurrency: 5,
    });
    const boardStop = await api.post('/api/board/tasks', {
      workspaceId: 'ws-board', title: '停止联动', auto: true, priority: 1000,
    });
    const planClaim = await api.post('/api/board/claim', { kind: 'planning' });
    assertEqual(planClaim.item.task.id, boardStop.id, '联动用例拿到规划槽位');
    await api.post(`/api/board/tasks/${boardStop.id}/attach`, {
      kind: 'planning', sessionId: 'sess-board-stop-plan', fence: planClaim.item.fence,
    });
    await api.post('/api/board/agents/plan', {
      sessionId: 'sess-board-stop-plan', plan: '# 停止联动', summary: '联动',
    });
    const execClaim = await api.post('/api/board/claim', { kind: 'inprogress' });
    assertEqual(execClaim.item.task.id, boardStop.id, '联动用例拿到执行槽位');
    await api.post(`/api/board/tasks/${boardStop.id}/attach`, {
      kind: 'inprogress', sessionId: 'sess-board-stop-plan', fence: execClaim.item.fence,
    });
    await api.post(`/api/board/tasks/${boardStop.id}/teams`, { teamId: stopTeam.id });
    await api.post(`/api/board/tasks/${boardStop.id}/stop`, { reason: '联动测试' });
    assertEqual((await api.get(`/api/tasks/${teamTask.id}`)).status, 'paused', '看板停止暂停绑定团队任务');
    assertEqual(
      (await api.get(`/api/status?member=${stopMember.id}`)).members[0].status,
      'interrupted',
      '看板停止中断绑定团队成员',
    );

    // 删除：活动任务拒绝；failed/封存恢复过的任务连同团队绑定一并删除
    let deleteBlocked = false;
    try { await api.del(`/api/board/tasks/${a.item.task.id}`); } catch (e) { deleteBlocked = e.status === 409; }
    assert(deleteBlocked, '活动任务禁止删除');
    const removed = await api.del(`/api/board/tasks/${t1.id}`);
    assertEqual(removed.id, t1.id, '删除返回任务 id');
    let gone = false;
    try { await api.get(`/api/board/tasks/${t1.id}`); } catch (e) { gone = e.status === 404; }
    assert(gone, '删除后任务不存在');
    assertEqual((await api.get('/api/board/by-team/team-x')).ok, false, '团队绑定随任务删除');

    console.log('ac-18 board: ok');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });

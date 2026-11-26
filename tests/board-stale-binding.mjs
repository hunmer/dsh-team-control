// tests/board-stale-binding.mjs — 启动自检：done / 已归档 / 被恢复回 todo 的任务上残留的 planning_session_id 必须被解绑。
// 否则一个早已结束的规划会话会继续被当成「当前规划会话」：提交计划找不到合法状态（404），脏绑定也永远不会自愈。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkTmp, startSidecar, assert, assertEqual, runAc } from './lib/harness.mjs';

const main = async () => {
  const tmp = mkTmp('dsh-team-stale-binding');
  let sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  let ids;
  try {
    const api = sidecar.api;
    await api.post('/api/workspaces', { items: [{ id: 'ws-stale', title: 'Stale', path: tmp.ws }] });
    const todoTask = await api.post('/api/board/tasks', { workspaceId: 'ws-stale', title: '回到待办但还绑着规划会话', auto: false });
    const doneTask = await api.post('/api/board/tasks', { workspaceId: 'ws-stale', title: '已完成但还绑着规划会话', auto: false });
    const archivedTask = await api.post('/api/board/tasks', { workspaceId: 'ws-stale', title: '已归档但还绑着规划会话', auto: false });
    ids = { todoTask: todoTask.id, doneTask: doneTask.id, archivedTask: archivedTask.id };
  } finally {
    await sidecar.close();
  }

  // sidecar 已停，直接改库造脏行（Windows 上句柄已释放）；这是真实库里出现过的形态：
  // 状态回到 todo / 已完成 / 已归档，但规划会话绑定还留着。
  const db = new DatabaseSync(path.join(tmp.dataDir, 'team.db'));
  const stamp = new Date().toISOString();
  try {
    db.prepare("UPDATE board_task SET status='todo', planning_session_id='session-stale-todo', updated_at=? WHERE id=?").run(stamp, ids.todoTask);
    db.prepare("UPDATE board_task SET status='done', done_at=?, planning_session_id='session-stale-done', updated_at=? WHERE id=?").run(stamp, stamp, ids.doneTask);
    db.prepare("UPDATE board_task SET status='done', done_at=?, archived_at=?, planning_session_id='session-stale-archived', updated_at=? WHERE id=?").run(stamp, stamp, stamp, ids.archivedTask);
  } finally {
    db.close();
  }

  sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  try {
    const api = sidecar.api;
    // 归档任务不在 /api/board 默认列表里，逐条取
    const todoTask = await api.get(`/api/board/tasks/${ids.todoTask}`);
    const doneTask = await api.get(`/api/board/tasks/${ids.doneTask}`);
    const archivedTask = await api.get(`/api/board/tasks/${ids.archivedTask}`);
    assertEqual(todoTask.planningSessionId, null, 'todo 任务的残留规划会话已解绑');
    assertEqual(doneTask.planningSessionId, null, 'done 任务的残留规划会话已解绑');
    assertEqual(archivedTask.planningSessionId, null, '归档任务的残留规划会话已解绑');
    assert(archivedTask.archivedAt, '归档状态本身保留');
    const log = [...sidecar.stdout, ...sidecar.stderr].join('\n');
    assert(log.includes('残留规划会话绑定'), '启动日志记录了解绑动作');
    // 被解绑的旧会话再提交计划：只能 404（带 hint），不能复活到别的任务上
    const stale = await api.post('/api/board/agents/plan', {
      sessionId: 'session-stale-todo', plan: '# 旧计划\n1. 无效',
    }).then(() => null, (e) => e);
    assertEqual(stale?.status, 404, '被解绑的会话提交计划仍是 404');
    assertEqual(typeof stale?.body?.error?.detail?.hint, 'string', '404 带 detail.hint');
  } finally {
    await sidecar.close();
    tmp.cleanup();
  }
  return 'todo/done/archived 残留绑定在启动时解绑，归档保留，旧会话提交 404';
};

runAc('board-stale-binding', main);

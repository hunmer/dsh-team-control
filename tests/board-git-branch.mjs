// tests/board-git-branch.mjs — 看板任务 git 分支：'' 自动生成 task/<短号>、指定名、null 不切、PATCH 改/清、非法名 400
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';

const tmp = mkTmp('dsh-board-git-branch');
const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
try {
  const api = sidecar.api;
  await api.post('/api/workspaces', { items: [{ id: 'ws-g', title: 'G', path: tmp.ws }] });

  const auto = await api.post('/api/board/tasks', { workspaceId: 'ws-g', title: '自动分支', gitBranch: '' });
  assert.match(auto.gitBranch, /^task\/[a-z0-9]{8}$/, `自动分支名: ${auto.gitBranch}`);

  const named = await api.post('/api/board/tasks', { workspaceId: 'ws-g', title: '指定分支', gitBranch: 'feat/x-1' });
  assert.equal(named.gitBranch, 'feat/x-1');

  const none = await api.post('/api/board/tasks', { workspaceId: 'ws-g', title: '不切分支' });
  assert.equal(none.gitBranch, null, '缺省不切分支');

  const patched = await api.patch(`/api/board/tasks/${none.id}`, { gitBranch: 'fix/y' });
  assert.equal(patched.gitBranch, 'fix/y', 'PATCH 改名');
  const cleared = await api.patch(`/api/board/tasks/${none.id}`, { gitBranch: null });
  assert.equal(cleared.gitBranch, null, 'PATCH null 清空');

  let err = null;
  try { await api.post('/api/board/tasks', { workspaceId: 'ws-g', title: 'x', gitBranch: 'bad..name' }); } catch (e) { err = e; }
  assert.equal(err?.status, 400, '非法分支名 400');
  err = null;
  try { await api.post('/api/board/tasks', { workspaceId: 'ws-g', title: 'x', gitBranch: '-lead' }); } catch (e) { err = e; }
  assert.equal(err?.status, 400, '以 - 开头的分支名 400');
  console.log('board-git-branch: ok');
} finally {
  await sidecar.close();
  tmp.cleanup();
}

// tests/ac-04-grant.mjs — AC-4：批准后单次写入成功 → 同路径二次写必须重新申请（grant 单次 + TTL）
// 真实进程：真 sidecar + 真 scope_request 阻塞等待 + 真 decision（落盘）+ 真 Worker 重试。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, sha256, readDb, fs } from './lib/harness.mjs';

/** 轮询 pending scope_request（worker 侧 RPC 是阻塞长轮询，这里模拟审批人异步决策） */
async function pendingRequests(api, teamId) {
  return (await api.get(`/api/scope-requests?team=${teamId}&status=pending`)).items;
}
async function waitPending(api, teamId, { exclude = null, timeout = 20000 } = {}) {
  return waitFor('pending scope_request', async () => {
    const items = await pendingRequests(api, teamId);
    return items.find((r) => r.id !== exclude) || null;
  }, { timeout, interval: 40 });
}

await runAc('AC-4', async () => {
  const tmp = mkTmp('dsh-team-ac04');
  let s = null;
  let done = false;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;

    // ---- 0) 前置：测试侧直接写 out/locked.txt = v1（不被 DB file_state 感知，验证 broker 真实磁盘 hash） ----
    fs.mkdirSync(tmp.file('out'), { recursive: true });
    fs.writeFileSync(tmp.file('out/locked.txt'), 'v1');
    const v1Hash = sha256(fs.readFileSync(tmp.file('out/locked.txt')));

    const team = await api.post('/api/teams', { name: 'ac04', workspace: tmp.ws, maxAttempts: 1, maxConcurrency: 4 });
    const member = await api.post(`/api/teams/${team.id}/members`, { name: 'writer' });

    // ---- 1) 两步都写同一路径：S1=v2（会被批准一次），S2=v3（必须重新申请） ----
    // 注意：默认策略未给 fs.write allow → 两次都会先被判 default deny，走 onDenied:'scope' 升级
    const task = await api.post('/api/tasks', {
      teamId: team.id, subject: 'ac04-single-use-grant', assignee: member.id, maxAttempts: 1,
      plan: [
        {
          step: 'S1', phase: 'write', action: 'write', target: 'out/locked.txt', domain: 'fs',
          onDenied: 'scope', scopeTimeoutMs: 60000,
          op: { kind: 'fs.write', args: { path: 'out/locked.txt', content: 'v2' } },
        },
        {
          step: 'S2', phase: 'write', action: 'write', target: 'out/locked.txt', domain: 'fs',
          onDenied: 'scope', scopeTimeoutMs: 60000,
          op: { kind: 'fs.write', args: { path: 'out/locked.txt', content: 'v3' } },
        },
      ],
    });

    // ---- 2) 等第一条 pending 请求 → 批准（TTL 60s + singleUse） ----
    const req1 = await waitPending(api, team.id);
    assertEqual(req1.domain, 'fs', '第一条 scope_request domain 必须是 fs');
    assertEqual(req1.target, 'out/locked.txt', '第一条 scope_request target 必须是 out/locked.txt');
    assertEqual(req1.status, 'pending', '批准前请求必须是 pending');

    const decided1 = await api.post(`/api/scope-requests/${req1.id}/decide`, {
      decision: 'approved', decidedBy: 'test', reason: 'AC-4 单次授权：只允许写这一路径', ttlSeconds: 60, singleUse: true,
    });
    assert(decided1.grant && decided1.grant.id, '批准必须返回 grant');
    const grant = decided1.grant;
    assertEqual(grant.matcher, 'out/locked.txt', 'grant matcher 必须精确匹配请求路径');
    assertEqual(Number(grant.singleUse), 1, 'grant 必须 singleUse=1');
    assertEqual(decided1.decision.chosen, 'approved', 'decision 必须落盘为 approved');

    // ---- 3) 断言：文件真的变成 v2（grant 生效、写入经过 broker） ----
    await waitFor('locked.txt == v2', () => fs.readFileSync(tmp.file('out/locked.txt'), 'utf8') === 'v2', { timeout: 15000 });
    const v2Hash = sha256(fs.readFileSync(tmp.file('out/locked.txt')));
    assert(v2Hash !== v1Hash, 'v2 的 hash 必须不同于 v1');

    // ---- 4) 断言：/api/steps 能查到 meta.grantId（FR-3.5 授权可追溯） ----
    const steps = async () => (await api.get(`/api/steps?member=${member.id}`)).items;
    // decision 事件也带 meta.grantId（phase=decision），这里只取「grant 真正被消费于写操作」的那条
    const grantEv = await waitFor('grantId 写入事件', async () => {
      return (await steps()).find((e) => e.meta?.grantId === grant.id && e.phase === 'fs' && e.action === 'write') || null;
    }, { timeout: 15000 });
    assertEqual(grantEv.result, 'OK', 'grant 消费后的写事件必须 result=OK');
    assert((await steps()).some((e) => e.phase === 'decision' && e.meta?.grantId === grant.id), 'decision 事件必须记 grantId');
    // S1 的 OK 事件也在
    assert((await steps()).some((e) => e.meta?.stepIndex === 0 && e.result === 'OK'), 'S1 写入成功事件必须存在');

    // ---- 5) 断言：readDb 里该 grant 的 used_at 非空、single_use=1（单次已消耗） ----
    const db1 = readDb(tmp.dataDir);
    try {
      const gRow = db1.get('SELECT id, matcher, single_use, used_at, expires_at FROM scope_grant WHERE id=?', grant.id);
      assert(gRow, `scope_grant 表中必须存在 grant ${grant.id}`);
      assertEqual(Number(gRow.single_use), 1, 'DB 中 grant single_use 必须为 1');
      assert(gRow.used_at, 'DB 中 grant used_at 必须非空（已消耗）');
      const dRow = db1.get('SELECT chosen, decided_by, request_id FROM decision WHERE request_id=?', req1.id);
      assert(dRow, 'decision 必须落盘（C4）');
      assertEqual(dRow.chosen, 'approved', 'DB 中 decision.chosen 必须 approved');
      assertEqual(dRow.decided_by, 'test', 'DB 中 decision.decided_by 必须记录决策人');
    } finally { db1.close(); }

    // ---- 6) 第二步必须创建第二条 pending 请求（id 不同），grant 已用掉不能再放行 ----
    const req2 = await waitPending(api, team.id, { exclude: req1.id });
    assert(req2.id !== req1.id, '第二次写必须创建新的 scope_request（id 不同）');
    assertEqual(req2.domain, 'fs', '第二条请求 domain 必须是 fs');
    assertEqual(req2.target, 'out/locked.txt', '第二条请求 target 相同路径');
    // 在拒绝前，磁盘上没有 v3 副作用
    assertEqual(fs.readFileSync(tmp.file('out/locked.txt'), 'utf8'), 'v2', '二次写未获批前文件必须仍是 v2');

    // ---- 7) 驳回第二条 → 任务 hard fail、文件内容仍 v2（无副作用） ----
    const decided2 = await api.post(`/api/scope-requests/${req2.id}/decide`, {
      decision: 'denied', decidedBy: 'test', reason: '单次授权已用尽，需重新评估', ttlSeconds: 60, singleUse: true,
    });
    assertEqual(decided2.decision.chosen, 'denied', '第二条 decision 必须落盘为 denied');
    assert(!decided2.grant, '驳回不得产生 grant');

    const failedTask = await waitFor('AC-4 任务终态', async () => {
      const t = await api.get(`/api/tasks/${task.id}`);
      return ['done', 'failed', 'skipped'].includes(t.status) ? t : null;
    }, { timeout: 20000 });
    assertEqual(failedTask.status, 'failed', '二次写被拒后任务必须 failed');

    const contentAfter = fs.readFileSync(tmp.file('out/locked.txt'), 'utf8');
    assertEqual(contentAfter, 'v2', '驳回后文件内容必须仍是 v2（零副作用，v3 未落盘）');
    assertEqual(sha256(fs.readFileSync(tmp.file('out/locked.txt'))), v2Hash, '驳回后文件 hash 必须仍是 v2 的 hash');

    // ---- 8) 汇总证据：请求状态/grant 唯一性/二次拒绝对应事件 ----
    const allReqs = (await api.get(`/api/scope-requests?team=${team.id}`)).items;
    const r1 = allReqs.find((r) => r.id === req1.id);
    const r2 = allReqs.find((r) => r.id === req2.id);
    assertEqual(r1.status, 'approved', '第一条请求最终状态 approved');
    assertEqual(r2.status, 'denied', '第二条请求最终状态 denied');
    assertEqual(r2.grantId, null, '被驳回的请求不得有 grantId');
    assertEqual(r1.grantId, grant.id, '第一条请求必须关联 grantId');

    const db2 = readDb(tmp.dataDir);
    try {
      const grants = db2.all('SELECT id, used_at FROM scope_grant WHERE team_id=?', team.id);
      assertEqual(grants.length, 1, '全流程只允许产生 1 个 grant（二次必须重新申请，不会自动复用）');
      assert(grants[0].used_at, '唯一 grant 必须已被消耗');
    } finally { db2.close(); }

    // 二次拒绝的失败事件（worker 侧）必须可见
    const finalSteps = await steps();
    assert(finalSteps.some((e) => e.phase === 'decision' && e.result === 'DENIED'), '必须落一条 decision=DENIED 事件');
    assert(finalSteps.some((e) => String(e.result).includes('E_DENIED')), 'Worker 必须收到 E_DENIED 并记录失败事件');

    done = true;
    return `S1 批准(grant=${grant.id}, TTL60, singleUse) → v2 落盘且 meta.grantId/used_at 可查；S2 新建请求 ${req2.id} 被驳回 → task failed、文件仍 v2（sha256 不变）`;
  } catch (e) {
    console.error(`[AC-4] 失败保留 tmp 目录：${tmp.root}`);
    throw e;
  } finally {
    if (s) await s.close();
    if (done) tmp.cleanup();
  }
});

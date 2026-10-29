// tests/ac-14-trace.mjs — AC-14 Trace 瀑布：步骤聚合、工具 span 上报、SSE 实时、幂等 upsert
// ① POST /api/spans 写入 running → done 同一 spanId 只保留一行（幂等 upsert），GET /api/spans 可读。
// ② 写入时 SSE 推 span.append 帧（实时刷新依赖此帧）。
// ③ 跑一个 3 步任务后 GET /api/trace：root(team) → member(子 Agent) → step(Worker 步骤) 树正确，
//    显式工具 span 挂到 session 节点，相对时间 >= 0，stats 一致。
import { runAc, mkTmp, startSidecar, waitFor, sseOpen, sleep, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-14';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac14');
  let sidecar = null;
  let sse = null;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', {
      name: 'ac14-trace', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 4,
    }), 'team');
    const m1 = one(await api.post(`/api/teams/${team.id}/members`, { name: 'trace-worker', role: 'worker' }), 'member');

    // ================= ① 幂等 upsert =================
    const spanId = 'tool:ac14-session:call-1';
    const t0 = Date.now() - 5000;
    const w1 = await api.post('/api/spans', {
      teamId: team.id, sessionId: 'ac14-session',
      spans: [{ spanId, name: 'read', kind: 'tool', status: 'running', startMs: t0, detail: 'src/a.mjs' }],
    });
    assert(w1 && w1.ok !== false, 'running span 写入成功');
    assertEqual(w1.items.length, 1, '单条写入返回 1 项');

    const w2 = await api.post('/api/spans', {
      teamId: team.id, sessionId: 'ac14-session',
      spans: [{ spanId, name: 'read', kind: 'tool', status: 'done', startMs: t0, endMs: t0 + 120, detail: 'src/a.mjs', output: 'ok' }],
    });
    assert(w2 && w2.ok !== false, 'done span upsert 成功');

    const spans = await api.get(`/api/spans?team=${team.id}`);
    assertEqual(spans.items.length, 1, '同一 spanId 只保留一行');
    assertEqual(spans.items[0].status, 'done', 'status 被 upsert 更新');
    assertEqual(spans.items[0].endMs - spans.items[0].startMs, 120, 'duration 保留');

    // ================= ② SSE 实时 span.append =================
    sse = sseOpen(sidecar.url, sidecar.token, { team: team.id });
    let liveFrame = null;
    for (let i = 0; i < 20 && !liveFrame; i += 1) {
      await api.post('/api/spans', {
        teamId: team.id, sessionId: 'ac14-warm',
        spans: [{ spanId: `tool:ac14-warm:${i}`, name: 'warmup', kind: 'tool', status: 'done', startMs: Date.now() }],
      });
      try {
        liveFrame = await sse.waitFor((f) => f.event === 'span.append', { label: 'span.append 实时帧', timeout: 400 });
      } catch { await sleep(50); }
    }
    assert(liveFrame, 'SSE 收到 span.append 实时帧');
    assert(liveFrame.payload && liveFrame.payload.teamId === team.id, 'span.append 带 teamId');
    assert(liveFrame.payload.span && liveFrame.payload.span.spanId, 'span.append 带 span 明细');

    // 工具结束后用同一 spanId 补 done —— 面板据此把 running 条拉直
    await api.post('/api/spans', {
      teamId: team.id, sessionId: 'ac14-session',
      spans: [{ spanId: 'tool:ac14-session:call-2', name: 'bash', kind: 'tool', status: 'done', startMs: Date.now(), endMs: Date.now() }],
    });

    // ================= ③ 步骤 + 工具调用聚合成树 =================
    const plan = [1, 2, 3].map((i) => ({
      step: `S${i}`, phase: 'verify', action: 'noop', target: `ac14-${i}`, op: { kind: 'noop' },
    }));
    const task = one(await api.post('/api/tasks', {
      teamId: team.id, subject: 'ac14-steps', assignee: m1.id, plan,
    }), 'task');
    await waitFor('3 步任务完成', async () => (await api.get(`/api/tasks/${task.id}`)).status === 'done', {
      timeout: 30000, interval: 50,
    });

    const trace = await api.get(`/api/trace?team=${team.id}`);
    assertEqual(trace.teamId, team.id, 'trace.teamId');
    assert(trace.root && Array.isArray(trace.root.children), 'root.children 存在');
    assertEqual(trace.root.start, 0, 'root 起点归零');
    assertEqual(trace.root.id, `run:${team.id}`, 'root id');

    const memberNode = trace.root.children.find((n) => n.id === `member:${m1.id}`);
    assert(memberNode, 'member 节点存在');
    assertEqual(memberNode.kind, 'subagent', 'member kind=subagent');
    const steps = memberNode.children;
    assertEqual(steps.length, 3, '3 个 Worker 步骤 span');
    assertEqual(steps[0].id, `step:${m1.id}:0`, 'step span 以 stepIndex 命名');
    assert(steps.every((s) => s.status !== 'running'), '步骤全部结束');
    assert(steps.every((s) => s.start >= 0 && s.end >= s.start), '步骤相对时间合法');

    const sessionNode = trace.root.children.find((n) => n.id === 'session:ac14-session');
    assert(sessionNode, 'session 节点存在');
    assertEqual(sessionNode.children.length, 2, '两个工具 span 挂到 session');
    assert(sessionNode.children.every((n) => n.start >= 0), '工具 span 相对时间非负');

    assert(trace.stats.steps >= 3, `stats.steps >= 3，实际 ${trace.stats.steps}`);
    assert(trace.stats.spans >= 2, `stats.spans >= 2，实际 ${trace.stats.spans}`);
    assert(trace.stats.nodes >= trace.stats.members + trace.stats.steps + trace.stats.spans, 'stats.nodes 覆盖所有节点');
    assertEqual(trace.stats.members, 1, 'stats.members');

    // ================= ④ 时间窗 window=N（分钟） =================
    const oldStart = Date.now() - 2 * 3600 * 1000; // 2 小时前
    await api.post('/api/spans', {
      teamId: team.id, sessionId: 'ac14-old',
      spans: [{ spanId: 'tool:ac14-old:old-1', name: 'old-call', kind: 'tool', status: 'done', startMs: oldStart, endMs: oldStart + 50 }],
    });
    const all = await api.get(`/api/trace?team=${team.id}`);
    assertEqual(all.windowMs, 0, '未指定 window 时 windowMs=0');
    assert(all.root.children.some((n) => n.id === 'session:ac14-old'), '全量视图包含 2 小时前的 span');

    const win = await api.get(`/api/trace?team=${team.id}&window=30`);
    assert(!win.root.children.some((n) => n.id === 'session:ac14-old'), '30 分钟窗口排除 2 小时前的 span');
    assertEqual(win.windowMs, 30 * 60000, 'windowMs 回显');
    assertEqual(all.stats.spans - win.stats.spans, 1, '窗口恰好排除 1 条旧 span');
    assert(win.cutoffMs > 0 && win.cutoffMs <= Date.now(), 'cutoffMs 落在过去');
    assertEqual(win.root.start, 0, '窗口模式 root 起点仍归零');
    assert(win.root.end >= 0, '窗口模式 root 有结束时间');

    // 空团队 / 非法参数
    let bad = null;
    try { await api.get('/api/trace'); } catch (e) { bad = e; }
    assert(bad, '缺少 team 参数时报错');
    await sleep(20);
  } finally {
    try { sse?.close?.(); } catch { /* ignore */ }
    if (sidecar) await sidecar.close();
  }
});

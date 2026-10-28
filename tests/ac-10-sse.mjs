// tests/ac-10-sse.mjs — AC-10 SSE 实时性与断线续传
// ① 实时性：开 SSE(team) 跑 30 个 noop 步骤的任务；每个 step.append 帧按「首次可见时刻 - payload.ts」计时，
//    p95 < 500ms，且收到的 step.append 帧 ≥ 30。
// ② 续传：收若干帧后记 lastId 并断开，任务继续跑；用 lastEventId 重连，断言新帧 id 全部 > lastId，
//    且事件型帧 id 序列与 /api/events/history?team=&since=lastId 完全一致（不丢、不重）。
import { runAc, mkTmp, startSidecar, waitFor, sseOpen, sleep, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-10';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);
const SYNTHETIC = new Set(['task.state', 'message.delivered']);   // 无对应 event 行的合成帧
const p95 = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]; };

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac10');
  const startedAt = Date.now();
  let sidecar = null;
  let ok = false;
  let sseA = null;
  let sseB = null;
  let sseC = null;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', {
      name: 'ac10-sse', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 4,
    }), 'team');
    const m1 = one(await api.post(`/api/teams/${team.id}/members`, { name: 'sse-worker-1' }), 'member');
    const m2 = one(await api.post(`/api/teams/${team.id}/members`, { name: 'sse-worker-2' }), 'member');

    const mkPlan = (n, label, ms = 0) => Array.from({ length: n }, (_, i) => ({
      step: `S${i + 1}`, phase: ms ? 'wait' : 'verify', action: ms ? 'sleep' : 'noop', target: `${label}-${i + 1}`,
      op: ms ? { kind: 'sleep', args: { ms } } : { kind: 'noop' },
    }));

    // ================= ① SSE 实时性 =================
    sseA = sseOpen(sidecar.url, sidecar.token, { team: team.id });
    const observedAt = new Map();   // frame index → 首次可见时刻
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const n = sseA.frames.length;
        for (let i = observedAt.size; i < n; i++) observedAt.set(i, Date.now());
        await sleep(2);
      }
      for (let i = observedAt.size; i < sseA.frames.length; i++) observedAt.set(i, Date.now());
    })();

    // 等 SSE 真正连上：建一个临时成员，它的 member.create 事件必须作为帧收到
    const warm = one(await api.post(`/api/teams/${team.id}/members`, { name: 'sse-warmup' }), 'member');
    await waitFor('SSE 连接建立（收到首帧）', () => sseA.frames.length > 0, { timeout: 10000, interval: 20 });
    assert(warm.id, 'warmup 成员创建成功');

    const taskA = one(await api.post('/api/tasks', {
      teamId: team.id, subject: 'sse-30-noop', assignee: m1.id, plan: mkPlan(30, 'noop'),
    }), 'task');
    await waitFor('30 步任务完成', async () => (await api.get(`/api/tasks/${taskA.id}`)).status === 'done',
      { timeout: 30000, interval: 50 });
    await sleep(200);   // 让最后几帧完成推送
    watching = false;
    await watcher;

    const stepFrames = [];
    for (let i = 0; i < sseA.frames.length; i++) {
      const f = sseA.frames[i];
      if (f.event !== 'step.append') continue;
      stepFrames.push({ i, f });
    }
    assert(stepFrames.length >= 30, `step.append 帧应 ≥30，实际 ${stepFrames.length}`);
    const latencies = stepFrames.map(({ i, f }) => {
      assert(Number.isFinite(Date.parse(f.payload?.ts)), `step.append 帧缺 payload.ts: ${JSON.stringify(f.payload)}`);
      assert(Number.isFinite(f.payload.seq) && typeof f.payload.phase === 'string'
        && typeof f.payload.action === 'string' && 'target' in f.payload
        && 'result' in f.payload && 'next' in f.payload, `step.append 载荷字段不全: ${JSON.stringify(f.payload)}`);
      return (observedAt.get(i) ?? Date.now()) - Date.parse(f.payload.ts);
    });
    const bad = latencies.filter((x) => !Number.isFinite(x) || x < 0);
    assertEqual(bad.length, 0, `存在非法延迟样本（负数/NaN）: ${bad.slice(0, 5)}`);
    const p95Lat = p95(latencies);
    const maxLat = Math.max(...latencies);
    assert(p95Lat < 500, `SSE step 推送 p95 应 <500ms，实际 p95=${p95Lat}ms（max=${maxLat}ms, n=${latencies.length}）`);
    sseA.close();
    sseA = null;

    // ================= ② 断线续传（lastEventId） =================
    sseB = sseOpen(sidecar.url, sidecar.token, { team: team.id });
    const taskB = one(await api.post('/api/tasks', {
      teamId: team.id, subject: 'sse-resume', assignee: m2.id, plan: mkPlan(14, 'resume', 40),
    }), 'task');
    await waitFor('续传前收到若干帧', () => sseB.frames.length >= 6, { timeout: 10000, interval: 10 });
    const lastId = sseB.lastId;
    assert(lastId > 0, `lastId 应为正数，实际 ${lastId}`);
    const seenBefore = sseB.frames.length;
    sseB.close();
    sseB = null;

    // 断开期间任务继续跑完 → 之后的事件必须在重连时回放
    await waitFor('续传任务完成', async () => (await api.get(`/api/tasks/${taskB.id}`)).status === 'done',
      { timeout: 30000, interval: 50 });
    const history = await api.get(`/api/events/history?team=${team.id}&since=${lastId}&limit=5000`);
    const histIds = history.items.map((e) => e.id);
    assert(histIds.length > 0, `断线后应产生待回放事件，实际 history 为空（lastId=${lastId}）`);

    sseC = sseOpen(sidecar.url, sidecar.token, { team: team.id, lastEventId: lastId });
    const lastHistId = histIds[histIds.length - 1];
    await waitFor('重连后回放到 history 末尾事件', () => sseC.frames.some((f) => f.id === lastHistId),
      { timeout: 15000, interval: 20 });
    await sleep(100);

    // 全部新帧 id 必须 > lastId（合成帧 id 取当前事件游标，不会早于 lastId）
    const staleFrames = sseC.frames.filter((f) => f.id <= lastId);
    assertEqual(staleFrames.length, 0, `重连后不应收到 id ≤ lastId 的帧，实际 ${staleFrames.length} 帧`);

    const eventFrames = sseC.frames.filter((f) => !SYNTHETIC.has(f.event));
    const gotIds = eventFrames.map((f) => f.id);
    // 事件型帧 id 严格递增且与 history since=lastId 完全一致 → 不丢事件、无重复
    for (let i = 1; i < gotIds.length; i++) {
      assert(gotIds[i] > gotIds[i - 1], `续传帧 id 应严格递增：${gotIds[i - 1]} → ${gotIds[i]}`);
    }
    assertEqual(gotIds.length, histIds.length, `续传帧数应等于 history 事件数（since=${lastId}）`);
    assertEqual(JSON.stringify(gotIds), JSON.stringify(histIds), '续传帧 id 序列应与 /api/events/history 完全一致');
    assert(seenBefore >= 6, `断线前应已收到 ≥6 帧，实际 ${seenBefore}`);

    const elapsed = Date.now() - startedAt;
    ok = true;
    return `SSE 实时性：${latencies.length} 个 step.append 帧 p95=${p95Lat}ms（max=${maxLat}ms，阈值 500）；`
      + `续传：lastId=${lastId} 断开后回放 ${gotIds.length} 个事件与 history 完全一致、无 id≤lastId 的帧；耗时 ${elapsed}ms`;
  } finally {
    for (const s of [sseA, sseB, sseC]) { try { s?.close(); } catch { /* ignore */ } }
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

// tests/ac-10-sse.mjs — AC-10 SSE 实时性与断线续传（agent 运行时）
// 事件源：创建权限审批（approval.request）。① 30 条审批事件 p95 < 500ms；
// ② 断开后继续产生事件，用 lastEventId 重连必须与 /api/events/history 完全一致（不丢、不重）。
import { runAc, mkTmp, startSidecar, waitFor, sseOpen, sleep, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-10';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);
const SYNTHETIC = new Set(['task.state', 'message.delivered']);
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

    const team = one(await api.post('/api/teams', { name: 'ac10-sse', workspace: tmp.ws, permissionPreset: 'workspace-write' }), 'team');
    const m1 = one(await api.post(`/api/teams/${team.id}/members`, { name: 'sse-member-1' }), 'member');
    const m2 = one(await api.post(`/api/teams/${team.id}/members`, { name: 'sse-member-2' }), 'member');

    // ================= ① SSE 实时性 =================
    sseA = sseOpen(sidecar.url, sidecar.token, { team: team.id });
    const observedAt = new Map();
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const n = sseA.frames.length;
        for (let i = observedAt.size; i < n; i++) observedAt.set(i, Date.now());
        await sleep(2);
      }
      for (let i = observedAt.size; i < sseA.frames.length; i++) observedAt.set(i, Date.now());
    })();

    const warm = one(await api.post(`/api/teams/${team.id}/members`, { name: 'sse-warmup' }), 'member');
    await waitFor('SSE 连接建立（收到首帧）', () => sseA.frames.length > 0, { timeout: 10000, interval: 20 });
    assert(warm.id, 'warmup 成员创建成功');

    for (let i = 0; i < 30; i++) {
      await api.post('/api/approvals', {
        id: `apr_a_${i}`, teamId: team.id, memberId: m1.id, toolName: 'fs.write',
        reason: `live-${i}`,
      });
    }
    await waitFor('30 条审批事件到达', () => {
      const n = sseA.frames.filter((f) => f.event === 'step.append' && f.payload?.action === 'approval.request').length;
      return n >= 30 ? n : null;
    }, { timeout: 30000, interval: 20 });
    await sleep(200);
    watching = false;
    await watcher;

    const approvalFrames = [];
    for (let i = 0; i < sseA.frames.length; i++) {
      const f = sseA.frames[i];
      if (f.event === 'step.append' && f.payload?.action === 'approval.request') approvalFrames.push({ i, f });
    }
    assert(approvalFrames.length >= 30, `approval.request 帧应 ≥30，实际 ${approvalFrames.length}`);
    const latencies = approvalFrames.map(({ i, f }) => {
      assert(Number.isFinite(Date.parse(f.payload?.ts)), `帧缺 payload.ts: ${JSON.stringify(f.payload)}`);
      assert(typeof f.payload.action === 'string' && 'target' in f.payload && 'result' in f.payload, `载荷字段不全: ${JSON.stringify(f.payload)}`);
      return (observedAt.get(i) ?? Date.now()) - Date.parse(f.payload.ts);
    });
    const SKEW_MS = 25;
    const bad = latencies.filter((x) => !Number.isFinite(x) || x < -SKEW_MS);
    assertEqual(bad.length, 0, `存在非法延迟样本（<-${SKEW_MS}ms 或 NaN）: ${bad.slice(0, 5)}`);
    const measured = latencies.map((x) => Math.max(0, x));
    const p95Lat = p95(measured);
    const maxLat = Math.max(...measured);
    assert(p95Lat < 500, `SSE 推送 p95 应 <500ms，实际 p95=${p95Lat}ms（max=${maxLat}ms, n=${measured.length}）`);
    sseA.close();
    sseA = null;

    // ================= ② 断线续传（lastEventId） =================
    sseB = sseOpen(sidecar.url, sidecar.token, { team: team.id });
    await api.post('/api/approvals', { id: 'apr_b_0', teamId: team.id, memberId: m2.id, toolName: 'exec', reason: 'resume-0' });
    await waitFor('续传前收到若干帧', () => sseB.frames.length >= 1, { timeout: 10000, interval: 10 });
    const lastId = sseB.lastId;
    assert(lastId > 0, `lastId 应为正数，实际 ${lastId}`);
    const seenBefore = sseB.frames.length;
    sseB.close();
    sseB = null;

    // 断开期间继续产生事件 → 重连必须回放
    for (let i = 1; i <= 14; i++) {
      await api.post('/api/approvals', { id: `apr_b_${i}`, teamId: team.id, memberId: m2.id, toolName: 'fs.write', reason: `resume-${i}` });
    }
    const history = await api.get(`/api/events/history?team=${team.id}&since=${lastId}&limit=5000`);
    const histIds = history.items.map((e) => e.id);
    assert(histIds.length > 0, `断线后应产生待回放事件，实际 history 为空（lastId=${lastId}）`);

    sseC = sseOpen(sidecar.url, sidecar.token, { team: team.id, lastEventId: lastId });
    const lastHistId = histIds[histIds.length - 1];
    await waitFor('重连后回放到 history 末尾事件', () => sseC.frames.some((f) => f.id === lastHistId),
      { timeout: 15000, interval: 20 });
    await sleep(120);

    const staleFrames = sseC.frames.filter((f) => f.id <= lastId);
    assertEqual(staleFrames.length, 0, `重连后不应收到 id ≤ lastId 的帧，实际 ${staleFrames.length} 帧`);

    const eventFrames = sseC.frames.filter((f) => !SYNTHETIC.has(f.event));
    const gotIds = eventFrames.map((f) => f.id);
    for (let i = 1; i < gotIds.length; i++) {
      assert(gotIds[i] > gotIds[i - 1], `续传帧 id 应严格递增：${gotIds[i - 1]} → ${gotIds[i]}`);
    }
    assertEqual(gotIds.length, histIds.length, `续传帧数应等于 history 事件数（since=${lastId}）`);
    assertEqual(JSON.stringify(gotIds), JSON.stringify(histIds), '续传帧 id 序列应与 /api/events/history 完全一致');
    assert(seenBefore >= 1, `断线前应已收到 ≥1 帧，实际 ${seenBefore}`);

    const elapsed = Date.now() - startedAt;
    ok = true;
    return `SSE 实时性：${latencies.length} 个 approval.request 帧 p95=${p95Lat}ms（max=${maxLat}ms，阈值 500）；`
      + `续传：lastId=${lastId} 断开后回放 ${gotIds.length} 个事件与 history 完全一致；耗时 ${elapsed}ms`;
  } finally {
    for (const s of [sseA, sseB, sseC]) { try { s?.close(); } catch { /* ignore */ } }
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

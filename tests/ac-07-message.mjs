// tests/ac-07-message.mjs — AC-7 消息投递与 idle 唤醒
// ① 运行中：任务 4 个 sleep 300ms 步骤，进入 running 后发消息；断言 ≤800ms deliveredAt、≤2s ackedAt，
//    且事件流在 ≤1 step 内记录 msg.receive（stepIndex 与发送时所在 step 相差 ≤1）；
// ② idle 且无任务的成员：发消息 → 5s 内出现 wake / wake.done 事件、消息 acked、成员回 idle、消息从未丢失。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-7';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

async function findMessage(api, teamId, messageId) {
  const r = await api.get(`/api/messages?team=${teamId}`);
  return r.items.find((m) => m.id === messageId) || null;
}

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac07');
  const startedAt = Date.now();
  let sidecar = null;
  let ok = false;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', {
      name: 'ac07-msg', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2,
    }), 'team');
    const busy = one(await api.post(`/api/teams/${team.id}/members`, { name: 'busy-worker' }), 'member');
    const idler = one(await api.post(`/api/teams/${team.id}/members`, { name: 'idle-worker' }), 'member');

    // ================= ① 运行中收消息 =================
    const plan = Array.from({ length: 4 }, (_, i) => ({
      step: `S${i + 1}`, phase: 'wait', action: 'sleep', target: `nap-${i + 1}`,
      op: { kind: 'sleep', args: { ms: 300 } },
    }));
    await api.post('/api/tasks', { teamId: team.id, subject: 'long-run', assignee: busy.id, plan });

    const running = await waitFor('busy 成员进入 running', async () => {
      const st = await api.get(`/api/status?member=${busy.id}`);
      const m = st.members?.[0];
      return m && m.status === 'running' ? m : null;
    }, { timeout: 15000, interval: 20 });
    const sendStepIdx = Number(String(running.step || 'S1').replace(/\D/g, '')) - 1;

    const sentAt = Date.now();
    const sent = await api.post('/api/messages', {
      teamId: team.id, from: 'lead', to: busy.id, payload: { cmd: 'check', n: 1 },
    });
    const msg = one(sent, 'message');
    assert(msg.id, '消息创建返回 id');

    const delivered = await waitFor('运行中消息 ≤800ms 内 delivered', async () => {
      const m = await findMessage(api, team.id, msg.id);
      return m && m.deliveredAt ? m : null;
    }, { timeout: 800, interval: 20 });
    const deliveredLag = Date.now() - sentAt;
    assert(deliveredLag <= 800, `deliveredAt 应在 ≤800ms 内出现，实际 ${deliveredLag}ms`);
    assert(Number.isFinite(Date.parse(delivered.deliveredAt)), 'deliveredAt 应为可解析时间');

    const acked = await waitFor('运行中消息 ≤2s 内 acked', async () => {
      const m = await findMessage(api, team.id, msg.id);
      return m && m.ackedAt ? m : null;
    }, { timeout: 2000, interval: 20 });
    const ackedLag = Date.now() - sentAt;
    assert(ackedLag <= 2000, `ackedAt 应在 ≤2s 内出现，实际 ${ackedLag}ms`);
    assertEqual(acked.status, 'acked', '消息派生状态应为 acked');
    assertEqual(JSON.stringify(acked.payload), JSON.stringify({ cmd: 'check', n: 1 }), 'payload 不应被改写');

    // ≤1 step 送达：事件流里应有 phase=msg/action=receive 且 stepIndex 与发送时所在 step 差 ≤1
    const busySteps = await api.get(`/api/steps?member=${busy.id}&since=0&limit=500`);
    const recv = busySteps.items.find((e) => e.phase === 'msg' && e.action === 'receive' && e.meta?.messageId === msg.id);
    assert(recv, '事件流应记录 msg.receive（消息在 step 边界被 Worker 消费）');
    const recvIdx = recv.meta?.stepIndex;
    assert(Number.isInteger(recvIdx), `msg.receive 应带 stepIndex，实际 ${JSON.stringify(recv.meta)}`);
    assert(Math.abs(recvIdx - sendStepIdx) <= 1, `消息应在 ≤1 step 内送达：发送于 stepIndex=${sendStepIdx}，消费于 ${recvIdx}`);

    // ================= ② idle 且无任务的成员被消息拉起 =================
    const idleState = one(await api.get(`/api/members/${idler.id}`), 'member');
    assertEqual(idleState.status, 'idle', 'idle-worker 发消息前应为 idle 且无任务');
    const idleTasks = await api.get(`/api/tasks?team=${team.id}`);
    assertEqual(idleTasks.items.filter((t) => t.assignee === idler.id).length, 0, 'idle-worker 不应有任务');
    const stepsBefore = await api.get(`/api/steps?member=${idler.id}&since=0&limit=500`);
    const wakeBefore = stepsBefore.items.filter((e) => e.action === 'wake' || e.action === 'wake.done').length;
    assertEqual(wakeBefore, 0, '发消息前不应有 wake 事件');

    const sent2 = await api.post('/api/messages', {
      teamId: team.id, from: 'lead', to: idler.id, payload: { cmd: 'ping', n: 2 },
    });
    const msg2 = one(sent2, 'message');
    assert(msg2.id, '唤醒消息创建返回 id');

    const wakeEvents = await waitFor('idle 成员 5s 内出现 wake + wake.done 事件', async () => {
      const r = await api.get(`/api/steps?member=${idler.id}&since=0&limit=500`);
      const wake = r.items.find((e) => e.action === 'wake');
      const wakeDone = r.items.find((e) => e.action === 'wake.done');
      return wake && wakeDone ? { wake, wakeDone } : null;
    }, { timeout: 5000, interval: 50 });
    assertEqual(wakeEvents.wake.status, 'running', 'wake 事件应把成员置为 running');
    assertEqual(wakeEvents.wakeDone.status, 'idle', 'wake.done 事件应把成员置回 idle');

    const acked2 = await waitFor('唤醒消息 5s 内 acked', async () => {
      const m = await findMessage(api, team.id, msg2.id);
      return m && m.ackedAt ? m : null;
    }, { timeout: 5000, interval: 50 });
    assertEqual(acked2.status, 'acked', '唤醒消息派生状态应为 acked');
    assert(Number.isFinite(Date.parse(acked2.deliveredAt)), '唤醒消息应有 deliveredAt');

    const backIdle = await waitFor('idle 成员收完后回到 idle', async () => {
      const m = one(await api.get(`/api/members/${idler.id}`), 'member');
      return m.status === 'idle' ? m : null;
    }, { timeout: 5000, interval: 50 });
    assertEqual(backIdle.status, 'idle', '唤醒结束后成员应回到 idle');

    // 消息永不丢：仍可通过 REST 查到（含 payload 原值）
    const still = await findMessage(api, team.id, msg2.id);
    assert(still, '唤醒消息必须始终可从 REST 查到（不丢）');
    assertEqual(still.status, 'acked', '不丢的消息状态为 acked');
    assertEqual(JSON.stringify(still.payload), JSON.stringify({ cmd: 'ping', n: 2 }), '不丢消息的 payload 原值');

    const elapsed = Date.now() - startedAt;
    ok = true;
    return `运行中消息 delivered=${deliveredLag}ms(≤800) acked=${ackedLag}ms(≤2s)、第 ${recvIdx - sendStepIdx} 个 step 边界送达；`
      + `idle 成员被消息拉起（wake→wake.done→idle）并 ack，消息可查不丢；耗时 ${elapsed}ms`;
  } finally {
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

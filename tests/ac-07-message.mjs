// tests/ac-07-message.mjs — AC-7 消息信箱（agent 运行时）
// 消息由 sidecar 落库、按 correlation/to/kind 过滤；agent 会话的送达/消费由 Host 插件负责，
// 这里验证：① 消息创建即 queued 且可查；② ack 状态与时间；③ payload 原值不被改写；④ 广播不回声给发送者。
import { runAc, mkTmp, startSidecar, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-7';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac07');
  const startedAt = Date.now();
  let sidecar = null;
  let ok = false;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', { name: 'ac07-msg', workspace: tmp.ws, maxMembers: 4 }), 'team');
    const a = one(await api.post('/api/agents/register', { teamId: team.id, name: 'agent-a', sessionId: 'sess_ac07_a' }), 'member');
    const b = one(await api.post('/api/agents/register', { teamId: team.id, name: 'agent-b', sessionId: 'sess_ac07_b' }), 'member');

    // ① 点对点
    const sent = await api.post('/api/messages', {
      teamId: team.id, from: 'lead', to: b.id, kind: 'request', payload: { cmd: 'ping', n: 2 }, correlationId: 'corr-ac07',
    });
    assert(sent.message?.id, '消息创建返回 id');
    assertEqual(sent.message.status, 'queued', '新消息为 queued');
    assertEqual(JSON.stringify(sent.message.payload), JSON.stringify({ cmd: 'ping', n: 2 }), 'payload 原值');

    const byId = (await api.get(`/api/messages?team=${team.id}`)).items.find((m) => m.id === sent.message.id);
    assert(byId, '消息可从 REST 查到');
    assertEqual(byId.to, b.id, '收件人');
    const byCorr = (await api.get(`/api/messages?team=${team.id}&correlation=corr-ac07`)).items;
    assertEqual(byCorr.length, 1, '按 correlation 过滤');

    // ② ack
    await api.post(`/api/messages/${sent.message.id}/ack`, { state: 'acked' });
    const acked = (await api.get(`/api/messages?team=${team.id}`)).items.find((m) => m.id === sent.message.id);
    assertEqual(acked.status, 'acked', 'ack 后状态');
    assert(Number.isFinite(Date.parse(acked.ackedAt)), 'ackedAt 可解析');
    assertEqual(JSON.stringify(acked.payload), JSON.stringify({ cmd: 'ping', n: 2 }), 'ack 不改 payload');

    // ③ 广播：发给除发送者外的所有成员
    const broadcast = await api.post('/api/messages', { teamId: team.id, from: a.id, to: '*', payload: { note: 'all' } });
    assert(Array.isArray(broadcast.recipients) || broadcast.message, '广播返回接收人');
    const mine = (await api.get(`/api/messages?team=${team.id}&member=${a.id}`)).items;
    assert(!mine.some((m) => m.id === broadcast.message?.id && m.to === a.id), '广播不回声给发送者');

    // ④ 不存在的收件人 404/400
    let bad = 0;
    try { await api.post('/api/messages', { teamId: team.id, from: 'lead', to: 'nobody', payload: {} }); } catch (e) { bad = e.status; }
    assertEqual(bad, 404, '未知收件人应 404');

    ok = true;
    return `消息 queued→acked、correlation 过滤、payload 原值、广播不回声；耗时 ${Date.now() - startedAt}ms`;
  } finally {
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

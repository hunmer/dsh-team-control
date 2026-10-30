// tests/ac-16-dispatch-hints.mjs — 实测踩过的两个「报错说不清」的地方
// ① deps.from 填成成员 id：必须 400 且点名「这是成员 X，请换 task id」，而不是一句 task not found；
// ② 派不出去时 no_idle_agent 要给出 idleMembers 与可执行的 hint，而不是只给一个 reason。
import { runAc, mkTmp, startSidecar, assert, assertEqual, sleep } from './lib/harness.mjs';

const AC = 'AC-16';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac16');
  let sidecar = null;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    // ============ ① deps.from 误填成员 id ============
    const wteam = one(await api.post('/api/teams', {
      name: 'ac16-deps', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2,
    }), 'team');
    const alice = one(await api.post(`/api/teams/${wteam.id}/members`, { name: 'alice' }), 'member');
    one(await api.post('/api/tasks', { teamId: wteam.id, subject: '上游', plan: [] }), 'task');
    const t2 = one(await api.post('/api/tasks', { teamId: wteam.id, subject: '下游', plan: [] }), 'task');

    let bad = null;
    try {
      await api.post('/api/deps', { from: alice.id, to: t2.id, condition: 'all_success' });
    } catch (e) { bad = e; }
    assert(bad, '把成员 id 当 deps.from 必须报错');
    assertEqual(bad.status, 400, 'deps.from 填成员 id → HTTP 400');
    const errBody = bad.body?.error || {};
    assertEqual(errBody.code, 'E_BAD_REQUEST', '错误码 E_BAD_REQUEST（不是 not found）');
    assert(String(errBody.message || '').includes('alice'), `错误消息要点名成员 alice，实际：${errBody.message}`);
    assert(String(errBody.message || '').includes('task id'), '错误消息要说明应为 task id');
    assertEqual(errBody.detail?.field, 'deps.from', 'detail.field 指明是 deps.from 写错了');
    assertEqual(errBody.detail?.got, alice.id, 'detail.got 回显填错的 id');
    assertEqual((await api.get(`/api/dag?team=${wteam.id}`)).edges.length, 0, '失败的 deps 不落库');
    assert(['pending', 'ready'].includes((await api.get(`/api/tasks/${t2.id}`)).status), '下游任务不受影响');

    // 不是成员、也不是 task_ 前缀：同样是 400 而不是 not found
    let bad2 = null;
    try {
      await api.post('/api/deps', { from: 'alice', to: t2.id, condition: 'all_success' });
    } catch (e) { bad2 = e; }
    assertEqual(bad2?.body?.error?.code, 'E_BAD_REQUEST', '非 task_ 前缀的 from → E_BAD_REQUEST');
    assert(String(bad2?.body?.error?.message || '').includes('task_'), '提示要以 task_ 开头');

    // ============ ② no_idle_agent 要带 idleMembers 与 hint ============
    const nteam = one(await api.post('/api/teams', {
      name: 'ac16-noidle', workspace: tmp.ws, runtime: 'agent', maxMembers: 4, maxConcurrency: 2,
    }), 'team');
    one(await api.post('/api/tasks', { teamId: nteam.id, subject: '没人干', plan: [] }), 'task');
    await sleep(300); // 越过 scheduler.settleMs=200
    const d1 = await api.post('/api/agents/dispatch', { teamId: nteam.id });
    assertEqual(d1.dispatched, false, '没有成员时派不出去');
    assertEqual(d1.reason, 'no_idle_agent', '原因 no_idle_agent');
    assertEqual(d1.idleMembers, 0, 'idleMembers=0');
    assert(String(d1.hint || '').includes('没有 idle 的 agent 成员'), `hint 要给出下一步动作，实际：${d1.hint}`);

    // 团队里确实有 idle 成员时，idleMembers 计数要让 Lead 看出「不是没人，是人被占着」
    one(await api.post('/api/agents/register', { teamId: nteam.id, name: 'bob', sessionId: 'ac16-sess-bob' }), 'member');
    const d2 = await api.post('/api/agents/dispatch', { teamId: nteam.id });
    assertEqual(d2.dispatched, true, '有 idle 成员后可以派发');
  } finally {
    if (sidecar) await sidecar.close();
  }
  return 'deps 误填成员 id 有明确报错；no_idle_agent 带 idleMembers/hint';
});

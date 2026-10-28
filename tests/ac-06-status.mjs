// tests/ac-06-status.mjs — AC-6 运行中查状态
// 成员跑 6 个 sleep 150ms 的步骤；running 期间连续 10 次 GET /api/status?team=：
// ① 每次耗时 < 1000ms；② 每次返回的成员对象都含 status/step/seq/next/blockers/asOf/stale，seq>0，blockers 是数组。
// 全流程真实 sidecar + 真实子进程 Worker。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual } from './lib/harness.mjs';

const AC = 'AC-6';
const one = (r, key) => (r && typeof r === 'object' && r[key] ? r[key] : r);
const REQUIRED_FIELDS = ['status', 'step', 'seq', 'next', 'blockers', 'asOf', 'stale'];

runAc(AC, async () => {
  const tmp = mkTmp('dsh-team-ac06');
  const startedAt = Date.now();
  let sidecar = null;
  let ok = false;
  try {
    sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = sidecar.api;

    const team = one(await api.post('/api/teams', {
      name: 'ac06-status', workspace: tmp.ws, maxMembers: 2, maxConcurrency: 2,
    }), 'team');
    const member = one(await api.post(`/api/teams/${team.id}/members`, { name: 'status-worker' }), 'member');

    // 6 × 150ms = 900ms 的可观测运行窗口
    const plan = Array.from({ length: 6 }, (_, i) => ({
      step: `S${i + 1}`, phase: 'wait', action: 'sleep', target: `nap-${i + 1}`,
      op: { kind: 'sleep', args: { ms: 150 } },
    }));
    const task = one(await api.post('/api/tasks', {
      teamId: team.id, subject: 'six-naps', assignee: member.id, plan,
    }), 'task');
    assert(task.id, '任务已创建');

    await waitFor('成员进入 running', async () => {
      const st = await api.get(`/api/status?member=${member.id}`);
      const m = st.members?.[0];
      return m && m.status === 'running' ? m : null;
    }, { timeout: 15000, interval: 20 });

    // running 期间连续 10 次查询，逐次计时
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const st = await api.get(`/api/status?team=${team.id}`);
      samples.push({ ms: Date.now() - t0, st });
    }

    const maxMs = Math.max(...samples.map((s) => s.ms));
    const avgMs = Math.round(samples.reduce((a, s) => a + s.ms, 0) / samples.length);
    assert(maxMs < 1000, `10 次 /api/status?team= 每次应 <1000ms，实际最大 ${maxMs}ms（avg ${avgMs}ms）`);

    let seqSeen = 0;
    for (const [i, { st }] of samples.entries()) {
      assert(st.asOf && Number.isFinite(st.version), `第 ${i + 1} 次查询应返回 asOf/version 快照标记`);
      assert(Array.isArray(st.members) && st.members.length === 1, `第 ${i + 1} 次查询应返回全团队员（1 人）`);
      assert(Array.isArray(st.staleMembers) && typeof st.degraded === 'boolean', 'status 应含 staleMembers/degraded');
      const m = st.members[0];
      for (const k of REQUIRED_FIELDS) {
        assert(Object.prototype.hasOwnProperty.call(m, k), `成员对象缺字段 ${k}`);
      }
      assertEqual(m.id, member.id, `第 ${i + 1} 次查询的成员 id`);
      assert(m.seq > 0, `seq 应 > 0，实际 ${m.seq}`);
      assert(Array.isArray(m.blockers), `blockers 应为数组，实际 ${typeof m.blockers}`);
      assert(typeof m.stale === 'boolean', 'stale 应为布尔');
      assert(Number.isFinite(Date.parse(m.asOf)), `asOf 应为可解析时间，实际 ${m.asOf}`);
      assertEqual(m.status, 'running', `第 ${i + 1} 次查询应在 running 期间`);
      assert(typeof m.step === 'string' && /^S\d+$/.test(m.step), `step 应为 S<n>，实际 ${m.step}`);
      assert(typeof m.next === 'string', `next 应为字符串，实际 ${m.next}`);
      seqSeen = Math.max(seqSeen, m.seq);
    }

    // 收尾前等任务自然完成（验证这段状态查询不影响执行）
    await waitFor('six-naps 任务完成', async () => (await api.get(`/api/tasks/${task.id}`)).status === 'done',
      { timeout: 15000, interval: 50 });

    const elapsed = Date.now() - startedAt;
    ok = true;
    return `running 期间 10 次 /api/status?team= 最大 ${maxMs}ms（阈值 1000）、avg ${avgMs}ms；`
      + `成员字段 ${REQUIRED_FIELDS.join('/')} 全部存在，seq 最大 ${seqSeen}，blockers=[]；耗时 ${elapsed}ms`;
  } finally {
    if (sidecar) await sidecar.close();
    if (ok) { try { tmp.cleanup(); } catch (e) { console.warn(`[${AC}] cleanup warn: ${e.message}`); } }
    else console.error(`[${AC}] FAILED — 现场已保留: ${tmp.root}`);
  }
});

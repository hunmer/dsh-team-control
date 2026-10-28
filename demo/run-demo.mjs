// demo/run-demo.mjs — 3 成员 + DAG 依赖 + 一次越界审批 + 一次 interrupt/resume（可复现）
// 运行：npm run demo   （或 node demo/run-demo.mjs）
import { mkTmp, startSidecar, waitFor, sseOpen, assert, sleep } from '../tests/lib/harness.mjs';
import fs from 'node:fs';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const tmp = mkTmp('dsh-demo');
let s;
let sse;

try {
  log('启动 sidecar…');
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  log(`sidecar ready: ${s.url}`);
  log(`数据目录: ${tmp.root}`);

  const team = await s.api.post('/api/teams', {
    name: 'demo-team', workspace: tmp.ws, maxMembers: 8, maxConcurrency: 3,
  });
  log(`团队 ${team.id}（maxMembers=${team.maxMembers}, maxConcurrency=${team.maxConcurrency}）`);

  // 只放行 out/** 的写；config/** 走审批流程
  await s.api.post('/api/policies', {
    teamId: team.id, subjectType: 'team', subjectId: team.id,
    domain: 'fs', matcher: 'out/**', ops: ['write', 'delete', 'rename'], mode: 'allow',
  });
  log('策略：fs 写 out/** 允许；config/** 默认拒绝（需审批）');

  const mk = (name, role) => s.api.post(`/api/teams/${team.id}/members`, { name, role });
  const alpha = await mk('lab-alpha', 'extractor');
  const beta = await mk('lab-beta', 'transformer');
  const gamma = await mk('lab-gamma', 'transformer');
  log(`成员：${alpha.name} / ${beta.name} / ${gamma.name}`);

  const task = (subject, assignee, plan) => s.api.post('/api/tasks', { teamId: team.id, subject, assignee, plan });
  const w = (path, content) => ({ kind: 'fs.write', args: { path, content } });
  const sl = (ms) => ({ kind: 'sleep', args: { ms } });

  const A = await task('A 抽取', alpha.id, [
    { step: 'S1', phase: 'write', action: 'write', target: 'out/data.json', op: w('out/data.json', '{"rows":3}\n') },
    { step: 'S2', phase: 'wait', action: 'sleep', target: 'A-hold', op: sl(150) },
  ]);
  const B1 = await task('B1 变换', beta.id, [
    { step: 'S1', phase: 'wait', action: 'sleep', target: 'B1-hold', op: sl(400) },
    { step: 'S2', phase: 'write', action: 'write', target: 'out/part-a.txt', op: w('out/part-a.txt', 'part-A\n') },
    { step: 'S3', phase: 'read', action: 'read', target: 'out/data.json', op: { kind: 'fs.read', args: { path: 'out/data.json' } } },
  ]);
  const B2 = await task('B2 变换', gamma.id, [
    { step: 'S1', phase: 'wait', action: 'sleep', target: 'B2-hold', op: sl(350) },
    { step: 'S2', phase: 'write', action: 'write', target: 'out/part-b.txt', op: w('out/part-b.txt', 'part-B\n') },
  ]);
  const C = await task('C 汇总（需越界审批）', alpha.id, [
    {
      step: 'S1', phase: 'write', action: 'write', target: 'config/report.json',
      op: w('config/report.json', '{"merged":true}\n'),
      onDenied: 'scope', scopeReason: '汇总结果必须写入共享 config', diffSize: 20,
      scopeTimeoutMs: 60000,
    },
    { step: 'S2', phase: 'verify', action: 'read', target: 'config/report.json', op: { kind: 'fs.read', args: { path: 'config/report.json' } } },
  ]);

  await s.api.post('/api/deps', { from: A.id, to: B1.id, condition: 'all_success' });
  await s.api.post('/api/deps', { from: A.id, to: B2.id, condition: 'all_success' });
  await s.api.post('/api/deps', { from: B1.id, to: C.id, condition: 'all_success' });
  await s.api.post('/api/deps', { from: B2.id, to: C.id, condition: 'all_success' });
  log('DAG：A → (B1 ‖ B2) → C（依赖满足后自动派发，Lead 不轮询）');

  sse = sseOpen(s.url, s.token, { team: team.id });
  sse.waitFor(() => true, { timeout: 5000 }).catch(() => {});

  // ---- 阶段 1：A 跑完，B1/B2 自动启动 ----
  await waitFor('A done', async () => (await s.api.get(`/api/tasks/${A.id}`)).status === 'done', { timeout: 20000 });
  const aDone = (await s.api.get(`/api/steps?member=${alpha.id}`)).items.find((e) => e.action === 'task.done');
  log('A 完成 → 依赖求值');
  await waitFor('B1/B2 running', async () => {
    const [b1, b2] = await Promise.all([s.api.get(`/api/tasks/${B1.id}`), s.api.get(`/api/tasks/${B2.id}`)]);
    return b1.status === 'running' && b2.status === 'running';
  }, { timeout: 10000 });
  const b1Start = (await s.api.get(`/api/steps?member=${beta.id}`)).items.find((e) => e.action === 'task.start');
  const lag = Date.parse(b1Start.ts) - Date.parse(aDone.ts);
  log(`B1/B2 已自动启动（A.done → B1.start 延迟 ${lag}ms）`);
  assert(lag <= 1000, `依赖触发延迟应在 1s 内，实际 ${lag}ms`);

  // ---- 阶段 2：interrupt + resume ----
  await waitFor('beta in S1', async () => {
    const st = await s.api.get(`/api/status?member=${beta.id}`);
    return st.members[0].status === 'running' && st.members[0].step === 'S1';
  }, { timeout: 10000 });
  log('interrupt lab-beta（同步落库，禁止僵尸 running）');
  const t0 = Date.now();
  await s.api.post(`/api/members/${beta.id}/interrupt`, { reason: 'demo interrupt' });
  const st1 = (await s.api.get(`/api/status?member=${beta.id}`)).members[0];
  log(`interrupt 后 ${Date.now() - t0}ms 状态=${st1.status}`);
  assert(st1.status === 'interrupted', 'interrupt 后必须立即是 interrupted');

  await sleep(300);
  log('resume lab-beta（从最后事件 seq 的下一步继续）');
  const rs = await s.api.post(`/api/members/${beta.id}/resume`, {});
  log(`resumeFrom=${rs.resumeFrom}，继续执行且不重做已完成单元`);

  // ---- 阶段 3：B1/B2 完成 → C 启动 → 越界审批 ----
  await waitFor('scope request', async () => {
    const r = await s.api.get(`/api/scope-requests?team=${team.id}&status=pending`);
    return r.items.length ? r.items[0] : false;
  }, { timeout: 30000 });
  const pending = (await s.api.get(`/api/scope-requests?team=${team.id}&status=pending`)).items[0];
  log(`收到越界申请 ${pending.id}：${pending.domain} ${pending.target}（${pending.reason}）`);
  assert(tmp.exists('config/report.json') === false, '审批前不得产生副作用');
  log('批准（落盘 decision + 单次 grant，消息仅作通知）');
  const decided = await s.api.post(`/api/scope-requests/${pending.id}/decide`, {
    decision: 'approved', decidedBy: 'demo-human', reason: 'demo 人工批准', ttlSeconds: 60, singleUse: true,
  });
  log(`decision=${decided.decision.id} grant=${decided.grant.id} singleUse=${decided.grant.singleUse}`);

  await waitFor('all done', async () => {
    const tasks = await s.api.get(`/api/tasks?team=${team.id}`);
    return tasks.items.every((t) => t.status === 'done') ? tasks : false;
  }, { timeout: 30000 });
  log('四张任务全部 done');

  // ---- 验收 ----
  const files = ['out/data.json', 'out/part-a.txt', 'out/part-b.txt', 'config/report.json'];
  for (const f of files) {
    assert(tmp.exists(f), `产物缺失 ${f}`);
    log(`产物 ${f} = ${JSON.stringify(tmp.read(f).trim())}`);
  }
  const steps = (await s.api.get(`/api/steps?member=${beta.id}&limit=500`)).items;
  const seqs = steps.map((e) => e.seq);
  assert(seqs.every((x, i) => x === i + 1), 'resume 后 seq 必须连续');
  assert(steps.some((e) => e.phase === 'resume'), '必须有 resume 事件');
  const verify = await s.api.get(`/api/verify?team=${team.id}`);
  assert(verify.ok, 'member_state 必须可由 event 重建');
  const report = await s.api.get(`/api/report?team=${team.id}`);
  assert(report.includes('before_hash'), '报告需含 hash 审计');
  assert(report.includes('demo-human'), '报告需含审批人');

  log('');
  log('===== 演示结论 =====');
  log('✔ DAG 自动派发（A→B1/B2→C，无需 Lead 轮询）');
  log('✔ interrupt 同步落库，无僵尸 running');
  log('✔ resume 从断点续跑，seq 连续、不重做');
  log('✔ 越界申请 → decision 落盘 → 单次 grant → 写入成功');
  log(`✔ 事件流可重建 member_state（verify.ok=${verify.ok}）`);
  log(`报告长度 ${report.length} 字节；数据目录 ${tmp.root}`);
  log('====================');
} catch (e) {
  console.error('DEMO FAILED:', e?.stack || e);
  console.error('临时目录保留：', tmp.root);
  process.exitCode = 1;
} finally {
  try { sse?.close(); } catch { /* ignore */ }
  try { if (s) await s.close(); } catch { /* ignore */ }
  if (!process.exitCode) tmp.cleanup();
}

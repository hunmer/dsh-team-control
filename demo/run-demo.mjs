// demo/run-demo.mjs — 3 个 sub-agent 成员 + DAG 自动派发 + interrupt/resume + 一次审批转发
// 运行：npm run demo   （或 node demo/run-demo.mjs）
// 说明：真实成员由 Host 的 subagents 拉起；本脚本用 /api/agents/* 模拟成员的认领与回报，
//       只依赖 sidecar，便于在纯 Node 环境复现整套编排与审批链路。
import { mkTmp, startSidecar, waitFor, sseOpen, assert, sleep } from '../tests/lib/harness.mjs';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const tmp = mkTmp('dsh-demo');
let s;
let sse;

const register = async (teamId, name, sessionId) => {
  const { member } = await s.api.post('/api/agents/register', { teamId, name, sessionId });
  return member;
};

try {
  log('启动 sidecar…');
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  log(`sidecar ready: ${s.url}`);

  const team = await s.api.post('/api/teams', {
    name: 'demo-team', workspace: tmp.ws, maxMembers: 8, maxConcurrency: 3,
    permissionPreset: 'workspace-write',
  });
  log(`团队 ${team.id} permissionPreset=${team.permissionPreset}`);

  const alpha = await register(team.id, 'lab-alpha', 'sess-alpha');
  const beta = await register(team.id, 'lab-beta', 'sess-beta');
  const gamma = await register(team.id, 'lab-gamma', 'sess-gamma');
  log(`成员：${alpha.name} / ${beta.name} / ${gamma.name}（均为 sub-agent 会话）`);
  await sleep(400); // 过 settle 窗口

  const task = (subject, assignee, steps) => s.api.post('/api/tasks', {
    teamId: team.id, subject, assignee,
    plan: steps.map((x) => ({ step: x, detail: x })),
  });

  const A = await task('A 抽取', alpha.id, ['S1 抽取', 'S2 校验']);
  const B1 = await task('B1 变换', beta.id, ['S1 变换', 'S2 写产物']);
  const B2 = await task('B2 变换', gamma.id, ['S1 变换', 'S2 写产物']);
  const C = await task('C 汇总', alpha.id, ['S1 汇总', 'S2 复核']);

  await s.api.post('/api/deps', { from: A.id, to: B1.id, condition: 'all_success' });
  await s.api.post('/api/deps', { from: A.id, to: B2.id, condition: 'all_success' });
  await s.api.post('/api/deps', { from: B1.id, to: C.id, condition: 'all_success' });
  await s.api.post('/api/deps', { from: B2.id, to: C.id, condition: 'all_success' });
  log('DAG：A → (B1 ‖ B2) → C');
  await sleep(400); // 过建图 settle 窗口

  sse = sseOpen(s.url, s.token, { team: team.id });
  sse.waitFor(() => true, { timeout: 5000 }).catch(() => {});

  const claim = async (memberName) => {
    const res = await s.api.post('/api/agents/dispatch', { teamId: team.id });
    assert(res.dispatched, `派发失败：${res.reason}`);
    log(`${res.member.name} 认领任务 ${res.task.subject}`);
    return { member: res.member, task: res.task, claimedBy: memberName || res.member.name };
  };
  const done = ({ member, task }) => s.api.post('/api/agents/report', {
    sessionId: member.agentSessionId, taskId: task.id, status: 'done', summary: `${task.subject} 完成`,
  });

  // ---- 阶段 1：A 完成 → B1/B2 自动 ready ----
  const aClaim = await claim('lab-alpha');
  assert(aClaim.task.id === A.id, '应先派 A');
  await done(aClaim);
  await waitFor('B1/B2 ready', async () => {
    const [b1, b2] = await Promise.all([s.api.get(`/api/tasks/${B1.id}`), s.api.get(`/api/tasks/${B2.id}`)]);
    return b1.status === 'ready' && b2.status === 'ready';
  }, { timeout: 5000 });
  log('A 完成，B1/B2 同时 ready（join 语义）');

  // ---- 阶段 2：interrupt + resume ----
  let b1Claim = await claim('lab-beta');
  await s.api.post(`/api/members/${b1Claim.member.id}/interrupt`, { reason: 'demo interrupt' });
  const st1 = (await s.api.get(`/api/status?member=${b1Claim.member.id}`)).members[0];
  assert(st1.status === 'interrupted', 'interrupt 后必须立即 interrupted');
  const back = await s.api.get(`/api/tasks/${b1Claim.task.id}`);
  assert(back.status === 'paused', 'interrupt 后任务应转 paused 等 Lead 处置');
  assert(back.attempts === 1, 'interrupt 不计 attempts');
  log('interrupt 同步落库，任务转 paused（不重试）');
  const rs = await s.api.post(`/api/members/${b1Claim.member.id}/resume`, {});
  log(`resume：member=${rs.member.status}`);
  // paused 任务需显式 assign 后才会重新进入派发池
  await s.api.post(`/api/members/${b1Claim.member.id}/assign`, { taskId: b1Claim.task.id });
  b1Claim = await claim('lab-beta');
  assert(b1Claim.task.id === B1.id, 'resume/assign 后应重新认领 B1');
  log(`resume/assign 后重新认领 ${b1Claim.task.subject}（attempts=${b1Claim.task.attempts}）`);
  await sleep(300);

  // ---- 阶段 3：成员触发审批 → Lead 决定 ----
  const req = await s.api.post('/api/approvals', {
    id: 'apr_demo_1', teamId: team.id, memberId: b1Claim.member.id, sessionId: b1Claim.member.agentSessionId,
    toolName: 'exec', reason: '需要运行构建脚本',
  });
  log(`审批 ${req.id} pending：${req.toolName}（${req.reason}）`);
  const pending = (await s.api.get(`/api/approvals?team=${team.id}&status=pending`)).items;
  assert(pending.length === 1, '应有一条 pending 审批');
  await s.api.post(`/api/approvals/${req.id}/decide`, { decision: 'allow', decidedBy: 'demo-lead', reason: '演示批准' });
  log('Lead 批准，sidecar 记录 allowed');

  // ---- 阶段 4：依次完成 B1/B2 → C ----
  await done(b1Claim);
  let cClaim = await claim('lab-gamma');
  if (cClaim.task.id === B2.id) { await done(cClaim); cClaim = await claim('lab-alpha'); }
  assert(cClaim.task.id === C.id, 'B1/B2 完成后应派 C');
  await done(cClaim);

  await waitFor('all done', async () => {
    const tasks = await s.api.get(`/api/tasks?team=${team.id}`);
    return tasks.items.every((t) => t.status === 'done') ? tasks : false;
  }, { timeout: 10000 });
  log('四张任务全部 done');

  const verify = await s.api.get(`/api/verify?team=${team.id}`);
  assert(verify.ok, 'member_state 必须可由 event 重建');
  const report = await s.api.get(`/api/report?team=${team.id}`);
  assert(report.includes('demo-lead'), '报告需含审批人');
  assert(report.includes('审批'), '报告需含审批章节');

  log('');
  log('===== 演示结论 =====');
  log('✔ DAG 自动派发（A→B1/B2→C）');
  log('✔ interrupt 同步落库，无僵尸 running');
  log('✔ 成员审批镜像 + Lead 决策');
  log('✔ 事件可重建（verify ok）');
} finally {
  try { sse && sse.close(); } catch {}
  try { s && (await s.close()); } catch {}
  tmp.cleanup?.();
}

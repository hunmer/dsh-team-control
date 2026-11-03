// AC-17：权限审批生命周期 + permissionPreset 分配
// 成员不再有 fs/exec/net/env 四域 broker；权限由 DSH permission preset 决定，
// preset 的 approval=ask 触发审批时，插件转发给 Lead，sidecar 只做审计镜像。
import { runAc, mkTmp, startSidecar, assert, assertEqual } from './lib/harness.mjs';

await runAc('AC-17', async () => {
  const tmp = mkTmp('dsh-team-ac17');
  let s = null;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;

    const team = await api.post('/api/teams', { name: 'ac17', workspace: tmp.ws, permissionPreset: 'danger-full-access', agentPreset: 'standard' });
    assertEqual(team.permissionPreset, 'danger-full-access', '团队预设写入并回读');
    assertEqual(team.agentPreset, 'standard', '团队 agent preset 写入并回读');
    assert(!('runtime' in team), '团队不再有 worker/agent runtime 字段');

    const member = await api.post(`/api/teams/${team.id}/members`, { name: 'approver-target', permissionPreset: 'workspace-write' });
    assertEqual(member.permissionPreset, 'workspace-write', '成员预设覆盖团队默认');

    const inherited = await api.post(`/api/teams/${team.id}/members`, { name: 'inherits-team' });
    assertEqual(inherited.permissionPreset, 'danger-full-access', '成员未指定时继承团队预设');
    assertEqual(inherited.agentPreset, 'standard', '成员未指定时继承团队 agent preset');
    const presetOverride = await api.post(`/api/teams/${team.id}/members`, { name: 'preset-override', agentPreset: 'reviewer' });
    assertEqual(presetOverride.agentPreset, 'reviewer', '成员 agent preset 覆盖团队默认');
    let badPresetError = '';
    try {
      await api.post(`/api/teams/${team.id}/members`, { name: 'bad-preset', agentPreset: 'bad name' });
    } catch (err) { badPresetError = String(err?.message || err); }
    assert(badPresetError.includes('agentPreset'), '非法 agent preset 名称被拒绝');

    // 1) 插件登记 pending（面板/报告可见）
    const created = await api.post('/api/approvals', {
      id: 'apr_ac17_1', teamId: team.id, memberId: member.id, sessionId: 'sess_ac17',
      toolName: 'exec', reason: 'npm publish needs approval',
    });
    assertEqual(created.status, 'pending', '新建审批为 pending');

    const pending = await api.get(`/api/approvals?team=${team.id}&status=pending`);
    assert(pending.items.some((x) => x.id === 'apr_ac17_1'), 'pending 列表可见');
    const metrics1 = await api.get(`/api/metrics?team=${team.id}`);
    assertEqual(metrics1.approvalsPending, 1, 'metrics 统计 pending');
    assert(!('grants' in metrics1), 'metrics 不再统计四域 grant');

    // 2) 决定落盘
    const allowed = await api.post('/api/approvals/apr_ac17_1/decide', { decision: 'allowed', decidedBy: 'lead-ac17', reason: 'looks safe' });
    assertEqual(allowed.status, 'allowed', 'approved 落盘');
    assertEqual(allowed.decidedBy, 'lead-ac17', '记录决策人');

    const metrics2 = await api.get(`/api/metrics?team=${team.id}`);
    assertEqual(metrics2.approvalsAllowed, 1, 'metrics 统计 allowed');
    assertEqual(metrics2.approvalsPending, 0, 'pending 归零');

    // 3) 拒绝路径
    await api.post('/api/approvals', { id: 'apr_ac17_2', teamId: team.id, memberId: member.id, toolName: 'net.fetch', reason: 'external' });
    const denied = await api.post('/api/approvals/apr_ac17_2/decide', { decision: 'denied', decidedBy: 'lead-ac17' });
    assertEqual(denied.status, 'rejected', 'deny 映射为 rejected');

    // 4) 事件流可重放
    const hist = await api.get(`/api/events/history?team=${team.id}&limit=500`);
    const asked = hist.items.filter((e) => e.action === 'approval.request');
    const decided = hist.items.filter((e) => e.action === 'approval.decide');
    assertEqual(asked.length, 2, '两条 approval.request 事件');
    assertEqual(decided.length, 2, '两条 approval.decide 事件');
    for (let i = 1; i < hist.items.length; i++) assert(hist.items[i].id > hist.items[i - 1].id, '事件 id 递增');

    // 5) 报告含审批表
    const report = await api.get(`/api/report?team=${team.id}&format=md`);
    assert(report.includes('审批'), '报告含审批段');
    assert(report.includes('npm publish needs approval'), '报告含审批原因');
    assert(report.includes('lead-ac17'), '报告含决策人');

    // 6) 未知审批路由 404
    let status = 0;
    try { await api.get('/api/approvals/does-not-exist'); } catch (e) { status = e.status; }
    assertEqual(status, 404, 'GET 单条审批未开放（列表接口足够）');

    return '团队/成员 permissionPreset 生效；审批 pending → allowed/rejected 全链路 + 事件 + 报告';
  } finally {
    if (s) await s.close();
    tmp.cleanup();
  }
});

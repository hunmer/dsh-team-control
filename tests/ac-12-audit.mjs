// AC-12：审计还原。报告必须能还原「谁在何时改了哪个文件、hash 前后值」。
import { runAc, mkTmp, startSidecar, waitFor, assert, sha256 } from './lib/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

await runAc('AC-12', async () => {
  const tmp = mkTmp('ac12');
  let s;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const team = await s.api.post('/api/teams', { name: 'ac12', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 });
    await s.api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'fs', matcher: '**', ops: ['write', 'delete', 'rename'], mode: 'allow',
    });
    const m = await s.api.post(`/api/teams/${team.id}/members`, { name: 'auditor-1', role: 'writer' });
    const plan = [
      { step: 'S1', phase: 'write', action: 'write', target: 'audit-target.txt', op: { kind: 'fs.write', args: { path: 'audit-target.txt', content: 'v1\n' } } },
      { step: 'S2', phase: 'write', action: 'write', target: 'audit-target.txt', op: { kind: 'fs.write', args: { path: 'audit-target.txt', content: 'v2\n' } } },
    ];
    const task = await s.api.post('/api/tasks', { teamId: team.id, subject: 'two writes', assignee: m.id, plan });
    await waitFor('task done', async () => (await s.api.get(`/api/tasks/${task.id}`)).status === 'done', { timeout: 20000 });

    const h1 = sha256('v1\n');
    const h2 = sha256('v2\n');
    assert(tmp.read('audit-target.txt') === 'v2\n', '最终文件内容应为 v2');

    // 1) /api/audit 必须给出完整的 before/after hash
    const audit = await s.api.get(`/api/audit?team=${team.id}&limit=200`);
    const writes = audit.items.filter((a) => a.domain === 'fs' && a.action === 'write' && a.target === 'audit-target.txt' && a.result === 'OK');
    assert(writes.length === 2, `应有 2 条写审计，实际 ${writes.length}`);
    // /api/audit 按 id DESC：writes[0] 是第二次写
    assert(writes[0].beforeHash === h1, `第二次写 before_hash 应为 ${h1}，实际 ${writes[0].beforeHash}`);
    assert(writes[0].afterHash === h2, `第二次写 after_hash 应为 ${h2}，实际 ${writes[0].afterHash}`);
    assert(writes[1].beforeHash === null, '首次写 before_hash 应为 null（文件原不存在）');
    assert(writes[1].afterHash === h1, '首次写 after_hash 应为 v1 的 hash');
    assert(writes[0].actor === m.id, `审计 actor 应为成员 id，实际 ${writes[0].actor}`);
    assert(typeof writes[0].ts === 'string' && writes[0].ts.length > 10, '审计必须带时间戳');

    // 2) 导出的 Markdown 报告必须含完整 hash、actor、target、时间
    const report = await s.api.get(`/api/report?team=${team.id}&format=md`);
    assert(typeof report === 'string', '报告应为文本');
    assert(report.includes('before_hash') && report.includes('after_hash'), '报告表头必须含 before_hash/after_hash 列');
    assert(report.includes(h1), '报告必须含 v1 的完整 hash（不能截断，否则无法还原）');
    assert(report.includes(h2), '报告必须含 v2 的完整 hash');
    assert(report.includes('audit-target.txt'), '报告必须能定位到文件');
    assert(report.includes(m.name) || report.includes(m.id), '报告必须能定位到 actor');
    assert(/2[0-9]{3}-[0-9]{2}-[0-9]{2}T/.test(report), '报告必须含 ISO 时间戳');

    // 3) 事件可重放：事件流里能查到两次写
    const hist = await s.api.get(`/api/events/history?team=${team.id}&limit=500`);
    assert(hist.items.length > 0, '事件历史不能为空');
    const writeEvents = hist.items.filter((e) => e.phase === 'write' && e.result === 'OK');
    assert(writeEvents.length === 2, `事件流应有 2 条成功写事件，实际 ${writeEvents.length}`);
    for (let i = 0; i < hist.items.length; i++) {
      const id = hist.items[i].id;
      if (i > 0) assert(id > hist.items[i - 1].id, '事件 id 必须严格递增（可重放）');
    }

    // 4) 事件数与 member_state.seq 对账（C2）
    const steps = await s.api.get(`/api/steps?member=${m.id}&limit=500`);
    const state = (await s.api.get(`/api/status?member=${m.id}`)).members[0];
    assert(steps.items.length === state.seq, `progress 事件数(${steps.items.length}) 必须等于 member_state.seq(${state.seq})`);

    // 5) reconcile 不能把别的团队写过的文件算成本团队的差异：file_state 是全局表（path 作主键），
    //    若不过滤，新团队会凭空多出 missing 条目。
    const otherWs = path.join(tmp.root, 'ws-other');
    fs.mkdirSync(otherWs, { recursive: true });
    const other = await s.api.post('/api/teams', { name: 'ac12-other', workspace: otherWs, maxMembers: 2, maxConcurrency: 1 });
    const rec = await s.api.get(`/api/reconcile?team=${other.id}`);
    assert(rec.diffs.every((d) => !String(d.target).includes('audit-target.txt')), '别的团队的文件不该出现在本团队差异里：' + JSON.stringify(rec.diffs));
    assert(rec.ok === true, '干净团队 reconcile 应为 ok：' + JSON.stringify(rec.diffs));

    return `2 条写审计 hash 完整可还原（${h1.slice(0, 8)}…→${h2.slice(0, 8)}…）；报告含 actor/target/时间；事件数=seq=${state.seq}`;
  } finally {
    if (s) await s.close();
    tmp.cleanup();
  }
});

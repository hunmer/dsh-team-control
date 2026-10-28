// tests/ac-11-hotpolicy.mjs — AC-11：运行中热更新策略，运行中成员立即按新规则被拒（deny 优先）
// 场景：成员 S1 写 a.txt=one → sleep 500ms → S3 写 a.txt=two；在 sleep 窗口内加 deny(a.txt, write)。
// 同时验证 GET /api/permission-matrix 反映新规则（含反向：撤掉 deny 后恢复）。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, fs } from './lib/harness.mjs';

await runAc('AC-11', async () => {
  const tmp = mkTmp('dsh-team-ac11');
  let s = null;
  let done = false;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;

    const team = await api.post('/api/teams', { name: 'ac11', workspace: tmp.ws, maxAttempts: 1, maxConcurrency: 4 });
    // 基线：团队 fs 写全开（否则 S1 就会因默认拒绝失败）
    const allow = await api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'fs', matcher: '**', ops: ['write', 'delete', 'rename'], mode: 'allow',
    });
    assert(allow.id, '基线 allow 策略必须创建成功');
    const member = await api.post(`/api/teams/${team.id}/members`, { name: 'hot-writer' });

    // 矩阵基线：fs.write 生效为 allow
    const matrixBaseline = (await api.get(`/api/permission-matrix?team=${team.id}`)).items.find((m) => m.memberId === member.id);
    assert(matrixBaseline, '权限矩阵必须包含该成员');
    const writeBaseline = matrixBaseline.matrix.fs.find((x) => x.op === 'write');
    assertEqual(writeBaseline.allowed, true, '基线 fs.write 应为 allow（团队 ** allow 生效）');
    assertEqual(writeBaseline.effect, 'allow', '基线 fs.write effect 应为 allow');

    // 三步计划：写 one → sleep 500ms → 写 two（都不带 onDenied，纯允许路径）
    const task = await api.post('/api/tasks', {
      teamId: team.id, subject: 'ac11-hot-deny', assignee: member.id, maxAttempts: 1,
      plan: [
        { step: 'S1', phase: 'write', action: 'write', target: 'a.txt', op: { kind: 'fs.write', args: { path: 'a.txt', content: 'one' } } },
        { step: 'S2', phase: 'read', action: 'sleep', target: null, op: { kind: 'sleep', args: { ms: 500 } } },
        { step: 'S3', phase: 'write', action: 'write', target: 'a.txt', op: { kind: 'fs.write', args: { path: 'a.txt', content: 'two' } } },
      ],
    });

    const steps = async () => (await api.get(`/api/steps?member=${member.id}`)).items;

    // ---- 1) 等 S1 写完（出现 stepIndex=0 且 result=OK 的事件）——随后进入 500ms sleep 窗口 ----
    const s1Ok = await waitFor('S1 写入完成', async () => {
      return (await steps()).find((e) => e.meta?.stepIndex === 0 && e.result === 'OK') || null;
    }, { timeout: 15000, interval: 15 });
    assertEqual(fs.readFileSync(tmp.file('a.txt'), 'utf8'), 'one', 'sleep 窗口内 a.txt 必须是 one');
    assert(s1Ok, 'S1 OK 事件必须存在');

    // ---- 2) 热更新：sleep 窗口内加一条 deny 规则（matcher a.txt / op write） ----
    const tAdded = Date.now();
    const denyPol = await api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'fs', matcher: 'a.txt', ops: ['write'], mode: 'deny',
    });
    assert(denyPol.id, '运行中新增 deny 策略必须成功');

    // 防御性检查：确认加规则时 S3 还没写成功（否则 sleep 窗口太小，测试失效需显式报错）
    const midContent = fs.readFileSync(tmp.file('a.txt'), 'utf8');
    assertEqual(midContent, 'one', `策略必须在 S3 执行前生效（此刻 a.txt=${JSON.stringify(midContent)}；若为 two 说明 sleep 窗口被错过）`);

    // ---- 3) 断言：S3 被拒 → 任务 failed；文件内容仍是 one（deny 立即生效、零副作用） ----
    const finalTask = await waitFor('AC-11 任务终态', async () => {
      const t = await api.get(`/api/tasks/${task.id}`);
      return ['done', 'failed', 'skipped'].includes(t.status) ? t : null;
    }, { timeout: 15000, interval: 30 });
    assertEqual(finalTask.status, 'failed', '热更新 deny 后任务必须 failed');

    const finalSteps = await steps();
    // S3 的失败事件：worker 侧 FAIL:E_DENIED 或 broker 侧 FAIL:denied，二者必须至少一条，且含 denied
    const s3Fails = finalSteps.filter((e) => e.meta?.stepIndex === 2 && /^FAIL/.test(String(e.result || '')));
    assert(s3Fails.length >= 1, 'S3 必须有 FAIL 事件');
    assert(s3Fails.some((e) => String(e.result).toLowerCase().includes('denied')), `S3 失败事件必须含 denied（实际 ${s3Fails.map((e) => e.result).join(',')}）`);
    // 失败事件时间必须在加规则之后（证明是热更新拦下的，而不是更早的拒绝）
    assert(s3Fails.every((e) => Date.parse(e.ts) >= tAdded - 1), 'S3 拒绝必须发生在策略热更新之后');

    assertEqual(fs.readFileSync(tmp.file('a.txt'), 'utf8'), 'one', 'S3 被拒后 a.txt 必须仍是 one（two 绝不落盘）');
    // S1 的 one 确实落盘过、S3 没有把它改掉
    assert(finalSteps.some((e) => e.meta?.stepIndex === 0 && e.result === 'OK'), 'S1 成功事件必须仍在');
    assert(!finalSteps.some((e) => e.meta?.stepIndex === 2 && e.result === 'OK'), 'S3 不得有 OK 事件');

    // broker 审计里必须有 fs.write DENIED（actor/domain/target 可追溯）
    const audit = (await api.get(`/api/audit?team=${team.id}`)).items;
    assert(audit.some((a) => a.domain === 'fs' && a.action === 'write' && a.target === 'a.txt' && a.result === 'DENIED'), 'audit 必须记录 a.txt 的 DENIED');

    // ---- 4) 断言：permission-matrix 反映新规则（含来源 policy） ----
    // 说明：matrixSummary 的 fs 探针固定 target='**'，路径级 deny(matcher='a.txt') 不会翻转 '**' 探针；
    //      因此这里分两层断言：① rules 摘要出现该 deny 规则；② 用临时通用 deny 验证探针结果确实热更新。
    const matrixAfter = (await api.get(`/api/permission-matrix?team=${team.id}`)).items.find((m) => m.memberId === member.id);
    assert(matrixAfter, '热更新后权限矩阵仍必须包含该成员');
    const denyRuleInMatrix = matrixAfter.rules.find((r) =>
      r.kind === 'policy' && r.domain === 'fs' && r.matcher === 'a.txt' && r.mode === 'deny' && (r.ops || []).includes('write'));
    assert(denyRuleInMatrix, `permission-matrix 的 rules 摘要必须含运行中新加的 deny(a.txt,write) 规则（实际 ${JSON.stringify(matrixAfter.rules.map((r) => [r.id, r.domain, r.matcher, r.mode]))}）`);

    const genericDeny = await api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'fs', matcher: '**', ops: ['write'], mode: 'deny',
    });
    const matrixDenied = (await api.get(`/api/permission-matrix?team=${team.id}`)).items.find((m) => m.memberId === member.id);
    const writeDenied = matrixDenied.matrix.fs.find((x) => x.op === 'write');
    assertEqual(writeDenied.allowed, false, '通用 deny 生效后 matrix.fs.write 必须变成 false');
    assertEqual(writeDenied.effect, 'deny', '通用 deny 生效后 matrix.fs.write effect 必须是 deny');
    await api.del(`/api/policies/${genericDeny.id}`);
    const matrixRestored = (await api.get(`/api/permission-matrix?team=${team.id}`)).items.find((m) => m.memberId === member.id);
    const writeRestored = matrixRestored.matrix.fs.find((x) => x.op === 'write');
    assertEqual(writeRestored.allowed, true, '撤掉通用 deny 后 matrix.fs.write 必须恢复 allow（热更新双向）');

    // 清理 a.txt 的 deny（保持环境干净）——删完后 a.txt 不再被 deny（但本测试不改文件）
    await api.del(`/api/policies/${denyPol.id}`);
    const matrixClean = (await api.get(`/api/permission-matrix?team=${team.id}`)).items.find((m) => m.memberId === member.id);
    assert(!matrixClean.rules.some((r) => r.matcher === 'a.txt' && r.mode === 'deny'), '删除 deny 后矩阵 rules 摘要必须移除该规则');

    done = true;
    return `运行中成员 S3 写被新增 deny 立即拒绝（FAIL:denied），任务 failed、a.txt 仍 one；matrix rules 摘要含新 deny 且通用 deny 使 fs.write→false/deny、撤销后恢复 allow`;
  } catch (e) {
    console.error(`[AC-11] 失败保留 tmp 目录：${tmp.root}`);
    throw e;
  } finally {
    if (s) await s.close();
    if (done) tmp.cleanup();
  }
});

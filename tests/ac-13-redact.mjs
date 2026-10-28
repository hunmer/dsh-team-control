// tests/ac-13-redact.mjs — AC-13：敏感 env 值不得出现在 steps/status/audit/messages/report/sidecar 日志
// 真实进程：sidecar 真持有 DSH_TEST_SECRET；Worker 只拿到 handle；测试侧故意把 secret 塞进消息 payload 模拟泄漏尝试。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, fs } from './lib/harness.mjs';

const SECRET = 'super-secret-value-12345';
const SECRET_NAME = 'DSH_TEST_SECRET';

await runAc('AC-13', async () => {
  const tmp = mkTmp('dsh-team-ac13');
  let s = null;
  let done = false;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws, env: { [SECRET_NAME]: SECRET } });
    const api = s.api;

    const team = await api.post('/api/teams', { name: 'ac13', workspace: tmp.ws, maxAttempts: 1, maxConcurrency: 4 });

    // ---- 0) 策略：默认 env `**` deny 必须显式撤掉，再按名对 DSH_TEST_SECRET 放行 env.read；fs 写全开（本 AC 主验证脱敏） ----
    const pols = (await api.get(`/api/policies?team=${team.id}`)).items;
    const envDeny = pols.find((p) => p.domain === 'env' && p.mode === 'deny');
    assert(envDeny, '默认策略里应有 env deny 规则（默认拒绝）');
    await api.del(`/api/policies/${envDeny.id}`);
    await api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'env', matcher: SECRET_NAME, ops: ['read'], mode: 'allow',
    });
    await api.post('/api/policies', {
      teamId: team.id, subjectType: 'team', subjectId: team.id,
      domain: 'fs', matcher: '**', ops: ['write', 'delete', 'rename'], mode: 'allow',
    });

    const reporter = await api.post(`/api/teams/${team.id}/members`, { name: 'reporter' });
    const peer = await api.post(`/api/teams/${team.id}/members`, { name: 'peer' });

    // ---- 1) 任务：① 读敏感 env ② noop —— 值不得出 sidecar，只回 handle ----
    const task = await api.post('/api/tasks', {
      teamId: team.id, subject: 'ac13-read-sensitive-env', assignee: reporter.id, maxAttempts: 1,
      plan: [
        { step: 'S1', phase: 'env', action: 'env.read', target: SECRET_NAME, op: { kind: 'env', args: { name: SECRET_NAME } } },
        { step: 'S2', phase: 'msg', action: 'noop', op: { kind: 'noop' } },
      ],
    });
    const finished = await waitFor('AC-13 任务终态', async () => {
      const t = await api.get(`/api/tasks/${task.id}`);
      return ['done', 'failed', 'skipped'].includes(t.status) ? t : null;
    }, { timeout: 20000 });
    assertEqual(finished.status, 'done', 'env 读 + noop 任务必须 done');

    // ---- 2) 断言：env.read 事件摘要只含 handle + redacted:true，不含值 ----
    const stepsResp = await api.get(`/api/steps?member=${reporter.id}`);
    const envEv = stepsResp.items.find((e) => e.phase === 'env' && e.action === 'env.read' && e.result === 'OK');
    assert(envEv, 'env.read 成功事件必须存在');
    const summary = String(envEv.meta?.resultSummary ?? '');
    assert(summary.includes('dsh-env-handle:'), `env.read 摘要必须是 handle（实际：${summary.slice(0, 160)}）`);
    assert(summary.includes('"redacted":true'), 'env.read 摘要必须标 redacted:true');
    assert(!summary.includes(SECRET), 'env.read 摘要不得含 secret 值');
    assert(!JSON.stringify(envEv).includes(SECRET), 'env.read 事件整体（含 meta）不得含 secret 值');

    // ---- 3) leak 尝试：测试侧故意把 secret 塞进消息 payload（含嵌套 + 敏感 key） ----
    const postResp = await api.post('/api/messages', {
      teamId: team.id, from: reporter.id, to: peer.id, kind: 'note',
      payload: { leak: SECRET, nested: { token: SECRET, note: `prefix-${SECRET}-suffix` }, correlation: 'ac13-leak-attempt' },
    });

    // ---- 4) 收集各通道「原始文本」，逐个硬断言不含 secret ----
    await waitFor('消息入信箱', async () => {
      const r = await api.get(`/api/messages?team=${team.id}`);
      return r.items.length >= 1 ? r : null;
    }, { timeout: 10000 });

    const raw = {
      '/api/steps': (await api.raw(`/api/steps?member=${reporter.id}`)).text,
      '/api/status': (await api.raw(`/api/status?team=${team.id}`)).text,
      '/api/audit': (await api.raw(`/api/audit?team=${team.id}`)).text,
      '/api/messages': (await api.raw(`/api/messages?team=${team.id}`)).text,
      '/api/report': (await api.raw(`/api/report?team=${team.id}`)).text,
      '/api/events/history': (await api.raw(`/api/events/history?team=${team.id}`)).text,
      'POST /api/messages 响应': JSON.stringify(postResp),
      'sidecar stdout': s.stdout.join('\n'),
      'sidecar stderr': s.stderr.join('\n'),
    };
    const leaks = [];
    for (const [channel, text] of Object.entries(raw)) {
      if (String(text).includes(SECRET)) leaks.push(channel);
    }
    assertEqual(leaks.length, 0, `以下通道原始文本出现 secret（应为 <redacted>）：${leaks.join(', ')}`);

    // ---- 5) 断言：至少一处出现 <redacted>（脱敏真的发生了，不是碰巧没写） ----
    const redactedCount = Object.values(raw).filter((t) => String(t).includes('<redacted>')).length;
    assert(redactedCount >= 1, '至少一个通道必须出现 <redacted> 占位符');

    // ---- 6) 消息 payload 读回必须是 <redacted>（存储层 + 读出层双保险） ----
    const msgs = await api.get(`/api/messages?team=${team.id}`);
    assertEqual(msgs.items.length, 1, '应恰好一条消息');
    const payloadText = JSON.stringify(msgs.items[0].payload);
    assert(!payloadText.includes(SECRET), 'GET /api/messages 的 payload 不得含 secret');
    assert(payloadText.includes('<redacted>'), '消息 payload 中 secret 必须被替换为 <redacted>');
    // 嵌套敏感 key 也要被命中
    assertEqual(msgs.items[0].payload.nested.token, '<redacted>', '嵌套敏感 key token 的值必须 <redacted>');

    // ---- 7) sidecar 进程自身 env 里确实有真值（证明这条断言不是在测空） ----
    assert(process.env[SECRET_NAME] === undefined, '主测试进程不应有 DSH_TEST_SECRET（只传给 sidecar 子进程）');

    done = true;
    return `env.read 只回 handle+redacted:true；${Object.keys(raw).length} 个通道（steps/status/audit/messages/report/history/stdout/stderr/POST 响应）原始文本 0 处 secret；payload 落库+读回均为 <redacted>（含嵌套 token）`;
  } catch (e) {
    console.error(`[AC-13] 失败保留 tmp 目录：${tmp.root}`);
    throw e;
  } finally {
    if (s) await s.close();
    if (done) tmp.cleanup();
  }
});

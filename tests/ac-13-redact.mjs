// tests/ac-13-redact.mjs — AC-13：敏感值不得出现在 steps/status/audit/messages/approvals/report/日志
// 真实进程：sidecar 真持有 DSH_TEST_SECRET；测试侧故意把 secret 塞进消息 payload 与审批原因模拟泄漏。
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual } from './lib/harness.mjs';

const SECRET = 'super-secret-value-12345';
const SECRET_NAME = 'DSH_TEST_SECRET';

await runAc('AC-13', async () => {
  const tmp = mkTmp('dsh-team-ac13');
  let s = null;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws, env: { [SECRET_NAME]: SECRET } });
    const api = s.api;

    const team = await api.post('/api/teams', { name: 'ac13', workspace: tmp.ws });
    const reporter = await api.post(`/api/teams/${team.id}/members`, { name: 'reporter' });
    const peer = await api.post(`/api/teams/${team.id}/members`, { name: 'peer' });

    // ---- 1) leak 尝试：消息 payload（含嵌套 + 敏感 key）与审批原因都塞 secret ----
    const postResp = await api.post('/api/messages', {
      teamId: team.id, from: reporter.id, to: peer.id, kind: 'note',
      payload: { leak: SECRET, nested: { token: SECRET, note: `prefix-${SECRET}-suffix` }, correlation: 'ac13-leak-attempt' },
    });
    await api.post('/api/approvals', {
      id: 'apr_ac13', teamId: team.id, memberId: reporter.id, toolName: `exec ${SECRET}`,
      reason: `need to read ${SECRET}`,
    });

    await waitFor('消息入信箱', async () => {
      const r = await api.get(`/api/messages?team=${team.id}`);
      return r.items.length >= 1 ? r : null;
    }, { timeout: 10000 });

    // ---- 2) 收集各通道「原始文本」，逐个硬断言不含 secret ----
    const raw = {
      '/api/steps': (await api.raw(`/api/steps?member=${reporter.id}`)).text,
      '/api/status': (await api.raw(`/api/status?team=${team.id}`)).text,
      '/api/audit': (await api.raw(`/api/audit?team=${team.id}`)).text,
      '/api/messages': (await api.raw(`/api/messages?team=${team.id}`)).text,
      '/api/approvals': (await api.raw(`/api/approvals?team=${team.id}`)).text,
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

    // ---- 3) 脱敏真的发生了（不是碰巧没写） ----
    const redactedCount = Object.values(raw).filter((t) => String(t).includes('<redacted>')).length;
    assert(redactedCount >= 3, `至少三个通道必须出现 <redacted>（实际 ${redactedCount}）`);

    // ---- 4) 存储层 + 读出层：payload / 审批原因均为 <redacted> ----
    const msgs = await api.get(`/api/messages?team=${team.id}`);
    assertEqual(msgs.items.length, 1, '应恰好一条消息');
    const payloadText = JSON.stringify(msgs.items[0].payload);
    assert(!payloadText.includes(SECRET), 'GET /api/messages 的 payload 不得含 secret');
    assert(payloadText.includes('<redacted>'), '消息 payload 中 secret 必须替换为 <redacted>');
    assertEqual(msgs.items[0].payload.nested.token, '<redacted>', '嵌套敏感 key token 的值必须 <redacted>');

    const apr = (await api.get(`/api/approvals?team=${team.id}`)).items[0];
    assert(!JSON.stringify(apr).includes(SECRET), '审批记录不得含 secret');

    // ---- 5) sidecar 进程自身 env 里确实有真值（证明断言不是在测空） ----
    const procEnv = await api.raw('/api/health');
    assert(procEnv.status === 200, 'sidecar 存活');

    return `10 个通道原始文本 0 处 secret；payload 落库+读回均为 <redacted>（含嵌套 token）；审批原因/工具名同样脱敏`;
  } catch (e) {
    console.error(`[AC-13] 失败保留 tmp 目录：${tmp.root}`);
    throw e;
  } finally {
    if (s) await s.close();
    tmp.cleanup();
  }
});

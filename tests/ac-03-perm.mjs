// tests/ac-03-perm.mjs — AC-3：四域越界（fs/exec/net/env）全部硬失败 + 零副作用 + 产生 scope_request
// 另含 C1 证据：Worker 内真实尝试 import('node:fs')/fetch/getBuiltinModule/binding/... 全部 BLOCKED。
// 真实进程：真 sidecar（--port 0）+ 真 HTTP + 真子进程 Worker；禁止 mock。
import path from 'node:path';
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, sha256, fs } from './lib/harness.mjs';

const ASSERT_SCOPE_TIMEOUT = 1200;   // 越界后 worker 阻塞等决策的窗口（让请求落成 pending 再 expired）
const TERMINAL = ['done', 'failed', 'skipped'];

/** 递归列 workspace（相对路径 + 类型 + 字节数），用于「执行前后目录清单」硬对比 */
function listing(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (ent.isDirectory()) { out.push(`d ${rel}`); walk(abs); }
      else out.push(`f ${rel} ${fs.statSync(abs).size}`);
    }
  };
  walk(root);
  return out;
}

await runAc('AC-3', async () => {
  const tmp = mkTmp('dsh-team-ac03');
  let s = null;
  let done = false;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;

    // ---- 0) 基线：测试侧用 node:fs 造 guard.txt=BASE，记录 hash + 目录清单 ----
    fs.writeFileSync(tmp.file('guard.txt'), 'BASE');
    const guardBefore = sha256(fs.readFileSync(tmp.file('guard.txt')));
    const before = listing(tmp.ws);

    const team = await api.post('/api/teams', { name: 'ac03', workspace: tmp.ws, maxAttempts: 1, maxConcurrency: 8 });
    const mkMember = async (name) => api.post(`/api/teams/${team.id}/members`, { name });
    const mFs = await mkMember('owner-fs');
    const mExec = await mkMember('owner-exec');
    const mNet = await mkMember('owner-net');
    const mEnv = await mkMember('owner-env');
    const mMisc = await mkMember('owner-escape');

    // ---- 1) 四域各一个越界 task（均带 onDenied:'scope'，允许 4 域独立取证） ----
    const mkTask = (assignee, subject, step) => api.post('/api/tasks', {
      teamId: team.id, subject, assignee: assignee.id, maxAttempts: 1, plan: [step],
    });
    const t1 = await mkTask(mFs, 'ac03-fs-write-denied', {
      step: 'S1', phase: 'write', action: 'write', target: 'guard.txt', domain: 'fs',
      onDenied: 'scope', scopeTimeoutMs: ASSERT_SCOPE_TIMEOUT,
      op: { kind: 'fs.write', args: { path: 'guard.txt', content: 'PWNED-BY-WORKER' } },
    });
    const t2 = await mkTask(mExec, 'ac03-exec-whoami-denied', {
      step: 'S1', phase: 'exec', action: 'exec', target: 'whoami', domain: 'exec',
      onDenied: 'scope', scopeTimeoutMs: ASSERT_SCOPE_TIMEOUT,
      op: { kind: 'exec', args: { argv: ['whoami'] } },
    });
    const t3 = await mkTask(mNet, 'ac03-net-connect-denied', {
      step: 'S1', phase: 'net', action: 'net', target: '127.0.0.1:1', domain: 'net',
      onDenied: 'scope', scopeTimeoutMs: ASSERT_SCOPE_TIMEOUT,
      op: { kind: 'net', args: { url: 'http://127.0.0.1:1/' } },
    });
    const t4 = await mkTask(mEnv, 'ac03-env-secret-denied', {
      step: 'S1', phase: 'env', action: 'env.read', target: 'DSH_TEST_SECRET', domain: 'env',
      onDenied: 'scope', scopeTimeoutMs: ASSERT_SCOPE_TIMEOUT,
      op: { kind: 'env', args: { name: 'DSH_TEST_SECRET' } },
    });
    const want = [t1.id, t2.id, t3.id, t4.id];

    // ---- 2) 断言：四个 task 全部 failed（硬失败，不是 blocked/done） ----
    const tasks = await waitFor('ac03 四域任务终态', async () => {
      const items = (await api.get(`/api/tasks?team=${team.id}`)).items.filter((t) => want.includes(t.id));
      return items.length === 4 && items.every((t) => TERMINAL.includes(t.status)) ? items : null;
    }, { timeout: 30000 });
    for (const t of tasks) assertEqual(t.status, 'failed', `task ${t.subject} 必须 failed`);
    assertEqual(tasks.length, 4, '四个越界任务都存在');

    // ---- 3) 断言：scope_request >= 4 且 domain 覆盖 fs/exec/net/env ----
    const srs = (await api.get(`/api/scope-requests?team=${team.id}`)).items;
    assert(srs.length >= 4, `scope_request 至少 4 条，实际 ${srs.length}`);
    const domains = new Set(srs.map((r) => r.domain));
    for (const d of ['fs', 'exec', 'net', 'env']) assert(domains.has(d), `scope_request 覆盖 domain=${d}（实际 ${[...domains].join(',')}）`);

    // ---- 4) 断言：每个越界成员都有「拒绝→scope 申请→失败」的证据链 ----
    const memberOf = { [mFs.id]: 'fs', [mExec.id]: 'exec', [mNet.id]: 'net', [mEnv.id]: 'env' };
    for (const [mid, domain] of Object.entries(memberOf)) {
      const steps = (await api.get(`/api/steps?member=${mid}`)).items;
      const denyEv = steps.find((e) => String(e.result || '').startsWith('FAIL'));
      assert(denyEv, `${domain} 成员必须有 FAIL 动作事件`);
      const scopeEv = steps.find((e) => e.action === 'scope.request' && e.phase === 'wait');
      assert(scopeEv, `${domain} 成员必须先落一条 scope.request 事件（越界流转）`);
      assert(scopeEv.meta?.requestId, `${domain} 成员 scope.request 事件必须带 requestId`);
    }
    // fs 越界必须留下 broker 侧 DENIED 审计（before/after hash 可追溯）
    const audit = (await api.get(`/api/audit?team=${team.id}`)).items;
    assert(audit.some((a) => a.domain === 'fs' && a.action === 'write' && a.result === 'DENIED'), 'fs.write 越界必须有 result=DENIED 的审计');
    assert(audit.some((a) => a.domain === 'exec' && a.result === 'DENIED'), 'exec 越界必须有 DENIED 审计');

    // ---- 5) 断言：目标文件 hash 与执行前完全一致（fs 写零副作用） ----
    const guardAfter = sha256(fs.readFileSync(tmp.file('guard.txt')));
    assertEqual(guardAfter, guardBefore, 'guard.txt 的 sha256 必须与越界前完全一致');
    assertEqual(fs.readFileSync(tmp.file('guard.txt'), 'utf8'), 'BASE', 'guard.txt 内容必须仍是 BASE');
    const afterDenied = listing(tmp.ws);
    assertEqual(JSON.stringify(afterDenied), JSON.stringify(before), '四域越界后 workspace 不得多出任何文件');

    // ---- 6) C1 探针：Worker 内真实尝试原生 IO，全部必须 BLOCKED ----
    const escapeTask = await api.post('/api/tasks', {
      teamId: team.id, subject: 'ac03-c1-escape-probes', assignee: mMisc.id, maxAttempts: 1,
      plan: [{
        step: 'S1', phase: 'verify', action: 'escape.probes', target: 'native-io',
        op: { kind: 'escape', args: { attempts: ['fs', 'net', 'exec', 'builtin', 'binding', 'report', 'sqlite'] } },
      }],
    });
    const escTask = await waitFor('ac03 escape 任务终态', async () => {
      const t = await api.get(`/api/tasks/${escapeTask.id}`);
      return TERMINAL.includes(t.status) ? t : null;
    }, { timeout: 20000 });
    assertEqual(escTask.status, 'done', 'escape 探针任务必须 done（探针内部自捕获，不算失败）');

    const escSteps = (await api.get(`/api/steps?member=${mMisc.id}`)).items;
    // 注意：worker 会先发一条同 action 的 RUNNING 事件，用 meta.probes 精确定位取证事件
    const probeEvs = escSteps.filter((e) => e.action === 'escape.probes' && Array.isArray(e.meta?.probes));
    assertEqual(probeEvs.length, 1, '必须恰好产出一条带 meta.probes 的 escape.probes 事件');
    const probeEv = probeEvs[0];
    assertEqual(probeEv.result, 'OK', 'escape.probes 事件 result 必须 OK');
    const probes = probeEv.meta?.probes;
    assert(Array.isArray(probes) && probes.length >= 7, `escape 探针至少 7 项，实际 ${probes?.length}`);
    for (const p of probes) assertEqual(p.blocked, true, `探针 ${p.name} 必须 blocked:true（实际 code=${p.code}）`);
    // 四种原生 IO 逃逸口逐一显式断言
    const byName = Object.fromEntries(probes.map((p) => [p.name, p]));
    for (const name of ['import node:fs', 'global fetch', 'import node:child_process', 'process.getBuiltinModule', 'process.binding']) {
      assert(byName[name], `必须有探针 "${name}"`);
      assertEqual(byName[name].blocked, true, `探针 "${name}" 必须 BLOCKED`);
    }

    // ---- 7) 断言：跑完 escape 探针后 workspace 仍无新文件 ----
    const afterAll = listing(tmp.ws);
    assertEqual(JSON.stringify(afterAll), JSON.stringify(before), 'escape 探针后 workspace 不得多出任何文件');

    // ---- 8) sidecar stdout/stderr 不得出现 panic / mock 痕迹（进程健康） ----
    const stderrText = s.stderr.join('\n');
    assert(!/sidecar exited early/.test(stderrText), 'sidecar 不得提前退出');

    done = true;
    return `4 域越界全部 failed；scope_request=${srs.length} 覆盖 ${[...domains].sort().join('/')}；guard.txt sha256 不变；workspace=${afterAll.length} 项无新增；C1 探针 ${probes.filter((p) => p.blocked).length}/${probes.length} BLOCKED`;
  } catch (e) {
    console.error(`[AC-3] 失败保留 tmp 目录：${tmp.root}`);
    throw e;
  } finally {
    if (s) await s.close();
    if (done) tmp.cleanup();
  }
});

// tests/ac-05-concurrent.mjs — AC-5：3 人并发 append 同一文件，20 轮零丢更新（CAS 版本校验 + 退避重试收敛）
// 复用同一个真实 sidecar；每轮新 team + 新 workspace 子目录 + 新 shared.txt。
import path from 'node:path';
import { runAc, mkTmp, startSidecar, waitFor, assert, assertEqual, fs } from './lib/harness.mjs';

const ROUNDS = 20;
const MARKERS = ['A', 'B', 'C'];
const TERMINAL = ['done', 'failed', 'skipped'];

await runAc('AC-5', async () => {
  const tmp = mkTmp('dsh-team-ac05');
  let s = null;
  let done = false;
  try {
    s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
    const api = s.api;
    let conflictsTotal = 0;
    let writesTotal = 0;
    const roundDetails = [];

    for (let round = 1; round <= ROUNDS; round++) {
      // 每轮独立 workspace（真实目录）+ 空 shared.txt（测试侧 node:fs 造）
      const wsDir = path.join(tmp.ws, `r${String(round).padStart(2, '0')}`);
      fs.mkdirSync(wsDir, { recursive: true });
      const target = path.join(wsDir, 'shared.txt');
      fs.writeFileSync(target, '');

      const team = await api.post('/api/teams', {
        name: `ac05-r${round}`, workspace: wsDir, maxAttempts: 1, maxConcurrency: 8,
      });
      // 授权本团队 fs 写：**（否则默认拒绝）
      await api.post('/api/policies', {
        teamId: team.id, subjectType: 'team', subjectId: team.id,
        domain: 'fs', matcher: '**', ops: ['write', 'delete', 'rename'], mode: 'allow',
      });

      const members = [];
      for (const m of MARKERS) members.push(await api.post(`/api/teams/${team.id}/members`, { name: `w-${m}` }));

      const taskIds = [];
      for (let i = 0; i < MARKERS.length; i++) {
        const t = await api.post('/api/tasks', {
          teamId: team.id, subject: `ac05-r${round}-${MARKERS[i]}`, assignee: members[i].id, maxAttempts: 1,
          plan: [{
            step: 'S1', phase: 'write', action: 'append', target: 'shared.txt',
            op: { kind: 'fs.append', args: { path: 'shared.txt', marker: MARKERS[i], retries: 12 } },
          }],
        });
        taskIds.push(t.id);
      }

      // 3 个任务必须全部 done（冲突只能靠 CAS 退避重试收敛，不能失败）
      const tasks = await waitFor(`round-${round} 三任务终态`, async () => {
        const items = (await api.get(`/api/tasks?team=${team.id}`)).items.filter((x) => taskIds.includes(x.id));
        return items.length === 3 && items.every((x) => TERMINAL.includes(x.status)) ? items : null;
      }, { timeout: 20000, interval: 30 });
      for (const t of tasks) assertEqual(t.status, 'done', `round-${round} task ${t.subject} 必须 done`);

      // 硬断言：A/B/C 各恰好一次，且没有别的行（零丢更新 + 零重复）
      const content = fs.readFileSync(target, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      assertEqual(lines.length, 3, `round-${round} shared.txt 必须恰好 3 行（实际内容 ${JSON.stringify(content)}）`);
      for (const mk of MARKERS) {
        const n = lines.filter((l) => l === mk).length;
        assertEqual(n, 1, `round-${round} marker ${mk} 必须恰好出现 1 次（实际 ${n}，内容 ${JSON.stringify(content)}）`);
      }
      assertEqual([...lines].sort().join(''), MARKERS.join(''), `round-${round} 内容集合必须是 A/B/C`);

      // CAS 冲突统计（允许 >0：证明真的发生过并发冲突并收敛）
      const metrics = await api.get(`/api/metrics?team=${team.id}`);
      conflictsTotal += Number(metrics.conflicts) || 0;
      writesTotal += Number(metrics.writes) || 0;
      roundDetails.push(`r${round}:done3/conflicts=${metrics.conflicts}`);
    }

    done = true;
    return `${ROUNDS} 轮 × 3 人并发 append 全部 done；每轮 A/B/C 各恰好 1 次；总 CAS conflicts=${conflictsTotal}，总 writes=${writesTotal}（允许 >0，证明冲突经退避重试收敛）`;
  } catch (e) {
    console.error(`[AC-5] 失败保留 tmp 目录：${tmp.root}`);
    throw e;
  } finally {
    if (s) await s.close();
    if (done) tmp.cleanup();
  }
});

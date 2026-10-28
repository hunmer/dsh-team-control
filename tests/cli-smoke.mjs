// tests/cli-smoke.mjs — 验证 dsh-team CLI 五个子命令真的可用（不是 AC，但属 M3 交付物）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { mkTmp, startSidecar, waitFor } from './lib/harness.mjs';

const exec = promisify(execFile);
const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BIN = path.join(REPO, 'bin', 'dsh-team.mjs');

const cli = (args, dataDir) => exec(process.execPath, [BIN, ...args, '--data', dataDir], { cwd: REPO, timeout: 30000, windowsHide: true });

const tmp = mkTmp('cli-smoke');
let s;
let failed = false;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed = true; };

try {
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  const team = await s.api.post('/api/teams', { name: 'cli-team', workspace: tmp.ws, maxMembers: 4 });
  await s.api.post('/api/policies', { teamId: team.id, subjectType: 'team', subjectId: team.id, domain: 'fs', matcher: '**', ops: ['write'], mode: 'allow' });
  const m = await s.api.post(`/api/teams/${team.id}/members`, { name: 'cli-alpha' });
  const task = await s.api.post('/api/tasks', {
    teamId: team.id, subject: 'cli task', assignee: m.id,
    plan: [{ step: 'S1', phase: 'write', action: 'write', target: 'cli.txt', op: { kind: 'fs.write', args: { path: 'cli.txt', content: 'cli-ok\n' } } }],
  });
  await waitFor('task done', async () => (await s.api.get(`/api/tasks/${task.id}`)).status === 'done', { timeout: 20000 });

  // status
  const st = await cli(['status', team.id], tmp.dataDir);
  check('status', st.stdout.includes('cli-alpha') && st.stdout.includes('idle'), st.stdout.split('\n')[1]?.trim());
  const stJson = await cli(['status', team.id, '--json'], tmp.dataDir);
  check('status --json', JSON.parse(stJson.stdout).members[0].name === 'cli-alpha');

  // dag
  const dag = await cli(['dag', team.id], tmp.dataDir);
  check('dag', dag.stdout.includes('cli task') && dag.stdout.includes('critical path'), dag.stdout.split('\n')[0]?.trim());

  // logs
  const logs = await cli(['logs', m.id], tmp.dataDir);
  check('logs', logs.stdout.includes('#1') && logs.stdout.includes('task.done'));

  // report
  const outFile = path.join(tmp.root, 'run.md');
  const rep = await cli(['report', team.id, '-o', outFile], tmp.dataDir);
  const md = fs.readFileSync(outFile, 'utf8');
  check('report -o', rep.stdout.includes('报告已写入') && md.includes('before_hash') && md.includes('cli-alpha'));

  // approve：造一个 pending scope request
  const sr = await s.api.post('/api/scope-requests', { memberId: m.id, domain: 'fs', target: 'config/x.json', reason: 'cli approve test', diffSize: 10 });
  check('scope pending', sr.status === 'pending');
  const ap = await cli(['approve', sr.id, '--ttl', '30'], tmp.dataDir);
  check('approve', ap.stdout.includes('approved') && ap.stdout.includes('grant='), ap.stdout.trim());
  const after = await s.api.get(`/api/scope-requests?team=${team.id}&status=approved`);
  check('decision persisted', after.items.some((x) => x.id === sr.id));

  // deny 路径
  const sr2 = await s.api.post('/api/scope-requests', { memberId: m.id, domain: 'exec', target: 'whoami', reason: 'deny test' });
  const dn = await cli(['approve', sr2.id, '--deny', '--reason', 'no'], tmp.dataDir);
  check('approve --deny', dn.stdout.includes('denied'), dn.stdout.trim());

  // down
  const down = await cli(['down'], tmp.dataDir);
  const exited = await s.waitExit(5000);
  check('down', down.stdout.includes('已停止') && exited);
  s = null;
} catch (e) {
  console.error('CLI SMOKE ERROR:', e?.stack || e);
  failed = true;
} finally {
  if (s) await s.close();
  tmp.cleanup();
  process.exit(failed ? 1 : 0);
}

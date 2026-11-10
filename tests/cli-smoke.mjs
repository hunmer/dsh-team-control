// tests/cli-smoke.mjs — 验证 dsh-team CLI 五个子命令真的可用（不是 AC，但属 M3 交付物）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkTmp, startSidecar, waitFor } from './lib/harness.mjs';

const exec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'dsh-team.mjs');

const cli = (args, dataDir) => exec(process.execPath, [BIN, ...args, '--data', dataDir], { cwd: REPO, timeout: 30000, windowsHide: true });

const tmp = mkTmp('cli-smoke');
let s;
let failed = false;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed = true; };

try {
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  const team = await s.api.post('/api/teams', { name: 'cli-team', workspace: tmp.ws, maxMembers: 4 });
  const m = await s.api.post(`/api/teams/${team.id}/members`, { name: 'cli-alpha' });
  const task = await s.api.post('/api/tasks', {
    teamId: team.id, subject: 'cli task', assignee: m.id,
    plan: [{ step: 'S1', detail: '由 CLI 冒烟检查' }],
  });
  await s.api.post('/api/messages', { teamId: team.id, from: m.id, to: m.id, payload: { text: 'hello from cli smoke' } });
  await waitFor('task ready', async () => (await s.api.get(`/api/tasks/${task.id}`)).status === 'ready', { timeout: 10000, interval: 50 });

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
  check('logs', logs.stdout.includes('task'), logs.stdout.trim().slice(0, 120));

  // report
  const outFile = path.join(tmp.root, 'run.md');
  const rep = await cli(['report', team.id, '-o', outFile], tmp.dataDir);
  const md = fs.readFileSync(outFile, 'utf8');
  check('report -o', rep.stdout.includes('报告已写入') && md.includes('cli-alpha'));

  // approvals：pending 列表 → API 决策 → 已决列表
  const apr = await s.api.post('/api/approvals', { id: 'apr_cli_1', teamId: team.id, memberId: m.id, toolName: 'exec', reason: 'cli approve test' });
  check('approval pending', apr.status === 'pending');
  const listed = await cli(['approvals', team.id], tmp.dataDir);
  check('approvals list', listed.stdout.includes('apr_cli_1') && listed.stdout.includes('pending'), listed.stdout.trim());
  await s.api.post('/api/approvals/apr_cli_1/decide', { decision: 'allowed', decidedBy: 'lead' });
  const allowed = await cli(['approvals', team.id, '--status', 'allowed'], tmp.dataDir);
  check('approvals --status', allowed.stdout.includes('apr_cli_1') && allowed.stdout.includes('allowed'), allowed.stdout.trim());
  const aprJson = await cli(['approvals', team.id, '--json'], tmp.dataDir);
  check('approvals --json', JSON.parse(aprJson.stdout).items.some((x) => x.id === 'apr_cli_1'));

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

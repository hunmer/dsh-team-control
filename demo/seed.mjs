// demo/seed.mjs — 给一个**正在运行**的 sidecar 灌一份可交互的演示数据（UTF-8 安全，纯 Node）
// 用法：node demo/seed.mjs [--url http://127.0.0.1:4317] [--home ~/.dsh/team]
// 内容：1 个团队 + 2 成员；task A 正常完成；task B 被策略拒绝 → 生成 pending 审批（等你在面板里批）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };

const home = path.resolve(argOf('home', process.env.DSH_TEAM_HOME || path.join(os.homedir(), '.dsh', 'team')));
const url = argOf('url', process.env.DSH_TEAM_URL || 'http://127.0.0.1:4317');
let token = argOf('token', process.env.DSH_TEAM_TOKEN || null);
if (!token) token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();

const api = async (method, p, body) => {
  const res = await fetch(url + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* md */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${json?.error?.message || text.slice(0, 200)}`);
  return json ?? text;
};

const workspace = argOf('workspace', path.join(home, 'demo-workspace'));
fs.mkdirSync(workspace, { recursive: true });

const existing = (await api('GET', '/api/teams')).items;
if (existing.some((t) => t.name === '演示团队')) {
  const t = existing.find((x) => x.name === '演示团队');
  console.log(`演示团队已存在：${t.id}`);
  console.log(`面板：${url}/panel#token=${token}`);
  process.exit(0);
}

const team = await api('POST', '/api/teams', { name: '演示团队', workspace, maxMembers: 8, maxConcurrency: 3 });
// 只放行 out/** 的写；config/** 保持默认拒绝，这样越界审批流程才真实
await api('POST', '/api/policies', {
  teamId: team.id, subjectType: 'team', subjectId: team.id,
  domain: 'fs', matcher: 'out/**', ops: ['write', 'delete', 'rename'], mode: 'allow',
});
const alpha = await api('POST', `/api/teams/${team.id}/members`, { name: 'lab-alpha', role: 'extractor' });
const beta = await api('POST', `/api/teams/${team.id}/members`, { name: 'lab-beta', role: 'transformer' });

// task A：正常完成（out/** 允许写）
const a = await api('POST', '/api/tasks', {
  teamId: team.id, subject: 'A 抽取数据', assignee: alpha.id,
  plan: [
    { step: 'S1', phase: 'write', action: 'write', target: 'out/data.json', op: { kind: 'fs.write', args: { path: 'out/data.json', content: '{"rows":3,"source":"demo"}\n' } } },
    { step: 'S2', phase: 'wait', action: 'sleep', target: 'A-hold', op: { kind: 'sleep', args: { ms: 150 } } },
  ],
});
// task B：写 config/** 被默认拒绝 → 阻塞并生成 pending 审批（等面板批准）
const b = await api('POST', '/api/tasks', {
  teamId: team.id, subject: 'B 等待审批的写操作', assignee: beta.id,
  plan: [
    {
      step: 'S1', phase: 'write', action: 'write', target: 'config/report.json',
      op: { kind: 'fs.write', args: { path: 'config/report.json', content: '{"merged":true}\n' } },
      onDenied: 'scope', scopeReason: '演示：汇总结果需要写入共享 config', diffSize: 18, risk: 'low',
      scopeTimeoutMs: 300000, fallback: 'outbox/report-patch.json',
    },
    { step: 'S2', phase: 'verify', action: 'read', target: 'config/report.json', op: { kind: 'fs.read', args: { path: 'config/report.json' } } },
  ],
});

// 等状态稳定，打印现场
for (let i = 0; i < 100; i++) {
  const st = await api('GET', `/api/status?team=${team.id}`);
  const blocked = st.members.find((m) => m.name === 'lab-beta');
  const doneA = (await api('GET', `/api/tasks/${a.id}`)).status;
  if (blocked && blocked.status === 'blocked' && doneA === 'done') break;
  await new Promise((r) => setTimeout(r, 100));
}
const st = await api('GET', `/api/status?team=${team.id}`);
const pending = (await api('GET', `/api/scope-requests?team=${team.id}&status=pending`)).items;

console.log(`team        ${team.id}  （${team.name}）`);
console.log(`workspace   ${workspace}`);
console.log(`task A      ${a.id}  已完成（写 out/data.json 被策略允许）`);
console.log(`task B      ${b.id}  ${(await api('GET', `/api/tasks/${b.id}`)).status}（写 config/** 被默认拒绝）`);
for (const m of st.members) console.log(`member      ${m.name.padEnd(10)} ${m.status.padEnd(9)} step=${m.step ?? '-'} seq=${m.seq} blockers=${(m.blockers || []).map((x) => x.kind + ':' + x.id).join(',') || '-'}`);
for (const r of pending) console.log(`pending     ${r.id}  ${r.domain} ${r.target}  reason=${r.reason}`);
console.log('');
console.log(`面板        ${url}/panel#token=${token}`);
console.log(`批准        node bin/dsh-team.mjs approve ${pending[0] ? pending[0].id : '<request-id>'}`);
console.log(`状态        node bin/dsh-team.mjs status ${team.id}`);

// demo/seed.mjs — 给一个**正在运行**的 sidecar 灌一份可交互的演示数据（纯 Node）
// 用法：node demo/seed.mjs [--url http://127.0.0.1:4317] [--home ~/.dsh/team]
// 内容：1 个团队（permissionPreset）+ 2 个 sub-agent 成员；task A 已完成；task B 待派发；
//       一条 pending 审批，等你在面板/CLI 里用 team_approve 或 `dsh-team approvals` 处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };

const home = path.resolve(argOf('home', process.env.DSH_TEAM_HOME || path.join(os.homedir(), '.dsh', 'team')));
const url = argOf('url', process.env.DSH_TEAM_URL || 'http://127.0.0.1:4317');
const token = argOf('token', process.env.DSH_TEAM_TOKEN || (() => {
  try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); } catch { return ''; }
})());

const api = async (method, p, body) => {
  const res = await fetch(url + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  console.log(`面板：${url}/panel`);
  process.exit(0);
}

const team = await api('POST', '/api/teams', {
  name: '演示团队', workspace, maxMembers: 8, maxConcurrency: 3,
  permissionPreset: 'workspace-write',
});
const alpha = (await api('POST', '/api/agents/register', {
  teamId: team.id, name: 'lab-alpha', sessionId: 'demo-alpha', role: 'extractor',
})).member;
const beta = (await api('POST', '/api/agents/register', {
  teamId: team.id, name: 'lab-beta', sessionId: 'demo-beta', role: 'transformer',
})).member;

const a = await api('POST', '/api/tasks', {
  teamId: team.id, subject: 'A 抽取数据', assignee: alpha.id, priority: -1,
  plan: [{ step: 'S1 抽取', detail: '从源数据抽出结构化记录' }, { step: 'S2 校验', detail: '校验行数与字段' }],
});
await api('POST', '/api/tasks', {
  teamId: team.id, subject: 'B 生成报告（待派发）', assignee: beta.id,
  plan: [{ step: 'S1 生成', detail: '按模板生成报告' }, { step: 'S2 复核', detail: '检查敏感字段' }],
});

// A 直接完成，B 保持 ready；再镜像一条成员审批
await new Promise((r) => setTimeout(r, 300)); // 过建图 settle 窗口
const claimed = await api('POST', '/api/agents/dispatch', { teamId: team.id });
if (claimed.dispatched) {
  await api('POST', '/api/agents/report', {
    sessionId: claimed.member.agentSessionId, taskId: claimed.task.id, status: 'done', summary: 'A 抽取数据 完成',
  });
}

const approval = await api('POST', '/api/approvals', {
  id: 'apr_demo_seed_1', teamId: team.id, memberId: beta.id, sessionId: 'demo-beta',
  toolName: 'exec', reason: '需要运行报告生成脚本',
});

console.log(`演示团队：${team.id}（permissionPreset=${team.permissionPreset}）`);
console.log(`成员：${alpha.name}(${alpha.id}) / ${beta.name}(${beta.id})`);
console.log(`任务：${a.id} 已派发；B 待派发`);
console.log(`待审批：${approval.id}（${approval.toolName}：${approval.reason}）`);
console.log(`面板：${url}/panel`);
console.log(`CLI：node bin/dsh-team.mjs approvals ${team.id}`);

#!/usr/bin/env node
/* dev-mock.mjs —— 仅供 src/web 面板自测的 mock sidecar（node 内置 http，零依赖）。
 *
 * 用途：在没有真实 sidecar 时验证面板的 HTTP 状态、静态资源、SSE 实时更新与写操作。
 * 集成时由 Lead 用真实服务（src/server.mjs）替换，本文件不参与生产。
 *
 * 用法：
 *   node src/web/dev-mock.mjs --port 0            # 随机端口，打印访问 URL
 *   node src/web/dev-mock.mjs --port 4317 --token demo-token --interval 300
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  return fallback;
}
const PORT = Number(option('--port', '4317'));
const TOKEN = option('--token', 'demo-token');
const TICK_MS = Math.max(50, Number(option('--interval', '300')) || 300);
const nowIso = () => new Date().toISOString();
const plusMs = (ms) => new Date(Date.now() + ms).toISOString();
let version = 7;
let policySeq = 10;
let requestSeq = 10;
let decisionSeq = 2;
let grantSeq = 2;
let eventSeq = 0;
let tick = 0;
const TEAM = {
  id: 't_demo',
  name: 'demo-team',
  workspace: process.cwd(),
  maxMembers: 64,
  maxConcurrency: 4,
  failurePolicy: 'continue',
  maxAttempts: 3,
  createdAt: plusMs(-3600 * 1000),
};
/* ---------------- 成员（种子；每次读取时重建 leaseUntil，保持“距今”语义） ---------------- */
const memberSeed = [
  { id: 'm_alpha', name: 'lab-alpha', role: 'builder', model: 'deepseek-flash', contextMode: 'fork', status: 'running', leaseOffsetMs: 9000, currentTaskId: 'task_2', step: 'S3', seq: 41, last: 'read src/policy.mjs', next: 'write src/policy.mjs', blockers: [], stale: false, pct: 0.45 },
  { id: 'm_beta', name: 'lab-beta', role: 'builder', model: 'deepseek-flash', contextMode: 'fork', status: 'blocked', leaseOffsetMs: 12000, currentTaskId: 'task_3', step: 'S2', seq: 23, last: 'fs.write config/shared.json', next: '等待 scope request 审批', blockers: [{ kind: 'scope_request', id: 'sr_1', detail: 'fs write config/shared.json' }], stale: false, pct: 0.2 },
  { id: 'm_gamma', name: 'lab-gamma', role: 'verifier', model: 'deepseek-flash', contextMode: 'fresh', status: 'idle', leaseOffsetMs: 14000, currentTaskId: null, step: null, seq: 17, last: 'verify AC-4', next: '等待任务派发', blockers: [], stale: false, pct: 1 },
  { id: 'm_delta', name: 'lab-delta', role: 'builder', model: 'deepseek-flash', contextMode: 'fork', status: 'done', leaseOffsetMs: null, currentTaskId: 'task_1', step: 'S6', seq: 66, last: 'task.done', next: '空闲', blockers: [], stale: false, pct: 1 },
  { id: 'm_epsilon', name: 'lab-epsilon', role: 'builder', model: 'deepseek-flash', contextMode: 'fork', status: 'interrupted', leaseOffsetMs: -45000, currentTaskId: 'task_4', step: 'S1', seq: 9, last: 'interrupt(reason=lease expired)', next: 'resume', blockers: [{ kind: 'manual', detail: 'interrupted by lead' }], stale: false, pct: 0.1 },
  { id: 'm_zeta', name: 'lab-zeta', role: 'builder', model: 'deepseek-flash', contextMode: 'fork', status: 'running', leaseOffsetMs: -20000, currentTaskId: 'task_5', step: 'S4', seq: 52, last: 'exec.run node --test', next: 'read tests/ac-10.mjs', blockers: [], stale: false, pct: 0.6 },
  { id: 'm_eta', name: 'lab-eta', role: 'verifier', model: 'deepseek-flash', contextMode: 'fresh', status: 'queued', leaseOffsetMs: null, currentTaskId: 'task_6', step: null, seq: 3, last: null, next: '等待并发配额', blockers: [{ kind: 'manual', detail: 'maxConcurrency=4' }], stale: true, pct: null },
];
function buildMember(seed) {
  return {
    id: seed.id,
    teamId: TEAM.id,
    name: seed.name,
    role: seed.role,
    model: seed.model,
    contextMode: seed.contextMode,
    status: seed.status,
    leaseUntil: seed.leaseOffsetMs === null ? null : plusMs(seed.leaseOffsetMs),
    currentTaskId: seed.currentTaskId,
    step: seed.step,
    seq: seed.seq,
    last: seed.last,
    next: seed.next,
    blockers: seed.blockers,
    stale: !!seed.stale,
    asOf: nowIso(),
    pct: seed.pct,
  };
}
function findSeed(memberId) {
  return memberSeed.find((seed) => seed.id === memberId) || null;
}
function buildStatus() {
  return {
    asOf: nowIso(),
    version,
    members: memberSeed.map(buildMember),
    staleMembers: memberSeed.filter((seed) => seed.stale).map((seed) => seed.id),
    degraded: false,
  };
}
/* ---------------- 任务 / DAG ---------------- */
const tasks = [
  { id: 'task_1', subject: 'Bootstrap event store', status: 'done', assignee: 'lab-delta', attempts: 1 },
  { id: 'task_2', subject: 'Implement policy engine', status: 'running', assignee: 'lab-alpha', attempts: 2 },
  { id: 'task_3', subject: 'Build SSE hub', status: 'ready', assignee: 'lab-beta', attempts: 0 },
  { id: 'task_4', subject: 'Web panel skeleton', status: 'blocked', assignee: 'lab-gamma', attempts: 0 },
  { id: 'task_5', subject: 'AC-10 SSE latency p95', status: 'pending', assignee: 'lab-zeta', attempts: 0 },
  { id: 'task_6', subject: 'Audit report (before/after hash)', status: 'pending', assignee: 'lab-eta', attempts: 0 },
];
const deps = [
  { id: 'dep_1', from: 'task_1', to: 'task_2', condition: 'all_success', artifactPath: null },
  { id: 'dep_2', from: 'task_1', to: 'task_3', condition: 'all_success', artifactPath: null },
  { id: 'dep_3', from: 'task_2', to: 'task_4', condition: 'all_success', artifactPath: null },
  { id: 'dep_4', from: 'task_3', to: 'task_5', condition: 'all_success', artifactPath: null },
  { id: 'dep_5', from: 'task_4', to: 'task_5', condition: 'all_success', artifactPath: null },
  { id: 'dep_6', from: 'task_2', to: 'task_6', condition: 'all_success', artifactPath: null },
  { id: 'dep_7', from: 'task_3', to: 'task_6', condition: 'any_success', artifactPath: null },
];
function buildDag() {
  const doneSet = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.id));
  const nodes = tasks.map((task) => {
    const dependsOn = deps.filter((dep) => dep.to === task.id).map((dep) => dep.from);
    const ready = task.status === 'ready' || (task.status === 'pending' && dependsOn.every((id) => doneSet.has(id)));
    const blocked = task.status === 'blocked' || (task.status === 'pending' && !ready);
    return {
      taskId: task.id,
      subject: task.subject,
      status: task.status,
      assignee: task.assignee,
      attempts: task.attempts,
      dependsOn,
      ready,
      blocked,
    };
  });
  return {
    teamId: TEAM.id,
    asOf: nowIso(),
    version,
    nodes,
    edges: deps,
    ready: nodes.filter((node) => node.ready).map((node) => node.taskId),
    criticalPath: ['task_1', 'task_2', 'task_4', 'task_5'],
  };
}
/* ---------------- 策略 / 权限矩阵 ---------------- */
let policies = [
  { id: 'p_1', teamId: TEAM.id, subjectType: 'member', subjectId: 'lab-alpha', domain: 'fs', matcher: 'src/**', ops: ['read', 'write'], mode: 'allow', constraints: { maxRuntimeMs: 5000 }, expiresAt: null, createdAt: plusMs(-600 * 1000) },
  { id: 'p_2', teamId: TEAM.id, subjectType: 'member', subjectId: 'lab-alpha', domain: 'fs', matcher: '.git/**', ops: ['read', 'write', 'delete', 'rename'], mode: 'deny', constraints: {}, expiresAt: null, createdAt: plusMs(-590 * 1000) },
  { id: 'p_3', teamId: TEAM.id, subjectType: 'role', subjectId: 'builder', domain: 'exec', matcher: 'node', ops: ['spawn'], mode: 'allow', constraints: { argvPrefix: ['node', '--version'] }, expiresAt: null, createdAt: plusMs(-580 * 1000) },
  { id: 'p_4', teamId: TEAM.id, subjectType: 'role', subjectId: 'builder', domain: 'net', matcher: 'registry.npmjs.org:443', ops: ['connect'], mode: 'deny', constraints: {}, expiresAt: null, createdAt: plusMs(-570 * 1000) },
  { id: 'p_5', teamId: TEAM.id, subjectType: 'task', subjectId: 'task_2', domain: 'env', matcher: '*_TOKEN', ops: ['read'], mode: 'allow', constraints: { sensitive: true, redact: true }, expiresAt: null, createdAt: plusMs(-560 * 1000) },
];
function buildMatrix() {
  return memberSeed.map((seed) => {
    const role = seed.role || 'member';
    const matched = policies.filter((policy) => {
      if (policy.subjectType === 'member' && policy.subjectId === seed.name) return true;
      if (policy.subjectType === 'role' && policy.subjectId === role) return true;
      if (policy.subjectType === 'task' && policy.subjectId === seed.currentTaskId) return true;
      return false;
    });
    const summarize = (domain) => {
      const rules = matched.filter((policy) => policy.domain === domain);
      if (!rules.length) {
        if (domain === 'fs') return { read: ['workspace/**（默认允许读）'], write: ['默认拒绝'] };
        return '默认拒绝';
      }
      return rules.map((policy) => policy.mode + ' ' + policy.matcher + ' [' + policy.ops.join(',') + ']');
    };
    return {
      memberId: seed.id,
      name: seed.name,
      role,
      fs: summarize('fs'),
      exec: summarize('exec'),
      net: summarize('net'),
      env: seed.id === 'm_alpha'
        ? { read: ['<redacted> handle only（sensitive=true）'], write: [] }
        : summarize('env'),
    };
  });
}
/* ---------------- 越界申请 / 消息 ---------------- */
let scopeRequests = [
  { id: 'sr_1', memberId: 'm_beta', teamId: TEAM.id, domain: 'fs', target: 'config/shared.json', reason: '并发写冲突解决后需要把合并结果写回共享配置（当前被默认拒绝阻塞）', diffSize: 128, risk: 'medium', blockedStep: 'S5', fallback: '继续等待，不写配置', status: 'pending', decisionId: null, grantId: null, createdAt: plusMs(-120 * 1000) },
  { id: 'sr_2', memberId: 'm_zeta', teamId: TEAM.id, domain: 'exec', target: 'rm -rf dist', reason: '清理构建产物以验证 AC-3 的 exec 域越界拒绝', diffSize: null, risk: 'high', blockedStep: 'S2', fallback: '跳过清理，保留旧产物', status: 'pending', decisionId: null, grantId: null, createdAt: plusMs(-60 * 1000) },
  { id: 'sr_3', memberId: 'm_alpha', teamId: TEAM.id, domain: 'env', target: '<redacted>', reason: '读取敏感变量句柄用于本地验证；值永不出 sidecar（AC-13）', diffSize: null, risk: 'low', blockedStep: 'S4', fallback: '使用默认配置', status: 'pending', decisionId: null, grantId: null, createdAt: plusMs(-30 * 1000) },
  { id: 'sr_4', memberId: 'm_gamma', teamId: TEAM.id, domain: 'net', target: 'api.example.com:443', reason: '历史申请（已批准，不应出现在 pending 队列）', diffSize: null, risk: 'low', blockedStep: 'S1', fallback: '离线重试', status: 'approved', decisionId: 'dec_1', grantId: 'g_1', createdAt: plusMs(-300 * 1000) },
];
let messages = [
  { id: 'msg_1', teamId: TEAM.id, from: 'lab-alpha', to: 'lead', kind: 'scope.request', correlationId: 'corr-77', payload: { summary: '<redacted>', requestId: 'sr_1' }, sentAt: plusMs(-150 * 1000), deliveredAt: plusMs(-149 * 1000), readAt: null, ackedAt: null, ttlSeconds: 300, status: 'delivered' },
  { id: 'msg_2', teamId: TEAM.id, from: 'lead', to: 'lab-alpha', kind: 'decision', correlationId: 'corr-77', payload: { summary: '<redacted>', decision: 'pending' }, sentAt: plusMs(-140 * 1000), deliveredAt: plusMs(-139 * 1000), readAt: plusMs(-138 * 1000), ackedAt: plusMs(-137 * 1000), ttlSeconds: 300, status: 'acked' },
  { id: 'msg_3', teamId: TEAM.id, from: 'lead', to: 'lab-beta', kind: 'notify', correlationId: null, payload: { summary: '<redacted>' }, sentAt: plusMs(-90 * 1000), deliveredAt: null, readAt: null, ackedAt: null, ttlSeconds: 600, status: 'queued' },
  { id: 'msg_4', teamId: TEAM.id, from: 'lab-gamma', to: 'lab-beta', kind: 'status', correlationId: 'corr-91', payload: { summary: '<redacted>' }, sentAt: plusMs(-80 * 1000), deliveredAt: plusMs(-79 * 1000), readAt: plusMs(-78 * 1000), ackedAt: null, ttlSeconds: 120, status: 'read' },
  { id: 'msg_5', teamId: TEAM.id, from: 'system', to: 'lead', kind: 'lease.warn', correlationId: null, payload: { summary: '<redacted>' }, sentAt: plusMs(-50 * 1000), deliveredAt: plusMs(-50 * 1000), readAt: null, ackedAt: null, ttlSeconds: 60, status: 'expired' },
];
/* ---------------- SSE hub ---------------- */
const clients = new Set();
const eventHistory = [];
function broadcast(type, memberId, taskId, payload) {
  eventSeq += 1;
  const frame = {
    id: eventSeq,
    type,
    teamId: TEAM.id,
    memberId: memberId || null,
    taskId: taskId || null,
    ts: nowIso(),
    payload: payload || {},
  };
  eventHistory.push(frame);
  if (eventHistory.length > 2000) eventHistory.shift();
  const chunk = 'id: ' + frame.id + '\nevent: ' + type + '\ndata: ' + JSON.stringify(frame) + '\n\n';
  for (const res of clients) {
    try { res.write(chunk); } catch (err) { clients.delete(res); }
  }
  return frame;
}
const ROTATION = [
  'step.append', 'step.append', 'member.status', 'step.append', 'task.state',
  'step.append', 'message.delivered', 'step.append', 'scope.request', 'step.append',
  'lease.warn', 'step.append', 'decision', 'step.append', 'member.status',
];
const STEP_PHASES = ['read', 'write', 'exec', 'verify', 'msg', 'wait', 'done'];
const STEP_TARGETS = [
  'src/eventstore.mjs', 'src/policy.mjs', 'tests/ac-03-fs.mjs', 'config/shared.json',
  'bin/dsh-team.mjs', 'docs/CONTRACT.md', 'src/sse.mjs',
];
function generateTick() {
  const index = tick % ROTATION.length;
  const type = ROTATION[index];
  const seed = memberSeed[tick % memberSeed.length];
  tick += 1;
  switch (type) {
    case 'step.append': {
      seed.seq += 1;
      const phase = STEP_PHASES[tick % STEP_PHASES.length];
      const target = STEP_TARGETS[tick % STEP_TARGETS.length];
      seed.last = phase + ' ' + target;
      seed.next = STEP_TARGETS[(tick + 1) % STEP_TARGETS.length];
      broadcast('step.append', seed.id, seed.currentTaskId, {
        seq: seed.seq,
        phase,
        action: phase === 'exec' ? 'spawn' : (phase === 'write' ? 'fs.write' : (phase === 'read' ? 'fs.read' : phase)),
        target,
        result: 'OK',
        next: seed.next,
        status: seed.status,
      });
      break;
    }
    case 'member.status': {
      seed.seq += 1;
      broadcast('member.status', seed.id, seed.currentTaskId, {
        status: seed.status,
        step: seed.step,
        seq: seed.seq,
        next: seed.next,
      });
      break;
    }
    case 'task.state': {
      const task = tasks[tick % tasks.length];
      task.attempts += (tick % 4 === 0) ? 1 : 0;
      broadcast('task.state', null, task.id, {
        taskId: task.id,
        status: task.status,
        attempts: task.attempts,
      });
      break;
    }
    case 'message.delivered': {
      const message = messages.find((item) => item.status === 'queued');
      if (!message) { broadcast('message.delivered', null, null, { messageId: null, to: null, status: 'queued' }); break; }
      message.status = 'delivered';
      message.deliveredAt = nowIso();
      broadcast('message.delivered', null, null, { messageId: message.id, to: message.to, status: 'delivered' });
      break;
    }
    case 'scope.request': {
      const request = scopeRequests.find((item) => item.status === 'pending');
      if (!request) { broadcast('scope.request', null, null, { requestId: null, domain: null, target: null }); break; }
      broadcast('scope.request', request.memberId, null, {
        requestId: request.id,
        domain: request.domain,
        target: request.target,
        memberId: request.memberId,
      });
      break;
    }
    case 'decision': {
      const decided = scopeRequests.find((item) => item.status !== 'pending' && item.decisionId);
      if (!decided) { broadcast('decision', null, null, { requestId: null, decision: 'approved', decidedBy: 'auto', grantId: null }); break; }
      broadcast('decision', decided.memberId, null, {
        requestId: decided.id,
        decision: decided.status,
        decidedBy: 'auto',
        grantId: decided.grantId,
      });
      break;
    }
    case 'lease.warn': {
      const leaseSeed = memberSeed[(tick + 2) % memberSeed.length];
      const leaseUntil = leaseSeed.leaseOffsetMs === null ? null : plusMs(leaseSeed.leaseOffsetMs);
      broadcast('lease.warn', leaseSeed.id, null, { memberId: leaseSeed.id, leaseUntil, missed: 2 });
      break;
    }
    default:
      break;
  }
}
/* ---------------- HTTP 工具 ---------------- */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
function sendError(res, status, code, message, detail) {
  sendJson(res, status, { error: { code, message, detail: detail === undefined ? null : detail } });
}
function sendText(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function authorized(req, url) {
  const header = req.headers.authorization || '';
  if (header === 'Bearer ' + TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}
async function serveFile(res, name, type) {
  try {
    const body = await readFile(path.join(HERE, name));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': body.length });
    res.end(body);
  } catch (err) {
    sendError(res, 404, 'E_NOT_FOUND', 'static file not found: ' + name);
  }
}
/* ---------------- SSE ---------------- */
function handleSSE(req, res, url) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const lastEventId = Number(url.searchParams.get('lastEventId') || req.headers['last-event-id'] || 0);
  if (Number.isFinite(lastEventId) && lastEventId > 0) {
    for (const frame of eventHistory) {
      if (frame.id > lastEventId) {
        res.write('id: ' + frame.id + '\nevent: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n');
      }
    }
  }
  clients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (err) { clients.delete(res); clearInterval(heartbeat); }
  }, 15000);
  req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
}
/* ---------------- 报告 ---------------- */
function buildReport() {
  const lines = [];
  lines.push('# dsh-team run report — ' + TEAM.name);
  lines.push('');
  lines.push('- team: `' + TEAM.id + '`');
  lines.push('- generatedAt: ' + nowIso());
  lines.push('- asOf: ' + nowIso() + ' · version ' + version);
  lines.push('');
  lines.push('## 成员状态');
  lines.push('');
  lines.push('| member | status | step | seq | last | next |');
  lines.push('|---|---|---|---|---|---|');
  for (const seed of memberSeed) {
    lines.push('| ' + seed.name + ' | ' + seed.status + ' | ' + (seed.step || '-') + ' | ' + seed.seq + ' | ' +
      String(seed.last || '-').replace(/\|/g, '\\|') + ' | ' + String(seed.next || '-').replace(/\|/g, '\\|') + ' |');
  }
  lines.push('');
  lines.push('## 任务与依赖');
  lines.push('');
  lines.push('| task | status | assignee | attempts | dependsOn |');
  lines.push('|---|---|---|---|---|');
  for (const task of tasks) {
    const dependsOn = deps.filter((dep) => dep.to === task.id).map((dep) => dep.from).join(', ') || '-';
    lines.push('| ' + task.id + ' | ' + task.status + ' | ' + task.assignee + ' | ' + task.attempts + ' | ' + dependsOn + ' |');
  }
  lines.push('');
  lines.push('## 审计（AC-12：who / when / 改了什么 / before_hash → after_hash）');
  lines.push('');
  lines.push('| actor | domain | action | target | before_hash | after_hash | ts |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push('| lab-alpha | fs | write | src/policy.mjs | sha256:' + 'a'.repeat(12) + ' | sha256:' + 'b'.repeat(12) + ' | ' + plusMs(-95000) + ' |');
  lines.push('| lab-beta | fs | denied | config/shared.json | sha256:' + 'c'.repeat(12) + ' | sha256:' + 'c'.repeat(12) + ' | ' + plusMs(-121000) + ' |');
  lines.push('| lab-zeta | exec | denied | rm -rf dist | - | - | ' + plusMs(-61000) + ' |');
  lines.push('');
  lines.push('## 事件尾部');
  lines.push('');
  lines.push('| id | seq | member | phase | action | target | result |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const frame of eventHistory.slice(-20)) {
    if (frame.type !== 'step.append') continue;
    lines.push('| ' + frame.id + ' | ' + (frame.payload.seq || '-') + ' | ' + (frame.memberId || '-') + ' | ' +
      (frame.payload.phase || '-') + ' | ' + (frame.payload.action || '-') + ' | ' +
      String(frame.payload.target || '-').replace(/\|/g, '\\|') + ' | ' + (frame.payload.result || '-') + ' |');
  }
  lines.push('');
  return lines.join('\n');
}
/* ---------------- API 路由 ---------------- */
async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';
  const parts = pathname.split('/').filter(Boolean);
  const listMeta = () => ({ asOf: nowIso(), version, items: [] });
  if (method === 'GET' && pathname === '/api/teams') {
    const payload = listMeta();
    payload.items = [TEAM];
    return sendJson(res, 200, payload);
  }
  if (method === 'GET' && pathname === '/api/teams/' + TEAM.id) {
    return sendJson(res, 200, { team: TEAM });
  }
  if (method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, buildStatus());
  }
  if (method === 'GET' && pathname === '/api/dag') {
    return sendJson(res, 200, buildDag());
  }
  if (method === 'GET' && pathname === '/api/events/history') {
    const since = Number(url.searchParams.get('since') || 0);
    const payload = listMeta();
    payload.items = eventHistory.filter((frame) => frame.id > since).slice(-200);
    return sendJson(res, 200, payload);
  }
  if (method === 'GET' && pathname === '/api/policies') {
    const payload = listMeta();
    payload.items = policies;
    return sendJson(res, 200, payload);
  }
  if (method === 'POST' && pathname === '/api/policies') {
    let body;
    try { body = await readBody(req); } catch (err) { return sendError(res, 400, 'E_BAD_REQUEST', err.message); }
    if (!body.subjectId || !body.domain || !body.matcher || !Array.isArray(body.ops) || !body.ops.length) {
      return sendError(res, 400, 'E_BAD_REQUEST', 'subjectId/domain/matcher/ops[] required');
    }
    policySeq += 1;
    const policy = {
      id: 'p_' + policySeq,
      teamId: body.teamId || TEAM.id,
      subjectType: body.subjectType || 'member',
      subjectId: body.subjectId,
      domain: body.domain,
      matcher: body.matcher,
      ops: body.ops,
      mode: body.mode === 'deny' ? 'deny' : 'allow',
      constraints: body.constraints || {},
      expiresAt: body.expiresAt || null,
      createdAt: nowIso(),
    };
    policies.push(policy);
    version += 1;
    return sendJson(res, 201, { policy });
  }
  if (method === 'DELETE' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'policies') {
    const id = decodeURIComponent(parts[2]);
    const index = policies.findIndex((policy) => policy.id === id);
    if (index < 0) return sendError(res, 404, 'E_NOT_FOUND', 'policy not found: ' + id);
    policies = policies.filter((policy) => policy.id !== id);
    version += 1;
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/permission-matrix') {
    const payload = listMeta();
    payload.items = buildMatrix();
    return sendJson(res, 200, payload);
  }
  if (method === 'GET' && pathname === '/api/scope-requests') {
    const statusFilter = url.searchParams.get('status');
    const memberFilter = url.searchParams.get('member');
    const payload = listMeta();
    payload.items = scopeRequests.filter((request) => {
      if (statusFilter && request.status !== statusFilter) return false;
      if (memberFilter && request.memberId !== memberFilter) return false;
      return true;
    });
    return sendJson(res, 200, payload);
  }
  const decideMatch = pathname.match(/^\/api\/scope-requests\/([^/]+)\/decide$/);
  if (method === 'POST' && decideMatch) {
    const id = decodeURIComponent(decideMatch[1]);
    const request = scopeRequests.find((item) => item.id === id);
    if (!request) return sendError(res, 404, 'E_NOT_FOUND', 'scope request not found: ' + id);
    if (request.status !== 'pending') return sendError(res, 409, 'E_CONFLICT', 'scope request is already ' + request.status);
    let body;
    try { body = await readBody(req); } catch (err) { return sendError(res, 400, 'E_BAD_REQUEST', err.message); }
    if (body.decision !== 'approved' && body.decision !== 'denied') {
      return sendError(res, 400, 'E_BAD_REQUEST', 'decision must be approved|denied');
    }
    decisionSeq += 1;
    version += 1;
    const decidedBy = body.decidedBy || 'panel';
    const decision = {
      id: 'dec_' + decisionSeq,
      requestId: id,
      decision: body.decision,
      decidedBy,
      reason: body.reason || null,
      decidedAt: nowIso(),
      ttlSeconds: body.ttlSeconds || null,
      optionsJson: [],
    };
    let grant = null;
    if (body.decision === 'approved') {
      grantSeq += 1;
      const grantOp = request.domain === 'exec' ? 'spawn'
        : request.domain === 'net' ? 'connect'
          : request.domain === 'env' ? 'read' : 'write';
      grant = {
        id: 'g_' + grantSeq,
        requestId: id,
        domain: request.domain,
        matcher: request.target,
        ops: [grantOp],
        singleUse: body.singleUse !== false,
        expiresAt: body.ttlSeconds ? plusMs(body.ttlSeconds * 1000) : null,
        grantedBy: decidedBy,
        usedAt: null,
      };
      request.grantId = grant.id;
    }
    request.status = body.decision;
    request.decisionId = decision.id;
    broadcast('decision', request.memberId, null, {
      requestId: id,
      decision: body.decision,
      decidedBy,
      grantId: grant ? grant.id : null,
    });
    return sendJson(res, 200, { scopeRequest: request, decision, grant });
  }
  if (method === 'GET' && pathname === '/api/messages') {
    const memberFilter = url.searchParams.get('member');
    const statusFilter = url.searchParams.get('status');
    const correlationFilter = url.searchParams.get('correlation');
    const payload = listMeta();
    payload.items = messages.filter((message) => {
      if (memberFilter && message.from !== memberFilter && message.to !== memberFilter) return false;
      if (statusFilter && message.status !== statusFilter) return false;
      if (correlationFilter && message.correlationId !== correlationFilter) return false;
      return true;
    });
    return sendJson(res, 200, payload);
  }
  if (method === 'GET' && pathname === '/api/steps') {
    const memberFilter = url.searchParams.get('member');
    const since = Number(url.searchParams.get('since') || 0);
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || 200)));
    const payload = listMeta();
    payload.items = eventHistory.filter((frame) => {
      if (frame.type !== 'step.append') return false;
      if (memberFilter && frame.memberId !== memberFilter) return false;
      return frame.id > since;
    }).slice(-limit);
    return sendJson(res, 200, payload);
  }
  if (method === 'GET' && pathname === '/api/report') {
    return sendText(res, 200, 'text/markdown; charset=utf-8', buildReport());
  }
  return sendError(res, 404, 'E_NOT_FOUND', 'no route: ' + method + ' ' + pathname);
}
/* ---------------- 服务器 ---------------- */
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + HOST + ':' + (server.address() ? server.address().port : PORT));
  } catch (err) {
    return sendError(res, 400, 'E_BAD_REQUEST', 'bad url');
  }
  const pathname = url.pathname;
  if (pathname === '/') {
    res.writeHead(302, { location: '/panel' });
    res.end();
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === '/panel' || pathname === '/panel/') {
    serveFile(res, 'panel.html', 'text/html; charset=utf-8');
    return;
  }
  if (pathname === '/panel/app.js') {
    serveFile(res, 'app.js', 'text/javascript; charset=utf-8');
    return;
  }
  if (pathname === '/panel/app.css') {
    serveFile(res, 'app.css', 'text/css; charset=utf-8');
    return;
  }
  if (pathname === '/api/events') {
    if (!authorized(req, url)) return sendError(res, 401, 'E_UNAUTHORIZED', 'missing or invalid token');
    handleSSE(req, res, url);
    return;
  }
  if (pathname.indexOf('/api/') !== 0) {
    sendError(res, 404, 'E_NOT_FOUND', 'no route: ' + pathname);
    return;
  }
  if (!authorized(req, url)) return sendError(res, 401, 'E_UNAUTHORIZED', 'missing or invalid token');
  handleApi(req, res, url).catch((err) => sendError(res, 500, 'E_INTERNAL', err.message));
});
server.listen(PORT, HOST, () => {
  const address = server.address();
  const base = 'http://' + HOST + ':' + address.port;
  console.log(JSON.stringify({
    event: 'ready',
    url: base,
    port: address.port,
    pid: process.pid,
    token: TOKEN,
    panel: base + '/panel#token=' + TOKEN,
  }));
  console.log('[dev-mock] panel: ' + base + '/panel#token=' + TOKEN);
  console.log('[dev-mock] token: ' + TOKEN + '（Authorization: Bearer / ?token=）');
  setInterval(generateTick, TICK_MS);
});
process.on('SIGINT', () => {
  for (const res of clients) {
    try { res.end(); } catch (err) { /* ignore */ }
  }
  server.close(() => process.exit(0));
});

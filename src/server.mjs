// server.mjs — REST + SSE + 静态面板 + 本地 token 鉴权
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError, ERR, nowIso, json, redactor } from './util.mjs';
import { DshTeam } from './core.mjs';
import { rowToTask } from './scheduler.mjs';

const PANEL_DIR = new URL('./web/', import.meta.url);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function ensureToken(home) {
  const file = path.join(home, 'token');
  if (process.env.DSH_TEAM_TOKEN) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, process.env.DSH_TEAM_TOKEN, { mode: 0o600 });
    return process.env.DSH_TEAM_TOKEN;
  }
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* generate */ }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

function sendJson(res, status, body) {
  // 出口兜底脱敏：任何 API 响应都不得带出已登记的敏感值（FR-3.8 / AC-13）
  const s = JSON.stringify(redactor.obj(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(ERR.bad('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(ERR.bad('invalid json body')); }
    });
    req.on('error', reject);
  });
}

export function createRoutes(core) {
  const C = core;
  const qs = (u) => u.searchParams;
  const need = (v, name) => { if (v == null || v === '') throw ERR.bad(`${name} required`); return v; };
  return [
    // health
    ['GET', /^\/api\/health$/, async (ctx) => ({ ok: true, asOf: nowIso(), pid: process.pid }), { public: true }],

    // teams
    ['POST', /^\/api\/teams$/, async (ctx) => C.createTeam(ctx.body)],
    ['GET', /^\/api\/teams$/, async (ctx) => ({ items: C.listTeams({ archived: qs(ctx.url).get('archived') === '1' }) })],
    ['GET', /^\/api\/teams\/by-lead\/([^/]+)$/, async (ctx) => ({ item: C.teamByLead(decodeURIComponent(ctx.p[0])) })],
    ['GET', /^\/api\/teams\/([^/]+)$/, async (ctx) => C.teamView(C.getTeam(ctx.p[0]))],
    ['PATCH', /^\/api\/teams\/([^/]+)$/, async (ctx) => C.patchTeam(ctx.p[0], ctx.body)],
    ['POST', /^\/api\/teams\/([^/]+)\/stop$/, async (ctx) => C.stopTeam(ctx.p[0], ctx.body.reason)],
    ['POST', /^\/api\/teams\/([^/]+)\/archive$/, async (ctx) => C.archiveTeam(ctx.p[0])],
    ['POST', /^\/api\/teams\/([^/]+)\/restore$/, async (ctx) => C.restoreTeam(ctx.p[0])],
    ['DELETE', /^\/api\/teams\/([^/]+)$/, async (ctx) => C.deleteTeam(ctx.p[0], { confirm: qs(ctx.url).get('confirm') === '1' })],

    // 面板设置（目前只有「自动封存」）
    ['GET', /^\/api\/settings$/, async () => C.panelSettings()],
    ['PATCH', /^\/api\/settings$/, async (ctx) => C.patchPanelSettings(ctx.body)],

    // members
    ['POST', /^\/api\/teams\/([^/]+)\/members$/, async (ctx) => C.addMember(ctx.p[0], ctx.body)],
    ['GET', /^\/api\/teams\/([^/]+)\/members$/, async (ctx) => ({ items: C.listMembers(ctx.p[0]) })],
    ['GET', /^\/api\/members\/([^/]+)$/, async (ctx) => C.memberView(ctx.p[0]) || (() => { throw ERR.notFound('member'); })()],
    ['PATCH', /^\/api\/members\/([^/]+)$/, async (ctx) => C.updateMember(ctx.p[0], ctx.body)],
    ['DELETE', /^\/api\/members\/([^/]+)$/, async (ctx) => C.removeMember(ctx.p[0], { mode: qs(ctx.url).get('mode') || 'retire', confirm: qs(ctx.url).get('confirm') === '1' })],
    ['POST', /^\/api\/members\/([^/]+)\/interrupt$/, async (ctx) => C.interruptMember(ctx.p[0], ctx.body.reason)],
    ['POST', /^\/api\/members\/([^/]+)\/resume$/, async (ctx) => C.resumeMember(ctx.p[0])],
    ['POST', /^\/api\/members\/([^/]+)\/assign$/, async (ctx) => C.assign(ctx.p[0], need(ctx.body.taskId, 'taskId'))],

    // agent 运行时：成员 = 真 DSH sub-agent（Host 插件派发，sidecar 只记状态）
    ['POST', /^\/api\/agents\/register$/, async (ctx) => C.registerAgent(ctx.body)],
    ['GET', /^\/api\/agents\/ready$/, async (ctx) => C.agentReady(need(qs(ctx.url).get('team'), 'team'))],
    ['POST', /^\/api\/agents\/dispatch$/, async (ctx) => C.dispatchAgentTask(need(ctx.body.teamId, 'teamId'))],
    ['POST', /^\/api\/agents\/status$/, async (ctx) => C.agentStatusBySession(need(ctx.body.sessionId, 'sessionId'), ctx.body)],
    ['POST', /^\/api\/agents\/report$/, async (ctx) => C.agentReportBySession(need(ctx.body.sessionId, 'sessionId'), ctx.body)],
    ['GET', /^\/api\/agents\/by-session\/([^/]+)$/, async (ctx) => C.memberBySession(decodeURIComponent(ctx.p[0])) || { ok: false, reason: 'unknown_session' }],
    ['POST', /^\/api\/members\/([^/]+)\/agent-status$/, async (ctx) => C.agentStatus(ctx.p[0], ctx.body)],
    ['POST', /^\/api\/members\/([^/]+)\/agent-report$/, async (ctx) => C.agentReport(ctx.p[0], ctx.body)],

    // tasks / deps / dag
    ['POST', /^\/api\/tasks$/, async (ctx) => C.scheduler.createTask(ctx.body)],
    ['GET', /^\/api\/tasks$/, async (ctx) => {
      const team = need(qs(ctx.url).get('team'), 'team');
      C.getTeam(team);
      return { asOf: nowIso(), version: C.scheduler.version(team), items: C.get('SELECT * FROM task WHERE team_id=? ORDER BY created_at ASC').all(team).map(rowToTask) };
    }],
    ['GET', /^\/api\/tasks\/([^/]+)$/, async (ctx) => {
      const r = C.get('SELECT * FROM task WHERE id=?').get(ctx.p[0]);
      if (!r) throw ERR.notFound('task');
      return rowToTask(r);
    }],
    ['POST', /^\/api\/tasks\/([^/]+)\/abort$/, async (ctx) => C.abortTask(ctx.p[0], ctx.body?.reason || 'lead abort')],
    ['POST', /^\/api\/deps$/, async (ctx) => C.scheduler.addDep(ctx.body)],
    ['DELETE', /^\/api\/deps\/([^/]+)$/, async (ctx) => C.scheduler.removeDep(Number(ctx.p[0]))],
    ['GET', /^\/api\/dag$/, async (ctx) => C.scheduler.dag(need(qs(ctx.url).get('team'), 'team'))],

    // 成员产物（Host 插件采集 present / workspace 变更后推送到这里）
    ['GET', /^\/api\/artifacts$/, async (ctx) => C.listArtifacts(need(qs(ctx.url).get('team'), 'team'), { taskId: qs(ctx.url).get('task'), limit: qs(ctx.url).get('limit') })],
    ['POST', /^\/api\/artifacts$/, async (ctx) => C.addArtifacts(ctx.body)],

    // 成员改动（Host 插件在成员 write/edit 落盘后上报 unified diff；面板「审阅」页只读展示）
    ['GET', /^\/api\/changes$/, async (ctx) => C.listChanges(need(qs(ctx.url).get('team'), 'team'), { taskId: qs(ctx.url).get('task'), memberId: qs(ctx.url).get('member'), limit: qs(ctx.url).get('limit') })],
    ['POST', /^\/api\/changes$/, async (ctx) => C.addChanges(ctx.body)],

    // 成员上下文分析（Host 插件算好「上下文窗口被什么占满」后推送；面板按成员展示）
    ['GET', /^\/api\/contexts$/, async (ctx) => C.listContexts(need(qs(ctx.url).get('team'), 'team'), { memberId: qs(ctx.url).get('member') })],
    ['POST', /^\/api\/contexts$/, async (ctx) => C.reportContext(ctx.body)],

    // DSH 工作区列表（Host 插件从 ctx.workspaceRegistry 同步过来）
    ['GET', /^\/api\/workspaces$/, async () => C.listWorkspaces()],
    ['POST', /^\/api\/workspaces$/, async (ctx) => C.reportWorkspaces(ctx.body)],

    // DSH Web 地址（Host 插件上报；独立面板据此在浏览器里深链打开会话）
    ['GET', /^\/api\/host\/web$/, async () => ({ url: C.board.hostWebUrl() })],
    ['POST', /^\/api\/host\/web$/, async (ctx) => C.board.reportHostWeb(ctx.body?.url)],

    // ---------- 工作区任务看板 ----------
    ['GET', /^\/api\/board$/, async (ctx) => C.board.view(need(qs(ctx.url).get('workspaceId'), 'workspaceId'), { archived: qs(ctx.url).get('archived') === '1' })],
    ['GET', /^\/api\/board\/live$/, async () => C.board.live()],
    ['GET', /^\/api\/board\/by-session\/([^/]+)$/, async (ctx) => C.board.bySession(decodeURIComponent(ctx.p[0])) || { ok: false, reason: 'unknown_session' }],
    ['GET', /^\/api\/board\/by-team\/([^/]+)$/, async (ctx) => C.board.byTeam(decodeURIComponent(ctx.p[0])) || { ok: false, reason: 'unknown_team' }],
    ['GET', /^\/api\/board\/settings$/, async (ctx) => C.board.settings(need(qs(ctx.url).get('workspaceId'), 'workspaceId'))],
    ['PUT', /^\/api\/board\/settings$/, async (ctx) => C.board.saveSettings(need(ctx.body.workspaceId, 'workspaceId'), ctx.body)],
    ['POST', /^\/api\/board\/tasks$/, async (ctx) => C.board.createTask(ctx.body)],
    ['POST', /^\/api\/board\/claim$/, async (ctx) => C.board.claim(need(ctx.body.kind, 'kind'))],
    ['GET', /^\/api\/board\/tasks\/([^/]+)$/, async (ctx) => C.board.getTask(ctx.p[0])],
    ['PATCH', /^\/api\/board\/tasks\/([^/]+)$/, async (ctx) => C.board.updateTask(ctx.p[0], ctx.body)],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/start$/, async (ctx) => C.board.startTask(ctx.p[0], ctx.body)],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/stop$/, async (ctx) => {
      const task = C.board.stopTask(ctx.p[0], ctx.body);
      // 看板停止不能只把任务标 failed：绑定的团队也要停，否则成员还在跑。
      for (const teamId of task.teams || []) {
        try { C.stopTeam(teamId, `board stop: ${task.id}`); } catch { /* ignore */ }
      }
      return task;
    }],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/retry$/, async (ctx) => C.board.retryTask(ctx.p[0])],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/archive$/, async (ctx) => C.board.archiveTask(ctx.p[0], ctx.body)],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/restore$/, async (ctx) => C.board.restoreTask(ctx.p[0])],
    ['DELETE', /^\/api\/board\/tasks\/([^/]+)$/, async (ctx) => C.board.deleteTask(ctx.p[0])],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/status$/, async (ctx) => C.board.setAgentStatus(need(ctx.body.sessionId, 'sessionId'), ctx.body)],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/attach$/, async (ctx) => C.board.attach(ctx.p[0], ctx.body)],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/release$/, async (ctx) => C.board.release(ctx.p[0], ctx.body)],
    ['GET', /^\/api\/board\/tasks\/([^/]+)\/teams$/, async (ctx) => ({ items: C.board.getTask(ctx.p[0]).teams })],
    ['POST', /^\/api\/board\/tasks\/([^/]+)\/teams$/, async (ctx) => C.board.bindTeam(ctx.p[0], need(ctx.body.teamId, 'teamId'))],
    ['POST', /^\/api\/board\/agents\/plan$/, async (ctx) => C.board.submitPlan(need(ctx.body.sessionId, 'sessionId'), ctx.body)],
    ['POST', /^\/api\/board\/agents\/status$/, async (ctx) => C.board.setAgentStatus(need(ctx.body.sessionId, 'sessionId'), ctx.body)],

    // status / steps / blockers / metrics
    ['GET', /^\/api\/status$/, async (ctx) => C.status({ teamId: qs(ctx.url).get('team'), memberId: qs(ctx.url).get('member') })],
    ['GET', /^\/api\/steps$/, async (ctx) => C.steps(need(qs(ctx.url).get('member'), 'member'), qs(ctx.url).get('since') || 0, qs(ctx.url).get('limit') || 200)],
    ['GET', /^\/api\/blockers$/, async (ctx) => C.blockers(need(qs(ctx.url).get('team'), 'team'))],
    ['GET', /^\/api\/metrics$/, async (ctx) => C.metrics(need(qs(ctx.url).get('team'), 'team'))],
    ['GET', /^\/api\/events\/history$/, async (ctx) => C.history(need(qs(ctx.url).get('team'), 'team'), { since: qs(ctx.url).get('since') || 0, member: qs(ctx.url).get('member'), limit: qs(ctx.url).get('limit') || 500 })],

    // trace 瀑布：显式 span 上报 + 聚合树（成员看板）
    ['POST', /^\/api\/spans$/, async (ctx) => C.appendSpans(ctx.body)],
    ['GET', /^\/api\/spans$/, async (ctx) => C.listSpans({
      teamId: need(qs(ctx.url).get('team'), 'team'),
      memberId: qs(ctx.url).get('member') || null,
      sessionId: qs(ctx.url).get('session') || null,
      since: qs(ctx.url).get('since') || 0,
      limit: qs(ctx.url).get('limit') || 2000,
    })],
    ['GET', /^\/api\/trace$/, async (ctx) => C.trace(need(qs(ctx.url).get('team'), 'team'), {
      limit: qs(ctx.url).get('limit') || 4000,
      windowMs: (Number(qs(ctx.url).get('window')) || 0) * 60000,
      // 往前翻页：until 是 epoch 毫秒上界，只取这段时间之前的记录
      untilMs: Number(qs(ctx.url).get('until')) || 0,
    })],
    ['GET', /^\/api\/verify$/, async (ctx) => C.verify(qs(ctx.url).get('team'))],
    ['GET', /^\/api\/reconcile$/, async (ctx) => C.reconcile(need(qs(ctx.url).get('team'), 'team'))],

    // messages
    ['POST', /^\/api\/messages$/, async (ctx) => C.sendMessage(ctx.body)],
    ['GET', /^\/api\/messages$/, async (ctx) => C.listMessages(need(qs(ctx.url).get('team'), 'team'), {
      correlation: qs(ctx.url).get('correlation'), member: qs(ctx.url).get('member'), status: qs(ctx.url).get('status'),
    })],
    ['POST', /^\/api\/messages\/([^/]+)\/ack$/, async (ctx) => C.ackMessage(ctx.p[0], ctx.body.state || 'acked')],

    // 权限审批：permission preset 的 approval=ask 触发，Host 插件把决定回填到这里
    ['POST', /^\/api\/approvals$/, async (ctx) => C.createApproval(ctx.body)],
    ['GET', /^\/api\/approvals$/, async (ctx) => C.listApprovals({ teamId: qs(ctx.url).get('team'), status: qs(ctx.url).get('status') })],
    ['POST', /^\/api\/approvals\/([^/]+)\/decide$/, async (ctx) => C.decideApproval(ctx.p[0], ctx.body)],
    ['GET', /^\/api\/presets$/, async () => C.listPresets()],
    ['POST', /^\/api\/presets\/sync$/, async (ctx) => C.syncPresets(ctx.body)],
    ['POST', /^\/api\/presets\/([^/]+)\/delete$/, async (ctx) => C.requestPresetDelete(ctx.p[0])],
    ['GET', /^\/api\/presets\/pending-deletes$/, async () => C.pendingPresetDeletes()],
    ['POST', /^\/api\/presets\/pending-deletes\/([^/]+)\/ack$/, async (ctx) => C.ackPresetDelete(ctx.p[0], ctx.body)],
    ['GET', /^\/api\/presets\/([^/]+)$/, async (ctx) => C.getPreset(ctx.p[0])],

    // todos
    ['GET', /^\/api\/todos$/, async (ctx) => C.listTodos({ teamId: need(qs(ctx.url).get('team'), 'team'), memberId: qs(ctx.url).get('member'), taskId: qs(ctx.url).get('task') })],
    ['POST', /^\/api\/tasks\/([^/]+)\/todos$/, async (ctx) => C.setTaskTodos(ctx.p[0], ctx.body.items, { by: ctx.body.by ?? null })],
    ['POST', /^\/api\/todos$/, async (ctx) => C.createTodo(ctx.body)],
    ['PATCH', /^\/api\/todos\/([^/]+)$/, async (ctx) => C.patchTodo(ctx.p[0], ctx.body)],

    // 模型路由目录：Host 插件把 DSH ctx.llm 的 provider/model 映射同步进来。
    // sidecar 只存「启用子集 + 注释」，不代理任何 LLM 请求、不持有凭据。
    ['POST', /^\/api\/llm\/catalog$/, async (ctx) => C.llm.sync(ctx.body)],
    ['GET', /^\/api\/llm\/catalog$/, async () => C.llm.catalog()],
    ['GET', /^\/api\/llm\/models$/, async (ctx) => {
      const all = qs(ctx.url).get('all') === '1';
      const items = all ? C.llm.catalog().providers.flatMap((p) => p.models) : C.llm.enabledModels();
      return { asOf: nowIso(), total: items.length, items };
    }],
    ['PATCH', /^\/api\/llm\/routes$/, async (ctx) => C.llm.setRoute(
      need(ctx.body.provider, 'provider'), need(ctx.body.model, 'model'),
      { enabled: ctx.body.enabled, note: ctx.body.note, allowedEfforts: ctx.body.allowedEfforts },
    )],

    // audit / report
    ['GET', /^\/api\/audit$/, async (ctx) => ({ asOf: nowIso(), items: C.auditList(need(qs(ctx.url).get('team'), 'team'), qs(ctx.url).get('limit') || 200) })],
    ['GET', /^\/api\/report$/, async (ctx) => C.report(need(qs(ctx.url).get('team'), 'team'))],
  ];
}

export async function startServer({ home, port = 4317, host = '127.0.0.1', log = null } = {}) {
  const token = ensureToken(home);
  const logs = [];
  const logFn = log || ((entry) => {
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    try { process.stdout.write(JSON.stringify(redactor.obj({ ts: nowIso(), ...entry })) + '\n'); } catch { /* ignore */ }
  });
  const core = new DshTeam({ home, log: logFn });
  const routes = createRoutes(core);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    // 静态面板（公开）
    if (pathname === '/' || pathname === '/panel' || pathname.startsWith('/panel/')) {
      const rel = pathname === '/' || pathname === '/panel' || pathname === '/panel/'
        ? 'panel.html'
        : decodeURIComponent(pathname.slice('/panel/'.length));
      const target = path.resolve(PANEL_DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1'), rel);
      const base = path.resolve(PANEL_DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      if (!target.startsWith(base)) { res.writeHead(403); res.end('forbidden'); return; }
      try {
        const buf = fs.readFileSync(target);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('panel not built yet (src/web/panel.html missing)\n');
      }
      return;
    }

    // SSE（无鉴权：面板与 API 均改为免 token，sidecar 只监听本机回环）
    if (pathname === '/api/events' && req.method === 'GET') {
      const last = Number(url.searchParams.get('lastEventId') || req.headers['last-event-id'] || 0) || 0;
      try {
        core.sse.subscribe(req, res, { teamId: url.searchParams.get('team'), member: url.searchParams.get('member'), lastEventId: last });
      } catch (e) { try { res.end(); } catch { /* ignore */ } }
      return;
    }

    // 鉴权已按需求移除：API 免 token 直接访问（仅限回环监听；如需暴露远端请自行加访问控制）

    const matched = routes.find(([m, re]) => m === req.method && re.test(pathname));
    if (!matched) {
      if (pathname.startsWith('/api/')) return sendJson(res, 404, ERR.notFound('route').toJSON());
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const [, re, handler] = matched;
    const m = pathname.match(re);
    try {
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = await handler({ p: m.slice(1), url, body, req, res });
      if (res.writableEnded) return;
      if (typeof result === 'string') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(result);
      } else sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof ApiError) return sendJson(res, e.status, e.toJSON());
      logFn({ level: 'error', msg: 'request failed', path: pathname, err: String(e?.stack || e) });
      return sendJson(res, 500, { error: { code: 'E_INTERNAL', message: String(e?.message || e) } });
    }
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;

  // 运行指针，供 CLI up/down 发现
  const runDir = path.join(home, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'sidecar.json'), JSON.stringify({ pid: process.pid, port: actualPort, url, startedAt: nowIso() }, null, 2));

  const close = async () => {
    try { server.close(); } catch { /* ignore */ }
    try { core.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.join(runDir, 'sidecar.json'), { force: true }); } catch { /* ignore */ }
  };
  return { server, core, token, port: actualPort, url, home, close };
}

// @local/dsh-team-plugin — 把本地 dsh-team sidecar 暴露为模型可调用工具。
//
// 设计约束（来自本仓 docs/CONTRACT.md 与 PRD）：
// - 本插件只做「适配 + 生命周期」，编排/权限/事件流全部在 sidecar 进程内，不在这里重写。
// - 零第三方 import：只用 Node 内置模块，避免 profile 依赖解析问题；
//   工具用普通 ToolDefinition 对象注册（JSON Schema 参数），不依赖 defineTool。
// - sidecar 未运行时，autoStart=true 会在首次工具调用时拉起 `dsh-team up`；
//   插件卸载时只回收「自己拉起」的进程，不影响用户手工起的服务。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
export const name = 'dsh-team';
/** Services required by this plugin. */
export const inject = ['tools'];

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENTRY = path.resolve(PKG_DIR, '..', 'bin', 'dsh-team.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveConfig(config) {
  const c = config || {};
  const baseUrl = String(c.baseUrl || process.env.DSH_TEAM_URL || 'http://127.0.0.1:4317').replace(/\/+$/, '');
  let port = 4317;
  try { port = Number(new URL(baseUrl).port) || 4317; } catch { /* keep default */ }
  return {
    baseUrl,
    port,
    home: path.resolve(c.home || process.env.DSH_TEAM_HOME || path.join(os.homedir(), '.dsh', 'team')),
    autoStart: c.autoStart !== false,
    entry: path.resolve(c.sidecarEntry || DEFAULT_ENTRY),
    startTimeoutMs: Number(c.startTimeoutMs) || 20000,
    requestTimeoutMs: Number(c.requestTimeoutMs) || 60000,
    // 把每次工具调用作为 trace span 上报到 sidecar（成员看板瀑布实时展示）
    reportToolCalls: c.reportToolCalls !== false,
    traceInputMax: Number(c.traceInputMax) || 1200,
  };
}

function tryReadToken(home) {
  try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim() || null; } catch { return null; }
}

async function isUp(baseUrl) {
  try {
    const res = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.ok === true;
  } catch { return false; }
}

function spawnSidecar(s) {
  const child = spawn(process.execPath, [s.entry, 'up', '--port', String(s.port), '--data', s.home], {
    cwd: path.dirname(s.entry),
    env: { ...process.env },
    stdio: 'ignore',
    windowsHide: true,
  });
  const state = { child, error: null };
  child.on('error', (e) => { state.error = e; });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) state.error = new Error(`sidecar 进程退出 code=${code}${signal ? ` signal=${signal}` : ''}`);
  });
  return state;
}

async function ensureSidecar(s) {
  if (!s.token) s.token = tryReadToken(s.home);
  if (await isUp(s.baseUrl)) return s;
  if (!s.autoStart) {
    throw new Error(`dsh-team sidecar 不可达：${s.baseUrl}。请先运行：node "${s.entry}" up --port ${s.port} --data "${s.home}"，或在插件 config 里设 autoStart: true。`);
  }
  if (!s.starting) {
    s.starting = (async () => {
      const spawned = spawnSidecar(s);
      s.spawned = spawned;
      const deadline = Date.now() + s.startTimeoutMs;
      while (Date.now() < deadline) {
        if (spawned.error) throw spawned.error;
        if (await isUp(s.baseUrl)) return;
        await sleep(150);
      }
      throw new Error(`dsh-team sidecar 启动超时（${s.startTimeoutMs}ms）：${s.baseUrl}。入口：${s.entry}`);
    })().finally(() => { s.starting = null; });
  }
  await s.starting;
  for (let i = 0; i < 20 && !s.token; i++) { s.token = tryReadToken(s.home); if (!s.token) await sleep(50); }
  return s;
}

async function request(s, pathname, { method = 'GET', body, raw = false } = {}) {
  await ensureSidecar(s);
  const run = async () => fetch(s.baseUrl + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(s.requestTimeoutMs),
  });
  let res = await run();
  if (res.status === 401) { s.token = tryReadToken(s.home); res = await run(); }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try { const j = JSON.parse(text); detail = `${j.error?.code || ''} ${j.error?.message || ''}`.trim() || detail; } catch { /* keep text */ }
    throw new Error(`dsh-team API ${res.status} on ${method} ${pathname}: ${detail}`);
  }
  if (raw) return text;
  try { return JSON.parse(text); } catch { return text; }
}

const panelUrl = (s) => `${s.baseUrl}/panel`;
const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};

// ---------- 工具 schema 片段 ----------
const PLAN_STEP = {
  type: 'object',
  additionalProperties: true,
  description: 'One observable action executed by a worker process through the sidecar permission broker.',
  properties: {
    step: { type: 'string', description: 'Step label, e.g. S1.' },
    phase: {
      type: 'string',
      description: 'Event phase used in the timeline: init|read|write|exec|net|env|msg|wait|verify|done|fail.',
    },
    action: { type: 'string', description: 'Verb shown in the timeline, e.g. write / read / exec.' },
    target: { type: 'string', description: 'File path, command, host, or env name this step touches.' },
    op: {
      type: 'object',
      additionalProperties: true,
      description: 'The proxied action. kind: fs.read{path} | fs.write{path,content,expectVersion?} | fs.append{path,marker,retries?} | fs.list{path} | exec{argv,cwd?,timeoutMs?} | net{url,method?,headers?,body?} | env{name} | sleep{ms} | escape{} | scope{domain,target,reason,then?} | fail{message,retryable?} | noop.',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
    },
    onDenied: { type: 'string', enum: ['scope'], description: "Escalate a denied action into a scope request instead of failing the task." },
    scopeReason: { type: 'string' },
    scopeTimeoutMs: { type: 'integer' },
    fatal: { type: 'boolean' },
  },
  required: ['step', 'op'],
};

const MEMBER_FIELDS = {
  id: { type: 'string' },
  name: { type: 'string' },
  status: { type: 'string' },
  step: { type: ['string', 'null'] },
  seq: { type: 'integer' },
  pct: { type: ['number', 'null'] },
  next: { type: ['string', 'null'] },
  stale: { type: 'boolean' },
};

const jsonOutput = (description) => ({
  schema: { type: 'object', additionalProperties: true, description },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const textOutput = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String(value?.markdown ?? value) }],
});

/** 构造全部工具（普通 ToolDefinition，不依赖 defineTool；参数即 JSON Schema）。 */
function buildTools(s) {
  const tools = [];

  tools.push({
    name: 'team_create',
    description: 'Create an orchestration team on the local dsh-team sidecar. A team owns members, a task DAG, and the four-domain (fs/exec/net/env) permission policy. `workspace` is the absolute directory workers may touch — and only through the sidecar broker. Next steps: team_spawn for members, team_task for DAG nodes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Team name.' },
        workspace: { type: 'string', description: 'Absolute directory shared by workers; created if missing.' },
        maxMembers: { type: 'integer', description: 'Member cap, 0 means unlimited. Default 64. Extra members are queued, never errors.' },
        maxConcurrency: { type: 'integer', description: 'Max simultaneously running tasks. Default 8.' },
        failurePolicy: { type: 'string', enum: ['continue', 'abort'], description: 'Team-level default failure policy.' },
        maxAttempts: { type: 'integer', description: 'Per-task retry cap. Default 3.' },
      },
      required: ['name', 'workspace'],
    },
    output: jsonOutput('{ team, panel }'),
    async execute(args) {
      const team = await request(s, '/api/teams', {
        method: 'POST',
        body: {
          name: args.name,
          workspace: args.workspace,
          ...(args.maxMembers !== undefined ? { maxMembers: args.maxMembers } : {}),
          ...(args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {}),
          ...(args.failurePolicy !== undefined ? { failurePolicy: args.failurePolicy } : {}),
          ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
        },
      });
      return { team, panel: panelUrl(s) };
    },
  });

  tools.push({
    name: 'team_spawn',
    description: 'Add one Worker member to a team. Over the member cap the member becomes `queued` instead of failing, and is promoted automatically when a slot frees. Members are reusable slots: they run one task at a time and return to `idle`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string', description: 'Team id from team_create.' },
        name: { type: 'string', description: 'Unique member name inside the team; this is the addressable target.' },
        role: { type: 'string', description: 'Role label, also usable as a policy subject (subjectType=role).' },
        model: { type: 'string', description: 'Optional model label recorded on the member.' },
        contextMode: { type: 'string', enum: ['isolated', 'fresh', 'fork'], description: 'Context isolation label. Default isolated.' },
      },
      required: ['teamId', 'name'],
    },
    output: jsonOutput('{ member }'),
    async execute(args) {
      const member = await request(s, `/api/teams/${encodeURIComponent(args.teamId)}/members`, {
        method: 'POST',
        body: {
          name: args.name,
          ...(args.role !== undefined ? { role: args.role } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.contextMode !== undefined ? { contextMode: args.contextMode } : {}),
        },
      });
      return { member };
    },
  });

  tools.push({
    name: 'team_status',
    description: 'Read a live snapshot instead of guessing progress. detail=summary returns every member with status/step/seq/percent/next/blockers/lease/stale; detail=dag returns the task DAG with dependencies, readiness, joins and the critical path. `asOf` marks the snapshot time.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        detail: { type: 'string', enum: ['summary', 'dag'], description: 'Default summary.' },
      },
      required: ['teamId'],
    },
    output: jsonOutput('{ asOf, version, panel, members? , ready?, criticalPath?, nodes?, edges? }'),
    isConcurrencySafe: () => true,
    async execute(args) {
      if ((args.detail || 'summary') === 'dag') {
        const dag = await request(s, `/api/dag${qs({ team: args.teamId })}`);
        return { ...dag, panel: panelUrl(s) };
      }
      const st = await request(s, `/api/status${qs({ team: args.teamId })}`);
      return {
        asOf: st.asOf,
        version: st.version,
        panel: panelUrl(s),
        members: (st.members || []).map((m) => ({
          name: m.name,
          status: m.status,
          step: m.step,
          seq: m.seq,
          pct: m.pct,
          next: m.next,
          last: m.last,
          currentTaskId: m.currentTaskId,
          leaseUntil: m.leaseUntil,
          blockers: m.blockers,
          stale: m.stale,
        })),
        staleMembers: st.staleMembers,
        degraded: st.degraded,
      };
    },
  });

  tools.push({
    name: 'team_task',
    description: 'Declare one task (DAG node) with an executable step plan. The scheduler satisfies dependencies and starts the assignee automatically — never poll or start anything yourself. Each plan step performs exactly one proxied action through the sidecar broker; the worker process has no direct IO, so a denied step fails hard with no side effect. Use team_scope to approve an out-of-scope action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        subject: { type: 'string', description: 'Concise task title.' },
        assignee: { type: 'string', description: 'Member id (not name). Omit to let the scheduler pick an idle member.' },
        plan: { type: 'array', items: PLAN_STEP, description: 'Ordered steps. May be empty for a pure heartbeat task.' },
        deps: {
          type: 'array',
          description: 'Upstream dependencies declared atomically with the task: [{from, condition?, artifactPath?}].',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string', description: 'Upstream task id.' },
              condition: { type: 'string', enum: ['all_success', 'any_success', 'on_failure', 'artifact_exists'] },
              artifactPath: { type: 'string', description: 'Workspace-relative path for condition=artifact_exists.' },
            },
            required: ['from'],
          },
        },
        writeScopes: { type: 'array', items: { type: 'string' }, description: 'Advisory write scope prefixes (sidecar policies are the enforced ones).' },
        acceptance: { type: 'string' },
        priority: { type: 'integer', description: 'Smaller runs first. Default 0.' },
        failurePolicy: { type: 'string', enum: ['continue', 'skip', 'abort_team', 'retry'] },
        maxAttempts: { type: 'integer' },
      },
      required: ['teamId', 'subject', 'plan'],
    },
    output: jsonOutput('{ task }'),
    async execute(args) {
      const task = await request(s, '/api/tasks', {
        method: 'POST',
        body: {
          teamId: args.teamId,
          subject: args.subject,
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          plan: args.plan || [],
          ...(args.deps !== undefined ? { deps: args.deps } : {}),
          ...(args.writeScopes !== undefined ? { writeScopes: args.writeScopes } : {}),
          ...(args.acceptance !== undefined ? { acceptance: args.acceptance } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.failurePolicy !== undefined ? { failurePolicy: args.failurePolicy } : {}),
          ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
        },
      });
      return { task };
    },
  });

  tools.push({
    name: 'team_send',
    description: "Send a persistent message to one member, or to '*' to broadcast to the whole team. A running member receives it at its next step boundary (within one step); an idle member is woken to consume it. Messages are never lost and expose delivered/read/acked receipts.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        to: { type: 'string', description: "Member id, or '*' for broadcast." },
        message: { type: 'string', description: 'Message body.' },
        correlationId: { type: 'string', description: 'Optional correlation id to pair a request with its response.' },
      },
      required: ['teamId', 'to', 'message'],
    },
    output: jsonOutput('{ message, messages? }'),
    async execute(args) {
      return await request(s, '/api/messages', {
        method: 'POST',
        body: {
          teamId: args.teamId,
          from: 'lead',
          to: args.to,
          payload: { text: args.message },
          ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
        },
      });
    },
  });

  tools.push({
    name: 'team_scope',
    description: 'Four-domain permission workflow. action=list shows pending or decided out-of-scope requests (fs/exec/net/env). action=request files one for a blocked action (the worker normally does this automatically when onDenied="scope"). action=decide approves or denies it: the decision is persisted transactionally and an approval creates a single-use, TTL-bounded grant — the same target needs a fresh request afterwards. Explicit deny always beats allow.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'request', 'decide'], description: 'Required operation.' },
        teamId: { type: 'string', description: 'Required for list and request.' },
        status: { type: 'string', description: 'For list: pending | approved | denied | expired.' },
        memberId: { type: 'string', description: 'For request: the blocked member.' },
        domain: { type: 'string', enum: ['fs', 'exec', 'net', 'env'] },
        target: { type: 'string', description: 'Relative path, argv string, host:port, or env var name.' },
        reason: { type: 'string' },
        diffSize: { type: 'integer' },
        risk: { type: 'string' },
        blockedStep: { type: 'string' },
        fallback: { type: 'string', description: 'What the member should do if denied.' },
        requestId: { type: 'string', description: 'For decide.' },
        decision: { type: 'string', enum: ['approved', 'denied'], description: 'For decide.' },
        decidedBy: { type: 'string', description: 'Who decided; defaults to lead.' },
        ttlSeconds: { type: 'integer', description: 'Grant lifetime in seconds. Default 60.' },
        singleUse: { type: 'boolean', description: 'Default true: one use, then re-request.' },
      },
      required: ['action'],
    },
    output: jsonOutput('{ items? , scopeRequest?, decision?, grant? }'),
    async execute(args) {
      const action = args.action;
      if (action === 'list') {
        if (!args.teamId) throw new Error('team_scope list requires teamId');
        return await request(s, `/api/scope-requests${qs({ team: args.teamId, status: args.status })}`);
      }
      if (action === 'request') {
        if (!args.teamId || !args.memberId || !args.domain || !args.target) {
          throw new Error('team_scope request requires teamId, memberId, domain, target');
        }
        const scopeRequest = await request(s, '/api/scope-requests', {
          method: 'POST',
          body: {
            memberId: args.memberId,
            teamId: args.teamId,
            domain: args.domain,
            target: args.target,
            reason: args.reason || '',
            ...(args.diffSize !== undefined ? { diffSize: args.diffSize } : {}),
            ...(args.risk !== undefined ? { risk: args.risk } : {}),
            ...(args.blockedStep !== undefined ? { blockedStep: args.blockedStep } : {}),
            ...(args.fallback !== undefined ? { fallback: args.fallback } : {}),
          },
        });
        return { scopeRequest };
      }
      if (action === 'decide') {
        if (!args.requestId || !args.decision) throw new Error('team_scope decide requires requestId and decision');
        return await request(s, `/api/scope-requests/${encodeURIComponent(args.requestId)}/decide`, {
          method: 'POST',
          body: {
            decision: args.decision,
            decidedBy: args.decidedBy || 'lead',
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.ttlSeconds !== undefined ? { ttlSeconds: args.ttlSeconds } : {}),
            ...(args.singleUse !== undefined ? { singleUse: args.singleUse } : {}),
          },
        });
      }
      throw new Error(`team_scope unknown action: ${action}`);
    },
  });

  tools.push({
    name: 'team_control',
    description: 'Control one member. interrupt writes status synchronously (no zombie `running`) and keeps the task resumable; resume continues from the last recorded step without repeating completed units; assign hands a ready task to an idle member.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['interrupt', 'resume', 'assign'] },
        memberId: { type: 'string' },
        taskId: { type: 'string', description: 'Required for assign.' },
        reason: { type: 'string', description: 'For interrupt.' },
      },
      required: ['action', 'memberId'],
    },
    output: jsonOutput('{ member, ... }'),
    async execute(args) {
      const id = encodeURIComponent(args.memberId);
      if (args.action === 'interrupt') return await request(s, `/api/members/${id}/interrupt`, { method: 'POST', body: { reason: args.reason || 'lead interrupt' } });
      if (args.action === 'resume') return await request(s, `/api/members/${id}/resume`, { method: 'POST', body: {} });
      if (args.action === 'assign') {
        if (!args.taskId) throw new Error('team_control assign requires taskId');
        return await request(s, `/api/members/${id}/assign`, { method: 'POST', body: { taskId: args.taskId } });
      }
      throw new Error(`team_control unknown action: ${args.action}`);
    },
  });

  tools.push({
    name: 'team_report',
    description: 'Export a Markdown run report: members, tasks/DAG, persisted decisions, and the audit table with actor, domain, action, target, and full before/after SHA-256 hashes. Use it for review, handoff, or proving who changed which file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { teamId: { type: 'string' } },
      required: ['teamId'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args) {
      const markdown = await request(s, `/api/report${qs({ team: args.teamId, format: 'md' })}`, { raw: true });
      return { markdown: String(markdown).slice(0, 200000) };
    },
  });

  return tools;
}

// ---------- trace 上报：把每次工具调用写成 span（running → done/failed） ----------
/** 会话 → 团队 的粘性绑定：参数里出现 teamId 或 team_create 返回后记住，后续调用自动归属。 */
const teamBySession = new Map();

const clipText = (value, max) => {
  if (value == null) return null;
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  return text.length > max ? text.slice(0, max) + '…' : text;
};

/** 后台 POST，1.2s 超时；sidecar 未起/网络抖动绝不影响工具调用本身。 */
function postSpan(s, payload) {
  if (!payload.teamId) return;
  const body = JSON.stringify(payload);
  void fetch(s.baseUrl + '/api/spans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(1200),
  }).catch(() => { /* ignore */ });
}

function bindSessionTeam(sessionId, args, resultValue) {
  if (!sessionId) return null;
  const teamId = args?.teamId || resultValue?.team?.id || resultValue?.teamId
    || (Array.isArray(resultValue?.items) && resultValue.items[0]?.team?.id);
  if (teamId) teamBySession.set(sessionId, String(teamId));
  return sessionId ? (teamBySession.get(sessionId) || null) : null;
}

/**
 * `tools/execute` waterfall：进入前报 running，返回/抛错后报终态。
 * 同一 spanId 幂等 upsert，因此面板可在调用进行中就先画出增长中的条。
 */
async function traceToolCall(s, exec, next) {
  const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
  const callId = exec?.callId != null ? String(exec.callId) : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const spanId = `tool:${sessionId || 'host'}:${callId}`;
  const name = String(exec?.name || 'tool');
  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const startMs = Date.now();
  const teamId = (args.teamId && String(args.teamId)) || (sessionId && teamBySession.get(sessionId)) || null;
  if (teamId) {
    postSpan(s, {
      teamId, sessionId, spanId, name, kind: 'tool', status: 'running', startMs,
      detail: Object.keys(args).length ? clipText(args, 160) : null,
      input: clipText(args, s.traceInputMax),
    });
  }
  let result;
  try {
    result = await next();
  } catch (err) {
    if (teamId) {
      postSpan(s, {
        teamId, sessionId, spanId, name, kind: 'tool', status: 'failed', startMs, endMs: Date.now(),
        error: clipText(err && err.message ? err.message : String(err), 2000),
      });
    }
    throw err;
  }
  const failed = !!result && (result.isError === true || result.error != null);
  const bound = bindSessionTeam(sessionId, args, failed ? null : result?.value);
  const finalTeam = teamId || bound;
  if (finalTeam) {
    postSpan(s, {
      teamId: finalTeam, sessionId, spanId, name, kind: 'tool',
      status: failed ? 'failed' : 'done', startMs, endMs: Date.now(),
      output: failed ? null : clipText(result?.value, s.traceInputMax),
      error: failed ? clipText(result?.error?.message || result?.value || 'tool error', 2000) : null,
    });
  }
  return result;
}

/** Cordis apply：注册全局工具，并接管自动拉起的 sidecar 进程。 */
export function apply(ctx, config) {
  const s = resolveConfig(config);
  ctx.effect(() => {
    const disposers = buildTools(s).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* ignore */ } }
      const spawned = s.spawned;
      if (spawned?.child && spawned.child.exitCode === null) {
        try { spawned.child.kill(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-team.tools()');
  if (s.reportToolCalls) {
    ctx.on('tools/execute', (exec, next) => traceToolCall(s, exec, next));
  }
}

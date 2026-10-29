// @local/dsh-team-plugin — 把本地 dsh-team sidecar 暴露为模型可调用工具。
//
// 设计约束（来自本仓 docs/CONTRACT.md 与 PRD）：
// - 本插件只做「适配 + 生命周期」，编排/权限/事件流全部在 sidecar 进程内，不在这里重写。
// - 零第三方 import：只用 Node 内置模块，避免 profile 依赖解析问题；
//   工具用普通 ToolDefinition 对象注册（JSON Schema 参数），不依赖 defineTool。
// - sidecar 未运行时，autoStart=true 会在首次工具调用时拉起 `dsh-team up`；
//   插件卸载时只回收「自己拉起」的进程，不影响用户手工起的服务。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
    // agent 运行时：成员在 sidecar 认领任务后，由本插件用 subagents.sendMessage 派发
    agentAutoDispatch: c.agentAutoDispatch !== false,
    agentDispatchMs: Number(c.agentDispatchMs) || 1500,
    agentDispatchMax: Number(c.agentDispatchMax) || 16,
    // sidecar 建任务后留 200ms 的「声明依赖」窗口，派发前先等过这段时间
    agentSettleMs: Number(c.agentSettleMs) || 250,
    // spawnTeammate 的 provider：默认与 dsh-experimental-tool-agent-team 一致
    freshProvider: String(c.freshProvider || 'spawn'),
    forkProvider: String(c.forkProvider || 'fork'),
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

// ---------- agent 运行时：成员 = 真 DSH sub-agent ----------
//
// 分工：sidecar 仍是任务/DAG/事件/审批的唯一状态源；本插件负责 agent 生命周期
// （spawnTeammate / sendMessage / interrupt）和派发，因为只有 Host 进程能创建 DSH agent。
//
// 流程：
//   team_spawn（runtime=agent）→ spawnTeammate → POST /api/agents/register 绑定 session
//   team_task 建任务 → sidecar 置 ready → POST /api/agents/dispatch 原子认领（running）
//                    → sendMessage(lead → member) 把任务说明投进成员信箱
//   成员跑完 → team_report_task（精确摘要）/ agent/status=idle（兜底）→ 任务 done → evaluate 推进依赖
//            → 再跑一轮 dispatch，把新 ready 的任务投给 idle 成员

/** teamId → 最近一次调用 team_* 工具的 Lead Agent（发消息必须由 live Lead 发出）。 */
const leadByTeam = new Map();
/** teamId → 'worker' | 'agent'，建团/查团缓存，省掉每次多一次 GET。 */
const runtimeByTeam = new Map();
/** DSH sessionId → { teamId, memberId }：把成员的工具 span 归到成员节点下。 */
const sessionMember = new Map();
/** teamId → 正在派发（防定时器与工具调用重入）。 */
const dispatching = new Set();

/**
 * `subagents` 服务：成员就是它起出来的 continuable 子会话。
 * 只用 optional 访问（`ctx.get`），宿主没装 dsh-subagent 时给出可读的报错，而不是加载失败。
 */
const subagentsOf = (ctx) => { try { return ctx.get('subagents'); } catch { return undefined; } };
const subagentNames = (ctx) => { const svc = subagentsOf(ctx); return svc && typeof svc.list === 'function' ? svc.list() : []; };

/** 子会话 label：`name: description`，上限 200 字符。 */
const memberLabel = (name, description) => `${name}: ${description}`.slice(0, 200);

/** spawnTeammate 需要 provider 名：优先配置值，未注册时退回已注册的第一个可用 provider。 */
function providerFor(ctx, s, context) {
  const want = context === 'fork' ? s.forkProvider : s.freshProvider;
  const names = subagentNames(ctx);
  if (!names.length || names.includes(want)) return want;
  for (const alt of ['spawn', 'fork', 'default', 'continuable']) if (names.includes(alt)) return alt;
  return names[0];
}

// ---------- 模型路由：DSH ctx.llm 目录 → sidecar 映射 ----------
//
// 目录的唯一来源是 Host 的 ctx.llm；这里只把 provider/model 的映射、展示名和
// 模态同步给 sidecar。sidecar 保存用户勾选的子集与备注，team_spawn 只接受
// 启用项。本插件不代理 LLM 请求、不保存任何凭据。
const llmOf = (ctx) => { try { return ctx.get('llm'); } catch { return undefined; } };

let llmSyncAt = 0;
let llmSyncInFlight = null;

/** 同步一次模型目录（30s 节流；force 用于 team_models / 适配器变更后）。 */
async function syncLlmCatalog(s, ctx, { force = false } = {}) {
  const llm = llmOf(ctx);
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: false, reason: 'llm-unavailable' };
  }
  if (!force && llmSyncAt && Date.now() - llmSyncAt < 30000) return { ok: true, cached: true };
  if (llmSyncInFlight) return llmSyncInFlight;
  llmSyncInFlight = (async () => {
    const seen = new Set();
    const providers = [];
    for (const p of (llm.listProviders() || [])) {
      if (!p || !p.id || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      providers.push({ id: String(p.id), name: String(p.name || p.id), source: 'live' });
    }
    const models = [];
    let partial = false;
    for (const p of providers) {
      try {
        for (const m of await llm.listModels(p.id)) {
          if (!m || !m.id) continue;
          models.push({
            provider: p.id, model: String(m.id), name: m.name || String(m.id),
            description: m.description || null, modalities: m.inputModalities || null,
          });
        }
      } catch (e) {
        // 单个提供商读取失败：标记 partial，让 sidecar 保留该 provider 已有的勾选
        p.error = clip(String(e?.message || e), 300);
        partial = true;
      }
    }
    // 只上报真正能列出模型的 provider；没模型的（含未配置的 dormant）不进目录，
    // 面板与 team_models 就不会出现空分组。
    const withModels = providers.filter((p) => models.some((m) => m.provider === p.id));
    if (!withModels.length) return { ok: true, providers: 0, models: 0, empty: true };
    await request(s, '/api/llm/catalog', { method: 'POST', body: { providers: withModels, models, partial } });
    llmSyncAt = Date.now();
    return { ok: true, providers: withModels.length, models: models.length, partial };
  })().finally(() => { llmSyncInFlight = null; });
  return llmSyncInFlight;
}

/** Lead 当前 route：请求头优先，创建选项兜底（与 resolveChildAgentOptions 一致）。 */
function leadRouteOf(caller) {
  if (!caller) return { provider: null, model: null, reasoningEffort: null };
  let cfg;
  try { cfg = typeof caller.session?.requestHeader === 'function' ? caller.session.requestHeader()?.config : undefined; } catch { cfg = undefined; }
  if (cfg) return { provider: cfg.provider ?? null, model: cfg.model ?? null, reasoningEffort: cfg.reasoningEffort ?? null };
  const o = caller.options || {};
  return { provider: o.provider ?? null, model: o.model ?? null, reasoningEffort: o.reasoningEffort ?? null };
}

/** 指定 route 必须在用户启用的子集里；目录尚未同步（为空）时不限制，保持向后兼容。 */
async function assertRouteEnabled(s, ctx, provider, model) {
  if (!provider && !model) return;
  try { await syncLlmCatalog(s, ctx); } catch { return; }
  let cat;
  try { cat = await request(s, '/api/llm/catalog'); } catch { return; }
  const all = (cat.providers || []).flatMap((p) => p.models || []);
  if (!all.length) return;
  // 目录里查不到的 route（例如适配器临时提供、未在 listModels 中声明）不拦，避免误伤；
  // 能查到但被停用的，无论是显式指定还是继承 Lead，都拒绝。
  const known = all.filter((m) => (!provider || m.provider === provider) && (!model || m.model === model));
  if (!known.length) return;
  const enabled = all.filter((m) => m.enabled);
  if (!enabled.length) throw new Error('所有模型路由都已停用：请先在面板「模型路由」页启用，或调用 team_models 查看。');
  if (known.some((m) => m.enabled)) return;
  const sample = enabled.slice(0, 8).map((m) => `${m.provider}/${m.model}`).join(', ');
  throw new Error(`模型路由未启用：${[provider, model].filter(Boolean).join('/')}。可用（前 8 条）：${sample}。完整列表见 team_models，或在面板「模型路由」页启用。`);
}

function rememberMember(sessionId, teamId, memberId) {
  if (sessionId == null) return;
  sessionMember.set(String(sessionId), { teamId: String(teamId), memberId: String(memberId) });
}

async function runtimeOfTeam(s, teamId) {
  const cached = runtimeByTeam.get(teamId);
  if (cached) return cached;
  try {
    const team = await request(s, `/api/teams/${encodeURIComponent(teamId)}`);
    runtimeByTeam.set(teamId, team.runtime || 'worker');
    return team.runtime || 'worker';
  } catch { return 'worker'; }
}

const clip = (text, max) => {
  const v = String(text ?? '');
  return v.length > max ? v.slice(0, max) + '…' : v;
};

/** 成员收到的一条任务说明：必须包含 teamId / taskId 和「跑完怎么回报」。 */
function taskBrief(teamId, task, member) {
  const plan = (task.plan || []).map((p, i) => {
    const kind = p.op?.kind || p.action || p.phase || 'do';
    const target = p.target ? ` → ${p.target}` : '';
    const args = p.op?.args ? ` ${clip(JSON.stringify(p.op.args), 300)}` : '';
    return `${i + 1}. [${p.step || `S${i + 1}`}] ${kind}${target}${args}`;
  });
  const deps = (task.dependsOn || []).length ? `\n依赖（已完成）：${task.dependsOn.join(', ')}` : '';
  const scopes = (task.writeScopes || []).length ? `\n写域（写入请限制在这些前缀内）：${task.writeScopes.join(', ')}` : '';
  const acceptance = task.acceptance ? `\n验收标准：${task.acceptance}` : '';
  return [
    '【dsh-team 任务派发】',
    `teamId=${teamId}`,
    `memberId=${member.id}`,
    `memberName=${member.name}`,
    `taskId=${task.id}`,
    `subject：${task.subject}`,
    ...(plan.length ? ['计划步骤：', ...plan] : []),
    ...(deps ? [deps.trim()] : []),
    ...(scopes ? [scopes.trim()] : []),
    ...(acceptance ? [acceptance.trim()] : []),
    '',
    '执行要求：',
    '1) 直接在本会话里做这件事（用你自己的工具，不要委派给别的 agent）。',
    '2) 每开始或完成一步、以及验收通过后，调用 team_todo 更新该任务的计划清单（teamId/taskId 同上）。',
    '3) 完成或失败后必须调用 team_report_task，例如：',
    `   team_report_task({ teamId: "${teamId}", taskId: "${task.id}", status: "done", summary: "一句话结果 + 关键产物路径" })`,
    '4) 需要 Lead 决策或补充信息时用 team_send（teamId 同上，to: "lead"），不要自己猜测。',
  ].join('\n');
}

/** 把任务投递给成员：由 Lead 发一条消息进成员信箱（running 时在最近 step 边界送达）。 */
async function deliverTask(s, ctx, lead, teamId, task, member) {
  const subs = subagentsOf(ctx);
  if (!subs || typeof subs.sendMessage !== 'function') throw new Error('subagents 服务不可用，无法派发给 agent 成员');
  if (!member.agentSessionId) throw new Error(`成员 ${member.name} 还没有绑定 sub-agent 会话`);
  const content = [{ type: 'text', text: taskBrief(teamId, task, member) }];
  await subs.sendMessage(lead, String(member.agentSessionId), content, { signal: AbortSignal.timeout(s.requestTimeoutMs) });
}

/**
 * 泵一次派发：反复「认领 + 投递」直到没有 idle 成员或没有 ready 任务。
 * 调用者尽量是 Lead 自己的工具调用（此时 lead 一定 live）；兜底用缓存的 Lead。
 */
async function dispatchLoop(s, ctx, teamId) {
  const lead = leadByTeam.get(teamId);
  if (!lead) return { dispatched: [], reason: 'no_lead_agent' };
  if (dispatching.has(teamId)) return { dispatched: [], reason: 'busy' };
  dispatching.add(teamId);
  const dispatched = [];
  try {
    for (let i = 0; i < s.agentDispatchMax; i++) {
      let r;
      try {
        r = await request(s, '/api/agents/dispatch', { method: 'POST', body: { teamId } });
      } catch (err) {
        return { dispatched, error: String(err?.message || err) };
      }
      if (!r || !r.dispatched) {
        return { dispatched, ...(r && r.reason ? { reason: r.reason } : {}) };
      }
      const { task, member } = r;
      try {
        await deliverTask(s, ctx, lead, teamId, task, member);
      } catch (err) {
        // 投递失败：把任务交回 sidecar（走失败重试），不要把任务挂死在 running
        await request(s, '/api/agents/report', {
          method: 'POST',
          body: { sessionId: member.agentSessionId, status: 'failed', summary: `派发失败：${String(err?.message || err)}` },
        }).catch(() => { /* ignore */ });
        return { dispatched, error: `sendMessage failed: ${String(err?.message || err)}` };
      }
      if (member.agentSessionId) rememberMember(member.agentSessionId, teamId, member.id);
      dispatched.push({ taskId: task.id, task: task.subject, member: member.name });
    }
    return { dispatched, reason: 'max_rounds' };
  } finally {
    dispatching.delete(teamId);
  }
}

/** agent/status 回写 sidecar：idle 时兜底收尾在途任务，running 时置 running。 */
function reportAgentStatus(s, sessionId, status, detail) {
  if (!sessionId) return;
  const body = JSON.stringify({ sessionId: String(sessionId), status, ...(detail ? { detail: clip(detail, 500) } : {}) });
  void fetch(s.baseUrl + '/api/agents/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
    body,
    signal: AbortSignal.timeout(1500),
  }).catch(() => { /* ignore */ });
}

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
function buildTools(s, ctx) {
  const tools = [];

  tools.push({
    name: 'team_create',
    description: 'START HERE to build a working team of agents. Order: team_create({name, workspace, runtime:"agent"}) → team_models() to see the enabled provider/model routes → team_spawn({teamId, name, prompt, agentProvider?, model?, reasoningEffort?}) once per member, choosing a cheap/fast route for mechanical work and a strong-reasoning route for architecture, debugging, or review → team_task({teamId, subject, assignee?, acceptance}) per DAG node → each member finishes by calling team_report_task → inspect with team_status / team_report. `runtime` is the one field that changes what a member IS: `agent` spawns real DSH sub-agent sessions (own model, tools, context) that you talk to and that report back; `worker` (default) creates inert plan-step slots that only run proxied fs/exec/net/env ops from a task `plan` and cannot think. If the user says "create an agent team", pass runtime:"agent". A team owns members, a task DAG, and the four-domain (fs/exec/net/env) permission policy. `workspace` is an absolute directory shared by the members (worker members may only touch it through the sidecar broker; agent members get it as their cwd). Keep teamId from this response (result.team.id): every later call needs it. For the full recipe with per-field pitfalls, load the skill "dsh-agent-team".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Team name.' },
        workspace: { type: 'string', description: 'Absolute directory shared by workers; created if missing.' },
        runtime: { type: 'string', enum: ['worker', 'agent'], description: "Member runtime. `agent` spawns real DSH sub-agent members (real models, real tool calls). Default worker." },
        maxMembers: { type: 'integer', description: 'Member cap, 0 means unlimited. Default 64. Extra members are queued, never errors.' },
        maxConcurrency: { type: 'integer', description: 'Max simultaneously running tasks. Default 8.' },
        failurePolicy: { type: 'string', enum: ['continue', 'abort'], description: 'Team-level default failure policy.' },
        maxAttempts: { type: 'integer', description: 'Per-task retry cap. Default 3.' },
      },
      required: ['name', 'workspace'],
    },
    output: jsonOutput('{ team, panel }'),
    async execute(args, exec) {
      const team = await request(s, '/api/teams', {
        method: 'POST',
        body: {
          name: args.name,
          workspace: args.workspace,
          ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
          ...(args.maxMembers !== undefined ? { maxMembers: args.maxMembers } : {}),
          ...(args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {}),
          ...(args.failurePolicy !== undefined ? { failurePolicy: args.failurePolicy } : {}),
          ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
        },
      });
      runtimeByTeam.set(team.id, team.runtime || 'worker');
      if (exec?.agent) leadByTeam.set(team.id, exec.agent);
      return { team, panel: panelUrl(s) };
    },
  });

  tools.push({
    name: 'team_spawn',
    description: "Add one member to a team; returns the member `id` you use as team_task's `assignee`. On a `worker` team this is a sandboxed Node slot that executes plan steps through the sidecar permission broker. On an `agent` team this SPAWNS A REAL DSH SUB-AGENT session (`subagents.startActivation`, continuable child) that owns its own model, context, tools and message inbox; `prompt` is required there and becomes the member's first instruction — the member cannot see your conversation, so state the team id, its job, the workspace, and end with: finish by calling team_report_task({teamId, taskId, status, summary}). Over the member cap the member becomes `queued` instead of failing. Members are reusable: they run one task at a time and return to `idle`. Model routing (agent teams): call team_models first, then pass `agentProvider` + `model` to fit the task — a cheap/fast route for mechanical edits and lookups, a strong-reasoning route for architecture, debugging, or review. Pass `reasoningEffort` when the model exposes one; omitting it inherits the Lead's effort only while the route stays the same, otherwise the model's default applies. Omit agentProvider/model to inherit the Lead's route.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string', description: 'Team id from team_create.' },
        name: { type: 'string', description: 'Unique member name inside the team; this is the addressable target.' },
        role: { type: 'string', description: 'Role label, also usable as a policy subject (subjectType=role).' },
        agentProvider: { type: 'string', description: 'LLM provider route id for an agent member, as returned by team_models. Omit to inherit the Lead\'s provider. Must be an enabled route in the team panel.' },
        model: { type: 'string', description: 'LLM model id for an agent member, as returned by team_models. On worker teams it is only a display label. Changing the route clears inherited reasoning effort unless reasoningEffort is set explicitly.' },
        reasoningEffort: { type: 'string', description: 'Adapter-defined reasoning effort id for an agent member (for example low / medium / high, when the model supports them). Omit to inherit the Lead\'s effort while the route is unchanged; a changed route falls back to the model default.' },
        contextMode: { type: 'string', enum: ['isolated', 'fresh', 'fork'], description: 'Context isolation: `fresh` starts with no Lead history, `fork` inherits completed Lead turns (agent teams only). Default isolated/fresh.' },
        prompt: { type: 'string', description: 'agent teams only (required there): the member’s first instruction. Tell it its role, workspace, and that it must call team_report_task when done.' },
        description: { type: 'string', description: 'agent teams only: one-line description of what this member is responsible for.' },
      },
      required: ['teamId', 'name'],
    },
    output: jsonOutput('{ member, agent?, panel }'),
    async execute(args, exec) {
      const runtime = await runtimeOfTeam(s, args.teamId);
      if (runtime !== 'agent') {
        const member = await request(s, `/api/teams/${encodeURIComponent(args.teamId)}/members`, {
          method: 'POST',
          body: {
            name: args.name,
            ...(args.role !== undefined ? { role: args.role } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.contextMode !== undefined ? { contextMode: args.contextMode } : {}),
          },
        });
        return { member, panel: panelUrl(s) };
      }

      // ---- agent 团队：用 subagents 服务起一个 continuable 真子会话 ----
      const subs = subagentsOf(ctx);
      if (!subs || typeof subs.startActivation !== 'function') {
        throw new Error('subagents 服务不可用：无法在 agent 团队里创建 sub-agent 成员（需要宿主启用 dsh-subagent）。');
      }
      const caller = exec?.agent;
      if (!caller) throw new Error('team_spawn (agent) 需要 Lead 会话上下文（exec.agent 缺失：不能在非 agent 调用里起成员）。');
      if (!args.prompt) throw new Error('agent 团队的 team_spawn 需要 prompt（成员的初始指令）。');

      const context = args.contextMode === 'fork' ? 'fork' : 'fresh';
      const provider = providerFor(ctx, s, context);
      // 实际 route：显式参数覆盖 Lead；effort 只在 route 未变时继承（与 DSH 子会话合并规则一致）
      const leadRoute = leadRouteOf(caller);
      const route = { provider: args.agentProvider || leadRoute.provider, model: args.model || leadRoute.model };
      const routeChanged = route.provider !== leadRoute.provider || route.model !== leadRoute.model;
      route.reasoningEffort = args.reasoningEffort || (routeChanged ? null : leadRoute.reasoningEffort);
      // 继承 Lead 的 route 也要过启用闸门：停用项不该被成员继续使用。
      await assertRouteEnabled(s, ctx, route.provider, route.model);
      const agentOptions = {};
      if (args.agentProvider) agentOptions.provider = String(args.agentProvider);
      if (args.model) agentOptions.model = String(args.model);
      if (args.reasoningEffort) agentOptions.reasoningEffort = String(args.reasoningEffort);
      const memberName = String(args.name).trim();
      const description = String(args.description || args.role || memberName).slice(0, 200);
      const sessionId = randomUUID();
      const team = await request(s, `/api/teams/${encodeURIComponent(args.teamId)}`).catch(() => null);
      const started = await subs.startActivation({
        delivery: 'parent',
        childId: sessionId,
        provider,
        label: memberLabel(memberName, description),
        request: {
          prompt: [{ type: 'text', text: String(args.prompt) }],
          parent: caller,
          ...(team && team.workspace ? { cwd: team.workspace } : {}),
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        },
        signal: exec.signal || AbortSignal.timeout(s.requestTimeoutMs),
      });
      // 成员跑的是一整轮 agent loop，结果由 team_report_task 汇报；这里只防止未处理的 rejection。
      if (started && started.result && typeof started.result.catch === 'function') started.result.catch(() => {});
      const spawned = { member: { id: sessionId, name: memberName, role: 'teammate', status: 'running', model: route.model || null, diagnostics: [] } };

      const registered = await request(s, '/api/agents/register', {
        method: 'POST',
        body: {
          teamId: args.teamId,
          name: memberName,
          sessionId,
          role: args.role || 'teammate',
          model: args.model || spawned.member.model || null,
          contextMode: context,
        },
      });
      rememberMember(sessionId, args.teamId, registered.member.id);
      leadByTeam.set(args.teamId, caller);
      return {
        member: registered.member,
        agent: {
          sessionId,
          name: spawned.member.name,
          status: spawned.member.status,
          role: spawned.member.role,
          provider,
          context,
          model: route.model || null,
          route,
          diagnostics: spawned.member.diagnostics || [],
        },
        panel: panelUrl(s),
      };
    },
  });

  tools.push({
    name: 'team_models',
    description: 'List the model routes enabled for this team: provider id, model id, display name, note, and modalities. Use it before team_spawn when a task should run on a different model or reasoning effort than the Lead — a cheap/fast route for mechanical work, a strong-reasoning route for architecture, debugging, or review. Only the user-enabled subset is listed; the panel curates it. Pass a listed pair to team_spawn({ agentProvider, model, reasoningEffort }).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { type: 'boolean', description: 'Re-read the host model catalog before listing. Default true.' },
      },
    },
    output: jsonOutput('{ asOf, total, models: [{ provider, model, name, description, note, modalities }], hint? }'),
    isConcurrencySafe: () => true,
    async execute(args) {
      const sync = await syncLlmCatalog(s, ctx, { force: args.refresh !== false })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      let cat = null;
      try { cat = await request(s, '/api/llm/catalog'); } catch { /* catalog unavailable */ }
      const all = cat ? (cat.providers || []).flatMap((p) => p.models || []) : [];
      const models = all.filter((m) => m.enabled).map((m) => ({
        provider: m.provider,
        model: m.model,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
        ...(m.note ? { note: m.note } : {}),
        ...(m.modalities ? { modalities: m.modalities } : {}),
      }));
      const hint = models.length
        ? '在 team_spawn 里用 agentProvider + model；reasoningEffort 由模型适配器定义，省略时只在 route 不变时继承 Lead 的 effort。'
        : '没有启用的模型路由：请让用户在面板「模型路由」页勾选需要的 provider/model。';
      return {
        asOf: cat?.asOf || new Date().toISOString(),
        total: models.length,
        models,
        hint,
        ...(sync.ok === false ? { catalogError: sync.error || sync.reason } : {}),
      };
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
        runtime: st.runtime || runtimeByTeam.get(args.teamId) || 'worker',
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
          agentSessionId: m.agentSessionId || null,
          agentStatus: m.agentStatus || null,
        })),
        staleMembers: st.staleMembers,
        degraded: st.degraded,
      };
    },
  });

  tools.push({
    name: 'team_task',
    description: 'Declare one task (DAG node) and hand it to a member. Two runtimes: on a `worker` team each plan step is one proxied action executed through the sidecar broker (the worker process has no direct IO, so a denied step fails hard); on an `agent` team the plan is a BRIEF sent to the member’s own sub-agent session, which does the work with its own tools and calls team_report_task when finished — write the brief self-contained (the member does not see this conversation). `assignee` takes a member **id** from team_spawn, not its name; omit it to let the scheduler pick an idle member. The scheduler satisfies dependencies itself — never poll. Creating a task on an agent team dispatches it immediately to an idle member when dependencies are already satisfied.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        subject: { type: 'string', description: 'Concise task title.' },
        assignee: { type: 'string', description: 'Member id (not name). Omit to let the scheduler pick an idle member.' },
        plan: { type: 'array', items: PLAN_STEP, description: 'Ordered steps. Worker teams: proxied actions. Agent teams: the task brief (usually omit and describe the work in `subject` + `acceptance`). May be empty for a pure heartbeat task.' },
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
        dispatch: { type: 'boolean', description: 'Agent teams only: dispatch immediately after creating (default true). Pass false to build the DAG first and dispatch later with team_dispatch.' },
      },
      required: ['teamId', 'subject', 'plan'],
    },
    output: jsonOutput('{ task, dispatched? }'),
    async execute(args, exec) {
      if (exec?.agent) leadByTeam.set(args.teamId, exec.agent);
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
      if (args.dispatch === false || (await runtimeOfTeam(s, args.teamId)) !== 'agent') return { task };
      await sleep(s.agentSettleMs);
      const dispatched = await dispatchLoop(s, ctx, args.teamId);
      return { task, dispatched };
    },
  });

  tools.push({
    name: 'team_send',
    description: "Send a message that a member will actually read. On `agent` teams the text is injected into the target sub-agent's message inbox (a running member sees it at its next step boundary, an idle member is woken); on `worker` teams it is queued on the sidecar and surfaced at the worker's next step boundary. `to` is a member NAME on agent teams (member id also accepted) or '*' to broadcast. Every send is also recorded on the sidecar so the panel shows the conversation.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        to: { type: 'string', description: "Member name (agent teams) or member id, or '*' for broadcast." },
        message: { type: 'string', description: 'Message body.' },
        correlationId: { type: 'string', description: 'Optional correlation id to pair a request with its response.' },
      },
      required: ['teamId', 'to', 'message'],
    },
    output: jsonOutput('{ message, messages?, delivered? }'),
    async execute(args, exec) {
      if (exec?.agent) leadByTeam.set(args.teamId, exec.agent);
      const recorded = await request(s, '/api/messages', {
        method: 'POST',
        body: {
          teamId: args.teamId,
          from: 'lead',
          to: args.to,
          payload: { text: args.message },
          ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
        },
      });
      if ((await runtimeOfTeam(s, args.teamId)) !== 'agent') return recorded;

      const subs = subagentsOf(ctx);
      const caller = exec?.agent;
      if (!subs || typeof subs.sendMessage !== 'function' || !caller) return { ...recorded, delivered: false };
      const content = [{ type: 'text', text: String(args.message) }];
      const st = await request(s, `/api/status${qs({ team: args.teamId })}`);
      const live = (st.members || []).filter((m) => m.agentSessionId);
      const targets = args.to === '*' ? live : live.filter((m) => m.name === args.to);
      const delivered = [];
      const failed = [];
      if (!targets.length) failed.push({ target: args.to, error: '该成员没有绑定 sub-agent 会话（可能还没 spawn 或已回收）' });
      for (const target of targets) {
        try {
          await subs.sendMessage(caller, String(target.agentSessionId), content, { signal: AbortSignal.timeout(s.requestTimeoutMs) });
          delivered.push(target.name);
        } catch (err) {
          failed.push({ target: target.name, error: String(err?.message || err) });
        }
      }
      return { ...recorded, delivered, ...(failed.length ? { failed } : {}) };
    },
  });

  tools.push({
    name: 'team_todo',
    description: '设置或更新一个任务的执行计划清单（todo）。与内置 todo_write 不同：这份清单落盘在 sidecar，面板主页 Plan 区域实时渲染，Lead 与成员都能看到（内置 todo 只属于当前会话）。语义是整体替换——每次提交完整清单（最多 50 条），用 status 标注进度：open（未开始）/ active（进行中）/ done（已完成）/ blocked（被阻塞）。Lead 在派发前/后用它给任务补计划；成员每开始或完成一步、以及通过验收后调用它更新状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        taskId: { type: 'string', description: 'Task id whose checklist you are setting.' },
        items: {
          type: 'array',
          maxItems: 50,
          description: 'Complete ordered checklist (replace-all).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: 'One-line step, imperative.' },
              status: { type: 'string', enum: ['open', 'active', 'done', 'blocked'], description: 'Default open.' },
              blockedBy: { type: 'array', items: { type: 'string' }, description: 'Optional reasons / ids this step waits on.' },
            },
            required: ['title'],
          },
        },
        by: { type: 'string', description: 'Who updates it (Lead or memberId). Defaults to the calling session, else "lead".' },
      },
      required: ['teamId', 'taskId', 'items'],
    },
    output: jsonOutput('{ taskId, items }'),
    async execute(args, exec) {
      if (!Array.isArray(args.items)) throw new Error('items must be an array');
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      const binding = sessionId ? sessionMember.get(sessionId) : null;
      const by = args.by || binding?.memberId || 'lead';
      return await request(s, `/api/tasks/${encodeURIComponent(args.taskId)}/todos`, { method: 'POST', body: { items: args.items, by } });
    },
  });

  tools.push({
    name: 'team_report_task',
    description: 'Report the outcome of ONE task you were dispatched (agent members: call this as the last thing you do). It marks the task done/failed/blocked on the sidecar, releases the member back to idle, advances the DAG (dependents become ready and are dispatched), and applies the team failure policy. `summary` is what the Lead and the panel will see — put the result, key file paths and any blocker in it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['done', 'failed', 'blocked'], description: 'done = acceptance met; failed = attempted and broken; blocked = cannot proceed without a decision.' },
        summary: { type: 'string', description: 'One-line result plus the artifacts (paths) and anything the Lead must know.' },
      },
      required: ['teamId', 'taskId', 'status', 'summary'],
    },
    output: jsonOutput('{ task, member, dispatched? }'),
    async execute(args, exec) {
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      const body = {
        sessionId,
        teamId: args.teamId,
        taskId: args.taskId,
        status: args.status,
        summary: args.summary,
      };
      const res = await request(s, '/api/agents/report', { method: 'POST', body });
      if (exec?.agent) leadByTeam.set(args.teamId, exec.agent);
      const dispatched = await dispatchLoop(s, ctx, args.teamId).catch(() => null);
      return { ...res, ...(dispatched ? { dispatched } : {}) };
    },
  });

  tools.push({
    name: 'team_dispatch',
    description: 'Pump the agent-team dispatcher once: claim ready tasks for idle members and send each member its brief. Normally unnecessary — team_task dispatches automatically and team_report_task dispatches the next wave — but useful after team_control/resume, after approving a scope request, or when a member went idle without reporting. Safe to call repeatedly; it returns when no idle member or no ready task is left.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { teamId: { type: 'string' } },
      required: ['teamId'],
    },
    output: jsonOutput('{ dispatched, reason? }'),
    async execute(args, exec) {
      if (exec?.agent) leadByTeam.set(args.teamId, exec.agent);
      return await dispatchLoop(s, ctx, args.teamId);
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
    description: 'Control one member. On `agent` teams interrupt aborts the sub-agent’s current turn (`subagents.interrupt`) and marks the member interrupted on the sidecar; resume re-arms it and dispatches the task again. On `worker` teams interrupt writes status synchronously (no zombie `running`) and keeps the task resumable. assign hands a ready task to an idle member on either runtime.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['interrupt', 'resume', 'assign'] },
        teamId: { type: 'string', description: 'Required to control an agent-team member.' },
        memberId: { type: 'string' },
        taskId: { type: 'string', description: 'Required for assign.' },
        reason: { type: 'string', description: 'For interrupt.' },
      },
      required: ['action', 'memberId'],
    },
    output: jsonOutput('{ member, ... }'),
    async execute(args, exec) {
      const id = encodeURIComponent(args.memberId);
      if (args.action === 'interrupt') {
        const res = await request(s, `/api/members/${id}/interrupt`, { method: 'POST', body: { reason: args.reason || 'lead interrupt' } });
        const runtime = args.teamId ? await runtimeOfTeam(s, args.teamId) : 'worker';
        if (runtime === 'agent' && res?.member?.agentSessionId) {
          const subs = subagentsOf(ctx);
          const caller = exec?.agent;
          if (subs && caller && typeof subs.interrupt === 'function') {
            const interrupted = await Promise.resolve()
              .then(() => subs.interrupt(String(res.member.agentSessionId), { kind: 'ancestor', agent: caller }))
              .then(() => ({ ok: true, previousStatus: res.member.agentStatus ?? null }),
                (err) => ({ ok: false, error: String(err?.message || err) }));
            return { ...res, agent: interrupted };
          }
        }
        return res;
      }
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
  const member = sessionId ? sessionMember.get(sessionId) : null;
  const teamId = (args.teamId && String(args.teamId)) || member?.teamId || (sessionId && teamBySession.get(sessionId)) || null;
  const memberId = member?.memberId || null;
  if (teamId) {
    postSpan(s, {
      teamId, sessionId, spanId, name, kind: 'tool', status: 'running', startMs,
      ...(memberId ? { memberId } : {}),
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
      ...(memberId ? { memberId } : {}),
      output: failed ? null : clipText(result?.value, s.traceInputMax),
      error: failed ? clipText(result?.error?.message || result?.value || 'tool error', 2000) : null,
    });
  }
  return result;
}

/** Cordis apply：注册全局工具，接管自动拉起的 sidecar，并把 agent 生命周期桥接到 sidecar。 */
export function apply(ctx, config) {
  const s = resolveConfig(config);
  ctx.effect(() => {
    const disposers = buildTools(s, ctx).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* ignore */ } }
      leadByTeam.clear(); runtimeByTeam.clear(); sessionMember.clear(); dispatching.clear(); teamBySession.clear();
      const spawned = s.spawned;
      if (spawned?.child && spawned.child.exitCode === null) {
        try { spawned.child.kill(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-team.tools()');

  if (s.reportToolCalls) {
    ctx.on('tools/execute', (exec, next) => traceToolCall(s, exec, next));
  }

  // 模型目录变化（provider 配置/适配器注册变化）→ 下次工具调用重新同步
  ctx.on('llm/adapters-updated', () => { llmSyncAt = 0; });

  // 成员 sub-agent 的 running/idle 回写 sidecar：面板实时、idle 兜底收尾在途任务。
  ctx.on('agent/status', ({ agent, status } = {}) => {
    const sessionId = agent?.id != null ? String(agent.id) : null;
    if (!sessionId) return;
    const binding = sessionMember.get(sessionId);
    if (!binding) return;
    reportAgentStatus(s, sessionId, status === 'idle' ? 'idle' : status);
    if (status === 'idle' && s.agentAutoDispatch) {
      void dispatchLoop(s, ctx, binding.teamId).catch(() => { /* ignore */ });
    }
  });

  // 保底泵：负责 lead 不在工具调用栈里时（例如成员直接回报）把 ready 任务继续发出去。
  if (s.agentAutoDispatch) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const teamId of leadByTeam.keys()) {
          void dispatchLoop(s, ctx, teamId).catch(() => { /* ignore */ });
        }
      }, Math.max(500, s.agentDispatchMs));
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'dsh-team.agent-pump()');
  }
}

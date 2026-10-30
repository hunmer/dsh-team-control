// dsh-team-control — 把本地 dsh-team sidecar 暴露为模型可调用工具。
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
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_TOOLS, changeKind, countDiff, displayPath, readTextSafe, targetFile, unifiedDiff } from './changes.js';
import { priceUsage } from './pricing.js';

/** Cordis plugin name. */
export const name = 'dsh-team';
/** Services required by this plugin. */
export const inject = ['tools'];

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ENTRY = path.resolve(PKG_DIR, '..', 'bin', 'dsh-team.mjs');
/** 本地克隆时入口在同级 `bin/`；npm 安装时从依赖 `dsh-team-control-cli` 里解析。 */
function resolveDefaultEntry() {
  if (fs.existsSync(LOCAL_ENTRY)) return LOCAL_ENTRY;
  try {
    return createRequire(import.meta.url).resolve('dsh-team-control-cli/bin/dsh-team.mjs');
  } catch {
    return LOCAL_ENTRY;
  }
}
const DEFAULT_ENTRY = resolveDefaultEntry();
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
    // 把成员 write/edit 的改动作为 unified diff 上报到 sidecar（面板「审阅」页只读展示）
    reportChanges: c.reportChanges !== false,
    // 把每次 LLM 调用的 token 用量与折算金额作为 span 上报（瀑布里的 ¥/$ 金额来源）
    reportLlmCalls: c.reportLlmCalls !== false,
    // 覆盖/扩展单价表（键为 provider id，结构见 pricing.js 的 DEFAULT_PRICE_TABLES）
    pricingTables: c.pricingTables && typeof c.pricingTables === 'object' ? c.pricingTables : null,
    traceInputMax: Number(c.traceInputMax) || 1200,
    // 把成员的上下文占用（system/tools/文件/结果/对话）上报到 sidecar（面板「上下文分析」页）
    reportContext: c.reportContext !== false,
    contextReportMs: Number(c.contextReportMs) || 6000,
    // 把 DSH 工作区注册表同步到 sidecar（面板左侧「工作区」下拉）
    reportWorkspaces: c.reportWorkspaces !== false,
    workspaceReportMs: Number(c.workspaceReportMs) || 8000,
    // 模型目录（provider/model 清单）：插件启动即同步，之后定时刷新，不再依赖 lead 调工具
    reportLlmCatalog: c.reportLlmCatalog !== false,
    llmCatalogMs: Number(c.llmCatalogMs) || 60000,
    // agent 运行时：成员在 sidecar 认领任务后，由本插件用 subagents.sendMessage 派发
    agentAutoDispatch: c.agentAutoDispatch !== false,
    agentDispatchMs: Number(c.agentDispatchMs) || 1500,
    agentDispatchMax: Number(c.agentDispatchMax) || 16,
    // sidecar 建任务后留 200ms 的「声明依赖」窗口，派发前先等过这段时间
    agentSettleMs: Number(c.agentSettleMs) || 250,
    // 成员 idle 的落库稳定窗口：DSH 在维护阶段（上下文压缩等）也会报 idle，立刻落库会把在途任务误判完成
    agentIdleSettleMs: c.agentIdleSettleMs == null ? 12000 : Math.max(0, Number(c.agentIdleSettleMs) || 0),
    // 成员状态心跳：本地认为在跑、sidecar 却回落到 idle 时补报 running（任务仍在跑说明回合没结束）
    agentHeartbeatMs: Number(c.agentHeartbeatMs) || 15000,
    // 任务投递后成员会话迟迟没有任何事件（模型路由报错、会话没启动）就判定失败并交回 sidecar 重试
    agentStartTimeoutMs: Number(c.agentStartTimeoutMs) || 120000,
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
/** DSH sessionId → 上次采集产物时的会话 seq：成员复用同一会话时只上报新产生的文件。 */
const lastArtifactSeq = new Map();
/** teamId → 正在派发（防定时器与工具调用重入）。 */
const dispatching = new Set();

/**
 * `subagents` 服务：成员就是它起出来的 continuable 子会话。
 * 只用 optional 访问（`ctx.get`），宿主没装 dsh-subagent 时给出可读的报错，而不是加载失败。
 */
/** 调用者对应的成员绑定；返回 null 说明调用者是 Lead。成员调用不得覆盖 Lead 句柄。 */
const memberOfCaller = (agent) => {
  const sid = agent?.sessionId ?? agent?.id ?? null;
  return sid != null ? (sessionMember.get(String(sid)) || null) : null;
};
const subagentsOf = (ctx) => { try { return ctx.get('subagents'); } catch { return undefined; } };
const subagentNames = (ctx) => { const svc = subagentsOf(ctx); return svc && typeof svc.list === 'function' ? svc.list() : []; };

/** `sessions` / `workspaceChanges`：读成员自己会话里的交付文件（都是可选依赖）。 */
const sessionsOf = (ctx) => { try { return ctx.get('sessions'); } catch { return undefined; } };
const workspaceChangesOf = (ctx) => { try { return ctx.get('workspaceChanges'); } catch { return undefined; } };

/**
 * 从成员会话采集产物：
 * 1) `present` 工具声明过的交付文件（带 description，最接近用户在 DSH 里看到的文件卡片）；
 * 2) 会话里 `workspace/changes` 事件记录的改动文件（Host 保存 summary，按 seq 取）。
 * 采集失败一律返回空数组——产物只是锦上添花，不能影响任务汇报。
 */
function collectArtifacts(ctx, sessionId) {
  const sessions = sessionsOf(ctx);
  const session = sessions && typeof sessions.get === 'function' && sessionId ? sessions.get(String(sessionId)) : undefined;
  if (!session) return [];
  let events = [];
  try { events = session.snapshotEvents(); } catch { return []; }
  // 成员复用同一会话跑多个任务：只看上次上报之后的事件，避免把旧产物重复挂到新任务上。
  const key = String(sessionId);
  const since = lastArtifactSeq.get(key) ?? 0;
  const files = new Map();
  const counts = new Map();
  /** 写文件时按行统计（present 只声明文件，不提供行数；workspace 摘要也不一定可用）。 */
  const bump = (p, add, del) => {
    const prev = counts.get(p) || { added: 0, deleted: 0, display: '' };
    counts.set(p, { added: prev.added + add, deleted: prev.deleted + del, display: prev.display });
  };
  const lineCount = (text) => (typeof text === 'string' && text.length ? text.split('\n').length : 0);
  const changes = workspaceChangesOf(ctx);
  for (const ev of events) {
    if (!ev || !ev.type) continue;
    if (Number(ev.seq) <= since) continue;
    if (ev.type === 'tool/call') {
      if (!ev.data) continue;
      const tool = ev.data.name;
      let parsed;
      try { parsed = JSON.parse(ev.data.arguments || '{}'); } catch { parsed = null; }
      if (tool === 'write' && parsed && typeof parsed.file_path === 'string') {
        bump(parsed.file_path, lineCount(parsed.content), 0);
        continue;
      }
      if (tool === 'edit' && parsed && typeof parsed.file_path === 'string') {
        const add = lineCount(parsed.new_string) * (parsed.replace_all ? 1 : 1);
        const del = lineCount(parsed.old_string);
        bump(parsed.file_path, add, del);
        continue;
      }
      if (tool !== 'present') continue;
      for (const f of Array.isArray(parsed?.files) ? parsed.files : []) {
        if (!f || typeof f.path !== 'string' || !f.path.trim()) continue;
        const p = f.path.trim();
        files.set(p, { path: p, label: typeof f.description === 'string' ? f.description : '', source: 'present' });
      }
    } else if (ev.type === 'workspace/changes') {
      let summary;
      try { summary = changes && typeof changes.summary === 'function' ? changes.summary(session.id, ev.seq) : undefined; } catch { summary = undefined; }
      for (const f of Array.isArray(summary?.files) ? summary.files : []) {
        if (!f || typeof f.path !== 'string' || !f.path) continue;
        // 同一文件出现在多轮 summary 里：行数累加；已有工具调用统计时以工具调用为准（更贴近实际写入行数）。
        const prev = counts.get(f.path) || { added: 0, deleted: 0, display: '' };
        if (!prev.added && !prev.deleted) {
          counts.set(f.path, {
            added: prev.added + (Number(f.added) || 0),
            deleted: prev.deleted + (Number(f.deleted) || 0),
            display: typeof f.display === 'string' ? f.display : '',
          });
        }
        if (files.has(f.path)) continue;
        files.set(f.path, { path: f.path, label: '', source: 'workspace' });
      }
    }
  }
  try { lastArtifactSeq.set(key, Number(session.seq) || 0); } catch { /* ignore */ }
  const sameFile = (a, b) => a === b || String(a).endsWith(String(b)) || String(b).endsWith(String(a));
  const findCounts = (p) => {
    const direct = counts.get(p);
    if (direct) return direct;
    for (const [key, c] of counts) if (sameFile(key, p)) return c;
    return undefined;
  };
  const out = [];
  for (const item of files.values()) {
    const c = findCounts(item.path);
    out.push({
      ...item,
      label: item.label || (c && c.display) || '',
      ...(c ? { added: c.added, deleted: c.deleted } : {}),
    });
  }
  for (const [p, c] of counts) {
    let seen = files.has(p);
    if (!seen) for (const item of files.values()) if (sameFile(item.path, p)) { seen = true; break; }
    if (seen) continue;
    out.push({ path: p, label: c.display || '', source: 'workspace', added: c.added, deleted: c.deleted });
  }
  return out.slice(-12);
}

// ---------- 成员上下文分析 ----------
//
// 「上下文窗口被什么占满」的唯一事实来源是 DSH 会话：
//   tokenMeter.measure(session)      → 当前 surface 上每个事件的价格（seq → tokens）
//   sessionProjections.snapshot(...) → system / tools / messages 三段拆分 + contextWindow
//   session.snapshotEvents()         → 事件类型、工具名、压缩记录
// 这里把它们折叠成面板 ContextMap 需要的 blocks；Host 只算不存，算完 POST 给 sidecar。
const CONTEXT_FILE_TOOLS = new Set(['read', 'write', 'edit', 'present', 'glob', 'grep', 'ls', 'list', 'glob_files', 'search']);

/** 一段消息的可见文本（用于 tile 的 hover 明细）。 */
function contentText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  for (const part of parts) if (part && typeof part.text === 'string' && part.text.trim()) return part.text;
  return '';
}

/** 第一行、压掉空白，截断到 max。 */
function firstLine(text, max = 60) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 从成员会话折出上下文快照；拿不到会话/事件时返回 null（观测功能不能影响任务）。
 * 返回的结构与 sidecar POST /api/contexts 的 body 对齐（不含 teamId/memberId）。
 */
function collectContext(ctx, sessionId) {
  const sessions = sessionsOf(ctx);
  const session = sessions && typeof sessions.get === 'function' && sessionId ? sessions.get(String(sessionId)) : undefined;
  if (!session) return null;
  let events = [];
  try { events = session.snapshotEvents(); } catch { return null; }
  const tokenMeter = (() => { try { return ctx.get('tokenMeter'); } catch { return undefined; } })();
  const projections = (() => { try { return ctx.get('sessionProjections'); } catch { return undefined; } })();

  let measurement = null;
  try {
    if (tokenMeter && typeof tokenMeter.measure === 'function') measurement = tokenMeter.measure(session);
  } catch { measurement = null; }
  let projection = {};
  try {
    if (projections && typeof projections.snapshot === 'function') {
      projection = projections.snapshot(session, ['contextBreakdown', 'contextPressure'])?.values || {};
    }
  } catch { projection = {}; }
  const breakdown = projection.contextBreakdown || {};
  const pressure = projection.contextPressure || {};

  // 当前 surface 上的事件才计价：被压缩掉的事件不在 nodes 里。
  const priceBySeq = new Map();
  for (const node of Array.isArray(measurement?.nodes) ? measurement.nodes : []) {
    if (!node) continue;
    const tokens = Number(node.tokens) || Number(node.heuristicTokens) || 0;
    priceBySeq.set(Number(node.seq), tokens);
  }

  const callInfo = new Map(); // callId → { name, target }
  const groups = new Map(); // block id → block
  const push = (id, kind, label, tokens, itemLabel) => {
    let group = groups.get(id);
    if (!group) { group = { id, kind, label, tokens: 0, items: [] }; groups.set(id, group); }
    group.tokens += Math.max(0, Math.round(tokens || 0));
    if (itemLabel && group.items.length < 12) group.items.push({ label: itemLabel });
    return group;
  };

  let compaction = null;
  let surfaceCount = 0;
  for (const ev of events) {
    if (!ev || !ev.type) continue;
    const data = ev.data || {};
    if (ev.type === 'tool/call') {
      if (data.callId != null) {
        let parsed = null;
        try { parsed = JSON.parse(data.arguments || '{}'); } catch { parsed = null; }
        const target = typeof parsed?.file_path === 'string' ? parsed.file_path
          : typeof parsed?.path === 'string' ? parsed.path
            : typeof parsed?.pattern === 'string' ? parsed.pattern
              : typeof parsed?.command === 'string' ? parsed.command : '';
        callInfo.set(String(data.callId), { name: String(data.name || 'tool'), target: firstLine(target, 80) });
      }
      continue;
    }
    if (ev.type === 'compaction/summary' || ev.type === 'compaction/prune') {
      // 同一次压缩的 summary + prune 只记最后一次（面板只展示最近一次压缩的前后对比）
      compaction = { atSeq: Number(ev.seq) || null, shadowedTokens: Number(data.shadowedTokenCount) || null, summary: 'summary' };
      continue;
    }
    const seq = Number(ev.seq);
    if (!priceBySeq.has(seq)) continue;
    const tokens = priceBySeq.get(seq);
    surfaceCount += 1;
    if (ev.type === 'system/message') { push('system', 'system', 'System prompt', tokens); continue; }
    if (ev.type === 'developer/message') { push('memory', 'memory', 'Memory · 开发者指令', tokens, 'developer message'); continue; }
    if (ev.type === 'user/message') {
      if (ev.surfaceOp && ev.surfaceOp.op === 'replace') { push('summary', 'summary', 'Compaction summary', tokens, '压缩摘要'); continue; }
      push('chat', 'chat', 'Chat · 对话', tokens, firstLine(contentText(data.message)) || 'user message');
      continue;
    }
    if (ev.type === 'assistant/message') { push('chat', 'chat', 'Chat · 对话', tokens); continue; }
    if (ev.type === 'tool/result') {
      const info = callInfo.get(String(data.message?.toolCallId ?? ''));
      const name = info?.name || 'tool';
      const isFile = CONTEXT_FILE_TOOLS.has(name);
      push(`${isFile ? 'file' : 'result'}:${name}`, isFile ? 'file' : 'result', `${isFile ? 'File' : 'Tool result'} · ${name}`, tokens, info?.target || name);
    }
  }

  let route = {};
  try { route = (typeof session.requestHeader === 'function' ? session.requestHeader()?.config : null) || {}; } catch { route = {}; }

  const systemTokens = groups.get('system')?.tokens || Number(breakdown.systemTokens) || 0;
  const toolsTokens = Number(breakdown.toolsTokens) || 0;
  const blocks = [];
  if (systemTokens) blocks.push({ id: 'system', label: 'System prompt', kind: 'system', tokens: systemTokens, detail: '系统提示（每次请求固定随行）' });
  if (toolsTokens) blocks.push({ id: 'tools', label: 'Tools', kind: 'tools', tokens: toolsTokens, detail: '工具 schema（每次请求固定随行）' });
  for (const prefix of ['memory', 'file', 'result', 'chat', 'summary']) {
    for (const group of groups.values()) {
      if (!group.id.startsWith(prefix)) continue;
      const detail = group.items.length ? `${group.items.length} 条` : '已进入上下文';
      blocks.push({ id: group.id, label: group.label, kind: group.kind, tokens: group.tokens, detail, items: group.items });
    }
  }
  // 没有可计价节点（tokenMeter 缺席）时退回投影的三段拆分，至少让面板有数据。
  if (!blocks.length) {
    if (Number(breakdown.systemTokens)) blocks.push({ id: 'system', label: 'System prompt', kind: 'system', tokens: Number(breakdown.systemTokens) });
    if (Number(breakdown.toolsTokens)) blocks.push({ id: 'tools', label: 'Tools', kind: 'tools', tokens: Number(breakdown.toolsTokens) });
    if (Number(breakdown.messageTokens)) blocks.push({ id: 'chat', label: 'Chat · 对话', kind: 'chat', tokens: Number(breakdown.messageTokens) });
  }

  const priced = blocks.reduce((sum, b) => sum + (Number(b.tokens) || 0), 0);
  const used = Number(measurement?.totalTokens) || Number(pressure.pressureTokens) || priced;
  const limit = Number(pressure.contextWindow) || 0;
  return {
    model: route.model ? String(route.model) : null,
    provider: route.provider ? String(route.provider) : null,
    limit,
    used: Math.max(used, priced),
    breakdown: {
      system: systemTokens,
      tools: toolsTokens,
      messages: Number(breakdown.messageTokens) || Math.max(0, used - systemTokens - toolsTokens),
    },
    blocks,
    compaction,
    status: null,
    asOfSeq: Number(session.seq) || null,
    surfaceCount,
  };
}

/** 上次上报时间（按会话节流：period 泵与 agent/status 事件可能同时触发）。 */
const contextReportAt = new Map();

/** 工作区注册表快照：DSH 的 ctx.workspaceRegistry.list() → sidecar，面板左侧工作区下拉用。 */
function collectWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') return null;
  let list = [];
  try { list = registry.list() || []; } catch { return null; }
  return list.slice(0, 200).map((w, i) => ({
    id: String(w?.id ?? ''),
    title: String(w?.title ?? '').slice(0, 200),
    path: String(w?.path ?? ''),
    position: i,
  })).filter((w) => w.id);
}

/** 工作区列表上报：POST 到 sidecar；返回是否成功（失败时调用方会快速重试）。 */
async function reportWorkspaces(s, ctx) {
  const items = collectWorkspaces(ctx);
  if (!items) return false;
  try {
    const res = await fetch(s.baseUrl + '/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

/** 子会话 label：`name: description`，上限 200 字符。 */
const memberLabel = (name, description) => `${name}: ${description}`.slice(0, 200);

/** 上下文快照上报：后台 POST，失败即弃。 */
function reportContextSnapshot(s, ctx, sessionId, { status = null, force = false } = {}) {
  const key = String(sessionId);
  const binding = sessionMember.get(key);
  if (!binding) return;
  const nowMs = Date.now();
  if (!force && nowMs - (contextReportAt.get(key) || 0) < 2000) return;
  contextReportAt.set(key, nowMs);
  const snapshot = collectContext(ctx, key);
  if (!snapshot) return;
  const { surfaceCount, ...payload } = snapshot;
  void fetch(s.baseUrl + '/api/contexts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
    body: JSON.stringify({
      ...payload,
      teamId: binding.teamId,
      memberId: binding.memberId,
      sessionId: key,
      status: status || binding.status || null,
    }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => { /* ignore */ });
}

/** 子会话 label：`name: description`，上限 200 字符。 */

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

let llmSyncInFlight = null;

/** 同步一次模型目录（并发去重；由插件启动泵与 adapters-updated 事件驱动，不再由工具触发）。 */
async function syncLlmCatalog(s, ctx) {
  const llm = llmOf(ctx);
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: false, reason: 'llm-unavailable' };
  }
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

function rememberMember(sessionId, teamId, memberId, cwd) {
  if (sessionId == null) return;
  const key = String(sessionId);
  const prev = sessionMember.get(key);
  // 会话 cwd 只有 spawn 时知道（= team.workspace）；派发路径会重复登记同一个会话，
  // 这里不能把它冲成空，否则成员用相对路径写文件时 diff 找不到落盘位置。
  sessionMember.set(key, { teamId: String(teamId), memberId: String(memberId), cwd: cwd || prev?.cwd || '' });
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
  const brief = taskBrief(teamId, task, member);
  // 简报本身就是一条 Lead→成员的消息：先落信箱，面板【消息与回执】才有「提问 → 回复」可配对；
  // 记录失败不影响派发本身。
  let messageId = null;
  try {
    const recorded = await request(s, '/api/messages', {
      method: 'POST',
      body: { teamId, from: 'lead', to: member.id, kind: 'note', payload: { text: brief, taskId: task.id } },
    });
    messageId = recorded?.message?.id || null;
  } catch { messageId = null; }
  const content = [{ type: 'text', text: brief }];
  await subs.sendMessage(lead, String(member.agentSessionId), content, { signal: AbortSignal.timeout(s.requestTimeoutMs) });
  await markDelivered(s, messageId);
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
        return {
          dispatched,
          ...(r && r.reason ? { reason: r.reason } : {}),
          // sidecar 的附加诊断（建图窗口等）原样透传，别让 Lead 看到「no_ready_task」就以为依赖写错了
          ...(r && r.settled ? { settled: r.settled } : {}),
          ...(r && r.hint ? { hint: r.hint } : {}),
        };
      }
      const { task, member } = r;
      // 先记绑定再投递：成员第一轮 LLM 调用可能在 sendMessage 返回后就已开始
      if (member.agentSessionId) rememberMember(member.agentSessionId, teamId, member.id);
      // 任务已投递：先按「在跑」记账，agent/status 的 running 事件可能因为状态未变化而不发
      if (member.agentSessionId) agentStatusBySession.set(String(member.agentSessionId), 'running');
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
      dispatched.push({ taskId: task.id, task: task.subject, member: member.name });
      // 投递成功 ≠ 真的跑起来：开一个「有没有活动」的监视，模型路由挂了也能把任务交回去
      if (member.agentSessionId) armStartWatchdog(s, String(member.agentSessionId), teamId, task.id);
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

/** 成员会话最近一次上报给 sidecar 的状态（心跳据此判断有没有漏报）。 */
const agentStatusBySession = new Map();
/** sessionId → 待落库的 idle 上报定时器。 */
const idleTimers = new Map();
/** sessionId → 派发后「成员会话是否真的跑起来」的监视定时器。 */
const startTimers = new Map();

function cancelIdleReport(sessionId) {
  const timer = idleTimers.get(sessionId);
  if (timer) { clearTimeout(timer); idleTimers.delete(sessionId); }
}

/**
 * 派发监视：任务投进成员信箱后，成员会话必须在这段时间内产生**任意**事件（turn/start、工具调用…）。
 * 模型路由挂掉时（例如 provider 返回 failed before it finished），DSH 只会把状态回到 idle、
 * 上一轮在途任务永远停在 running，那个成员就被“挂着 running 任务的 assignee”规则永久排除。
 * 超时没有任何事件 → 报 failed，sidecar 按重试策略把任务交回 ready。
 */
function armStartWatchdog(s, sessionId, teamId, taskId) {
  cancelStartWatchdog(sessionId);
  const timeout = Number(s.agentStartTimeoutMs) || 0;
  if (!sessionId || timeout <= 0) return;
  const timer = setTimeout(() => {
    startTimers.delete(sessionId);
    if (agentStatusBySession.get(sessionId) !== 'running') return;      // 期间已经收工/失败过，不用管
    agentStatusBySession.set(sessionId, 'idle');
    reportAgentStatus(s, sessionId, 'failed',
      `成员会话在 ${Math.round(timeout / 1000)}s 内没有任何活动（模型路由失败或会话未启动），任务交回重试`);
  }, timeout);
  timer.unref?.();
  startTimers.set(sessionId, timer);
}

function cancelStartWatchdog(sessionId) {
  const timer = startTimers.get(sessionId);
  if (timer) { clearTimeout(timer); startTimers.delete(sessionId); }
}

/** 直接读 sidecar /status（不经 request：心跳/镜像不能顺手把 sidecar 拉起来）。 */
async function readStatus(s) {
  try {
    const res = await fetch(s.baseUrl + '/api/status', {
      headers: s.token ? { authorization: `Bearer ${s.token}` } : undefined,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** DSH 内置 todo 的状态 → sidecar 计划步骤的状态。 */
const TODO_TO_PLAN = { pending: 'open', in_progress: 'active', completed: 'done' };

/**
 * 成员没用 team_todo、而是用了内置 todo_write 时，把 DSH 的 `todos` 投影镜像成 sidecar 计划。
 * todo_write 每次整份替换，这里也整份替换（POST /api/tasks/<taskId>/todos），
 * 于是「todo 完成 → 计划步骤完成」自动同步，面板与团队校验都能看到成员的真实 plan。
 */
async function mirrorTodos(s, ctx, sessionId) {
  const sid = sessionId != null ? String(sessionId) : '';
  if (!sid || !sessionMember.has(sid)) return;
  const sessions = sessionsOf(ctx);
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sid) : undefined;
  if (!session) return;
  const projections = (() => { try { return ctx.get('sessionProjections'); } catch { return undefined; } })();
  let todos = null;
  try {
    if (projections && typeof projections.stateOf === 'function') todos = projections.stateOf(session, 'todos');
    else if (projections && typeof projections.snapshot === 'function') todos = projections.snapshot(session, ['todos'])?.values?.todos;
  } catch { todos = null; }
  if (!Array.isArray(todos) || todos.length === 0) return;
  const items = todos.slice(0, 50).map((todo) => ({
    title: clip(String(todo?.content || ''), 200),
    status: TODO_TO_PLAN[String(todo?.status || '')] || 'open',
  })).filter((item) => item.title);
  if (items.length === 0) return;
  const status = await readStatus(s);
  const member = ((status && status.members) || []).find((m) => m && String(m.agentSessionId || '') === sid);
  if (!member || !member.currentTaskId) return; // 还没有在途任务：等派发后下一次 todo_write/收工再镜像
  await request(s, `/api/tasks/${encodeURIComponent(member.currentTaskId)}/todos`, {
    method: 'POST',
    body: { items, by: member.id },
  }).catch(() => { /* 计划镜像失败不影响任务本身 */ });
}

/** 心跳：本地认为在跑、sidecar 却回落到 idle（且有在途任务）时补报 running。 */
async function heartbeatAgentStatus(s) {
  if (sessionMember.size === 0) return;
  const status = await readStatus(s);
  if (!status) return;
  const bySession = new Map();
  for (const member of status.members || []) {
    if (member && member.agentSessionId) bySession.set(String(member.agentSessionId), member);
  }
  for (const sessionId of sessionMember.keys()) {
    if (idleTimers.has(sessionId)) continue;                 // idle 正在等稳定窗口，别把它救回 running
    if (agentStatusBySession.get(sessionId) !== 'running') continue;
    const member = bySession.get(sessionId);
    if (!member || !member.currentTaskId) continue;          // 没有在途任务：可能真的闲下来了
    if (member.status === 'running') continue;
    reportAgentStatus(s, sessionId, 'running', 'heartbeat');
  }
}

/** 消息推进成员信箱后补记「送达」：面板不再把已送达的消息显示成 queued。 */
async function markDelivered(s, messageId) {
  if (!messageId) return;
  await request(s, `/api/messages/${encodeURIComponent(messageId)}/ack`, {
    method: 'POST',
    body: { state: 'delivered' },
  }).catch(() => { /* 回执补记失败不影响投递 */ });
}

/** 成员会话这一轮最后的助手正文：收工时落库成 member→lead 的回复消息。 */
const lastReplyBySession = new Map();

/** 从 assistant/message 的 content 里取正文；纯工具调用步骤没有正文，返回空串。 */
function assistantReplyText(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim();
}

/**
 * 把成员这一轮的结论作为 member→lead 的消息落库（kind=response）。
 * 成员用 send_message / team_report_task 回话都不经过消息总线，面板里只剩 Lead 单向提问；
 * 收工时补一条回复，【消息与回执】才能配对成双向箭头并展示两条正文。
 */
async function flushMemberReply(s, sessionId) {
  const sid = sessionId != null ? String(sessionId) : '';
  if (!sid) return;
  const binding = sessionMember.get(sid);
  const text = lastReplyBySession.get(sid) || '';
  lastReplyBySession.delete(sid);
  if (!binding || !text) return;
  await request(s, '/api/messages', {
    method: 'POST',
    body: {
      teamId: binding.teamId,
      from: binding.memberId,
      to: 'lead',
      kind: 'response',
      payload: { text: clip(text, 4000) },
    },
  }).catch(() => { /* 回复落库失败不影响任务收尾 */ });
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
          ...(exec?.agent && exec.agent.id != null ? { leadSessionId: String(exec.agent.id) } : {}),
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
      rememberMember(sessionId, args.teamId, registered.member.id, team?.workspace);
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
      properties: {},
    },
    output: jsonOutput('{ asOf, total, models: [{ provider, model, name, description, note, modalities }], hint? }'),
    isConcurrencySafe: () => true,
    async execute() {
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
    description: 'Declare one task (DAG node) and hand it to a member. Two runtimes: on a `worker` team each plan step is one proxied action executed through the sidecar broker (the worker process has no direct IO, so a denied step fails hard); on an `agent` team the plan is a BRIEF sent to the member’s own sub-agent session, which does the work with its own tools and calls team_report_task when finished — write the brief self-contained (the member does not see this conversation). `assignee` takes a member **id** from team_spawn, not its name; omit it to let the scheduler pick an idle member. `deps[].from` takes a **task** id returned by an earlier team_task (member ids are rejected). The scheduler satisfies dependencies itself — never poll. Creating a task on an agent team dispatches it immediately to an idle member when dependencies are already satisfied.',
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
              from: { type: 'string', description: 'Upstream **task** id (starts with task_), taken from the team_task result — not a member id.' },
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
      if (exec?.agent && !memberOfCaller(exec.agent)) leadByTeam.set(args.teamId, exec.agent);
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
      // 调用者可能是 Lead，也可能是某个成员（成员用 send_message 工具调用本工具时 exec.agent 就是成员会话）。
      const callerSessionId = exec?.agent?.sessionId ?? exec?.agent?.id ?? null;
      const callerMember = callerSessionId ? sessionMember.get(String(callerSessionId)) : null;
      // 只有 Lead 才更新 Lead 句柄：成员调用不能覆盖它，否则后续派发/转发会拿错会话。
      if (exec?.agent && !callerMember) leadByTeam.set(args.teamId, exec.agent);
      const from = callerMember ? callerMember.memberId : 'lead';
      const toLead = String(args.to).trim().toLowerCase() === 'lead';
      const runtime = await runtimeOfTeam(s, args.teamId);
      // sidecar 的收件人只能是成员 id、'*' 或虚拟收件人 'lead'，所以先把 name / id 统一解析成成员行。
      const st = runtime === 'agent' ? await request(s, `/api/status${qs({ team: args.teamId })}`) : null;
      const members = st?.members || [];
      const resolve = (v) => members.find((m) => m.name === v || m.id === v) || null;
      if (!toLead && args.to !== '*' && (members.length ? !resolve(args.to) : false)) {
        throw new Error(`team_send: 找不到成员 ${args.to}（可用成员 name 或 memberId；广播用 '*'；给 Lead 留言用 to:"lead"）`);
      }
      const recorded = await request(s, '/api/messages', {
        method: 'POST',
        body: {
          teamId: args.teamId,
          from,
          to: toLead ? 'lead' : (args.to === '*' ? '*' : (resolve(args.to)?.id || args.to)),
          payload: { text: args.message },
          ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
        },
      });
      // 成员→Lead 只落信箱（面板可见），不打扰 Lead 会话；worker 团队也没有可唤醒的 sub-agent。
      if (runtime !== 'agent' || toLead) return recorded;

      const subs = subagentsOf(ctx);
      // 成员之间互通必须借 Lead 的 agent 句柄：成员会话都挂在 Lead 下，成员直发会「belongs to another parent session」。
      const caller = leadByTeam.get(args.teamId) || exec?.agent;
      if (!subs || typeof subs.sendMessage !== 'function' || !caller) return { ...recorded, delivered: false };
      const content = [{ type: 'text', text: String(args.message) }];
      const candidates = args.to === '*' ? members : [resolve(args.to)].filter(Boolean);
      const targets = candidates.filter((m) => m.agentSessionId);
      const delivered = [];
      const failed = [];
      if (!targets.length) failed.push({ target: args.to, error: '该成员没有绑定 sub-agent 会话（可能还没 spawn 或已回收）' });
      for (const target of targets) {
        try {
          await subs.sendMessage(caller, String(target.agentSessionId), content, { signal: AbortSignal.timeout(s.requestTimeoutMs) });
          delivered.push(target.name);
          // 投递成功才补记送达：这一条消息确实进了成员会话
          const row = (recorded.messages || [recorded.message]).find((m) => m && String(m.to) === String(target.id));
          await markDelivered(s, row?.id);
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
      if (exec?.agent && !memberOfCaller(exec.agent)) leadByTeam.set(args.teamId, exec.agent);
      try {
        const items = collectArtifacts(ctx, sessionId);
        if (items.length) {
          const binding = sessionId ? sessionMember.get(sessionId) : null;
          await request(s, '/api/artifacts', { method: 'POST', body: { teamId: args.teamId, taskId: args.taskId, memberId: binding?.memberId ?? null, items } });
        }
      } catch { /* 产物采集失败不影响任务汇报 */ }
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
    output: jsonOutput('{ dispatched, reason?, settled?, hint?, error? }'),
    async execute(args, exec) {
      if (exec?.agent && !memberOfCaller(exec.agent)) leadByTeam.set(args.teamId, exec.agent);
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
async function traceToolCall(s, ctx, exec, next) {
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

// ---------- 成员改动（审阅）：write/edit 落盘前后的 unified diff ----------
// 只上报成员（子 agent）的改动：Lead 自己改文件不进审阅页。read 失败 / 工具失败一律静默跳过，
// 绝不影响工具调用本身。
async function reportFileChange(s, ctx, exec, next) {
  const name = String(exec?.name || '');
  const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
  const binding = sessionId ? sessionMember.get(sessionId) : null;
  if (!binding || !FILE_TOOLS.has(name)) return next();
  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : null;
  const raw = args ? targetFile(name, args) : '';
  if (!raw) return next();
  // 成员会话的当前目录：spawn 时设成 team.workspace，这里优先用登记值；Agent 上没有 cwd 字段，
  // 再问 workingDirectory 服务；都拿不到才退回宿主进程 cwd（此时相对路径多半解析不到，diff 会被跳过）。
  let agentCwd = typeof exec?.agent?.cwd === 'string' ? exec.agent.cwd : '';
  if (!agentCwd && binding.cwd) agentCwd = binding.cwd;
  if (!agentCwd && exec?.agent?.session && typeof ctx?.workingDirectory?.get === 'function') {
    try { agentCwd = ctx.workingDirectory.get(exec.agent.session) || ''; } catch { /* 忽略 */ }
  }
  const baseDir = agentCwd || process.cwd();
  const abs = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
  const before = readTextSafe(abs);
  const result = await next();
  const failed = !!result && (result.isError === true || result.error != null);
  if (failed) return result;
  const after = readTextSafe(abs);
  if (after === null) return result;
  // 新建的空文件没有可审内容
  if (before === null && after === '') return result;
  const shown = displayPath(abs, baseDir);
  const diff = unifiedDiff(shown, before ?? '', after);
  if (!diff) return result;
  const { added, deleted } = countDiff(diff);
  void request(s, '/api/changes', {
    method: 'POST',
    body: {
      teamId: binding.teamId,
      memberId: binding.memberId,
      sessionId,
      items: [{ path: shown, kind: changeKind(before, after), diff, added, deleted }],
    },
  }).catch(() => { /* 上报失败不影响工具调用 */ });
  return result;
}

// ---------- LLM 调用 span：真实 token 用量 + 按单价表折算的金额 ----------
// DSH 内核只上报 token，不报钱；金额由 pricing.js 折算。查不到单价就只报 token。
let llmSpanSeq = 0;

const fmtTokens = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

const PURPOSE_LABEL = { compaction: '上下文压缩', 'session-title': '会话标题' };

/**
 * `llm/stream` waterfall：包住一次流式模型调用，抓 usage 后再补一条终态 span。
 * 没有团队归属的会话（普通对话、非团队成员）直接透传，零开销。
 */
function traceLlmCall(s, options, next) {
  const stream = next();
  if (!s.reportLlmCalls) return stream;
  const sessionId = options?.sessionId != null ? String(options.sessionId) : null;
  const member = sessionId ? sessionMember.get(sessionId) : null;
  const teamId = member?.teamId || (sessionId ? teamBySession.get(sessionId) : null) || null;
  if (!teamId) return stream;

  const provider = options?.provider != null ? String(options.provider) : null;
  const model = options?.model != null ? String(options.model) : null;
  const purpose = options?.purpose || null;
  const startMs = Date.now();
  const spanId = `llm:${sessionId || 'host'}:${startMs.toString(36)}-${++llmSpanSeq}`;
  const base = {
    teamId, sessionId, spanId, kind: 'llm', name: model || provider || 'llm', model, provider,
    ...(member?.memberId ? { memberId: member.memberId } : {}),
  };
  postSpan(s, {
    ...base, status: 'running', startMs,
    detail: PURPOSE_LABEL[purpose] || null,
    meta: { provider, purpose },
  });

  return (async function* traced() {
    let usage = null;
    try {
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
        yield chunk;
      }
    } catch (err) {
      postSpan(s, {
        ...base, status: 'failed', startMs, endMs: Date.now(),
        detail: PURPOSE_LABEL[purpose] || null,
        error: clipText(err?.message || String(err), 2000),
      });
      throw err;
    }
    const endMs = Date.now();
    const tokensIn = usage
      ? (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
      : null;
    const tokensOut = usage ? (Number(usage.outputTokens) || 0) : null;
    const priced = usage ? priceUsage({ provider, model, usage, atMs: endMs, tables: s.pricingTables }) : null;
    const parts = [];
    if (usage) parts.push(`${fmtTokens(tokensIn)} in · ${fmtTokens(tokensOut)} out`);
    if (usage && Number(usage.cacheReadTokens) > 0) parts.push(`缓存命中 ${fmtTokens(usage.cacheReadTokens)}`);
    if (priced && priced.peak) parts.push('高峰价');
    if (PURPOSE_LABEL[purpose]) parts.push(PURPOSE_LABEL[purpose]);
    postSpan(s, {
      ...base, status: 'done', startMs, endMs,
      tokensIn, tokensOut,
      cost: priced ? priced.cost : null,
      detail: parts.join(' · ') || null,
      meta: { provider, purpose, currency: priced?.currency ?? null, peak: priced?.peak ?? null, usage: usage ?? null },
    });
  })();
}

// ---- 技能：把包内 `skills/` 注册成 skills provider ----
// 装上插件就带 `dsh-agent-team` 技能，不需要用户手动 `cp -r skills/... ~/.dsh/skills/`。
// 本地克隆读 `<repo>/skills`；npm 安装读依赖包 `dsh-team-control-cli` 里的 `skills/`（同一份文件）。
const SKILL_RANK = 600; // 与官方 BUNDLED_SKILL_RANK 一致：打包来源的标准优先级

function skillRoots() {
  const roots = [path.resolve(PKG_DIR, '..', 'skills')];
  try {
    const cliPkg = createRequire(import.meta.url).resolve('dsh-team-control-cli/package.json');
    roots.push(path.join(path.dirname(cliPkg), 'skills'));
  } catch { /* 本地布局下可能没有该依赖 */ }
  const seen = new Set();
  return roots.filter((dir) => {
    if (seen.has(dir) || !fs.existsSync(dir)) return false;
    seen.add(dir);
    return true;
  });
}

/** 解析 SKILL.md 的 YAML frontmatter（只处理 `key: value` 这一层，够用且零依赖）。 */
export function parseSkillFrontmatter(text) {
  const meta = {};
  if (!text.startsWith('---')) return meta;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return meta;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[m[1]] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return meta;
}

function stripSkillFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  const after = text.indexOf('\n', end + 4);
  return (after < 0 ? '' : text.slice(after + 1)).replace(/^\r?\n/, '');
}

/** 扫描可用目录，产出 skills 服务的候选条目（纯函数，便于测试）。 */
export function discoverTeamSkills() {
  const out = [];
  for (const root of skillRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const file = path.join(dir, 'SKILL.md');
      let meta;
      try { meta = parseSkillFrontmatter(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const name = String(meta.name || entry.name);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
      out.push({
        name,
        description: String(meta.description || ''),
        ...(meta.whenToUse ? { whenToUse: String(meta.whenToUse) } : {}),
        invocation: { modelInvocable: true, userInvocable: meta['user-invocable'] !== false },
        source: 'bundled',
        provider: 'dsh-team',
        rank: SKILL_RANK,
        path: file,
        resourceBase: { kind: 'directory', path: dir },
        locator: { file, dir },
        metadata: meta,
      });
    }
  }
  return out;
}

/** 读取候选对应的完整正文（frontmatter 已剥离）。 */
function loadTeamSkill(candidate) {
  const file = candidate?.locator?.file ?? candidate?.path;
  if (!file) return undefined;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  return {
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse ? { whenToUse: candidate.whenToUse } : {}),
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    path: candidate.path,
    resourceBase: candidate.resourceBase,
    metadata: candidate.metadata,
    content: stripSkillFrontmatter(text),
  };
}

/** Cordis apply：注册全局工具，接管自动拉起的 sidecar，并把 agent 生命周期桥接到 sidecar。 */
export function apply(ctx, config) {
  const s = resolveConfig(config);
  ctx.effect(() => {
    const disposers = buildTools(s, ctx).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* ignore */ } }
      leadByTeam.clear(); runtimeByTeam.clear(); sessionMember.clear(); dispatching.clear(); teamBySession.clear(); contextReportAt.clear();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      for (const timer of startTimers.values()) clearTimeout(timer);
      idleTimers.clear(); startTimers.clear(); agentStatusBySession.clear(); lastReplyBySession.clear();
      const spawned = s.spawned;
      if (spawned?.child && spawned.child.exitCode === null) {
        try { spawned.child.kill(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-team.tools()');

  // 技能：skills 服务在场时把包内 `skills/` 注册成 provider，装上插件就带 `dsh-agent-team` 技能；
  // 服务缺失（老版本/测试假 ctx）时静默跳过，不影响工具面。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (scope) => {
      scope.skills.registerProvider(() => ({
        name: 'dsh-team',
        list: async () => discoverTeamSkills(),
        get: async (candidate) => loadTeamSkill(candidate),
      }));
    });
  }

  if (s.reportToolCalls) {
    ctx.on('tools/execute', (exec, next) => traceToolCall(s, ctx, exec, next));
  }

  // 成员写/改文件 → unified diff 上报（面板「审阅」页）：只给子成员，Lead 的改动不进审阅。
  // 钩子打上 dshTeamHook 标记：测试与排障能在多个 tools/execute 拦截器里认出它。
  if (s.reportChanges) {
    const fileChangeHook = (exec, next) => reportFileChange(s, ctx, exec, next);
    fileChangeHook.dshTeamHook = 'file-change';
    ctx.on('tools/execute', fileChangeHook);
  }

  // 成员用内置 todo_write 维护计划（没建 team_todo）时，把 DSH 的 `todos` 投影镜像成
  // sidecar 计划步骤：面板/团队校验能看到真实 plan，todo 勾完计划步骤也跟着完成。
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    const sid = exec?.agent?.id != null ? String(exec.agent.id) : null;
    const failed = !!result && (result.isError === true || result.error != null);
    if (sid && String(exec?.name || '') === 'todo_write' && !failed) {
      void mirrorTodos(s, ctx, sid).catch(() => { /* ignore */ });
    }
    return result;
  });

  // 每次 LLM 调用的 token 用量 → 金额（瀑布里的 ¥/$ 就来自这条 span）
  if (s.reportLlmCalls) {
    ctx.on('llm/stream', (options, next) => traceLlmCall(s, options, next));
  }

  // 模型目录变化（provider 配置/适配器注册变化）→ 立刻重新同步（force + in-flight 去重）
  ctx.on('llm/adapters-updated', () => {
    if (s.reportLlmCatalog) void syncLlmCatalog(s, ctx).catch(() => { /* ignore */ });
  });

  // 成员 sub-agent 的 running/idle 回写 sidecar：面板实时、idle 兜底收尾在途任务。
  // idle 不立刻落库：DSH 把 maintenance（压缩/整理）也算 idle，立刻落库会把正在干活的成员
  // 判成收工、把在途任务兜底判 done（页面上一段时间灰显）。等一个稳定窗口再落库。
  ctx.on('agent/status', ({ agent, status } = {}) => {
    const sessionId = agent?.id != null ? String(agent.id) : null;
    if (!sessionId) return;
    const binding = sessionMember.get(sessionId);
    if (!binding) return;
    // DSH 的 status getter 把 maintenance（上下文压缩/整理）也算 idle，但它不是收工：
    // 这类事件直接忽略，避免把在途任务误判 done（页面上一段时间显示灰色的根因）。
    const phaseKind = agent && agent.phase && agent.phase.kind;
    if (status === 'idle' && phaseKind === 'maintenance') {
      cancelIdleReport(sessionId);
      agentStatusBySession.set(sessionId, 'running');
      return;
    }
    if (status !== 'idle') {
      cancelIdleReport(sessionId);
      agentStatusBySession.set(sessionId, status);
      reportAgentStatus(s, sessionId, status);
      return;
    }
    cancelIdleReport(sessionId);
    agentStatusBySession.set(sessionId, 'idle');
    // 收工前把内置 todo 的影子计划同步一次，保证「todo 完成 → 计划完成」不丢最后一步
    void mirrorTodos(s, ctx, sessionId).catch(() => { /* ignore */ });
    const settle = Math.max(0, Number(s.agentIdleSettleMs) || 0);
    const finish = () => {
      idleTimers.delete(sessionId);
      if (agentStatusBySession.get(sessionId) !== 'idle') return; // 窗口内又跑起来了
      // 把这一轮最后的正文带给 sidecar：漏调 team_report_task 时，兜底收尾的 task.done 也有摘要可看
      const reply = lastReplyBySession.get(sessionId);
      reportAgentStatus(s, sessionId, 'idle', reply ? clip(reply, 500) : undefined);
      void flushMemberReply(s, sessionId).catch(() => { /* ignore */ });
      if (s.agentAutoDispatch) {
        void dispatchLoop(s, ctx, binding.teamId).catch(() => { /* ignore */ });
      }
    };
    if (!settle) { finish(); return; }
    const timer = setTimeout(finish, settle);
    timer.unref?.();
    idleTimers.set(sessionId, timer);
  });

  // 成员回合的助手正文：只在收工时（agent/status idle 稳定窗口后）落库成回复消息。
  // 每轮先攒着，纯工具步骤没有正文就清掉缓存，避免把上一轮结论当成这一轮的回复。
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id != null ? String(session.id) : null;
    if (!sessionId || !sessionMember.has(sessionId)) return;
    // 收到了这个会话的事件 → 会话确实活着，撤掉「派发后没动静」的监视
    cancelStartWatchdog(sessionId);
    // 回合以 error 结束（模型路由报错、上游超时、适配器异常…）：DSH 的 agent 状态只会回到 idle，
    // 若不在这里报 failed，sidecar 会把在途任务当「正常收工」结掉，成员也得等下一次派发才发现。
    if (event && event.type === 'turn/end') {
      const reason = event.data?.reason;
      if (reason && reason.kind === 'error') {
        const err = reason.error || {};
        const msg = String(err.message || err.code || 'unknown error').slice(0, 500);
        cancelIdleReport(sessionId);
        agentStatusBySession.set(sessionId, 'idle');
        reportAgentStatus(s, sessionId, 'failed', `模型回合失败：${msg}`);
      }
      return;
    }
    if (!event || event.type !== 'assistant/message') return;
    const text = assistantReplyText(event.data?.message);
    if (text) lastReplyBySession.set(sessionId, text);
    else lastReplyBySession.delete(sessionId);
  });

  // 状态心跳：本地认为在跑、sidecar 却回落到 idle 且有在途任务时补报 running
  ctx.effect(() => {
    const timer = setInterval(() => {
      void heartbeatAgentStatus(s).catch(() => { /* ignore */ });
    }, Math.max(2000, s.agentHeartbeatMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-team.agent-heartbeat()');

  // 成员上下文快照：面板「上下文分析」页的数据来源。周期泵覆盖进行中的回合，
  // agent/status 变化时补报一次（回合结束/中断后上下文占用才定型）。
  if (s.reportContext) {
    ctx.on('agent/status', ({ agent } = {}) => {
      const sessionId = agent?.id != null ? String(agent.id) : null;
      if (sessionId && sessionMember.has(sessionId)) reportContextSnapshot(s, ctx, sessionId, { force: true });
    });
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const sessionId of sessionMember.keys()) reportContextSnapshot(s, ctx, sessionId);
      }, Math.max(2000, s.contextReportMs));
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'dsh-team.context-pump()');
  }

  // 工作区注册表 → sidecar：插件一启动就推一次；sidecar 可能还没监听（同一个 apply 里刚 spawn），
  // 失败就 1.5s 后重试，成功后再转入低频轮询。
  if (s.reportWorkspaces) {
    ctx.effect(() => {
      let stopped = false;
      let timer = null;
      const run = async () => {
        const ok = await reportWorkspaces(s, ctx);
        if (stopped) return;
        timer = setTimeout(run, ok ? Math.max(5000, s.workspaceReportMs) : 1500);
        timer.unref?.();
      };
      void run();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, 'dsh-team.workspace-pump()');
  }

  // 模型目录泵：面板「模型路由」页不再依赖 lead 调 team_models。
  // 启动即同步（sidecar 可能刚 spawn，失败 2s 重试），成功后按 llmCatalogMs 定时刷新。
  if (s.reportLlmCatalog) {
    ctx.effect(() => {
      let stopped = false;
      let timer = null;
      const run = async () => {
        let delay = 2000;
        try {
          const r = await syncLlmCatalog(s, ctx);
          // adapter 还没注册完时目录是空的：10s 后再试（adapters-updated 事件也会立刻补一次）
          delay = r?.ok ? (r.empty ? 10000 : Math.max(10000, s.llmCatalogMs)) : 2000;
        } catch { delay = 2000; }
        if (stopped) return;
        timer = setTimeout(run, delay);
        timer.unref?.();
      };
      void run();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, 'dsh-team.llm-catalog-pump()');
  }

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

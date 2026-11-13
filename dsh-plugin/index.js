// dsh-team-control — 把本地 dsh-team sidecar 暴露为模型可调用工具。
//
// 设计约束（来自本仓 docs/CONTRACT.md 与 PRD）：
// - 本插件只做「适配 + 生命周期」，编排/权限/事件流全部在 sidecar 进程内，不在这里重写。
// - 零第三方 import：只用 Node 内置模块，避免 profile 依赖解析问题；
//   工具用普通 ToolDefinition 对象注册（JSON Schema 参数），不依赖 defineTool。
// - sidecar 未运行时，autoStart=true 会在首次工具调用时拉起 `dsh-team up`；
//   插件卸载时只回收「自己拉起」的进程，不影响用户手工起的服务。
import { spawn, execFileSync } from 'node:child_process';
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
    // Leader 自建 agentPreset 的固定目录：JSON 文档（JSON 是合法 YAML），插件启动时注册进宿主
    presetDir: path.resolve(c.presetDir || process.env.DSH_TEAM_PRESET_DIR || path.join(os.homedir(), '.dsh', 'team', 'presets')),
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
    // 面板 steer 队列的投递泵间隔（面板排队消息 → 成员会话）
    steerPollMs: Number(c.steerPollMs) || 1200,
    agentDispatchMax: Number(c.agentDispatchMax) || 16,
    // sidecar 建任务后留 200ms 的「声明依赖」窗口，派发前先等过这段时间
    agentSettleMs: Number(c.agentSettleMs) || 250,
    // 成员 idle 的落库稳定窗口：DSH 在维护阶段（上下文压缩等）也会报 idle，立刻落库会把在途任务误判完成
    agentIdleSettleMs: c.agentIdleSettleMs == null ? 12000 : Math.max(0, Number(c.agentIdleSettleMs) || 0),
    // 成员状态心跳：本地认为在跑、sidecar 却回落到 idle 时补报 running（任务仍在跑说明回合没结束）
    agentHeartbeatMs: Number(c.agentHeartbeatMs) || 15000,
    // 面板/看板停止后轮询 sidecar：发现成员被置 interrupted 就真正 subagents.interrupt
    forceStopPollMs: Number(c.forceStopPollMs) || 1000,
    // 任务投递后成员会话迟迟没有任何事件（模型路由报错、会话没启动）就判定失败并交回 sidecar 重试
    agentStartTimeoutMs: Number(c.agentStartTimeoutMs) || 120000,
    // 成员触发权限审批（permission preset 的 approval=ask）后，等待 Lead 调 team_approve 的上限
    approvalTimeoutMs: Number(c.approvalTimeoutMs) || 600000,
    // 审批降噪：命令明确是「已知安全程序 + 无重定向/命令替换/脚本块」时直接 allowed-once，
    // 不打扰 Lead；敏感命令（见 DEFAULT_SENSITIVE_COMMAND_PATTERNS）仍转 Lead 审批
    autoApproveLowRisk: c.autoApproveLowRisk !== false,
    // 追加的敏感命令正则（字符串数组）：命中即视为敏感，仍走 Lead 审批
    sensitiveCommandPatterns: Array.isArray(c.sensitiveCommandPatterns)
      ? c.sensitiveCommandPatterns.map((p) => String(p)).filter(Boolean)
      : [],
    // 工具级自动放行白名单（字符串数组，支持 `*` 通配）：命中工具名的审批直接 allowed-once。
    // 默认空；用于把「非 shell 但明确安全」的工具（如只读 MCP 发现类工具）从审批流里摘出去。
    autoApproveTools: Array.isArray(c.autoApproveTools)
      ? c.autoApproveTools.map((p) => String(p).trim()).filter(Boolean)
      : [],
    // spawnTeammate 的 provider：默认与 dsh-experimental-tool-agent-team 一致
    freshProvider: String(c.freshProvider || 'spawn'),
    forkProvider: String(c.forkProvider || 'fork'),
    // 工作区看板：Host 侧调度器（claim → 建会话 → 投 prompt）。
    // 默认开启；只有 auto=1 或用户点「开始执行」的任务才会入队，显式 false 可关闭。
    boardEnabled: c.boardEnabled !== false,
    boardDispatchMs: Number(c.boardDispatchMs) || 2000,
    boardIdleGraceMs: c.boardIdleGraceMs == null ? 6000 : Math.max(0, Number(c.boardIdleGraceMs) || 0),
    boardPlanningTimeoutMs: Number(c.boardPlanningTimeoutMs) || 30 * 60 * 1000,
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
    const err = new Error(`dsh-team API ${res.status} on ${method} ${pathname}: ${detail}`);
    err.status = res.status; // 调用方据此区分「团队不存在(404)」与服务/网络侧故障
    throw err;
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
const teamCache = new Map();
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
      projection = projections.snapshot(session, ['contextBreakdown', 'contextPressure', 'sessionStats', 'tokenUsage'])?.values || {};
    }
  } catch { projection = {}; }
  const breakdown = projection.contextBreakdown || {};
  const pressure = projection.contextPressure || {};
  const sessionStats = projection.sessionStats || null;
  const tokenUsage = projection.tokenUsage || null;
  let stats = null;
  if (sessionStats || tokenUsage) {
    const uncached = Number(tokenUsage?.uncachedInputTokens) || 0;
    const cacheRead = Number(tokenUsage?.cacheReadTokens) || 0;
    const cacheWrite = Number(tokenUsage?.cacheWriteTokens) || 0;
    const input = uncached + cacheRead + cacheWrite;
    stats = {
      turns: Number(sessionStats?.turns) || 0,
      steps: Number(sessionStats?.steps) || 0,
      llmMs: Number(sessionStats?.llmMs) || 0,
      toolMs: Number(sessionStats?.toolMs) || 0,
      ttftMs: Number(sessionStats?.ttftMs) || 0,
      decodeMs: Number(sessionStats?.decodeMs) || 0,
      decodeTokens: Number(sessionStats?.decodeTokens) || 0,
      inputTokens: input,
      outputTokens: Number(tokenUsage?.outputTokens) || 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cacheHitRate: input > 0 ? cacheRead / input : null,
    };
  }

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
    stats,
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

/**
 * 一条 route 的思考强度元数据（适配器声明）：数组 = 已知（可能为空），undefined = 取不到。
 * resolveModel 对 pi-ai 是内存目录查询；对其他适配器可能触网，所以并发受限 + 超时兜底，
 * 取不到就不上报（sidecar 保留上一次的值），不让 effort 能力拖垮整个目录同步。
 */
async function effortsOfRoute(llm, provider, model) {
  // llm 服务暴露的是 resolveModelInfo（带校验的精确模型元数据）；resolveModel 是适配器基类方法，
  // 部分环境/旧版本才直接挂在服务上。两个都试，优先服务公开面。
  const resolve = typeof llm.resolveModelInfo === 'function'
    ? (p, m, signal) => llm.resolveModelInfo(p, m, signal)
    : typeof llm.resolveModel === 'function'
      ? (p, m, signal) => llm.resolveModel(p, m, signal)
      : null;
  if (!resolve) return undefined;
  const call = Promise.resolve()
    .then(() => resolve(provider, model, AbortSignal.timeout(3000)))
    .catch(() => undefined);
  const info = await Promise.race([
    call,
    new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
  ]);
  const reasoning = info && info.reasoning;
  if (!reasoning || !Array.isArray(reasoning.efforts)) return undefined;
  // 「off」等于关思考，不是可派发的强度：既不进面板胶囊，也不进 team_models，
  // 否则用户能「允许派发 off」而实际语义相反。
  const efforts = reasoning.efforts
    .filter((e) => e && e.id && String(e.id) !== 'off')
    .map((e) => ({ id: String(e.id), name: String(e.name || e.id), ...(e.description ? { description: String(e.description) } : {}) }));
  if (!efforts.length) return undefined;
  const defaultEffort = reasoning.defaultEffort ? String(reasoning.defaultEffort) : null;
  return {
    efforts,
    defaultEffort: defaultEffort && defaultEffort !== 'off' && efforts.some((e) => e.id === defaultEffort) ? defaultEffort : null,
  };
}

/** 小并发 map：effort 解析最多同时 4 条，避免一次同步打爆适配器。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

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
        const listed = await llm.listModels(p.id);
        const withEfforts = await mapLimit(listed, 4, async (m) => {
          if (!m || !m.id) return null;
          const meta = await effortsOfRoute(llm, p.id, String(m.id));
          return {
            provider: p.id, model: String(m.id), name: m.name || String(m.id),
            description: m.description || null, modalities: m.inputModalities || null,
            ...(meta ? { efforts: meta.efforts, ...(meta.defaultEffort ? { defaultEffort: meta.defaultEffort } : {}) } : {}),
          };
        });
        for (const row of withEfforts) if (row) models.push(row);
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

/** 指定 route 必须在用户启用的子集里，且 effort 在该 route 允许的集合里；目录尚未同步（为空）时不限制。 */
async function assertRouteEnabled(s, ctx, provider, model, effort = null) {
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
  if (!known.some((m) => m.enabled)) {
    const sample = enabled.slice(0, 8).map((m) => `${m.provider}/${m.model}`).join(', ');
    throw new Error(`模型路由未启用：${[provider, model].filter(Boolean).join('/')}。可用（前 8 条）：${sample}。完整列表见 team_models，或在面板「模型路由」页启用。`);
  }
  // effort 闸门：只有该 route 声明了 efforts 才校验；allowedEfforts=null 表示全部允许。
  if (!effort) return;
  const declared = known.filter((m) => Array.isArray(m.efforts) && m.efforts.length > 0);
  if (!declared.length) return;
  const ids = [...new Set(declared.flatMap((m) => m.efforts.map((e) => e.id)))];
  const allowed = [...new Set(declared.flatMap((m) => (Array.isArray(m.allowedEfforts) ? m.allowedEfforts : ids)))];
  if (!ids.includes(String(effort))) {
    throw new Error(`模型路由 ${[provider, model].filter(Boolean).join('/')} 不支持 reasoningEffort「${effort}」：可用 ${ids.join(', ')}。`);
  }
  if (!allowed.includes(String(effort))) {
    throw new Error(`模型路由 ${[provider, model].filter(Boolean).join('/')} 已禁止 reasoningEffort「${effort}」：面板「模型路由」页允许的为 ${allowed.join(', ') || '（无，省略该参数使用模型默认）'}。`);
  }
}

function rememberMember(sessionId, teamId, memberId, cwd, permissionPreset = null, name = null) {
  if (sessionId == null) return;
  const key = String(sessionId);
  const prev = sessionMember.get(key);
  // 会话 cwd 只有 spawn 时知道（= team.workspace）；派发路径会重复登记同一个会话，
  // 这里不能把它冲成空，否则成员用相对路径写文件时 diff 找不到落盘位置。
  sessionMember.set(key, {
    teamId: String(teamId),
    memberId: String(memberId),
    cwd: cwd || prev?.cwd || '',
    permissionPreset: permissionPreset || prev?.permissionPreset || null,
    name: name || prev?.name || null,
  });
}

async function teamOf(s, teamId, { refresh = false, sessionId = null } = {}) {
  // 模型偶尔会漏掉必填的 teamId。先显式挡住，避免 /api/teams/undefined 被误报成「团队不存在」；
  // 同一会话内 team_create 过的团队可以直接兜底（DSH 对直接注册的工具不做 required 运行时校验）。
  const missing = teamId == null || String(teamId).trim() === '' || String(teamId) === 'undefined' || String(teamId) === 'null';
  if (missing && sessionId) {
    const bound = sessionMember.get(String(sessionId))?.teamId || teamBySession.get(String(sessionId));
    if (bound) teamId = bound;
  }
  if (teamId == null || String(teamId).trim() === '' || String(teamId) === 'undefined' || String(teamId) === 'null') {
    throw new Error('缺少 teamId：请把 team_create 返回的 result.team.id（形如 team_xxx）作为 teamId 参数传入后重试。');
  }
  const key = String(teamId);
  if (!refresh && teamCache.has(key)) return teamCache.get(key);
  try {
    const team = await request(s, `/api/teams/${encodeURIComponent(key)}`);
    teamCache.set(key, team);
    return team;
  } catch (err) {
    if (err && err.status === 404) {
      throw new Error(`团队不存在或 teamId 无效: ${key}（teamId 来自 team_create 返回值，请核对后重试）`);
    }
    throw err;
  }
}

const permissionPresetsOf = (ctx) => {
  try { return ctx.get('permissionPresets'); } catch { return undefined; }
};

const agentPresetsOf = (ctx) => {
  try { return ctx.get('agentPresets'); } catch { return undefined; }
};

/** 解析并校验 agentPreset（组合预设：工具/skill/MCP/系统提示词）。空 = 不指定（调用方需用宿主默认兜底）。 */
async function resolveAgentPreset(ctx, requested, fallback, store = null) {
  if (store) await ensureTeamPresets(store, ctx).catch(() => null);
  const preset = String(requested ?? fallback ?? '').trim();
  if (!preset) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(preset)) {
    throw new Error(`agentPreset 名称非法：「${preset}」`);
  }
  const svc = agentPresetsOf(ctx);
  if (!svc || typeof svc.list !== 'function') return preset;
  let rows = null;
  try { rows = await svc.list(); } catch { rows = null; }
  const ids = Array.isArray(rows) ? rows.map((r) => r && r.id).filter(Boolean) : [];
  if (ids.length && !ids.includes(preset)) {
    throw new Error(`agentPreset「${preset}」不存在；可用预设：${ids.join(', ')}`);
  }
  return preset;
}

/**
 * 宿主默认 agentPreset 的 id。
 *
 * DSH 的 subagent 在 request 里省略 agentPreset 时，会继承父会话的实时组合
 * （`composeFrom(parent)`），并不会自动套用宿主默认。因此 team_spawn 必须显式
 * 把默认预设传下去，否则成员就只能拿到 Lead 根组合里的宿主级工具（比如没有 shell）。
 */
async function hostDefaultAgentPreset(ctx) {
  const svc = agentPresetsOf(ctx);
  if (!svc) return null;
  let id = '';
  try {
    if (typeof svc.defaultId === 'string') id = svc.defaultId.trim();
  } catch { id = ''; }
  if (!id && typeof svc.resolve === 'function') {
    try {
      const row = await svc.resolve(undefined);
      if (row && row.id != null && row.broken === undefined) id = String(row.id).trim();
    } catch { id = ''; }
  }
  return id || null;
}

// ---------------------------------------------------------------------------
// Leader 自建 agentPreset
//
// 内置 preset 不满足时，Lead 用 team_preset({action:'save'}) 把一份组合定义写到固定目录，
// 并立刻调用宿主 `agentPresets.register()` 生效（无需重启 DSH）。目录里的 JSON 文档
// （JSON 是合法 YAML）在插件启动时也会被重新注册，因此跨会话可复用。
// ---------------------------------------------------------------------------
const PRESET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const teamPresetDisposers = new Map();
let teamPresetsReady = null;
let teamPresetLoading = null;

function presetFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** 读目录里全部 preset 文档；坏文件只记诊断，不阻塞其他文件。 */
function readTeamPresetFiles(dir) {
  const docs = [];
  const errors = [];
  for (const file of presetFiles(dir)) {
    const full = path.join(dir, file);
    try {
      const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!doc || typeof doc !== 'object') throw new Error('不是对象');
      if (!PRESET_ID_RE.test(String(doc.id || ''))) throw new Error('id 非法');
      if (!Array.isArray(doc.plugins) || doc.plugins.length === 0) throw new Error('plugins 必须是非空数组');
      docs.push({ doc, file: full });
    } catch (err) {
      errors.push({ file: full, error: String(err?.message || err) });
    }
  }
  return { docs, errors };
}

/** 启动时把目录里的 preset 注册进宿主；幂等，重复调用复用同一个 Promise。 */
function ensureTeamPresets(s, ctx) {
  if (teamPresetsReady) return teamPresetsReady;
  if (teamPresetLoading) return teamPresetLoading;
  const serviceAvailable = () => {
    const svc = ctx.get('agentPresets');
    return !!(svc && typeof svc.register === 'function');
  };
  teamPresetLoading = (async () => {
    const svc = ctx.get('agentPresets');
    const result = { dir: s.presetDir, registered: [], skipped: [], errors: [] };
    if (!svc || typeof svc.register !== 'function') {
      result.errors.push({ file: s.presetDir, error: 'agentPresets 服务不可用（宿主未启用 agent-preset-registry）' });
      return result;
    }
    const { docs, errors } = readTeamPresetFiles(s.presetDir);
    result.errors.push(...errors);
    let known = new Set();
    try { known = new Set((await svc.list()).map((r) => r && r.id).filter(Boolean)); } catch { /* list 不可用就按空处理 */ }
    for (const { doc, file } of docs) {
      try {
        if (known.has(doc.id)) { result.skipped.push({ id: doc.id, file, reason: '同名预设已由宿主定义' }); continue; }
        const dispose = await svc.register(doc);
        teamPresetDisposers.set(doc.id, dispose);
        known.add(doc.id);
        result.registered.push({ id: doc.id, file });
      } catch (err) {
        result.errors.push({ file, error: String(err?.message || err) });
      }
    }
    return result;
  })().finally(() => {
    // 服务暂时不可用时不缓存失败，下次调用（例如宿主稍后启用 registry）再重试。
    if (serviceAvailable()) teamPresetsReady = teamPresetLoading;
    teamPresetLoading = null;
  });
  return teamPresetLoading;
}

/** 保存一个 preset 文档并立刻注册；同名的自建 preset 可覆盖，宿主内置的同名 preset 不允许覆盖。 */
async function saveTeamPreset(s, ctx, input) {
  const id = String(input?.id || '').trim();
  if (!PRESET_ID_RE.test(id)) throw new Error(`agentPreset 名称非法：「${id}」`);
  if (!Array.isArray(input?.plugins) || input.plugins.length === 0) {
    throw new Error('plugins 必须是非空数组，每项形如 { name, config?, id?, disabled? }');
  }
  const doc = { id };
  if (input.name) doc.name = String(input.name);
  if (input.description) doc.description = String(input.description);
  if (Number.isFinite(Number(input.order))) doc.order = Number(input.order);
  doc.plugins = input.plugins;
  const file = path.join(s.presetDir, `${id}.json`);
  if (fs.existsSync(file) && !input?.confirm) {
    throw new Error(`团队预设「${id}」已存在；覆盖请传 confirm:true（内置预设始终不可覆盖）`);
  }
  const svc = ctx.get('agentPresets');
  if (!svc || typeof svc.register !== 'function') {
    fs.mkdirSync(s.presetDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return { id, file, registered: false, warning: 'agentPresets 服务不可用：文件已保存，宿主启用该服务后会加载' };
  }
  let existing = null;
  let hostIds = [];
  try {
    const rows = await svc.list();
    hostIds = rows.map((r) => r && r.id).filter(Boolean);
    existing = rows.find((r) => r && r.id === id) || null;
  } catch { existing = null; }
  if (existing && !teamPresetDisposers.has(id)) {
    throw new Error(`agentPreset「${id}」已由宿主定义，换一个 id（内置预设：${hostIds.join(', ')}）`);
  }
  fs.mkdirSync(s.presetDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  if (teamPresetDisposers.has(id)) {
    const dispose = teamPresetDisposers.get(id);
    teamPresetDisposers.delete(id);
    try { await dispose(); } catch { /* 旧定义已失效就继续注册新定义 */ }
  }
  const dispose = await svc.register(doc);
  teamPresetDisposers.set(id, dispose);
  const row = (await svc.list().catch(() => [])).find((r) => r && r.id === id) || null;
  return { id, file, registered: true, ...(row?.broken ? { broken: row.broken } : {}) };
}

/** 列出宿主 preset + 目录里的自建 preset（含未成功注册/解析失败的文件）。 */
async function listTeamPresets(s, ctx) {
  await ensureTeamPresets(s, ctx).catch(() => null);
  const { docs, errors } = readTeamPresetFiles(s.presetDir);
  const fileById = new Map(docs.map(({ doc, file }) => [doc.id, file]));
  const svc = ctx.get('agentPresets');
  let rows = [];
  try { rows = await svc?.list?.() || []; } catch { rows = []; }
  const presets = rows.map((r) => ({
    id: r.id,
    ...(r.name ? { name: r.name } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.order !== undefined ? { order: r.order } : {}),
    ...(r.broken ? { broken: r.broken } : {}),
    source: fileById.has(r.id) ? 'team' : 'host',
    ...(fileById.has(r.id) ? { file: fileById.get(r.id) } : {}),
  }));
  for (const { doc, file } of docs) {
    if (!presets.some((p) => p.id === doc.id)) {
      presets.push({ id: doc.id, ...(doc.name ? { name: doc.name } : {}), source: 'team', file, registered: false });
    }
  }
  return { dir: s.presetDir, presets, errors };
}

/** 把目录镜像同步给 sidecar，供面板浏览（尽力而为，失败不影响主流程）。 */
async function syncPresetCatalog(s, ctx) {
  try {
    const catalog = await listTeamPresets(s, ctx);
    const { docs } = readTeamPresetFiles(s.presetDir);
    const docById = new Map(docs.map(({ doc }) => [doc.id, doc]));
    const presets = catalog.presets.map(({ registered, ...row }) => ({ ...row, ...(docById.has(row.id) ? { doc: docById.get(row.id) } : {}) }));
    await request(s, '/api/presets/sync', { method: 'POST', body: { presets } });
    return catalog;
  } catch { return null; }
}

/** 只删团队自建（目录里的 .json）；内置预设不可删。 */
async function deleteTeamPreset(s, ctx, rawId) {
  const id = String(rawId || '').trim();
  if (!PRESET_ID_RE.test(id)) throw new Error(`agentPreset 名称非法：「${id}」`);
  const file = path.join(s.presetDir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`只有团队自建预设可以删除：「${id}」不在 ${s.presetDir}`);
  const dispose = teamPresetDisposers.get(id);
  teamPresetDisposers.delete(id);
  if (dispose) { try { await dispose(); } catch { /* 已失效就继续删文件 */ } }
  fs.rmSync(file, { force: true });
  await syncPresetCatalog(s, ctx);
  return { id, file, removed: true };
}

/** 面板点删除 → sidecar 排队 → 这里取队列执行并 ack（Host 服务只在本进程里可调）。 */
async function processPresetDeletes(s, ctx) {
  let items = [];
  try { items = (await request(s, '/api/presets/pending-deletes')).items || []; } catch { return; }
  for (const item of items) {
    if (Number(item.attempts) >= 5) continue; // 面板显示错误；不再无限重试
    let error = null;
    try { await deleteTeamPreset(s, ctx, item.id); } catch (err) { error = String(err?.message || err); }
    try { await request(s, `/api/presets/pending-deletes/${encodeURIComponent(item.id)}/ack`, { method: 'POST', body: error ? { error } : {} }); } catch { /* 下次再 ack */ }
  }
}

/** 解析并校验 permissionPreset：宿主注册了该服务时按 names 校验，否则原样交给宿主 set()。 */
function resolvePermissionPreset(ctx, requested, fallback) {
  const preset = String(requested || fallback || 'workspace-write').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(preset)) {
    throw new Error(`permissionPreset 名称非法：「${preset}」`);
  }
  const svc = permissionPresetsOf(ctx);
  const names = svc && Array.isArray(svc.names) ? svc.names : null;
  if (names && names.length && !names.includes(preset)) {
    throw new Error(`permissionPreset「${preset}」不存在；可用预设：${names.join(', ')}`);
  }
  return preset;
}

/** 把预设落到已发布的子会话：sandbox + approval 两个 knob 一起写。 */
function applyPermissionPreset(ctx, sessionId, preset) {
  const svc = permissionPresetsOf(ctx);
  if (!svc || typeof svc.set !== 'function') return { applied: false, reason: 'permissionPresets 服务不可用' };
  const sessions = sessionsOf(ctx);
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(String(sessionId)) : null;
  if (!session) return { applied: false, reason: '子会话尚未发布' };
  try {
    svc.set(session, preset);
    return { applied: true, preset };
  } catch (err) {
    return { applied: false, preset, error: String(err?.message || err) };
  }
}

const clip = (text, max) => {
  const v = String(text ?? '');
  return v.length > max ? v.slice(0, max) + '…' : v;
};

/** 成员收到的一条任务说明：必须包含 teamId / taskId 和「跑完怎么回报」。 */
function taskBrief(teamId, task, member) {
  const plan = (task.plan || []).map((p, i) => {
    const detail = p.detail || p.action || p.phase || 'do';
    return `${i + 1}. [${p.step || `S${i + 1}`}] ${detail}`;
  });
  const deps = (task.dependsOn || []).length ? `\n依赖（已完成）：${task.dependsOn.join(', ')}` : '';
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
    ...(acceptance ? [acceptance.trim()] : []),
    '',
    '执行要求：',
    '1) 直接在本会话里做这件事（用你自己的工具，不要委派给别的 agent）。',
    '2) 每开始或完成一步、以及验收通过后，调用 team_todo 更新该任务的计划清单（teamId/taskId 同上）。',
    '3) 收工前，如果这次任务产生了对后续任务可复用的结论（接口约定、坑、决策理由、未决问题），调用 team_memory_write 存一条简短 handoff（scope="member"，kind="handoff"，value 不超过 300 字）；没有可复用结论就跳过，不要为了留记忆而写。只有 Lead 明确要求上传时才写 scope="team"。',
    '4) 完成或失败后必须调用 team_report_task，例如：',
    `   team_report_task({ teamId: "${teamId}", taskId: "${task.id}", status: "done", summary: "一句话结果 + 关键产物路径" })`,
    '5) 需要 Lead 决策或补充信息时用 team_send（teamId 同上，to: "lead"），不要自己猜测。',
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
      if (member.agentSessionId) rememberMember(member.agentSessionId, teamId, member.id, null, member.permissionPreset, member.name);
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

// ---------- 权限审批转发：成员 preset 触发 approval/request → Lead 用 team_approve 决定 ----------
const pendingApprovals = new Map();

// 审批分类：approval/request 只带 toolName 与 callId，不带命令参数；
// 在 tools/pre-execute 里按 callId 记住成员这一轮的入参，供低风险命令自动放行判定。
const preExecuteArgs = new Map();
const PRE_EXECUTE_TTL_MS = 5 * 60 * 1000;
const PRE_EXECUTE_MAX = 500;
const SHELL_TOOL_RE = /(^|[._-])(bash|shell|exec|command|powershell|pwsh|zsh|sh)($|[._-])/i;
// 只有这些程序出现在命令首位才考虑自动放行；不在表里的（rm、curl、ssh、脚本解释执行等）仍转 Lead。
const SAFE_COMMAND_PROGRAMS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'biome',
  'python', 'python3', 'py', 'pytest', 'uv', 'pip', 'pip3',
  'cargo', 'rustc', 'go', 'dotnet', 'javac', 'java', 'mvn', 'gradle',
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'rg', 'grep', 'find', 'fd', 'where', 'which',
  'git', 'echo', 'cd', 'pwd', 'mkdir', 'touch',
  // PowerShell 只读命令：成员在 Windows 上排查时的大量噪声来自 Get-*/Select-*/Format-*。
  // ForEach-Object 等能执行脚本块的 cmdlet 故意不收录（脚本块另有 `{}` 拦截）。
  'get-childitem', 'get-content', 'get-item', 'get-itemproperty', 'get-location', 'get-command',
  'get-process', 'get-date', 'get-acl', 'get-help', 'get-member', 'get-module', 'get-variable',
  'select-string', 'select-object', 'where-object', 'measure-object', 'sort-object',
  'format-table', 'format-list', 'out-string', 'out-host', 'write-output',
  'test-path', 'resolve-path', 'join-path', 'split-path', 'compare-object', 'group-object',
  'convertto-json', 'convertfrom-json', 'get-filehash',
]);
// 解释器带 -e/-c 等价于任意代码执行，不自动放行。
const INTERPRETER_PROGRAMS = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun']);
const DEFAULT_SENSITIVE_COMMAND_PATTERNS = new RegExp([
  String.raw`\brm\s+-[a-z]*[rf]`,
  String.raw`\bremove-item\b[^\n]*-(recurse|force)`,
  String.raw`\bdel\s+/[sfq]`,
  String.raw`\bformat\s+[a-z]:`,
  String.raw`\bmkfs\b`,
  String.raw`\bdiskpart\b`,
  String.raw`\bgit\s+push\b[^\n]*(--force|-f\b)`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bgit\s+clean\s+-[a-z]*f`,
  String.raw`\b(npm|pnpm|yarn)\s+publish\b`,
  String.raw`\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b`,
  String.raw`\b(iex|invoke-expression)\b`,
  String.raw`\b(sudo|runas)\b`,
  String.raw`\breg\s+(add|delete)\b`,
  String.raw`\bsc\s+delete\b`,
  String.raw`\bnet\s+user\b`,
  String.raw`\b(icacls|takeown|bcdedit)\b`,
  String.raw`\b(shutdown|reboot|taskkill)\b`,
  String.raw`\bchmod\s+777\b`,
  String.raw`[\\/]\.ssh[\\/]id_`,
  String.raw`(^|[\\/\s])\.env\b`,
  String.raw`[\\/]\.aws[\\/]`,
  String.raw`[\\/]\.npmrc\b`,
  String.raw`[\\/]\.netrc\b`,
].join('|'), 'i');

function rememberPreExecuteArgs(exec) {
  const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
  const callId = exec?.callId != null ? String(exec.callId) : null;
  if (!sessionId || !callId || !sessionMember.has(sessionId)) return;
  preExecuteArgs.set(`${sessionId}:${callId}`, {
    name: String(exec.name || ''),
    args: exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {},
    at: Date.now(),
  });
  while (preExecuteArgs.size > PRE_EXECUTE_MAX) {
    const oldest = preExecuteArgs.keys().next().value;
    if (oldest == null) break;
    preExecuteArgs.delete(oldest);
  }
}

function cachedPreExecuteArgs(sessionId, callId) {
  const key = `${sessionId}:${callId}`;
  const hit = preExecuteArgs.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PRE_EXECUTE_TTL_MS) {
    preExecuteArgs.delete(key);
    return null;
  }
  return hit;
}

/**
 * 低风险命令判定：白名单程序 + 禁止重定向/命令替换/脚本块 + 敏感规则。
 * 允许管道（每段都按白名单校验）与 `&&`/`||`/`;` 串联，覆盖 `git status | head`、
 * `Get-ChildItem | Where-Object` 这类只读排查命令。
 * 这是启发式而非完整 shell 解析——宁可漏放行（转 Lead），也不误放行。
 */
function isLowRiskCommand(command, extraPatterns = []) {
  const text = String(command || '').trim();
  if (!text || text.length > 2000) return false;
  // `<>` 重定向、反引号、$() 命令替换、换行、{} 脚本块（ForEach-Object/Where-Object 的代码）
  if (/[<>`{}]|\$\(|\n|\r/.test(text)) return false;
  if (DEFAULT_SENSITIVE_COMMAND_PATTERNS.test(text)) return false;
  for (const pattern of extraPatterns) {
    try { if (new RegExp(pattern, 'i').test(text)) return false; } catch { /* 非法正则忽略 */ }
  }
  // 先按命令分隔符切成简单命令，再按单管道切段；空段（尾随 `|`）视为异常，宁可转 Lead。
  for (const chain of text.split(/&&|\|\||;/)) {
    if (!chain.trim()) continue;
    for (const seg of chain.split('|')) {
      const part = seg.trim();
      if (!part) return false;
      const words = part.split(/\s+/);
      const prog = words[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
      if (!SAFE_COMMAND_PROGRAMS.has(prog)) return false;
      if (INTERPRETER_PROGRAMS.has(prog) && words.slice(1).some((w) => /^(-e|-c|--eval|--command|\/c)$/i.test(w))) return false;
    }
  }
  return true;
}

/** 工具名匹配：精确或 `*` 通配（大小写不敏感），用于 autoApproveTools 白名单。 */
function toolNameMatches(pattern, name) {
  const target = String(name || '');
  if (!pattern || !target) return false;
  if (!pattern.includes('*')) return pattern.toLowerCase() === target.toLowerCase();
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(target);
}

function isAutoApprovedTool(patterns, ...names) {
  return (patterns || []).some((pattern) => names.some((name) => toolNameMatches(pattern, name)));
}

function settleApproval(s, requestId, decision, reason, decidedBy) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) return null;
  pendingApprovals.delete(requestId);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener?.('abort', entry.onAbort);
  const outcome = decision === 'allow' || decision === 'allowed-once'
    ? 'allowed-once'
    : decision === 'cancelled' ? 'cancelled' : 'rejected';
  const recorded = outcome === 'allowed-once' ? 'allowed' : outcome;
  entry.resolve(outcome);
  void request(s, `/api/approvals/${encodeURIComponent(requestId)}/decide`, {
    method: 'POST',
    body: { decision: recorded, decidedBy: decidedBy || 'lead', ...(reason ? { reason } : {}) },
  }).catch(() => { /* 审计镜像失败不影响审批本身 */ });
  return entry;
}

function cancelPendingApprovals() {
  for (const [requestId, entry] of [...pendingApprovals]) {
    pendingApprovals.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    entry.resolve('cancelled');
  }
}

async function notifyLeadOfApproval(s, ctx, req, info) {
  const subs = subagentsOf(ctx);
  if (!subs || typeof subs.sendMessage !== 'function' || !req?.agent) return false;
  const team = await teamOf(s, info.teamId);
  const leadId = leadByTeam.get(info.teamId)?.id != null
    ? String(leadByTeam.get(info.teamId).id)
    : (team.leadSessionId ? String(team.leadSessionId) : null);
  if (!leadId) return false;
  const minutes = Math.max(1, Math.round(s.approvalTimeoutMs / 60000));
  const text = [
    '【dsh-team 权限审批】',
    `teamId=${info.teamId}`,
    `memberId=${info.memberId}`,
    `memberName=${info.memberName || info.memberId}`,
    `toolName=${info.toolName || '(unknown)'}`,
    ...(info.reason ? [`reason：${clip(info.reason, 500)}`] : []),
    `requestId=${info.requestId}`,
    '',
    `成员因 permissionPreset「${info.preset || 'unknown'}」的审批策略暂停，等待你决定。`,
    `批准本次操作：team_approve({ teamId: "${info.teamId}", requestId: "${info.requestId}", decision: "allow" })`,
    `拒绝：把 decision 改成 "deny"（可加 reason）。`,
    `超过 ${minutes} 分钟未决定将自动拒绝。`,
  ].join('\n');
  await subs.sendMessage(req.agent, leadId, [{ type: 'text', text }], { signal: AbortSignal.timeout(s.requestTimeoutMs) });
  return true;
}

async function onApprovalRequest(s, ctx, req, next) {
  const sessionId = req?.agent?.id != null ? String(req.agent.id) : null;
  const binding = sessionId ? sessionMember.get(sessionId) : null;
  // 不是本插件的成员：交回 DSH 原有审批链路（Lead 自己的审批仍走宿主 UI）。
  if (!binding) return next();

  const requestId = String(req.id ?? req.requestId ?? `${sessionId}:${Date.now()}`);
  const info = {
    requestId,
    teamId: binding.teamId,
    memberId: binding.memberId,
    memberName: binding.name || null,
    sessionId,
    toolName: String(req.toolName || ''),
    reason: String(req.reason || ''),
    preset: binding.permissionPreset || null,
  };
  // 同一个请求重复进入（理论上不会）直接拒绝，避免两个 waiter 争同一个 id。
  if (pendingApprovals.has(requestId)) return 'rejected';

  // 自动放行（两条独立通道，命中即 allowed-once，镜像 decidedBy:"auto"，不打扰 Lead）：
  // ① autoApproveTools：显式工具白名单（支持 *），不依赖参数；
  // ② autoApproveLowRisk：工具名像 shell、参数里带 command、且命令通过白名单校验。
  const cached = sessionId && req?.callId != null ? cachedPreExecuteArgs(sessionId, String(req.callId)) : null;
  const cachedToolName = String(cached?.name || '');
  const autoApprove = (autoReason) => {
    void request(s, '/api/approvals', {
      method: 'POST',
      body: {
        id: requestId, teamId: info.teamId, memberId: info.memberId,
        sessionId, toolName: info.toolName, reason: autoReason,
      },
    }).then(() => request(s, `/api/approvals/${encodeURIComponent(requestId)}/decide`, {
      method: 'POST', body: { decision: 'allowed', decidedBy: 'auto', reason: autoReason },
    })).catch(() => { /* 镜像失败不影响放行 */ });
    return 'allowed-once';
  };
  if (isAutoApprovedTool(s.autoApproveTools, cachedToolName, info.toolName)) {
    return autoApprove(`工具白名单自动放行：${info.toolName || cachedToolName}`);
  }
  if (s.autoApproveLowRisk && cached) {
    const toolName = String(cached.name || info.toolName || '');
    const command = cached.args?.command;
    if (SHELL_TOOL_RE.test(toolName) && typeof command === 'string' && isLowRiskCommand(command, s.sensitiveCommandPatterns)) {
      return autoApprove(`低风险命令自动放行：${clip(command, 300)}`);
    }
  }

  // 先镜像到 sidecar，面板/报告可见；失败不影响审批。
  void request(s, '/api/approvals', {
    method: 'POST',
    body: { id: requestId, teamId: info.teamId, memberId: info.memberId, sessionId, toolName: info.toolName, reason: info.reason },
  }).catch(() => { /* ignore */ });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingApprovals.delete(requestId)) return;
      resolve('rejected');
      void request(s, `/api/approvals/${encodeURIComponent(requestId)}/decide`, {
        method: 'POST', body: { decision: 'expired', decidedBy: 'timeout', reason: 'approval timeout' },
      }).catch(() => {});
    }, s.approvalTimeoutMs);
    timer.unref?.();

    const onAbort = () => {
      if (!pendingApprovals.delete(requestId)) return;
      clearTimeout(timer);
      resolve('cancelled');
      void request(s, `/api/approvals/${encodeURIComponent(requestId)}/decide`, {
        method: 'POST', body: { decision: 'cancelled', decidedBy: 'abort', reason: 'member turn aborted' },
      }).catch(() => {});
    };

    pendingApprovals.set(requestId, { ...info, resolve, timer, signal: req.signal, onAbort });
    if (req.signal) req.signal.addEventListener?.('abort', onAbort, { once: true });

    notifyLeadOfApproval(s, ctx, req, info).then((ok) => {
      if (ok) return;
      // 通知不到 Lead（服务缺失/没有 lead 会话）：立刻拒绝，别让成员干等。
      const entry = pendingApprovals.get(requestId);
      if (entry) settleApproval(s, requestId, 'deny', '无法通知 Lead', 'system');
    }).catch(() => {
      const entry = pendingApprovals.get(requestId);
      if (entry) settleApproval(s, requestId, 'deny', '通知 Lead 失败', 'system');
    });
  });
  return outcome;
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
/** Lead 主动 interrupt 后冻结的会话：在 resume 前忽略其 idle / turn-error 回报。 */
const heldSessions = new Set();

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

/** 成员会话被替换/移除后，清掉插件侧所有指向旧 session 的绑定。 */
function forgetSession(sessionId) {
  if (sessionId == null) return;
  const sid = String(sessionId);
  cancelIdleReport(sid);
  cancelStartWatchdog(sid);
  heldSessions.delete(sid);
  agentStatusBySession.delete(sid);
  sessionMember.delete(sid);
  for (const key of [...preExecuteArgs.keys()]) {
    if (key.startsWith(`${sid}:`)) preExecuteArgs.delete(key);
  }
}

/**
 * 释放成员子会话：优先 drainChildren（从父会话摘除并结束），
 * 旧版 subagents 没有该能力时退回 interrupt。
 */
async function releaseSession(subs, caller, sessionId) {
  if (!sessionId) return { ok: true, method: 'none' };
  const sid = String(sessionId);
  if (typeof subs?.drainChildren === 'function') {
    try {
      await subs.drainChildren(caller, [sid]);
      return { ok: true, method: 'drainChildren' };
    } catch (err) {
      if (typeof subs?.interrupt !== 'function') return { ok: false, error: String(err?.message || err) };
    }
  }
  if (typeof subs?.interrupt === 'function') {
    try {
      await subs.interrupt(sid, { kind: 'ancestor', agent: caller });
      return { ok: true, method: 'interrupt' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  return { ok: false, error: 'subagents 服务不支持 drainChildren/interrupt' };
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

/** sessionId → 最近一次从 sidecar 看到的成员状态；用于只强制中断一次。 */
const forceStopSeen = new Map();

/**
 * 面板/看板停止只走 sidecar（不经过 Host 插件），sidecar 改不了 DSH 会话。
 * 这里轮询成员状态：一旦看到 running → interrupted，就用登记的直接父会话
 * 以 user 授权调用 subagents.interrupt，真正停掉成员当前回合，并冻结该会话，
 * 防止 DSH 中断后的 idle 又把成员改回 idle。
 */
async function forceStopPump(s, ctx) {
  const subs = subagentsOf(ctx);
  if (!subs || typeof subs.interrupt !== 'function') return;
  const status = await readStatus(s);
  if (!status || !Array.isArray(status.members)) return;
  const live = new Set();
  for (const m of status.members) {
    const sid = m?.agentSessionId != null ? String(m.agentSessionId) : null;
    if (!sid) continue;
    live.add(sid);
    const prev = forceStopSeen.get(sid);
    forceStopSeen.set(sid, m.status);
    if (m.status !== 'interrupted' || prev === 'interrupted') continue;
    if (heldSessions.has(sid)) continue;
    const parentSessionId = m.parentSessionId != null ? String(m.parentSessionId) : null;
    if (!parentSessionId) continue;
    heldSessions.add(sid);
    cancelIdleReport(sid);
    cancelStartWatchdog(sid);
    agentStatusBySession.set(sid, 'interrupted');
    try {
      await Promise.resolve(subs.interrupt(sid, { kind: 'user', parentSessionId }));
    } catch {
      // 会话可能已经结束；撤销冻结并清掉 seen，让下一跳还能重试。
      heldSessions.delete(sid);
      forceStopSeen.delete(sid);
    }
  }
  for (const sid of forceStopSeen.keys()) if (!live.has(sid)) forceStopSeen.delete(sid);
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

/**
 * 面板 steer 队列的投递泵。
 *
 * 面板（或任何外部调用）只把 `kind='steer'` 的消息写进 sidecar 信箱，sidecar 不会自己送进成员会话；
 * 这里定时取 queued 的 steer 消息，用 `subagents.sendMessage` 推进成员会话后补记送达。
 * - `payload.immediate=true`（面板 ⌘/Ctrl+↵ 或队列 chip 的「Now」）排到最前，只是优先投递，不打断当前回合；
 * - 每个成员每轮只投一条，避免一次性灌爆成员上下文；
 * - 投递失败保持 queued，下一轮重试；成员已无会话（worker / 已回收）就留在队列里等人工处理。
 */
const steerInFlight = new Set();

async function steerPump(s, ctx) {
  if (!sessionMember.size) return;
  const subs = subagentsOf(ctx);
  if (!subs || typeof subs.sendMessage !== 'function') return;
  const teams = new Set();
  for (const binding of sessionMember.values()) if (binding?.teamId) teams.add(binding.teamId);

  for (const teamId of teams) {
    const caller = leadByTeam.get(teamId);
    if (!caller) continue;
    const res = await request(
      s,
      `/api/messages${qs({ team: teamId, status: 'queued', limit: 100 })}`,
    ).catch(() => null);
    const rows = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
    const items = rows.filter(
      (m) => m && m.kind === 'steer' && m.to && m.to !== 'lead' && m.status === 'queued' && !steerInFlight.has(m.id),
    );
    items.sort((a, b) => {
      const priority = Number(!!b.payload?.immediate) - Number(!!a.payload?.immediate);
      return priority || String(a.sentAt || '').localeCompare(String(b.sentAt || ''));
    });

    const taken = new Set();
    for (const message of items) {
      const target = String(message.to);
      if (taken.has(target)) continue;            // 每个成员每轮只投一条
      const binding = [...sessionMember.entries()].find(
        ([, b]) => b && b.memberId === target && b.teamId === teamId,
      );
      if (!binding) continue;                     // 该成员没有 sub-agent 会话：留队列，等重新 spawn
      taken.add(target);
      const text = String(message.payload?.text || '').trim();
      if (!text) { await markDelivered(s, message.id); continue; }
      steerInFlight.add(message.id);
      try {
        await subs.sendMessage(caller, String(binding[0]), [{ type: 'text', text }], {
          signal: AbortSignal.timeout(s.requestTimeoutMs),
        });
        await markDelivered(s, message.id);
      } catch { /* 成员会话暂时不可写：保持 queued，下一轮重试 */ }
      finally { steerInFlight.delete(message.id); }
    }
  }
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
  description: 'One plan step / brief line handed to the member sub-agent. Purely descriptive: the member executes it with its own tools.',
  properties: {
    step: { type: 'string', description: 'Step label, e.g. S1.' },
    phase: {
      type: 'string',
      description: 'Optional phase used in the timeline: init|read|write|exec|net|env|msg|wait|verify|done|fail.',
    },
    action: { type: 'string', description: 'Verb shown in the timeline, e.g. write / read / exec.' },
    target: { type: 'string', description: 'File path, command, host, or env name this step touches.' },
    op: { type: 'object', additionalProperties: true, description: 'Optional legacy detail (ignored by the sidecar).' },
    fatal: { type: 'boolean' },
  },
  required: ['step'],
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


// ---------------------------------------------------------------------------
// 工作区看板：Host 侧调度
//
// sidecar 只负责状态/并发/claim；这里按 claim 结果创建根会话并投 prompt。
// 规划默认只读，执行用 danger-full-access（无人值守会话不能停在审批 UI）。
// ---------------------------------------------------------------------------
const boardSessions = new Map(); // sessionId -> { taskId, phase, handle, sawRunning }
const boardSessionIds = new Set();

function boardUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  };
}

function boardRoute(task, settings, kind) {
  const one = (provider, model, reasoningEffort) => (model
    ? { ...(provider ? { provider } : {}), model, ...(reasoningEffort ? { reasoningEffort } : {}) }
    : null);
  const list = kind === 'planning'
    ? [
      [task.planRoute?.provider, task.planRoute?.model, task.planRoute?.reasoningEffort],
      [settings.planProvider, settings.planModel, settings.planReasoningEffort],
      [task.leadRoute?.provider, task.leadRoute?.model, task.leadRoute?.reasoningEffort],
      [settings.leadProvider, settings.leadModel, settings.leadReasoningEffort],
    ]
    : [
      [task.leadRoute?.provider, task.leadRoute?.model, task.leadRoute?.reasoningEffort],
      [settings.leadProvider, settings.leadModel, settings.leadReasoningEffort],
    ];
  for (const [provider, model, effort] of list) {
    const route = one(provider, model, effort);
    if (route) return route;
  }
  return undefined;
}

function boardRouteOrDefault(ctx, task, settings, kind) {
  const route = boardRoute(task, settings, kind);
  if (route) return route;
  try {
    const cur = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (cur?.model) return { ...(cur.provider ? { provider: cur.provider } : {}), model: cur.model };
  } catch { /* ignore */ }
  return undefined;
}

function boardSetPermission(ctx, agent, preset) {
  if (!preset) return { applied: false };
  const svc = permissionPresetsOf(ctx);
  if (!svc || typeof svc.set !== 'function') return { applied: false, reason: 'permissionPresets 不可用' };
  try {
    svc.set(agent.session, preset);
    return { applied: true, preset };
  } catch (err) {
    return { applied: false, preset, error: String(err?.message || err) };
  }
}

/**
 * Prewalk（实验性）：规划完成后，把同一个会话交给执行模型继续跑。
 *
 * 走 DSH 的会话级模型选择（`sessionController.agents.selectForNextRequest`，与 Web UI
 * 里切换模型同一条链路）：只改这一个会话下一次装配用的模型，并让下一轮请求前补一条
 * "model changed" 通知；会话历史、工具结果、todo、已经改过的文件全部留在原地，
 * 不新建会话、也不改部署默认模型。失败时保持原模型继续执行，不阻断任务。
 */
async function boardApplyPrewalk(ctx, agent, task, settings) {
  const target = boardRoute(task, settings || {}, 'inprogress');
  if (!target?.model) return { switched: false, reason: '没有可用的执行模型' };
  let controller;
  try { controller = ctx.get('sessionController'); } catch { controller = undefined; }
  const sessions = controller?.agents;
  if (!sessions || typeof sessions.selectionFor !== 'function' || typeof sessions.selectForNextRequest !== 'function') {
    console.warn('[dsh-team] prewalk: 当前 Host 不支持会话内切换模型，保持规划模型继续执行');
    return { switched: false, reason: 'sessionController 不可用' };
  }
  let selection = {
    ...(target.provider ? { provider: target.provider } : {}),
    model: target.model,
    ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
  };
  const llm = llmOf(ctx);
  if (llm && typeof llm.resolveCallConfig === 'function') {
    try {
      const resolved = await llm.resolveCallConfig(selection);
      selection = {
        ...(resolved?.provider ? { provider: resolved.provider } : selection),
        model: resolved?.model || selection.model,
        ...(resolved?.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
      };
    } catch (err) {
      console.warn(`[dsh-team] prewalk: 执行模型不可用（${String(err?.message || err)}），保持规划模型继续执行`);
      return { switched: false, reason: '执行模型不可用' };
    }
  }
  let current;
  try { current = sessions.selectionFor(agent)?.current; } catch { current = undefined; }
  if (current && current.model === selection.model
    && (current.provider || undefined) === (selection.provider || undefined)
    && (current.reasoningEffort || undefined) === (selection.reasoningEffort || undefined)) {
    return { switched: false, reason: '已经是执行模型' };
  }
  try {
    sessions.selectForNextRequest(agent, selection);
  } catch (err) {
    console.warn(`[dsh-team] prewalk: 切换模型失败（${String(err?.message || err)}），保持规划模型继续执行`);
    return { switched: false, reason: '切换模型失败' };
  }
  console.log(`[dsh-team] prewalk: 任务 ${task.id} 已落到实现，会话 ${String(agent.id)} 切到 ${selection.provider || '默认'}/${selection.model} 继续执行`);
  return { switched: true, selection };
}

/**
 * 触发 prewalk 交接的「实现动作」。
 *
 * 对齐官方语义：不在计划提交时切换，而是等规划模型在同一条会话里落下第一笔实现
 * 动作之后（首个 edit/write 类工具结果；团队任务则是 Lead 的首次 team_task 派发），
 * 再把剩下的活交给执行模型，避免便宜模型接手后才发现计划不可执行。
 */
const PREWALK_EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const PREWALK_DISPATCH_TOOLS = new Set(['team_task']);

/** 执行阶段已武装、等待首次实现动作的会话：sessionId → { task, settings }。 */
const prewalkArmed = new Map();

function boardPrewalkWantsTool(name) {
  return PREWALK_EDIT_TOOLS.has(name) || PREWALK_DISPATCH_TOOLS.has(name);
}

/** 会话里是否已经出现过实现动作（插件重启 / 会话恢复后据此立即补一次交接）。 */
function boardSessionStartedImplementation(agent) {
  try {
    const session = agent?.session;
    if (!session || typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return false;
    const callIds = new Set();
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq);
      if (!event) continue;
      if (event.type === 'tool/call' && boardPrewalkWantsTool(String(event.data?.name || ''))) {
        callIds.add(String(event.data?.callId || ''));
      } else if (event.type === 'tool/result') {
        const ok = event.data?.message?.isError !== true;
        if (ok && callIds.has(String(event.data?.message?.toolCallId || ''))) return true;
      }
    }
    return false;
  } catch { return false; }
}

/**
 * 交接 steering：只说「继续」。
 * 计划、todo、已读文件与已做改动都在会话上下文里，任何附加清单都会诱导接手模型
 * 逐条核对、重新读文件；让它接着上文做完即可。
 */
function boardPrewalkSteering() {
  return '继续';
}

/** 交接：切到执行模型并注入一条简短的继续指令；一次任务只做一次。 */
async function boardHandoffPrewalk(ctx, agent, task, settings) {
  const sessionId = agent?.id != null ? String(agent.id) : null;
  if (sessionId) prewalkArmed.delete(sessionId);
  const result = await boardApplyPrewalk(ctx, agent, task, settings || {});
  if (!result?.switched) return result;
  const steering = boardPrewalkSteering();
  try {
    if (typeof agent.steer === 'function') agent.steer(boardUserMessage(steering));
    else if (typeof agent.followup === 'function') agent.followup(boardUserMessage(steering));
    console.log(`[dsh-team] prewalk: 继续指令已注入会话 ${sessionId}`);
  } catch (err) {
    console.warn(`[dsh-team] prewalk: 注入继续指令失败（${String(err?.message || err)}）`);
  }
  return result;
}

/**
 * 武装 prewalk：记录待交接，等首个实现动作再切模型。
 * 恢复/重启时如果实现动作已经发生过，直接交接，避免规划模型继续用着贵模型干完。
 */
async function armBoardPrewalk(ctx, agent, task, settings) {
  const sessionId = agent?.id != null ? String(agent.id) : null;
  if (!sessionId || !agent || !task?.prewalk) return false;
  if (boardSessionStartedImplementation(agent)) {
    await boardHandoffPrewalk(ctx, agent, task, settings);
    return true;
  }
  if (!prewalkArmed.has(sessionId)) prewalkArmed.set(sessionId, { task, settings: settings || {} });
  return false;
}

function boardPromptModels(task) {
  return Array.isArray(task.teamModels) && task.teamModels.length
    ? task.teamModels.map((m) => (typeof m === 'string' ? m : `${m.provider ? m.provider + '/' : ''}${m.model}`)).join('\n')
    : '不限制';
}

// 看板任务的 git 分支：任务开启分支时，spawn 前先切好（不存在就从当前 HEAD 新建）。
// git 是可选能力：目录不是仓库 / 没装 git / 切换失败都不阻断任务，只在 prompt 里降级说明。
function gitRun(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureBoardGitBranch(task) {
  const branch = String(task?.gitBranch || '').trim();
  if (!branch) return { branch: null, ok: true };
  const cwd = String(task.workspacePath || '').trim();
  if (!cwd) return { branch, ok: false, reason: '工作区路径为空' };
  try {
    if (gitRun(cwd, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      return { branch, ok: false, reason: '工作区不是 git 仓库' };
    }
  } catch {
    return { branch, ok: false, reason: '工作区不是 git 仓库，或本机没有 git' };
  }
  try {
    const cur = gitRun(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (cur === branch) return { branch, ok: true };
  } catch { /* 空仓库没有 HEAD，继续尝试新建分支 */ }
  let exists = false;
  try {
    gitRun(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    exists = true;
  } catch { exists = false; }
  try {
    gitRun(cwd, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
    return { branch, ok: true, created: !exists };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
    console.warn(`[dsh-team] board git branch ${branch} checkout failed: ${msg}`);
    return { branch, ok: false, reason: msg || 'git 切分支失败' };
  }
}

// prompt 里的分支说明：正常时一句话告知「已在目标分支上」；失败时允许自行补救但不强制。
function boardBranchLines(task) {
  const branch = String(task?.gitBranch || '').trim();
  if (!branch) return [];
  const st = task.gitBranchState;
  if (!st || st.ok) {
    return [`git 分支：${branch}（会话开始前已切好，直接在该分支上改文件；不要自行 checkout 其他分支）`];
  }
  return [
    `git 分支：目标是 ${branch}，但自动切分支失败（${st.reason || '未知原因'}）。`
    + `可以用 shell 执行 git checkout -b ${branch}（已存在则 git checkout ${branch}）后继续；`
    + '如果仍失败，就在当前分支继续完成工作，并在最终汇报里明确说明分支未切换。',
  ];
}

function boardPlanningPrompt(task, settings) {
  const useTeam = task.useTeam !== false;
  // 同会话模式：规划与执行是同一个会话，board_plan_submit 会直接领执行槽位，
  // 所以执行规则从一开始就写进规划 prompt，提交后不再补发「现在开始执行」。
  const sameSession = task.executionMode === 'same';
  const models = boardPromptModels(task);
  const head = [
    `你是「${task.title}」的规划 Agent。`,
    sameSession
      ? '这一轮先只做规划，不要写代码、不要修改文件、不要创建团队。'
      : '只做规划，不写代码、不修改文件、不创建团队。',
    sameSession
      ? '计划提交后读取 board_plan_submit 的返回：status 是 inprogress 就直接在同一会话里按计划开始执行（此时可以写文件、可以调用 team_*）；status 是 planned 说明执行槽位已满，立刻停下等待调度器。'
      : '规划完成后不要开始执行；调度器会在执行槽位空出后，在同一会话里让你继续。',
    '',
    `工作区：${task.workspacePath}`,
    ...boardBranchLines(task),
    '任务描述：',
    task.description || '(无)',
    '',
  ];
  const body = useTeam
    ? [
      '可用模型（成员分配只能从这里选）：',
      models,
      '',
      '开始规划前，先加载 `dsh-agent-team` 技能（调用 skill 工具，参数 {"name":"dsh-agent-team"}），按技能里的团队编排流程与工具字段规划。',
      '',
      '请先阅读必要文件，然后输出一份可执行计划，必须包含：',
      '1. 目标与验收标准',
      '2. 实施步骤（到文件/模块级）',
      '3. 团队与成员建议（每个成员的角色、模型、依赖关系；按能力域合并，同一模块或相邻功能优先交给同一个成员，能一人完成就不要拆成多人）',
      '4. 风险与回滚',
    ]
    : [
      '本任务不开启团队：执行阶段由单个 Agent 独立完成，不需要规划成员或 DAG。',
      '',
      '请先阅读必要文件，然后输出一份可执行计划，必须包含：',
      '1. 目标与验收标准',
      '2. 实施步骤（到文件/模块级）',
      '3. 风险与回滚',
    ];
  return [
    ...head,
    ...body,
    '',
    '最后必须调用 board_plan_submit({ plan: "<完整 markdown>", summary: "<一句话>" })。',
    '不要只把计划写在回复里。',
    ...(sameSession
      ? ['', '提交后如果返回 inprogress，继续按下面的规则执行；返回 planned 则忽略这些规则并停下：', '', ...boardLeadRules(task)]
      : ['提交后停下，等待执行指令。']),
  ].join('\n');
}

function boardLeadRules(task) {
  const useTeam = task.useTeam !== false;
  const models = boardPromptModels(task);
  // 任务已有关联团队（重试、失败后继续、或完成后再次执行）时，在原团队上接着干，
  // 不要每轮都 team_create 出一个新团队。
  const teams = Array.isArray(task.teams) ? task.teams.filter(Boolean).map(String) : [];
  const teamRule = teams.length
    ? `1. 本任务已关联团队：${teams.join('、')}。不要调用 team_create 新建团队：先 team_status 查看这些团队的现状，`
      + '在原团队里用 team_task 追加剩余工作继续推进；已经完成的成员任务不要重复创建。'
      + '只有原团队已被删除或全部不可用时，才允许 team_create 新团队（若既有团队需要继续保留、只是要并行新建，必须显式传 force: true）。'
    : '1. 先调用 team_create 创建团队；name 用任务标题，workspace 用上面的路径。需要多个团队就多次创建，所有团队都会自动绑定到本任务。';
  const teamRules = [
    '开始执行前，先加载 `dsh-agent-team` 技能（调用 skill 工具，参数 {"name":"dsh-agent-team"}），按技能里的团队编排流程、工具字段与常见错法执行，不要凭记忆猜参数。',
    '',
    '规则：',
    teamRule,
    '2. 调用 team_models 查看可用路由；只能使用以下模型：',
    models,
    '3. 用 team_task 拆解并派发；用 team_status / team_report 跟踪。不要自己写代码，不要重复成员的工作。成员按能力域分配：同一模块/相邻功能、或一个成员能顺手做完的多个条目，合并给同一个成员；成员数取能完成工作的最小值，不要按需求条目数量等量创建成员。',
    '4. 用户反馈 Bug 时，不要自己去读代码排查：先判断归属成员，用 team_send 把复现步骤与怀疑点派给对应成员定位、修复；你只做分派、汇总与状态汇报。',
    '5. 每轮结束前必须先调用 board_task_status 对齐状态：全部任务成功→done（附完成摘要），失败→failed（附原因），仍需继续或等待用户→inprogress。不能只在开始时调用一次。',
    '6. 用户再次发消息时，先调用 board_task_status({ status: "inprogress" })，再继续处理。',
  ];
  const soloRules = [
    '本任务不开启团队：由你自己直接完成所有工作，不要调用 team_create / team_spawn / team_task。',
    '',
    '规则：',
    '1. 按任务描述直接修改文件、运行命令并验证结果。',
    '2. 每轮结束前必须先调用 board_task_status 对齐状态：全部完成→done（附完成摘要），失败→failed（附原因），仍需继续或等待用户→inprogress。不能只在开始时调用一次。',
    '3. 用户再次发消息时，先调用 board_task_status({ status: "inprogress" })，再继续处理。',
  ];
  return useTeam ? teamRules : soloRules;
}

function boardLeadPrompt(task, sameSession) {
  const useTeam = task.useTeam !== false;
  const needPlan = task.needPlan !== false;
  // 同会话执行：计划已经在同一会话的上文里，不再重复注入任务描述与 plan 全文。
  const rules = boardLeadRules(task);
  if (sameSession) {
    return [
      `现在开始执行「${task.title}」。计划就在同一会话的上文里，不要重复输出计划。`,
      ...boardBranchLines(task),
      '',
      ...rules,
    ].join('\n');
  }
  const lines = [
    `你是任务「${task.title}」的${useTeam ? ' Lead' : '执行 Agent'}。工作区：${task.workspacePath}`,
    ...boardBranchLines(task),
    needPlan ? '以下是规划会话产出的计划，现在开始执行。' : '本任务不需要规划，直接开始执行。',
    '',
    '任务描述：',
    task.description || '(无)',
  ];
  if (needPlan) lines.push('', '已确认的计划：', task.planMd || '(无)');
  lines.push('', ...rules);
  return lines.join('\n');
}

async function boardTaskOf(s, sessionId) {
  if (!sessionId) return null;
  try {
    const r = await request(s, `/api/board/by-session/${encodeURIComponent(sessionId)}`);
    return r && r.id ? r : null;
  } catch { return null; }
}

async function bindBoardTeam(s, exec, teamId) {
  const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
  if (!sessionId || !teamId) return;
  try {
    const task = await boardTaskOf(s, sessionId);
    if (task) await request(s, `/api/board/tasks/${encodeURIComponent(task.id)}/teams`, { method: 'POST', body: { teamId } });
  } catch { /* 绑定失败不影响团队创建 */ }
}

/**
 * 重试/续跑出来的 Lead 会话（spawn 时任务已有团队）默认禁止重复建队：
 * 提示词是软约束，这里做成硬约束，避免模型不听话又多出一个团队。
 * 只有 `force:true` 或原团队全部已被删除/归档时才放行。
 */
async function guardBoardTeamReuse(s, sessionId, force) {
  if (force || !sessionId) return;
  const rec = boardSessions.get(String(sessionId));
  if (!rec?.reusedRun) return;
  const task = await boardTaskOf(s, String(sessionId));
  const teamIds = Array.isArray(task?.teams) ? task.teams.filter(Boolean).map(String) : [];
  if (!teamIds.length) return;
  const alive = [];
  for (const id of teamIds) {
    try {
      const team = await request(s, `/api/teams/${encodeURIComponent(id)}`);
      if (team && !team.archivedAt) alive.push(`${team.id}（${team.name || '未命名'}）`);
    } catch { /* 团队已不存在 */ }
  }
  if (!alive.length) return;
  throw new Error(
    `本任务已关联团队：${alive.join('、')}。重试/续跑请在原团队上继续：先用 team_status 查看现状，再用 team_task 追加剩余工作，不要重复 team_create。`
    + '确实需要与之并行新建团队时，调用 team_create 并显式传 force: true。',
  );
}

/**
 * 把看板会话挂进 DSH 工作区会话账本，让它在「工作区会话」列表里可见。
 * 受看板设置 showTaskSessions 控制（缺省开启）；失败只告警，不影响任务推进。
 */
async function attachBoardSessionToWorkspace(ctx, task, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.get !== 'function' || !task.workspaceId) return;
    const workspace = registry.get(task.workspaceId);
    if (!workspace || typeof workspace.attachSession !== 'function') return;
    await workspace.attachSession(String(sessionId));
  } catch (err) {
    console.warn(`[dsh-team] attach board session to workspace failed: ${String(err?.message || err)}`);
  }
}

async function spawnBoardSession(s, ctx, item) {
  const { task, workspace, settings, fence } = item;
  const agents = (() => { try { return ctx.get('agents'); } catch { return undefined; } })();
  if (!agents || typeof agents.create !== 'function') throw new Error('agents 服务不可用：无法创建看板会话');

  const kind = task.status === 'planning' ? 'planning' : 'inprogress';
  // spawn 时任务已有团队（重试、失败后续跑、或再次执行）→ 该会话属于续跑，
  // 允许复用既有团队但默认禁止再建新团队（见 guardBoardTeamReuse）。
  const hadTeams = Array.isArray(task.teams) && task.teams.filter(Boolean).length > 0;
  // 任何已有 Lead 会话的 inprogress 都复用该会话：same 模式的首轮、
  // 以及 new 模式完成后用户追问，都不能再新建会话。
  const sameSession = kind === 'inprogress' && !!task.leadSessionId;

  // 任务指定 git 分支时，在拉起/复用任何会话之前切好：分支是仓库级状态，会话 cwd 不变，
  // 同会话续跑也直接落在目标分支上。结果只挂到本地 task 供本轮 prompt 文案使用。
  task.gitBranchState = ensureBoardGitBranch(task);

  // 同会话执行：复用规划会话，只切权限 + 投执行 prompt。
  if (sameSession) {
    const sessionId = String(task.leadSessionId);
    let agent = boardSessions.get(sessionId)?.handle?.agent;
    if (!agent && typeof agents.get === 'function') {
      try { agent = agents.get(sessionId); } catch { agent = undefined; }
    }
    if (!agent) {
      await request(s, `/api/board/tasks/${encodeURIComponent(task.id)}/release`, {
        method: 'POST', body: { kind: 'inprogress', error: 'session_not_live' },
      }).catch(() => {});
      return;
    }
    await request(s, `/api/board/tasks/${encodeURIComponent(task.id)}/attach`, {
      method: 'POST', body: { kind: 'inprogress', sessionId, fence },
    });
    boardSetPermission(ctx, agent, settings.leadPermissionPreset);
    if (settings.showTaskSessions !== false) await attachBoardSessionToWorkspace(ctx, task, sessionId);
    const rec = boardSessions.get(sessionId) || { taskId: task.id, handle: { agent }, sawRunning: false, reusedRun: hadTeams };
    rec.phase = 'execution';
    rec.sawRunning = false;
    boardSessions.set(sessionId, rec);
    boardSessionIds.add(sessionId);
    // prewalk：只武装交接。规划模型先在同一会话里落下第一笔成功的实现动作，
    // 再由 tools/execute 钩子切模型并注入「继续」；实现动作已经发生（恢复/重启）
    // 则 armBoardPrewalk 会立即交接，不必等下一笔改动。
    if (task.prewalk) await armBoardPrewalk(ctx, agent, task, settings);
    // 用户追问触发 done→inprogress 时，真实用户消息已经在会话里；
    // 这里只恢复状态与权限，不再注入重复的执行 prompt。
    if (!task.resumed) agent.followup(boardUserMessage(boardLeadPrompt(task, true)));
    return;
  }

  // 新建会话：规划或「在新的会话执行」。
  const route = boardRouteOrDefault(ctx, task, settings, kind);
  const requestedPreset = kind === 'planning' ? settings.planAgentPreset : settings.leadAgentPreset;
  let presetId = null;
  try { presetId = await resolveAgentPreset(ctx, requestedPreset, null, s); } catch { presetId = null; }
  // 看板会话是根会话，没有父组合可继承；不显式挂 preset 就只剩宿主级工具
  // （没有 standard 的 shell/文件工具），成员再继承它也会一起缺。
  if (!presetId) presetId = await hostDefaultAgentPreset(ctx);
  const presetSvc = agentPresetsOf(ctx);
  let resolved = null;
  if (presetId && presetSvc && typeof presetSvc.resolve === 'function') {
    try { resolved = await presetSvc.resolve(presetId); } catch { resolved = null; }
  }
  const cwd = task.workspacePath || workspace.path;
  if (!cwd) throw new Error('工作区路径为空');
  fs.mkdirSync(cwd, { recursive: true });
  const sessionId = `session-${randomUUID()}`;
  let handle = null;
  let step = 'create';
  try {
    handle = await agents.create({
      sessionId,
      ...(route ? { agentOptions: route } : {}),
      meta: { cwd, ...(resolved ? { agentPreset: resolved.id } : {}) },
      setup: async (agentCtx) => {
        if (!resolved || !presetSvc || typeof presetSvc.mount !== 'function') return;
        await presetSvc.mount(agentCtx, resolved.id);
      },
    });
    boardSetPermission(ctx, handle.agent, kind === 'planning' ? settings.planPermissionPreset : settings.leadPermissionPreset);
    step = 'attach';
    await request(s, `/api/board/tasks/${encodeURIComponent(task.id)}/attach`, {
      method: 'POST', body: { kind, sessionId, fence },
    });
    if (settings.showTaskSessions !== false) await attachBoardSessionToWorkspace(ctx, task, sessionId);
    boardSessions.set(sessionId, { taskId: task.id, phase: kind, handle, sawRunning: false, reusedRun: hadTeams });
    boardSessionIds.add(sessionId);
    handle.agent.followup(boardUserMessage(kind === 'planning'
      ? boardPlanningPrompt(task, settings)
      : boardLeadPrompt(task, false)));
  } catch (err) {
    console.warn(`[dsh-team] board ${step} failed: ${String(err?.message || err)} cause=${String(err?.cause?.code || err?.cause || '')}`);
    try { await handle?.dispose?.(); } catch { /* ignore */ }
    await request(s, `/api/board/tasks/${encodeURIComponent(task.id)}/release`, {
      method: 'POST', body: { kind, error: String(err?.message || err) },
    }).catch(() => {});
    throw err;
  }
}

async function boardPump(s, ctx) {
  if (!s.boardEnabled) return;
  const agents = (() => { try { return ctx.get('agents'); } catch { return undefined; } })();
  if (!agents || typeof agents.create !== 'function') return;
  // 规划超时：插件崩溃/会话卡死时，避免任务永久占着 planning 槽位。
  try {
    const live = await request(s, '/api/board/live');
    for (const task of live?.tasks || []) {
      // 插件重启后 boardSessions 是空的：能找回 live agent 就接管，找不回就把
      // 永远不可能再推进的任务置 failed，避免占着槽位。
      if (task.status === 'done' || task.status === 'failed') {
        // 规划被 stop/failed 后，规划会话已无用途，直接释放。
        const planSid = task.planningSessionId;
        const planRec = planSid ? boardSessions.get(String(planSid)) : null;
        if (planRec && planRec.phase === 'planning') {
          try { void planRec.handle?.dispose?.(); } catch { /* ignore */ }
          boardSessions.delete(String(planSid));
          boardSessionIds.delete(String(planSid));
        }
        // 终态任务的 Lead 会话仍可能收到用户追问；重启后把它重新纳入监听。
        const sid = task.leadSessionId;
        if (sid && !boardSessionIds.has(String(sid))) {
          let agent = null;
          try { agent = agents.get(String(sid)); } catch { agent = null; }
          if (agent) {
            boardSessions.set(String(sid), {
              taskId: task.id, phase: 'execution', handle: { agent }, sawRunning: false,
            });
            boardSessionIds.add(String(sid));
          }
        }
        continue;
      }
      if (task.status === 'planning' || task.status === 'inprogress') {
        const sid = task.status === 'planning' ? task.planningSessionId : task.leadSessionId;
        if (sid && !boardSessions.has(String(sid))) {
          let agent = null;
          try { agent = agents.get(String(sid)); } catch { agent = null; }
          if (agent) {
            boardSessions.set(String(sid), {
              taskId: task.id, phase: task.status === 'planning' ? 'planning' : 'execution',
              handle: { agent }, sawRunning: true,
            });
            boardSessionIds.add(String(sid));
          } else {
            await request(s, '/api/board/agents/status', {
              method: 'POST',
              body: { sessionId: sid, status: 'failed', summary: '会话已失效（插件重启或会话被关闭）' },
            }).catch(() => {});
          }
        }
      }
      if (task.status !== 'planning') continue;
      const at = Date.parse(task.updatedAt || task.claimedAt || '');
      if (!Number.isFinite(at) || Date.now() - at < s.boardPlanningTimeoutMs) continue;
      if (!task.planningSessionId) {
        await request(s, `/api/board/tasks/${encodeURIComponent(task.id)}/stop`, {
          method: 'POST', body: { reason: '规划超时（未 attach 会话）' },
        }).catch(() => {});
        continue;
      }
      await request(s, '/api/board/agents/status', {
        method: 'POST', body: { sessionId: task.planningSessionId, status: 'failed', summary: '规划超时' },
      }).catch(() => {});
      const rec = boardSessions.get(String(task.planningSessionId));
      if (rec) {
        try { void rec.handle?.dispose?.(); } catch { /* ignore */ }
        boardSessions.delete(String(task.planningSessionId));
        boardSessionIds.delete(String(task.planningSessionId));
      }
    }
  } catch { /* 查询失败不阻塞 claim */ }
  for (const kind of ['planning', 'inprogress']) {
    for (let i = 0; i < 4; i++) {
      let claimed;
      try {
        claimed = await request(s, '/api/board/claim', { method: 'POST', body: { kind } });
      } catch { return; }
      if (!claimed?.item) break;
      try { await spawnBoardSession(s, ctx, claimed.item); }
      catch (err) { console.warn(`[dsh-team] board spawn failed: ${String(err?.message || err)}`); }
    }
  }
}

/** 构造全部工具（普通 ToolDefinition，不依赖 defineTool；参数即 JSON Schema）。 */
function buildTools(s, ctx) {
  const tools = [];

  tools.push({
    name: 'team_create',
    description: 'START HERE to build a working team of agents. Order: team_create({name, workspace, permissionPreset?}) → team_models() to see the enabled provider/model routes → team_spawn({teamId, name, prompt, agentProvider?, model?, reasoningEffort?, permissionPreset?}) once per member, choosing a cheap/fast route for mechanical work and a strong-reasoning route for architecture, debugging, or review → team_task({teamId, subject, assignee?, plan, acceptance}) per DAG node → each member finishes by calling team_report_task → inspect with team_status / team_report. Every member is a real DSH sub-agent session (own model, tools, context, message inbox). `permissionPreset` decides the member sandbox + approval policy (DSH permission presets, e.g. workspace-write or danger-full-access); the team value is the default and team_spawn can override it per member. When a member hits an operation its preset requires approval for, the approval is forwarded to the Lead, who decides with team_approve. `workspace` is an absolute directory shared by the members and becomes their cwd. Keep teamId from this response (result.team.id): every later call needs it. Spawn members by capability domain, not one per requirement item: one member can own several related team_task items, so keep the member count at the minimum needed. For the full recipe with per-field pitfalls, load the skill "dsh-agent-team".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Team name.' },
        workspace: { type: 'string', description: 'Absolute directory shared by members; created if missing.' },
        permissionPreset: { type: 'string', description: 'Default DSH permission preset for members (sandbox + approval policy). Default workspace-write. team_spawn can override it per member.' },
        agentPreset: { type: 'string', description: 'Default DSH agent preset (composition: tools/skills/MCP + system prompt) for members. Omit to use the host default. team_spawn can override it per member.' },
        maxMembers: { type: 'integer', description: 'Member cap, 0 means unlimited. Default 64. Extra members are queued, never errors.' },
        maxConcurrency: { type: 'integer', description: 'Max simultaneously running tasks. Default 8.' },
        failurePolicy: { type: 'string', enum: ['continue', 'abort'], description: 'Team-level default failure policy.' },
        maxAttempts: { type: 'integer', description: 'Per-task retry cap. Default 3.' },
        force: { type: 'boolean', description: '仅看板任务相关：该任务已关联团队时默认禁止重复建队（重试应继续用原团队）；确认需要与之并行新建团队时传 true。' },
      },
      required: ['name', 'workspace'],
    },
    output: jsonOutput('{ team, panel }'),
    async execute(args, exec) {
      await guardBoardTeamReuse(s, exec?.agent?.id, args.force);
      const permissionPreset = resolvePermissionPreset(ctx, args.permissionPreset, 'workspace-write');
      const agentPreset = await resolveAgentPreset(ctx, args.agentPreset, null, s);
      const team = await request(s, '/api/teams', {
        method: 'POST',
        body: {
          name: args.name,
          workspace: args.workspace,
          permissionPreset,
          ...(agentPreset ? { agentPreset } : {}),
          ...(args.maxMembers !== undefined ? { maxMembers: args.maxMembers } : {}),
          ...(args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {}),
          ...(args.failurePolicy !== undefined ? { failurePolicy: args.failurePolicy } : {}),
          ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
          ...(exec?.agent && exec.agent.id != null ? { leadSessionId: String(exec.agent.id) } : {}),
        },
      });
      teamCache.set(team.id, team);
      if (exec?.agent) leadByTeam.set(team.id, exec.agent);
      // 会话级粘性绑定：即使后续 team_spawn 漏传 teamId，也能解析到本会话刚建的团队。
      if (exec?.agent?.id != null) teamBySession.set(String(exec.agent.id), String(team.id));
      await bindBoardTeam(s, exec, team.id);
      return { team, panel: panelUrl(s) };
    },
  });

  tools.push({
    name: 'team_spawn',
    description: "Add one member to a team; returns the member `id` you use as team_task's `assignee`. This SPAWNS A REAL DSH SUB-AGENT session (`subagents.startActivation`, continuable child) that owns its own model, context, tools and message inbox; `prompt` is required and becomes the member's first instruction — the member cannot see your conversation, so state the team id, its job, the workspace, and end with: finish by calling team_report_task({teamId, taskId, status, summary}). Over the member cap the member becomes `queued` instead of failing. Members are reusable: they run one task at a time and return to `idle`. Model routing: call team_models first, then pass `agentProvider` + `model` to fit the task — a cheap/fast route for mechanical edits and lookups, a strong-reasoning route for architecture, debugging, or review. Pass `reasoningEffort` when the model exposes one; omitting it inherits the Lead's effort only while the route stays the same, otherwise the model's default applies. Omit agentProvider/model to inherit the Lead's route. `permissionPreset` overrides the team default for this member (sandbox + approval policy); approval-required operations are forwarded to the Lead via team_approve.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string', description: 'team_create 返回的 result.team.id（形如 team_xxx）。漏传时自动使用当前会话刚创建的团队。' },
        name: { type: 'string', description: 'Unique member name inside the team; this is the addressable target.' },
        role: { type: 'string', description: 'Role label shown on the panel.' },
        permissionPreset: { type: 'string', description: "DSH permission preset for this member (sandbox + approval policy). Defaults to the team's permissionPreset." },
        agentPreset: { type: 'string', description: "DSH agent preset (composition: tools/skills/MCP + system prompt). Defaults to the team's agentPreset; omit both to join the host default. Only supported with contextMode 'fresh' (the fork provider inherits the Lead's composition)." },
        agentProvider: { type: 'string', description: 'LLM provider route id, as returned by team_models. Omit to inherit the Lead\'s provider. Must be an enabled route in the team panel.' },
        model: { type: 'string', description: 'LLM model id, as returned by team_models. Changing the route clears inherited reasoning effort unless reasoningEffort is set explicitly.' },
        reasoningEffort: { type: 'string', description: 'Adapter-defined reasoning effort id (for example low / medium / high, when the model supports them). Omit to inherit the Lead\'s effort while the route is unchanged; a changed route falls back to the model default.' },
        contextMode: { type: 'string', enum: ['isolated', 'fresh', 'fork'], description: 'Context isolation: `fresh` starts with no Lead history, `fork` inherits completed Lead turns. Default isolated/fresh.' },
        prompt: { type: 'string', description: 'The member’s first instruction. Tell it its role, workspace, and that it must call team_report_task when done.' },
        description: { type: 'string', description: 'One-line description of what this member is responsible for.' },
      },
      required: ['teamId', 'name', 'prompt'],
    },
    output: jsonOutput('{ member, agent, panel, permissionPreset, agentPreset, agentPresetWarning?, permissionPresetApplied?, permissionPresetWarning? }'),
    async execute(args, exec) {
      const team = await teamOf(s, args.teamId, { sessionId: exec?.agent?.id });
      const permissionPreset = resolvePermissionPreset(ctx, args.permissionPreset, team.permissionPreset);
      let requestedAgentPreset = await resolveAgentPreset(ctx, args.agentPreset, team.agentPreset, s);

      // ---- 用 subagents 服务起一个 continuable 真子会话 ----
      const subs = subagentsOf(ctx);
      if (!subs || typeof subs.startActivation !== 'function') {
        throw new Error('subagents 服务不可用：无法创建 sub-agent 成员（需要宿主启用 dsh-subagent）。');
      }
      const caller = exec?.agent;
      if (!caller) throw new Error('team_spawn 需要 Lead 会话上下文（exec.agent 缺失：不能在非 agent 调用里起成员）。');
      if (!args.prompt) throw new Error('team_spawn 需要 prompt（成员的初始指令）。');

      const context = args.contextMode === 'fork' ? 'fork' : 'fresh';
      // 省略 preset 时 DSH 继承 Lead 的实时组合，不会套宿主默认；
      // fresh 成员必须显式拿宿主默认，否则 Lead 是看板裸会话时成员就没有 shell/文件工具。
      if (context !== 'fork' && !requestedAgentPreset) {
        requestedAgentPreset = await hostDefaultAgentPreset(ctx);
      }
      // fork provider 继承父方组装，DSH 会拒绝独立 agentPreset；这里显式降级为警告而不是静默传。
      const agentPreset = context === 'fork' ? null : requestedAgentPreset;
      const agentPresetWarning = context === 'fork' && requestedAgentPreset
        ? `contextMode=fork 继承 Lead 的组装，agentPreset「${requestedAgentPreset}」未生效`
        : undefined;
      const provider = providerFor(ctx, s, context);
      // 实际 route：显式参数覆盖 Lead；effort 只在 route 未变时继承（与 DSH 子会话合并规则一致）
      const leadRoute = leadRouteOf(caller);
      const route = { provider: args.agentProvider || leadRoute.provider, model: args.model || leadRoute.model };
      // 看板任务如果指定了团队模型白名单，成员 route 必须落在名单内；不指定时取第一条。
      let pickedByBoard = false;
      const callerId = caller?.id != null ? String(caller.id) : null;
      const boardTask = callerId && boardSessionIds.has(callerId) ? await boardTaskOf(s, callerId) : null;
      const allowedModels = Array.isArray(boardTask?.teamModels)
        ? boardTask.teamModels.map((m) => (typeof m === 'string'
          ? { provider: null, model: m, reasoningEffort: null }
          : { provider: m?.provider || null, model: m?.model || null, reasoningEffort: m?.reasoningEffort || null })).filter((m) => m.model)
        : [];
      if (allowedModels.length) {
        if (!args.model) {
          const first = allowedModels[0];
          route.provider = first.provider || route.provider;
          route.model = first.model;
          pickedByBoard = true;
        }
        const hit = allowedModels.find((m) => m.model === route.model && (!m.provider || m.provider === route.provider));
        if (!hit) throw new Error(`模型 ${route.provider || '?'}/${route.model || '?'} 不在看板任务的白名单内：${allowedModels.map((m) => m.model).join(', ')}`);
      }
      const routeChanged = route.provider !== leadRoute.provider || route.model !== leadRoute.model;
      route.reasoningEffort = args.reasoningEffort || (routeChanged ? null : leadRoute.reasoningEffort);
      // 继承 Lead 的 route 也要过启用闸门：停用项不该被成员继续使用；effort 同理。
      await assertRouteEnabled(s, ctx, route.provider, route.model, route.reasoningEffort);
      const agentOptions = {};
      if (args.agentProvider || args.model || pickedByBoard) {
        if (route.provider) agentOptions.provider = String(route.provider);
        if (route.model) agentOptions.model = String(route.model);
        if (route.reasoningEffort && (args.reasoningEffort || pickedByBoard)) agentOptions.reasoningEffort = String(route.reasoningEffort);
      }
      const memberName = String(args.name).trim();
      const description = String(args.description || args.role || memberName).slice(0, 200);
      const sessionId = randomUUID();
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
          ...(agentPreset ? { agentPreset } : {}),
        },
        signal: exec.signal || AbortSignal.timeout(s.requestTimeoutMs),
      });
      // 成员跑的是一整轮 agent loop，结果由 team_report_task 汇报；这里只防止未处理的 rejection。
      if (started && started.result && typeof started.result.catch === 'function') started.result.catch(() => {});
      // 子会话发布后立刻把 preset 落到会话（会覆盖 subagent 继承来的 approval=never）。
      const presetResult = applyPermissionPreset(ctx, sessionId, permissionPreset);

      const registered = await request(s, '/api/agents/register', {
        method: 'POST',
        body: {
          // 用解析后的 team.id，而不是原始 args.teamId：teamId 可省略并回退到会话绑定的团队，
          // 原始值此时是 undefined，直接透传会让 sidecar 报 `teamId required`。
          teamId: team.id,
          name: memberName,
          sessionId,
          parentSessionId: caller.id != null ? String(caller.id) : null,
          role: args.role || 'teammate',
          model: args.model || route.model || null,
          contextMode: context,
          agentProvider: route.provider || null,
          permissionPreset,
          ...(agentPreset ? { agentPreset } : {}),
          // 实际生效的思考强度（含从 Lead 继承的值）：面板成员卡片据此展示，之后不可变
          reasoningEffort: route.reasoningEffort || null,
        },
      });
      rememberMember(sessionId, team.id, registered.member.id, team.workspace, registered.member.permissionPreset || permissionPreset, memberName);
      leadByTeam.set(team.id, caller);
      return {
        member: registered.member,
        agent: {
          sessionId,
          name: memberName,
          status: 'running',
          role: args.role || 'teammate',
          provider,
          context,
          model: route.model || null,
          route,
        },
        permissionPreset: registered.member?.permissionPreset || permissionPreset,
        agentPreset: registered.member?.agentPreset || agentPreset || null,
        ...(agentPresetWarning ? { agentPresetWarning } : {}),
        permissionPresetApplied: presetResult.applied,
        ...(presetResult.reason ? { permissionPresetWarning: presetResult.reason } : {}),
        ...(presetResult.error ? { permissionPresetWarning: presetResult.error } : {}),
        panel: panelUrl(s),
      };
    },
  });

  tools.push({
    name: 'team_models',
    description: 'List the model routes enabled for this team: provider id, model id, display name, note, providerNote (the vendor-level strength the user wrote, e.g. "适合逻辑处理" / "适合做设计"), and modalities. Use it before team_spawn when a task should run on a different model or reasoning effort than the Lead — a cheap/fast route for mechanical work, a strong-reasoning route for architecture, debugging, or review. Only the user-enabled subset is listed; the panel curates it. Pass a listed pair to team_spawn({ agentProvider, model, reasoningEffort }).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: jsonOutput('{ asOf, total, models: [{ provider, model, name, description, note, providerNote, modalities, efforts?, defaultEffort? }], hint? }'),
    isConcurrencySafe: () => true,
    async execute() {
      let cat = null;
      try { cat = await request(s, '/api/llm/catalog'); } catch { /* catalog unavailable */ }
      // 厂商级备注（用户在面板分组头写的「这个厂商擅长什么」）随每个 route 一起下发，
      // 让模型在派活时能按「擅长逻辑 / 擅长设计」这类语义选厂商，而不只看模型 id。
      const providerNotes = new Map((cat?.providers || []).map((p) => [p.id, p.note || null]));
      const all = cat ? (cat.providers || []).flatMap((p) => p.models || []) : [];
      const models = all.filter((m) => m.enabled).map((m) => {
        // 只报用户允许的 effort；allowedEfforts=null 表示全部允许。未声明 efforts 的 route 不报该字段。
        const effortIds = Array.isArray(m.efforts) ? m.efforts.map((e) => e.id) : [];
        const allowed = Array.isArray(m.allowedEfforts) ? effortIds.filter((id) => m.allowedEfforts.includes(id)) : effortIds;
        const providerNote = providerNotes.get(m.provider);
        return {
          provider: m.provider,
          model: m.model,
          name: m.name,
          ...(providerNote ? { providerNote } : {}),
          ...(m.description ? { description: m.description } : {}),
          ...(m.note ? { note: m.note } : {}),
          ...(m.modalities ? { modalities: m.modalities } : {}),
          ...(effortIds.length ? { efforts: allowed, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}) } : {}),
        };
      });
      const hint = models.length
        ? '在 team_spawn 里用 agentProvider + model；providerNote 是该厂商整体强项（用户填写的厂商备注），note 是单模型差异；'
          + 'efforts 是该 route 允许派发的 reasoningEffort 列表（省略时只在 route 不变时继承 Lead 的 effort，被禁止的 effort 会被拒绝）。'
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
    name: 'team_preset',
    description: 'Create, inspect, list, or delete team-owned agent presets when the host built-ins do not fit. A preset decides what a member OWNS (tool plugins, skill providers, MCP clients, persona/system prompt); permissionPreset decides what it MAY DO. action:list lists host presets plus presets the team already created; action:save writes one JSON document to the fixed team preset directory and registers it with the host immediately (no DSH restart), then the id can be passed to team_create({agentPreset}) / team_spawn({agentPreset}); action:show prints the saved document; action:delete removes a team-owned preset file and unregisters it (host built-ins are read-only). plugins must be a non-empty Cordis entry list, e.g. [{name:"@deepseek-ai/dsh-tool-fs"},{name:"@deepseek-ai/dsh-persona",config:{prefix:"You are a reviewer."}}]. Prefer copying the shape of an existing host preset: call team_preset({action:"show", id:"standard"}) and swap rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'show', 'delete'], description: 'list：列出可用预设；save：写入固定目录并立刻注册；show：读回已保存的文档；delete：删除团队自建预设并反注册。' },
        id: { type: 'string', description: '预设 id（save/show 必填），`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。' },
        name: { type: 'string', description: '展示名（save 可选）。' },
        description: { type: 'string', description: '用途说明（save 可选）。' },
        order: { type: 'number', description: '排序权重（save 可选，越小越靠前）。' },
        confirm: { type: 'boolean', description: 'save 覆盖同名团队自建预设时必须显式 true；内置预设任何时候都不能覆盖。' },
        plugins: {
          type: 'array',
          description: 'save 必填：Cordis 插件条目列表，每项 { name, config?, id?, disabled? }。',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['name'],
            properties: { name: { type: 'string', description: '插件包名，如 @deepseek-ai/dsh-tool-fs。' } },
          },
        },
      },
    },
    output: jsonOutput('list → { dir, presets:[{id,name?,source:"host"|"team",file?,broken?}], errors }；save → { id, file, registered, broken?, warning? }；show → { id, file, doc }；delete → { id, file, removed }'),
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const action = String(args.action || '');
      if (action === 'list') return listTeamPresets(s, ctx);
      if (action === 'show') {
        const id = String(args.id || '').trim();
        if (!PRESET_ID_RE.test(id)) throw new Error(`agentPreset 名称非法：「${id}」`);
        const file = path.join(s.presetDir, `${id}.json`);
        if (!fs.existsSync(file)) {
          const svc = ctx.get('agentPresets');
          let row = null;
          try { row = (await svc?.list?.() || []).find((r) => r && r.id === id) || null; } catch { row = null; }
          if (!row) throw new Error(`没有找到 preset「${id}」：既不在 ${s.presetDir}，也不是宿主内置预设`);
          return { id, source: 'host', preset: row, hint: '宿主内置预设的文档在 DSH bundle 里，不能编辑；需要定制就新建一个 id。' };
        }
        return { id, source: 'team', file, doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
      }
      if (action === 'save') {
        const saved = await saveTeamPreset(s, ctx, args);
        await syncPresetCatalog(s, ctx);
        return saved;
      }
      if (action === 'delete') return deleteTeamPreset(s, ctx, args.id);
      throw new Error(`未知 action「${action}」：只支持 list / save / show / delete`);
    },
  });

  tools.push({
    name: 'team_status',
    description: 'Read a live snapshot instead of guessing progress. detail=summary returns every member with status/step/seq/percent/next/blockers/stale and its permissionPreset; detail=dag returns the task DAG with dependencies, readiness, joins and the critical path. `asOf` marks the snapshot time.',
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
          model: m.model || null,
          permissionPreset: m.permissionPreset || null,
          agentPreset: m.agentPreset || null,
          reasoningEffort: m.reasoningEffort || null,
          status: m.status,
          step: m.step,
          seq: m.seq,
          pct: m.pct,
          next: m.next,
          last: m.last,
          currentTaskId: m.currentTaskId,
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
    name: 'team_task_get',
    description: 'Read ONE DAG task of a team instead of the whole status: subject/status/assignee/attempts/maxAttempts/failurePolicy, its plan and acceptance, plus ledger node info (dependsOn, ready, blocked, blockers). Use it to confirm a task was dispatched, to check whether it is blocked on a dependency or a member, and to decide whether to retry or re-dispatch it. teamId is optional when the caller is already bound to that team.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'Task id returned by team_task (task_…).' },
        teamId: { type: 'string', description: 'Optional ownership check; inferred from the caller session when omitted.' },
      },
      required: ['taskId'],
    },
    output: jsonOutput('{ task, node }'),
    isConcurrencySafe: () => true,
    async execute(args) {
      const task = await request(s, `/api/tasks/${encodeURIComponent(args.taskId)}`);
      const teamId = String(args.teamId || task.teamId || '');
      if (!teamId) throw new Error('team_task_get 无法确定 teamId：请显式传入');
      if (args.teamId && String(task.teamId) !== String(args.teamId)) {
        throw new Error(`task ${task.id} 不属于 team ${args.teamId}`);
      }
      // DAG 节点提供依赖/就绪/阻塞信息，task 行本身不存这些派生状态。
      const dag = await request(s, `/api/dag${qs({ team: teamId })}`).catch(() => null);
      const node = dag?.nodes?.find((n) => n.taskId === task.id) || null;
      return { task, node };
    },
  });

  tools.push({
    name: 'team_task',
    description: 'Declare one task (DAG node) and hand it to a member. The plan is a BRIEF sent to the member’s own sub-agent session, which does the work with its own tools and calls team_report_task when finished — write it self-contained (the member does not see this conversation). `assignee` takes a member **id** from team_spawn, not its name; omit it to let the scheduler pick an idle member. `deps[].from` takes a **task** id returned by an earlier team_task (member ids are rejected). The scheduler satisfies dependencies itself — never poll. The task dispatches immediately to an idle member once dependencies are satisfied; pass dispatch:false to build the DAG first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        subject: { type: 'string', description: 'Concise task title.' },
        assignee: { type: 'string', description: 'Member id (not name). Omit to let the scheduler pick an idle member.' },
        plan: { type: 'array', items: PLAN_STEP, description: 'Ordered plan steps / brief lines handed to the member. May be empty for a pure heartbeat task.' },
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
        acceptance: { type: 'string' },
        priority: { type: 'integer', description: 'Smaller runs first. Default 0.' },
        failurePolicy: { type: 'string', enum: ['continue', 'skip', 'abort_team', 'retry'] },
        maxAttempts: { type: 'integer' },
        dispatch: { type: 'boolean', description: 'Dispatch immediately after creating (default true). Pass false to build the DAG first and dispatch later with team_dispatch.' },
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
          ...(args.acceptance !== undefined ? { acceptance: args.acceptance } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.failurePolicy !== undefined ? { failurePolicy: args.failurePolicy } : {}),
          ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
        },
      });
      if (args.dispatch === false) return { task };
      await sleep(s.agentSettleMs);
      const dispatched = await dispatchLoop(s, ctx, args.teamId);
      return { task, dispatched };
    },
  });

  tools.push({
    name: 'team_send',
    description: "Send a message that a member will actually read: the text is injected into the target sub-agent's message inbox. By default a running member's current turn is interrupted first, so the message immediately starts a fresh turn instead of waiting for the next step boundary; pass `interrupt: false` to keep the current turn and deliver at the next step boundary. An idle member is woken. `to` is a member NAME (member id also accepted) or '*' to broadcast; use to:'lead' to reply to the Lead. Every send is also recorded on the sidecar so the panel shows the conversation.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        to: { type: 'string', description: "Member name (agent teams) or member id, or '*' for broadcast." },
        message: { type: 'string', description: 'Message body.' },
        correlationId: { type: 'string', description: 'Optional correlation id to pair a request with its response.' },
        interrupt: { type: 'boolean', description: 'Default true: if the target member is running, interrupt its current turn before delivering so this message takes effect immediately. false = keep the current turn and deliver at the next step boundary; the message is still queued durably and will be read (a pending steer forces another turn, an idle member is woken), but it may land only after the member finished the current step, so it cannot be relied on to change this turn.' },
      },
      required: ['teamId', 'to', 'message'],
    },
    output: jsonOutput('{ message, messages?, delivered?, interrupted?, failed? }'),
    async execute(args, exec) {
      // 调用者可能是 Lead，也可能是某个成员（成员用 send_message 工具调用本工具时 exec.agent 就是成员会话）。
      const callerSessionId = exec?.agent?.sessionId ?? exec?.agent?.id ?? null;
      const callerMember = callerSessionId ? sessionMember.get(String(callerSessionId)) : null;
      // 只有 Lead 才更新 Lead 句柄：成员调用不能覆盖它，否则后续派发/转发会拿错会话。
      if (exec?.agent && !callerMember) leadByTeam.set(args.teamId, exec.agent);
      const from = callerMember ? callerMember.memberId : 'lead';
      const toLead = String(args.to).trim().toLowerCase() === 'lead';
      // sidecar 的收件人只能是成员 id、'*' 或虚拟收件人 'lead'，所以先把 name / id 统一解析成成员行。
      const st = await request(s, `/api/status${qs({ team: args.teamId })}`);
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
      // 成员→Lead 只落信箱（面板可见），不打扰 Lead 会话。
      if (toLead) return recorded;

      const subs = subagentsOf(ctx);
      // 成员之间互通必须借 Lead 的 agent 句柄：成员会话都挂在 Lead 下，成员直发会「belongs to another parent session」。
      const caller = leadByTeam.get(args.teamId) || exec?.agent;
      if (!subs || typeof subs.sendMessage !== 'function' || !caller) return { ...recorded, delivered: false };
      const content = [{ type: 'text', text: String(args.message) }];
      const candidates = args.to === '*' ? members : [resolve(args.to)].filter(Boolean);
      const targets = candidates.filter((m) => m.agentSessionId);
      const delivered = [];
      const failed = [];
      const interrupted = [];
      const interruptErrors = [];
      if (!targets.length) failed.push({ target: args.to, error: '该成员没有绑定 sub-agent 会话（可能还没 spawn 或已回收）' });
      for (const target of targets) {
        const sid = String(target.agentSessionId);
        try {
          // 成员还在跑：先打断当前回合，新消息才会立刻开一轮；否则 steer 只能等下一个 step 边界。
          const busy = agentStatusBySession.get(sid) === 'running' || target.agentStatus === 'running' || target.status === 'running';
          if (args.interrupt !== false && busy && typeof subs.interrupt === 'function') {
            try {
              await Promise.resolve(subs.interrupt(sid, { kind: 'ancestor', agent: caller }));
              interrupted.push(target.name);
            } catch (err) {
              // 打断失败不能连消息一起丢：退化成 step 边界投递。
              interruptErrors.push({ target: target.name, error: String(err?.message || err) });
            }
          }
          await subs.sendMessage(caller, sid, content, { signal: AbortSignal.timeout(s.requestTimeoutMs) });
          delivered.push(target.name);
          // 投递成功才补记送达：这一条消息确实进了成员会话
          const row = (recorded.messages || [recorded.message]).find((m) => m && String(m.to) === String(target.id));
          await markDelivered(s, row?.id);
        } catch (err) {
          failed.push({ target: target.name, error: String(err?.message || err) });
        }
      }
      return {
        ...recorded,
        delivered,
        ...(interrupted.length ? { interrupted } : {}),
        ...(interruptErrors.length ? { interruptErrors } : {}),
        ...(failed.length ? { failed } : {}),
      };
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

  // ---------- 显式记忆（文件持久化；成员收工时保存 handoff，Lead 可要求上传团队空间） ----------
  const memorySession = (exec) => (exec?.agent?.sessionId ?? exec?.agent?.id ?? null) == null
    ? null : String(exec.agent.sessionId ?? exec.agent.id);
  const memoryQuery = (params, sessionId) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    if (sessionId) q.set('session', sessionId);
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  tools.push({
    name: 'team_memory_write',
    description: 'Save ONE memory into the file-backed memory space (one JSON file per memory, never SQLite). scope=member writes the caller member\'s own space; scope=team writes the shared team space (use it when the Lead asks you to upload). Same (scope, team, owner, key) upserts and bumps version; pass expectedVersion for compare-and-set. Keep handoffs short (<=300 chars) and only save what is actually reusable — do NOT force a memory when the task produced nothing worth carrying.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        scope: { type: 'string', enum: ['member', 'team'], description: 'member = caller\'s own space (default); team = shared space.' },
        key: { type: 'string', description: 'Stable slot key inside the space, e.g. "handoff/api-contract" or "decision/db". Max 128 chars.' },
        value: { description: 'Memory body: string, or JSON value (objects are stored as a JSON string). Max 64KB.' },
        kind: { type: 'string', enum: ['handoff', 'fact', 'decision', 'open-question'], description: 'Default fact; use handoff when finishing a task.' },
        title: { type: 'string', description: 'Optional short title; defaults to the first line of value.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (max 20).' },
        visibility: { type: 'string', enum: ['private', 'team', 'shared'], description: 'private = owner + team Lead; team = this team\'s members; shared = any team by id. Default: private for member scope, team for team scope.' },
        taskId: { type: 'string', description: 'Optional task provenance id.' },
        expectedVersion: { type: 'integer', description: 'Optimistic concurrency: 0 = must be new; N = must currently be version N.' },
      },
      required: ['teamId', 'key', 'value'],
    },
    output: jsonOutput('{ memory, created }'),
    async execute(args, exec) {
      await teamOf(s, args.teamId, { sessionId: memorySession(exec) });
      return await request(s, '/api/memory', {
        method: 'POST',
        body: {
          teamId: args.teamId,
          scope: args.scope ?? 'member',
          key: args.key,
          value: args.value,
          kind: args.kind,
          title: args.title,
          tags: args.tags,
          visibility: args.visibility,
          expectedVersion: args.expectedVersion,
          source: args.taskId ? { taskId: args.taskId } : undefined,
          sessionId: memorySession(exec),
        },
      });
    },
  });

  tools.push({
    name: 'team_memory_read',
    description: 'Read ONE memory by id, or find the first matching memory by scope+key (and optional memberId). Memory ids are portable: a shared memory id can be passed to a member of another team. Returns the full value and version.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        memoryId: { type: 'string', description: 'mem_xxx id; takes precedence over scope/key.' },
        scope: { type: 'string', enum: ['member', 'team'] },
        key: { type: 'string', description: 'Slot key to look up when memoryId is absent.' },
        memberId: { type: 'string', description: 'Owner member for member scope; defaults to the caller member.' },
      },
      required: ['teamId'],
    },
    output: jsonOutput('{ memory?, items? }'),
    async execute(args, exec) {
      const sessionId = memorySession(exec);
      const binding = sessionId ? sessionMember.get(sessionId) : null;
      if (args.memoryId) {
        return await request(s, `/api/memory/${encodeURIComponent(args.memoryId)}${memoryQuery({ team: args.teamId }, sessionId)}`);
      }
      if (!args.key) throw new Error('需要 memoryId 或 key');
      const memberId = args.scope === 'member' ? (args.memberId || binding?.memberId) : args.memberId;
      const res = await request(s, `/api/memory${memoryQuery({ team: args.teamId, scope: args.scope ?? (memberId ? 'member' : undefined), member: memberId, slot: args.key, limit: 20 }, sessionId)}`);
      const hit = (res.items || [])[0];
      if (!hit) return { items: [] };
      return await request(s, `/api/memory/${encodeURIComponent(hit.id)}${memoryQuery({ team: args.teamId }, sessionId)}`);
    },
  });

  tools.push({
    name: 'team_memory_list',
    description: 'List memory metadata (slot/title/kind/source/updatedAt, no value body) for a team. Members see their own private memories + team-scope memories; the Lead sees all memories of the team; shared memories are visible across teams. Use q to search slot/title/tags/value text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        scope: { type: 'string', enum: ['member', 'team'] },
        memberId: { type: 'string' },
        kind: { type: 'string', enum: ['handoff', 'fact', 'decision', 'open-question'] },
        tag: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'integer', description: 'Default 200, max 1000.' },
      },
      required: ['teamId'],
    },
    output: jsonOutput('{ asOf, total, items: [{ id, scope, slot, kind, title, summary, tags, visibility, source, updatedAt, version }] }'),
    async execute(args, exec) {
      const sessionId = memorySession(exec);
      const binding = sessionId ? sessionMember.get(sessionId) : null;
      const memberId = args.memberId || (args.scope === 'member' ? binding?.memberId : undefined);
      return await request(s, `/api/memory${memoryQuery({
        team: args.teamId, scope: args.scope, member: memberId, kind: args.kind, tag: args.tag, q: args.q, limit: args.limit,
      }, sessionId)}`);
    },
  });

  tools.push({
    name: 'team_memory_share',
    description: 'Change a memory\'s visibility: private (owner + team Lead), team (this team\'s members), shared (any team by id). The Lead uses this to hand a member\'s memory to other members; a member can share its own memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        memoryId: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'team', 'shared'] },
      },
      required: ['teamId', 'memoryId', 'visibility'],
    },
    output: jsonOutput('{ memory }'),
    async execute(args, exec) {
      await teamOf(s, args.teamId, { sessionId: memorySession(exec) });
      return await request(s, `/api/memory/${encodeURIComponent(args.memoryId)}/share${memoryQuery({ team: args.teamId }, memorySession(exec))}`, {
        method: 'POST',
        body: { visibility: args.visibility, sessionId: memorySession(exec) },
      });
    },
  });

  tools.push({
    name: 'team_memory_delete',
    description: 'Delete ONE memory file permanently. The owner member or the team Lead may delete; team deletion does NOT cascade to memory files. Shared memory ids keep working across teams until deleted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string' },
        memoryId: { type: 'string' },
      },
      required: ['teamId', 'memoryId'],
    },
    output: jsonOutput('{ id, removed }'),
    async execute(args, exec) {
      return await request(s, `/api/memory/${encodeURIComponent(args.memoryId)}${memoryQuery({ team: args.teamId }, memorySession(exec))}`, { method: 'DELETE' });
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
    name: 'team_approve',
    description: 'Decide a permission approval raised by a member. When a member runs an operation its permission preset requires approval for (sandbox escalation / write outside the sandbox), the DSH approval request is forwarded to the Lead and the member is paused. Read the requestId/member/tool/reason from the forwarded message, then call team_approve with decision "allow" (authorize this one operation) or "deny". Only the Lead of that team can decide. If nobody decides before the timeout, the request is rejected automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        teamId: { type: 'string', description: 'Team id from the forwarded approval message.' },
        requestId: { type: 'string', description: 'Approval request id from the forwarded message.' },
        decision: { type: 'string', enum: ['allow', 'deny'], description: 'allow = authorize this single operation; deny = reject it.' },
        reason: { type: 'string', description: 'Optional reason shown in the audit trail and to the member.' },
      },
      required: ['teamId', 'requestId', 'decision'],
    },
    output: jsonOutput('{ requestId, decision, memberId, toolName, reason }'),
    async execute(args, exec) {
      const requestId = String(args.requestId || '').trim();
      if (!requestId) throw new Error('team_approve requires requestId');
      const entry = pendingApprovals.get(requestId);
      if (!entry) throw new Error('审批请求不存在或已处理（可能已超时）。请以成员收到的审批消息里的 requestId 为准。');
      if (String(entry.teamId) !== String(args.teamId)) throw new Error('teamId 与审批请求不匹配');
      const callerId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      const team = await teamOf(s, entry.teamId).catch(() => null);
      const leadId = team?.leadSessionId ? String(team.leadSessionId) : (leadByTeam.get(entry.teamId)?.id != null ? String(leadByTeam.get(entry.teamId).id) : null);
      if (leadId && callerId && leadId !== callerId) {
        throw new Error('只有该团队的 Lead 可以审批这个请求');
      }
      settleApproval(s, requestId, args.decision, args.reason || '', callerId || 'lead');
      return { requestId, decision: args.decision, memberId: entry.memberId, toolName: entry.toolName, reason: args.reason || null };
    },
  });

  tools.push({
    name: 'team_control',
    description: 'Control one member. interrupt stops the sub-agent’s current turn and pauses its in-flight task (no retry, no attempt consumed); resume re-arms it; assign hands a ready task to an idle member; abort permanently voids a task (taskId) without retry.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['interrupt', 'resume', 'assign', 'abort'] },
        teamId: { type: 'string', description: 'Required to control an agent-team member.' },
        memberId: { type: 'string', description: 'Required for interrupt/resume/assign.' },
        taskId: { type: 'string', description: 'Required for assign and abort.' },
        reason: { type: 'string', description: 'For interrupt/abort.' },
      },
      required: ['action'],
    },
    output: jsonOutput('{ member, ... }'),
    async execute(args, exec) {
      if (args.action === 'abort') {
        if (!args.taskId) throw new Error('team_control abort requires taskId');
        const res = await request(s, `/api/tasks/${encodeURIComponent(args.taskId)}/abort`, { method: 'POST', body: { reason: args.reason || 'lead abort' } });
        if (!res?.wasRunning || !res?.member?.agentSessionId) return res;
        const sid = String(res.member.agentSessionId);
        const subs = subagentsOf(ctx);
        const caller = exec?.agent;
        if (!subs || !caller || typeof subs.interrupt !== 'function') return res;
        cancelIdleReport(sid);
        cancelStartWatchdog(sid);
        agentStatusBySession.set(sid, 'interrupted');
        const interrupted = await Promise.resolve()
          .then(() => subs.interrupt(sid, { kind: 'ancestor', agent: caller }))
          .then(() => ({ ok: true, previousStatus: res.member.agentStatus ?? null }),
            (err) => ({ ok: false, error: String(err?.message || err) }));
        return { ...res, agent: interrupted };
      }
      if (!args.memberId) throw new Error(`team_control ${args.action} requires memberId`);
      const id = encodeURIComponent(args.memberId);
      if (args.action === 'interrupt') {
        const res = await request(s, `/api/members/${id}/interrupt`, { method: 'POST', body: { reason: args.reason || 'lead interrupt' } });
        if (res?.member?.agentSessionId) {
          const sid = String(res.member.agentSessionId);
          const subs = subagentsOf(ctx);
          const caller = exec?.agent;
          if (subs && caller && typeof subs.interrupt === 'function') {
            // 冻结会话：直到 Lead resume 前，忽略该会话的 idle / turn-error 回报，
            // 否则 DSH 中断后的 idle 会把 sidecar 的 interrupted 覆盖成 idle，派发泵又能唤醒它。
            heldSessions.add(sid);
            cancelIdleReport(sid);
            cancelStartWatchdog(sid);
            agentStatusBySession.set(sid, 'interrupted');
            const interrupted = await Promise.resolve()
              .then(() => subs.interrupt(sid, { kind: 'ancestor', agent: caller }))
              .then(() => ({ ok: true, previousStatus: res.member.agentStatus ?? null }),
                (err) => ({ ok: false, error: String(err?.message || err) }));
            if (!interrupted.ok) heldSessions.delete(sid);
            return { ...res, agent: interrupted };
          }
        }
        return res;
      }
      if (args.action === 'resume') {
        const res = await request(s, `/api/members/${id}/resume`, { method: 'POST', body: {} });
        const sid = res?.member?.agentSessionId ? String(res.member.agentSessionId) : null;
        if (sid) heldSessions.delete(sid);
        return res;
      }
      if (args.action === 'assign') {
        if (!args.taskId) throw new Error('team_control assign requires taskId');
        return await request(s, `/api/members/${id}/assign`, { method: 'POST', body: { taskId: args.taskId } });
      }
      throw new Error(`team_control unknown action: ${args.action}`);
    },
  });

  tools.push({
    name: 'team_member',
    description: "Update or remove a team member. `update` changes role/permission/model/context. `permissionPreset` (and `role`) applies to a RUNNING member immediately, no interrupt needed; changing model, agentProvider, contextMode, agentPreset or reasoningEffort rebuilds the member's DSH sub-agent session (old context is lost) and therefore requires the member to be idle or interrupted. `retire` keeps the member row as retired and frees capacity; `remove` deletes the row and requires confirm:true. Both release the sub-agent session.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['update', 'retire', 'remove'] },
        teamId: { type: 'string', description: 'Team id; omit to resolve from the current Lead session.' },
        memberId: { type: 'string', description: 'Member id returned by team_spawn / team_status.' },
        role: { type: 'string', description: 'update: new role label.' },
        model: { type: 'string', description: 'update: new LLM model id (empty to inherit). Rebuilds the session.' },
        agentProvider: { type: 'string', description: 'update: new LLM provider route id. Rebuilds the session.' },
        contextMode: { type: 'string', enum: ['isolated', 'fresh', 'fork'], description: 'update: new context isolation. Rebuilds the session; old context is lost.' },
        reasoningEffort: { type: 'string', description: 'update: new reasoning effort id. Rebuilds the session.' },
        permissionPreset: { type: 'string', description: 'update: DSH permission preset (sandbox + approvals). Applies to the live session without rebuild.' },
        agentPreset: { type: 'string', description: 'update: DSH agent preset (composition). Rebuilds the session; not supported with contextMode fork.' },
        confirm: { type: 'boolean', description: 'Required true for action=remove.' },
      },
      required: ['action', 'memberId'],
    },
    output: jsonOutput('{ member, restarted?, agent?, removed?, panel }'),
    async execute(args, exec) {
      const id = encodeURIComponent(args.memberId);
      const current = await request(s, `/api/members/${id}`);
      if (!current) throw new Error(`member not found: ${args.memberId}`);
      const team = await teamOf(s, args.teamId || current.teamId, { sessionId: exec?.agent?.id });
      if (current.teamId !== team.id) throw new Error('member 不属于指定团队');

      if (args.action === 'retire' || args.action === 'remove') {
        if (args.action === 'remove' && args.confirm !== true) throw new Error('team_member remove requires confirm:true');
        const mode = args.action === 'remove' ? 'remove' : 'retire';
        const res = await request(s, `/api/members/${id}?mode=${mode}${mode === 'remove' ? '&confirm=1' : ''}`, { method: 'DELETE' });
        let agent = null;
        if (current.agentSessionId) {
          const released = await releaseSession(subagentsOf(ctx), exec?.agent, current.agentSessionId);
          forgetSession(current.agentSessionId);
          agent = {
            sessionId: String(current.agentSessionId),
            released: released.ok,
            method: released.method || null,
            ...(released.error ? { error: released.error } : {}),
          };
        }
        return { ...res, agent, panel: panelUrl(s) };
      }

      if (args.action !== 'update') throw new Error(`team_member unknown action: ${args.action}`);
      if (current.status === 'retired') throw new Error('member is retired; create a new member instead');

      const has = (key) => Object.prototype.hasOwnProperty.call(args, key);
      const metadata = {};
      for (const key of ['role', 'model', 'agentProvider', 'contextMode', 'reasoningEffort', 'permissionPreset', 'agentPreset']) {
        if (has(key)) metadata[key] = args[key];
      }
      const restart = ['model', 'agentProvider', 'contextMode', 'agentPreset', 'reasoningEffort'].some(has);
      // 运行中的成员只允许热改 role / permissionPreset（DSH 预设支持对 live session 直接 set）；
      // 换模型/上下文/组合需要重建会话，仍要求先 interrupt。
      if (['running', 'provisioning', 'blocked'].includes(current.status) && restart) {
        throw new Error(`member is ${current.status}; interrupt it before changing model/provider/context/agentPreset. role and permissionPreset can be updated while it runs`);
      }

      if (!restart) {
        const updated = await request(s, `/api/members/${id}`, { method: 'PATCH', body: metadata });
        let presetApplied = null;
        if (has('permissionPreset') && updated.agentSessionId) {
          presetApplied = applyPermissionPreset(ctx, String(updated.agentSessionId), updated.permissionPreset);
          // 热更新后同步插件侧绑定，后续审批通知/分类按新预设走。
          const live = sessionMember.get(String(updated.agentSessionId));
          if (live) live.permissionPreset = updated.permissionPreset ?? null;
        }
        return {
          member: updated,
          restarted: false,
          agent: { sessionId: updated.agentSessionId || null, permissionPresetApplied: presetApplied },
          panel: panelUrl(s),
        };
      }

      const subs = subagentsOf(ctx);
      const caller = exec?.agent;
      if (!subs || typeof subs.startActivation !== 'function') throw new Error('subagents 服务不可用：无法重建成员会话');
      if (!caller) throw new Error('team_member update 需要 Lead 会话上下文（exec.agent 缺失）');

      const leadRoute = leadRouteOf(caller);
      const oldRoute = {
        provider: current.agentProvider ?? leadRoute.provider ?? null,
        model: current.model ?? leadRoute.model ?? null,
        reasoningEffort: current.reasoningEffort ?? null,
      };
      const route = {
        provider: has('agentProvider') ? (args.agentProvider || null) : oldRoute.provider,
        model: has('model') ? (args.model || null) : oldRoute.model,
        reasoningEffort: has('reasoningEffort') ? (args.reasoningEffort || null) : oldRoute.reasoningEffort,
      };
      const routeChanged = route.provider !== oldRoute.provider || route.model !== oldRoute.model;
      if (routeChanged && !has('reasoningEffort')) route.reasoningEffort = null;
      await assertRouteEnabled(s, ctx, route.provider, route.model, route.reasoningEffort);

      const context = has('contextMode')
        ? (args.contextMode === 'fork' ? 'fork' : 'fresh')
        : (current.contextMode === 'fork' ? 'fork' : 'fresh');
      let requestedAgentPreset = has('agentPreset')
        ? await resolveAgentPreset(ctx, args.agentPreset, team.agentPreset, s)
        : (current.agentPreset || team.agentPreset || null);
      if (context !== 'fork' && !requestedAgentPreset) {
        requestedAgentPreset = await hostDefaultAgentPreset(ctx);
      }
      const agentPreset = context === 'fork' ? null : requestedAgentPreset;
      const agentPresetWarning = context === 'fork' && requestedAgentPreset
        ? `contextMode=fork 继承 Lead 的组装，agentPreset「${requestedAgentPreset}」未生效`
        : undefined;
      const permissionPreset = has('permissionPreset')
        ? resolvePermissionPreset(ctx, args.permissionPreset, team.permissionPreset)
        : (current.permissionPreset || team.permissionPreset);
      const role = has('role') ? args.role : current.role;

      const provider = providerFor(ctx, s, context);
      const agentOptions = {};
      if (route.provider) agentOptions.provider = String(route.provider);
      if (route.model) agentOptions.model = String(route.model);
      if (route.reasoningEffort) agentOptions.reasoningEffort = String(route.reasoningEffort);

      const sessionId = randomUUID();
      const started = await subs.startActivation({
        delivery: 'parent',
        childId: sessionId,
        provider,
        label: memberLabel(current.name, String(role || current.name)),
        request: {
          prompt: [{ type: 'text', text: `你是团队成员 ${current.name}（${role || 'teammate'}）。配置刚刚更新，这是新的会话；当前没有任务，等待 Lead 派发。收到任务后按简报执行，完成时调用 team_report_task。` }],
          parent: caller,
          ...(team.workspace ? { cwd: team.workspace } : {}),
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        },
        signal: exec.signal || AbortSignal.timeout(s.requestTimeoutMs),
      });
      if (started && started.result && typeof started.result.catch === 'function') started.result.catch(() => {});
      const presetResult = applyPermissionPreset(ctx, sessionId, permissionPreset);

      await request(s, '/api/agents/register', {
        method: 'POST',
        body: {
          teamId: team.id,
          name: current.name,
          sessionId,
          parentSessionId: caller.id != null ? String(caller.id) : null,
          role,
          model: route.model,
          contextMode: context,
          agentProvider: route.provider,
          permissionPreset,
          agentPreset, // explicit null = clear old override
          reasoningEffort: route.reasoningEffort,
        },
      });
      // 只把调用方显式改的字段写回元数据并记 member.update；不要用解析后的
      // 继承值覆盖成员覆盖项，否则团队预设以后变更时该成员不会再跟随。
      const updated = await request(s, `/api/members/${id}`, { method: 'PATCH', body: metadata });
      const release = await releaseSession(subs, caller, current.agentSessionId);
      forgetSession(current.agentSessionId);
      rememberMember(sessionId, team.id, updated.id, team.workspace, updated.permissionPreset || permissionPreset, current.name);
      leadByTeam.set(team.id, caller);
      return {
        member: updated,
        restarted: true,
        agent: {
          sessionId,
          previousSessionId: current.agentSessionId ? String(current.agentSessionId) : null,
          provider,
          context,
          model: route.model,
          route,
          release,
        },
        permissionPreset: updated.permissionPreset || permissionPreset,
        agentPreset: updated.agentPreset || agentPreset || null,
        ...(agentPresetWarning ? { agentPresetWarning } : {}),
        permissionPresetApplied: presetResult.applied,
        ...(presetResult.reason ? { permissionPresetWarning: presetResult.reason } : {}),
        ...(presetResult.error ? { permissionPresetWarning: presetResult.error } : {}),
        panel: panelUrl(s),
      };
    },
  });

  tools.push({
    name: 'team_report',
    description: 'Export a Markdown run report: members, tasks/DAG, permission approvals (who asked for what, who decided), and the audit table with actor, action, target, and full before/after SHA-256 hashes. Use it for review, handoff, or proving who changed which file.',
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


  tools.push({
    name: 'board_plan_submit',
    description: 'Submit the finished plan for the current workspace-board task. Call this at the end of the planning session; the scheduler stores the plan and moves the task to planned. In same-session mode this tool also moves the task into the execution slot and keeps this session running: if the returned task status is inprogress, continue with the plan immediately; if it is planned, stop and wait for the scheduler.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: { type: 'string', description: 'Complete plan in markdown.' },
        summary: { type: 'string', description: 'One-line summary.' },
      },
      required: ['plan'],
    },
    output: jsonOutput('{ board task }'),
    async execute(args, exec) {
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      if (!sessionId) throw new Error('board_plan_submit 只能在规划会话里调用');
      const task = await request(s, '/api/board/agents/plan', {
        method: 'POST',
        body: { sessionId, plan: args.plan, summary: args.summary || null },
      });
      const rec = boardSessions.get(sessionId);
      // 同会话模式：sidecar 保存计划时已经 claim 执行槽位并 attach 回本会话，
      // 这里只切权限、改 phase，让同一个回合直接继续执行（不再补发第二条 prompt）。
      if (task?.status === 'inprogress') {
        if (task.leadPermissionPreset) boardSetPermission(ctx, rec?.handle?.agent || exec?.agent, task.leadPermissionPreset);
        // prewalk：这里只武装、不切模型。规划模型先按计划落下第一笔实现动作
        // （首次 edit/write 或首次 team_task 派发），确认计划可执行后再交给执行模型。
        if (task.prewalk) {
          const boardSettings = await request(
            s,
            `/api/board/settings?workspaceId=${encodeURIComponent(task.workspaceId)}`,
          ).catch(() => null);
          await armBoardPrewalk(ctx, rec?.handle?.agent || exec?.agent, task, boardSettings || {});
        }
        if (rec) { rec.phase = 'execution'; rec.sawRunning = false; }
      } else if (rec) {
        rec.phase = 'planned';
      }
      if (task?.executionMode === 'new' && rec) {
        const timer = setTimeout(() => {
          if (rec.phase !== 'planned') return;
          try { void rec.handle?.dispose?.(); } catch { /* ignore */ }
          boardSessions.delete(sessionId);
          boardSessionIds.delete(sessionId);
        }, 5000);
        timer.unref?.();
      }
      return task;
    },
  });

  tools.push({
    name: 'board_task_status',
    description: 'Report the current workspace-board task status from the Lead session. Call it at the end of EVERY turn: "done" after all team tasks succeed, "failed" when the task cannot be completed, and "inprogress" while work remains or when waiting for the user (also call it when the user sends a new message after a finished task).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['done', 'failed', 'inprogress'] },
        summary: { type: 'string', description: 'Short result or failure reason.' },
      },
      required: ['status'],
    },
    output: jsonOutput('{ board task }'),
    async execute(args, exec) {
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      if (!sessionId) throw new Error('board_task_status 只能在看板 Lead 会话里调用');
      return await request(s, '/api/board/agents/status', {
        method: 'POST',
        body: { sessionId, status: args.status, summary: args.summary || null },
      });
    },
  });

  tools.push({
    name: 'board_task_create',
    description: 'Create a new workspace-board task card (the user-facing queue the board scheduler picks up) — use it for follow-up work the current task uncovered but should not do itself. This is NOT a team DAG task: team_* tools stay inside the current team. workspaceId defaults to the caller own board task, then to the only registered workspace; pass it when either is ambiguous. Pass gitBranch to run the new task on a git branch ("" = auto `task/<id>`, omitted = no branch).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Card title; the card is created in todo.' },
        description: { type: 'string', description: 'Full instructions for the session that will run this card.' },
        workspaceId: { type: 'string', description: 'Board workspace id; inferred from the caller board task or the single registered workspace.' },
        workspacePath: { type: 'string', description: 'Workspace path; defaults to the registered workspace path.' },
        auto: { type: 'boolean', description: 'Queue immediately (default false: stays in todo until started).' },
        needPlan: { type: 'boolean', description: 'Run a planning session first (default true).' },
        useTeam: { type: 'boolean', description: 'Let the Lead orchestrate a team (default true).' },
        executionMode: { type: 'string', enum: ['same', 'new'], description: 'same = plan and execute in one session; new = execute in a fresh session.' },
        gitBranch: { type: 'string', description: 'Git branch to switch to before spawning; "" auto-generates task/<id>.' },
      },
      required: ['title'],
    },
    output: jsonOutput('{ task }'),
    async execute(args, exec) {
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      let workspaceId = args.workspaceId ? String(args.workspaceId) : null;
      let workspacePath = args.workspacePath ? String(args.workspacePath) : null;
      // 优先沿用调用者自己那张看板卡的工作区：它一定和当前会话的 cwd 一致。
      if (!workspaceId && sessionId) {
        const cur = await request(s, `/api/board/by-session/${encodeURIComponent(sessionId)}`).catch(() => null);
        if (cur && cur.ok !== false && cur.id) {
          workspaceId = cur.workspaceId;
          workspacePath = workspacePath || cur.workspacePath;
        }
      }
      if (!workspaceId) {
        const ws = await request(s, '/api/workspaces').catch(() => null);
        const items = Array.isArray(ws?.items) ? ws.items : [];
        if (items.length === 1) {
          workspaceId = items[0].id;
          workspacePath = workspacePath || items[0].path;
        }
      }
      if (!workspaceId) throw new Error('board_task_create 需要 workspaceId：当前会话不属于任何看板任务，且工作区不唯一');
      const task = await request(s, '/api/board/tasks', {
        method: 'POST',
        body: {
          workspaceId,
          ...(workspacePath ? { workspacePath } : {}),
          title: args.title,
          description: args.description || '',
          ...(args.auto !== undefined ? { auto: args.auto } : {}),
          ...(args.needPlan !== undefined ? { needPlan: args.needPlan } : {}),
          ...(args.useTeam !== undefined ? { useTeam: args.useTeam } : {}),
          ...(args.executionMode !== undefined ? { executionMode: args.executionMode } : {}),
          ...(args.gitBranch !== undefined ? { gitBranch: args.gitBranch } : {}),
        },
      });
      return { task };
    },
  });

  tools.push({
    name: 'board_task_get',
    description: 'Read the current workspace-board task of this session (status/planSummary/lastError/gitBranch/sessions) when taskId is omitted, or any board card by taskId. Cheap and safe to call every turn: it returns the status snapshot, not the whole plan body. Use it to decide whether to keep working, wait, or report via board_task_status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'Board task id (bt_…); omit to read the caller own card.' },
      },
    },
    output: jsonOutput('{ task }'),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const pick = (t) => ({
        id: t.id, workspaceId: t.workspaceId, title: t.title, status: t.status,
        executionMode: t.executionMode, needPlan: t.needPlan, useTeam: t.useTeam,
        gitBranch: t.gitBranch || null,
        planSummary: t.planSummary || null, lastError: t.lastError || null,
        planningSessionId: t.planningSessionId || null, leadSessionId: t.leadSessionId || null,
        teams: t.teams || [], archivedAt: t.archivedAt || null, updatedAt: t.updatedAt,
      });
      if (args.taskId) {
        const task = await request(s, `/api/board/tasks/${encodeURIComponent(args.taskId)}`);
        return { task: pick(task) };
      }
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      if (!sessionId) throw new Error('board_task_get 需要 taskId，或从看板会话里调用');
      const found = await request(s, `/api/board/by-session/${encodeURIComponent(sessionId)}`).catch(() => null);
      if (!found || found.ok === false || !found.id) throw new Error('当前会话没有关联的看板任务');
      return { task: pick(found) };
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
      leadByTeam.clear(); teamCache.clear(); sessionMember.clear(); dispatching.clear(); teamBySession.clear(); contextReportAt.clear(); prewalkArmed.clear();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      for (const timer of startTimers.values()) clearTimeout(timer);
      idleTimers.clear(); startTimers.clear(); agentStatusBySession.clear(); lastReplyBySession.clear();
      const spawned = s.spawned;
      if (spawned?.child && spawned.child.exitCode === null) {
        try { spawned.child.kill(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-team.tools()');

  // Leader 自建 agentPreset：启动时把固定目录里的 JSON 文档注册进宿主，卸载时反注册。
  // 注册失败不阻断插件：工具仍可 list/show/save，错误从返回值里看。
  ctx.effect(() => {
    teamPresetsReady = null;
    teamPresetLoading = null;
    void ensureTeamPresets(s, ctx).then(() => syncPresetCatalog(s, ctx)).catch(() => null);
    let presetTicks = 0;
    const presetTimer = setInterval(() => {
      void processPresetDeletes(s, ctx).catch(() => null);
      // sidecar 可能比插件晚就绪：每 30s 补一次目录同步，面板不会一直空着。
      if (++presetTicks % 6 === 0) void syncPresetCatalog(s, ctx).catch(() => null);
    }, 5000);
    presetTimer.unref?.();
    return () => {
      clearInterval(presetTimer);
      const pending = [...teamPresetDisposers.values()];
      teamPresetDisposers.clear();
      teamPresetsReady = null;
      teamPresetLoading = null;
      for (const dispose of pending) { try { void dispose(); } catch { /* ignore */ } }
    };
  }, 'dsh-team.presets()');

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

  // 审批分类需要工具参数，但 approval/request 只带 toolName/callId：
  // 在 pre-execute 里按 callId 缓存成员这一轮的入参（只记成员，带 TTL），供低风险命令自动放行判定。
  if (s.autoApproveLowRisk || s.autoApproveTools.length) {
    ctx.on('tools/pre-execute', (exec, next) => {
      try { rememberPreExecuteArgs(exec); } catch { /* ignore */ }
      return typeof next === 'function' ? next() : undefined;
    });
  }

  // 成员权限审批：preset 的 approval=ask 触发时，把请求转给 Lead，由 team_approve 决定。
  // 放在最前面（prepend），确保本插件的成员请求不会再弹出宿主审批 UI。
  ctx.effect(() => {
    const off = ctx.on('approval/request', (req, next) => onApprovalRequest(s, ctx, req, next), { prepend: true });
    return () => {
      try { off?.(); } catch { /* ignore */ }
      cancelPendingApprovals();
    };
  }, 'dsh-team.approval()');

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

  // prewalk（实验性）：先在原模型上做第一笔实现动作，再交接同一条会话。
  // 只有武装过的看板会话参与；交接失败不影响工具结果，也不阻断任务。
  const prewalkHook = async (exec, next) => {
    const result = await next();
    try {
      const sessionId = exec?.agent?.id != null ? String(exec.agent.id) : null;
      const entry = sessionId ? prewalkArmed.get(sessionId) : null;
      if (!entry) return result;
      const name = String(exec?.name || '');
      // 任务收工（done/failed）时清掉未触发的武装，避免会话结束后残留。
      if (name === 'board_task_status' && exec?.arguments?.status !== 'inprogress') {
        prewalkArmed.delete(sessionId);
        return result;
      }
      if (!boardPrewalkWantsTool(name)) return result;
      // 工具报错（参数错、权限拒绝等）不算「已经落到实现」：保持武装，等下一次
      // 成功的 edit/write（或 team_task）再交接，避免接手模型先替规划模型收拾失败。
      if (result && (result.isError === true || result.error != null)) return result;
      prewalkArmed.delete(sessionId);
      await boardHandoffPrewalk(ctx, exec.agent, entry.task, entry.settings);
    } catch (err) {
      console.warn(`[dsh-team] prewalk: 交接失败（${String(err?.message || err)}）`);
    }
    return result;
  };
  prewalkHook.dshTeamHook = 'prewalk';
  ctx.on('tools/execute', prewalkHook);

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
    // Lead interrupt 后会话处于冻结态：DSH 中断引发的 idle 不能把成员改回 idle，
    // 否则 sidecar 认为成员可派发，下一次派发泵又会把它唤醒。
    if (status === 'idle' && heldSessions.has(sessionId)) {
      cancelIdleReport(sessionId);
      agentStatusBySession.set(sessionId, 'interrupted');
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
      if (heldSessions.has(sessionId)) { agentStatusBySession.set(sessionId, 'interrupted'); return; }
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
        // 冻结中的会话：中断本身可能让回合以 error 结束，不要覆盖 sidecar 的 interrupted。
        if (heldSessions.has(sessionId)) return;
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

  // 面板/看板停止的强制收尾：sidecar 只把成员置 interrupted，真正中断 DSH 会话在这里做。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void forceStopPump(s, ctx).catch(() => { /* ignore */ });
    }, Math.max(250, s.forceStopPollMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-team.force-stop-pump()');

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

  // 看板会话审批：规划阶段只读，任何审批直接拒绝，避免无人值守卡住。
  // 执行阶段用 danger-full-access（never），正常情况下不会走到这里。
  if (s.boardEnabled) {
    ctx.effect(() => {
      const off = ctx.on('approval/request', (req, next) => {
        const sessionId = req?.agent?.id != null ? String(req.agent.id) : null;
        const rec = sessionId ? boardSessions.get(sessionId) : null;
        if (rec && rec.phase === 'planning') return 'rejected';
        return next();
      }, { prepend: true });
      return () => { try { off?.(); } catch { /* ignore */ } };
    }, 'dsh-team.board-approval()');
  }

  // 看板会话的后续用户消息：done/failed 被追问时翻回 inprogress（sidecar 只对这些状态生效）。
  // 规划阶段例外：任务可能已被 idle 宽限判 failed，此时翻 inprogress 会让提交计划只认 planning
  // 的状态机报 404；保持原状，由 submitPlan 按 planning_session_id 复活。
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id != null ? String(session.id) : null;
    if (!sessionId || !boardSessionIds.has(sessionId)) return;
    if (!event || event.type !== 'user/message') return;
    if (boardSessions.get(sessionId)?.phase === 'planning') return;
    void request(s, '/api/board/agents/status', {
      method: 'POST', body: { sessionId, status: 'inprogress' },
    }).catch(() => { /* 非终态时 sidecar 会拒绝，忽略 */ });
  });

  // 看板会话 idle：规划阶段宽限后仍停在 planning → 判失败，避免永久占着槽位。
  ctx.on('agent/status', ({ agent, status } = {}) => {
    const sessionId = agent?.id != null ? String(agent.id) : null;
    const rec = sessionId ? boardSessions.get(sessionId) : null;
    if (!rec) return;
    if (status === 'running') { rec.sawRunning = true; return; }
    if (status !== 'idle' || !rec.sawRunning) return;

    if (rec.phase !== 'planning') return;
    const timer = setTimeout(() => {
      void (async () => {
        if (rec.phase !== 'planning') return;
        try {
          const task = await request(s, `/api/board/tasks/${encodeURIComponent(rec.taskId)}`);
          if (task?.status !== 'planning') return;
          await request(s, '/api/board/agents/status', {
            method: 'POST', body: { sessionId, status: 'failed', summary: '规划会话空闲但未提交计划' },
          });
        } catch { /* ignore */ }
      })();
    }, Math.max(0, s.boardIdleGraceMs));
    timer.unref?.();
  });

  // 把 DSH Web 的浏览器地址报给 sidecar：独立面板据此 window.open 到 `#dsh-session=<id>`
  // 深链，由 dsh-plugin-ui 的客户端半边接管并打开对应会话。
  ctx.effect(() => {
    const report = () => {
      try {
        const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
        if (!ws || !ws.port) return;
        const host = String(ws.host || '127.0.0.1');
        const authority = host.includes(':') ? `[${host}]` : host;
        const proto = ws.config?.tls ? 'https' : 'http';
        void request(s, '/api/host/web', { method: 'POST', body: { url: `${proto}://${authority}:${ws.port}` } })
          .catch(() => { /* sidecar 未就绪时下一轮再报 */ });
      } catch { /* 宿主没有 webServer 服务时跳过 */ }
    };
    report();
    const timer = setInterval(report, 60000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-team.host-web()');

  // 看板调度泵：每个 tick 向 sidecar claim 规划/执行槽位，claim 到就建会话并投 prompt。
  if (s.boardEnabled) {
    ctx.effect(() => {
      const timer = setInterval(() => { void boardPump(s, ctx).catch(() => { /* ignore */ }); }, Math.max(500, s.boardDispatchMs));
      timer.unref?.();
      return () => {
        clearInterval(timer);
        for (const rec of boardSessions.values()) { try { void rec.handle?.dispose?.(); } catch { /* ignore */ } }
        boardSessions.clear();
        boardSessionIds.clear();
      };
    }, 'dsh-team.board-pump()');
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

  // steer 泵：把面板排进 sidecar 的队列消息（kind='steer'）推进成员会话。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void steerPump(s, ctx).catch(() => { /* ignore */ });
    }, Math.max(500, s.steerPollMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-team.steer-pump()');
}

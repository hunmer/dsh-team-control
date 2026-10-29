/**
 * 面板全局状态：数据只来自 SSE；REST 仅首屏快照 / 重连补齐 / 操作。
 * 逻辑移植自原 vanilla src/web/app.js，行为保持一致。
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { API_BASE, api, ApiError, EMBEDDED, enc, getToken, initUrlToken, pickItems, setToken } from './lib/api';
import { fmtClock, storeGet, storeSet } from './lib/format';
import type { DagData, MatrixRow, Member, Policy, ScopeRequest, Task, Team, TeamMessage, TimelineEntry, Todo, TraceData } from './types';

export const TAB_NAMES = ['board', 'dag', 'timeline', 'models', 'permissions', 'approvals', 'messages'] as const;
/**
 * 面板视图。`home` 是 affectui 风格的默认主页（FR-2/FR-4）：
 * 它不在 TAB_NAMES 里，因此不会被持久化；旧版本存下的 7 个业务 tab 仍按白名单恢复。
 */
export type TabName = (typeof TAB_NAMES)[number] | 'home';

export const PHASES = ['init', 'read', 'write', 'exec', 'net', 'env', 'msg', 'wait', 'verify', 'interrupt', 'resume', 'done', 'fail', 'decision', 'recover'];
const SSE_TYPES = ['member.status', 'step.append', 'task.state', 'message.delivered', 'scope.request', 'decision', 'lease.warn', 'span.append'];
const TIMELINE_CAP = 2000;
const STORE_UI = 'dsh-team.panel.ui.v1';
const STORE_LAST = 'dsh-team.panel.lastEventId.v1';

/** 暂停缓存（模块级单例 ref，供 Timeline 视图轮询展示长度）。 */
export const pendingTimelineRef: { current: TimelineEntry[] } = { current: [] };

export type ConnKind = 'connecting' | 'live' | 'reconnecting' | 'offline';
export interface ToastItem { id: number; message: string; kind: 'ok' | 'warn' | 'error' | 'info'; }
export type Errors = Partial<Record<'status' | 'dag' | 'permissions' | 'policies' | 'approvals' | 'messages' | 'timeline' | 'trace' | 'tasks' | 'todos', string | null>>;

interface PanelState {
  teamId: string | null;
  team: Team | null;
  teams: Team[];
  noTeams: boolean;
  members: Member[];
  staleMembers: Set<string>;
  degraded: boolean;
  snapshot: { asOf: string | null; version: number | null } | null;
  dag: DagData | null;
  /** sidecar 任务行（/api/tasks）：主页 AgentInbox 的标题/时间/验收来源 */
  tasks: Task[];
  /** 任务计划清单（/api/todos）：主页 Plan 区域的数据源 */
  todos: Todo[];
  trace: TraceData | null;
  /** Trace 时间窗（分钟，0 = 全部历史）；默认只看最近 30 分钟，避免长期闲置团队的横轴被拉爆 */
  traceWindow: number;
  matrix: MatrixRow[];
  policies: Policy[];
  scopeRequests: ScopeRequest[];
  messages: TeamMessage[];
  errors: Errors;
  timeline: TimelineEntry[];
  paused: boolean;
  speed: 1 | 4;
  tab: TabName;
  filters: { member: string; phase: string };
  conn: ConnKind;
}

const initialState: PanelState = {
  teamId: null, team: null, teams: [], noTeams: false,
  members: [], staleMembers: new Set(), degraded: false, snapshot: null,
  dag: null, tasks: [], todos: [], trace: null, traceWindow: 30, matrix: [], policies: [], scopeRequests: [], messages: [],
  errors: {}, timeline: [], paused: false, speed: 1,
  tab: 'home', filters: { member: '', phase: '' }, conn: 'connecting',
};

export interface PanelActions {
  state: PanelState;
  toasts: ToastItem[];
  authOverlay: null | 'missing' | 'invalid' | 'boot-failed';
  bootError: string | null;
  memberName(id?: string | null): string;
  toast(message: string, kind?: ToastItem['kind'], ttl?: number): void;
  selectTeam(teamId: string): Promise<void>;
  refreshTeams(): Promise<Team[]>;
  refreshAll(): Promise<void>;
  /** 落盘一条越界申请决策，并刷新审批队列/权限矩阵。 */
  decideScope(id: string, decision: 'approved' | 'denied'): Promise<void>;
  refreshPermissions(): Promise<void>;
  refreshMessages(): Promise<void>;
  refreshStatus(): Promise<void>;
  /** 可选窗口覆盖（分钟）；不传则用当前 state.traceWindow */
  refreshTrace(windowMinutes?: number): Promise<void>;
  setTraceWindow(minutes: number): void;
  setTab(tab: TabName): void;
  setPaused(paused: boolean): void;
  setSpeed(speed: 1 | 4): void;
  setFilterMember(member: string): void;
  setFilterPhase(phase: string): void;
  exportReport(): Promise<void>;
  retryBoot(): void;
  submitToken(token: string): void;
}

const PanelContext = createContext<PanelActions | null>(null);
export const usePanel = (): PanelActions => {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error('usePanel must be used within PanelProvider');
  return ctx;
};

function loadUiState() {
  const ui = { tab: 'home' as TabName, filters: { member: '', phase: '' }, paused: false, speed: 1 as 1 | 4 };
  const raw = storeGet(STORE_UI);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && (TAB_NAMES as readonly string[]).includes(parsed.tab)) ui.tab = parsed.tab;
      if (parsed?.filters) {
        ui.filters.member = String(parsed.filters.member || '');
        ui.filters.phase = String(parsed.filters.phase || '');
      }
      ui.paused = !!parsed?.paused;
      ui.speed = parsed?.speed === 4 ? 4 : 1;
    } catch { /* 损坏的存储忽略 */ }
  }
  const last = Number(storeGet(STORE_LAST));
  return { ui, lastEventId: Number.isFinite(last) && last > 0 ? last : 0 };
}

function normalizeFrameEntry(frame: { id?: unknown; memberId?: string; taskId?: string; ts?: string }, payload: Record<string, unknown>): TimelineEntry | null {
  const id = Number(frame.id);
  if (!Number.isFinite(id)) return null;
  return {
    id, seq: payload.seq as number | undefined,
    memberId: frame.memberId || (payload.memberId as string | undefined),
    taskId: frame.taskId || (payload.taskId as string | undefined),
    ts: frame.ts || (payload.ts as string | undefined) || new Date().toISOString(),
    phase: String(payload.phase || ''), action: String(payload.action || ''), target: String(payload.target || ''),
    result: String(payload.result || ''), next: String(payload.next || ''),
  };
}

function normalizeHistoryEntry(item: Record<string, unknown>): TimelineEntry | null {
  if (!item || typeof item !== 'object') return null;
  const id = Number(item.id);
  if (!Number.isFinite(id)) return null;
  const payload = (item.payload && typeof item.payload === 'object') ? (item.payload as Record<string, unknown>) : null;
  if (payload && (payload.phase !== undefined || payload.action !== undefined || payload.seq !== undefined)) {
    return normalizeFrameEntry(item as never, payload);
  }
  if (!item.phase) return null;
  return {
    id, seq: item.seq as number | undefined, memberId: item.memberId as string | undefined, taskId: item.taskId as string | undefined,
    ts: (item.ts as string) || new Date().toISOString(),
    phase: String(item.phase), action: String(item.action || ''), target: String(item.target || ''),
    result: String(item.result || ''), next: String(item.next || ''),
  };
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PanelState>(initialState);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [authOverlay, setAuthOverlay] = useState<PanelActions['authOverlay']>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(0);
  const authProbing = useRef(false);
  const lastEventIdRef = useRef(0);
  const pausedRef = useRef(false);

  const timelineIdsRef = useRef<Set<number>>(new Set());
  const playbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const bootedRef = useRef(false);

  const toast = useCallback((message: string, kind: ToastItem['kind'] = 'info', ttl?: number) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-5), { id, message, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ttl ?? (kind === 'error' ? 8000 : 4200));
  }, []);

  const patchUi = useCallback((patch: Partial<PanelState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  /* ---------- 时间线（暂停缓存 / 回放 / 去重，与原实现一致） ---------- */
  const appendTimeline = useCallback((entry: TimelineEntry) => {
    timelineIdsRef.current.add(entry.id);
    setState((prev) => {
      const timeline = [...prev.timeline, entry];
      if (timeline.length > TIMELINE_CAP) {
        const dropped = timeline.slice(0, timeline.length - TIMELINE_CAP);
        for (const item of dropped) timelineIdsRef.current.delete(item.id);
        return { ...prev, timeline: timeline.slice(-TIMELINE_CAP) };
      }
      return { ...prev, timeline };
    });
  }, []);

  const stopPlayback = useCallback(() => {
    if (playbackTimerRef.current) { clearInterval(playbackTimerRef.current); playbackTimerRef.current = null; }
  }, []);

  const flushPlayback = useCallback((speed: 1 | 4) => {
    if (playbackTimerRef.current) return;
    if (!pendingTimelineRef.current.length) return;
    playbackTimerRef.current = setInterval(() => {
      if (pausedRef.current) { stopPlayback(); return; }
      const next = pendingTimelineRef.current.shift();
      if (!next) { stopPlayback(); return; }
      appendTimeline(next);
    }, speed === 4 ? 25 : 100);
  }, [appendTimeline, stopPlayback]);

  const ingestTimelineEntry = useCallback((entry: TimelineEntry, initial: boolean) => {
    if (!entry || timelineIdsRef.current.has(entry.id)) return;
    if (!initial && (pausedRef.current || playbackTimerRef.current)) {
      pendingTimelineRef.current.push(entry);
      while (pendingTimelineRef.current.length > TIMELINE_CAP) pendingTimelineRef.current.shift();
      return;
    }
    appendTimeline(entry);
  }, [appendTimeline]);

  /* ---------- 刷新 ---------- */
  const onUnauthorized = useCallback(() => setAuthOverlay('invalid'), []);

  const refreshTeams = useCallback(async () => {
    const teams = pickItems<Team>(await api('/api/teams', { onUnauthorized }));
    patchUi({ teams, noTeams: teams.length === 0 });
    return teams;
  }, [patchUi]);

  const refreshStatus = useCallback(async () => {
    const response = await api<{ asOf?: string; version?: number; members?: Member[]; staleMembers?: string[]; degraded?: boolean }>(
      '/api/status?team=' + enc(stateRef.current.teamId), { onUnauthorized });
    patchUi({
      snapshot: { asOf: response.asOf || null, version: response.version === undefined ? null : response.version },
      members: Array.isArray(response.members) ? response.members : pickItems<Member>(response),
      staleMembers: new Set(Array.isArray(response.staleMembers) ? response.staleMembers : []),
      degraded: !!response.degraded,
    });
  }, [patchUi]);

  const refreshTrace = useCallback(async (windowMinutes?: number) => {
    const teamId = stateRef.current.teamId;
    if (!teamId) return;
    const win = Math.max(0, Math.round(Number(windowMinutes ?? stateRef.current.traceWindow) || 0));
    const q = '/api/trace?team=' + enc(teamId) + (win > 0 ? '&window=' + win : '');
    const trace = await api<TraceData>(q, { onUnauthorized });
    if (stateRef.current.teamId !== teamId) return; // 团队已切换：丢弃过期响应
    setState((prev) => ({ ...prev, trace, errors: { ...prev.errors, trace: null } }));
  }, [onUnauthorized]);

  const setTraceWindow = useCallback((minutes: number) => {
    const win = Math.max(0, Math.round(Number(minutes) || 0));
    setState((prev) => ({ ...prev, traceWindow: win }));
    void refreshTrace(win).catch(() => undefined);
  }, [refreshTrace]);

  const refreshDag = useCallback(async () => {
    const dag = await api<DagData>('/api/dag?team=' + enc(stateRef.current.teamId), { onUnauthorized });
    patchUi({ dag });
  }, [patchUi]);

  const refreshTasks = useCallback(async () => {
    const teamId = stateRef.current.teamId;
    if (!teamId) return;
    const items = pickItems<Task>(await api('/api/tasks?team=' + enc(teamId), { onUnauthorized }));
    if (stateRef.current.teamId !== teamId) return; // 团队已切换：丢弃过期响应
    setState((prev) => ({ ...prev, tasks: items, errors: { ...prev.errors, tasks: null } }));
  }, [onUnauthorized]);

  const refreshTodos = useCallback(async () => {
    const teamId = stateRef.current.teamId;
    if (!teamId) return;
    const items = pickItems<Todo>(await api('/api/todos?team=' + enc(teamId), { onUnauthorized }));
    if (stateRef.current.teamId !== teamId) return; // 团队已切换：丢弃过期响应
    setState((prev) => ({ ...prev, todos: items, errors: { ...prev.errors, todos: null } }));
  }, [onUnauthorized]);

  const refreshPermissions = useCallback(async () => {
    const teamId = stateRef.current.teamId;
    const [policiesResponse, matrixResponse] = await Promise.all([
      api('/api/policies?team=' + enc(teamId), { onUnauthorized }),
      api('/api/permission-matrix?team=' + enc(teamId), { onUnauthorized }),
    ]);
    setState((prev) => ({
      ...prev,
      policies: pickItems<Policy>(policiesResponse),
      matrix: pickItems<MatrixRow>(matrixResponse),
      errors: { ...prev.errors, permissions: null, policies: null },
    }));
  }, []);

  const refreshApprovals = useCallback(async () => {
    const items = pickItems<ScopeRequest>(await api('/api/scope-requests?team=' + enc(stateRef.current.teamId) + '&status=pending', { onUnauthorized }));
    patchUi({ scopeRequests: items });
  }, [patchUi]);

  const refreshMessages = useCallback(async () => {
    const items = pickItems<TeamMessage>(await api('/api/messages?team=' + enc(stateRef.current.teamId), { onUnauthorized }));
    patchUi({ messages: items });
  }, [patchUi]);

  const backfillTimeline = useCallback(async () => {
    try {
      const response = await api('/api/events/history?team=' + enc(stateRef.current.teamId) + '&since=0', { onUnauthorized });
      const raw = Array.isArray(response) ? response : pickItems<Record<string, unknown>>(response);
      const entries: TimelineEntry[] = [];
      for (const item of raw) {
        const entry = normalizeHistoryEntry(item);
        if (entry) entries.push(entry);
      }
      entries.sort((a, b) => a.id - b.id);
      const kept = entries.length > TIMELINE_CAP ? entries.slice(entries.length - TIMELINE_CAP) : entries;
      for (const entry of kept) ingestTimelineEntry(entry, true);
      setState((prev) => ({ ...prev, errors: { ...prev.errors, timeline: null } }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'E_UNAUTHORIZED') throw err;
      setState((prev) => ({ ...prev, errors: { ...prev.errors, timeline: err instanceof Error ? err.message : String(err) } }));
    }
  }, [ingestTimelineEntry]);

  const refreshAll = useCallback(async () => {
    const safe = async (key: keyof Errors, fn: () => Promise<void>) => {
      try {
        await fn();
        setState((prev) => (prev.errors[key] ? { ...prev, errors: { ...prev.errors, [key]: null } } : prev));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'E_UNAUTHORIZED') throw err;
        setState((prev) => ({ ...prev, errors: { ...prev.errors, [key]: err instanceof Error ? err.message : String(err) } }));
      }
    };
    await Promise.all([
      safe('status', refreshStatus),
      safe('trace', refreshTrace),
      safe('dag', refreshDag),
      safe('tasks', refreshTasks),
      safe('todos', refreshTodos),
      safe('permissions', refreshPermissions),
      safe('approvals', refreshApprovals),
      safe('messages', refreshMessages),
    ]);
  }, [refreshStatus, refreshTrace, refreshDag, refreshTasks, refreshTodos, refreshPermissions, refreshApprovals, refreshMessages]);

  /**
   * 落盘一条越界申请的决策（home 右栏审批卡使用）。
   * 与审批队列视图的差别：不收集 reason/TTL，使用默认的 300s 授权有效期。
   */
  const decideScope = useCallback(async (id: string, decision: 'approved' | 'denied') => {
    const body: Record<string, unknown> = { decision, decidedBy: 'panel', singleUse: true };
    if (decision === 'approved') body.ttlSeconds = 300;
    await api('/api/scope-requests/' + enc(id) + '/decide', { method: 'POST', body, onUnauthorized });
    await Promise.all([refreshAll(), refreshPermissions()]);
  }, [refreshAll, refreshPermissions]);

  const scheduleRefresh = useCallback((key: 'status' | 'trace' | 'dag' | 'tasks' | 'todos' | 'permissions' | 'approvals' | 'messages', delay = 200) => {
    if (refreshTimers.current[key]) return;
    refreshTimers.current[key] = setTimeout(async () => {
      delete refreshTimers.current[key];
      const map: Record<string, () => Promise<void>> = {
        status: refreshStatus, trace: refreshTrace, dag: refreshDag, tasks: refreshTasks, todos: refreshTodos, permissions: refreshPermissions, approvals: refreshApprovals, messages: refreshMessages,
      };
      try { await map[key](); } catch { return; }
    }, delay);
  }, [refreshStatus, refreshTrace, refreshDag, refreshTasks, refreshTodos, refreshPermissions, refreshApprovals, refreshMessages]);

  /* ---------- SSE ---------- */
  const memberName = useCallback((id?: string | null): string => {
    if (!id) return '—';
    const member = stateRef.current.members.find((m) => m.id === id);
    return member?.name || id;
  }, []);

  const probeAuth = useCallback(async () => {
    if (authProbing.current || (!getToken() && !EMBEDDED)) return;
    authProbing.current = true;
    try {
      const headers = getToken() ? { Authorization: 'Bearer ' + getToken() } : undefined;
      const response = await fetch(API_BASE + '/api/teams', { headers });
      if (response.status === 401) setAuthOverlay('invalid');
    } catch { /* 网络不可用：继续退避重连 */ }
    finally { authProbing.current = false; }
  }, []);

  const patchMember = useCallback((memberId: string | undefined, patch: Partial<Member>) => {
    if (!memberId) return;
    let found = false;
    setState((prev) => {
      const index = prev.members.findIndex((m) => m.id === memberId);
      if (index < 0) return prev;
      found = true;
      const members = prev.members.slice();
      members[index] = { ...members[index], ...patch };
      return { ...prev, members };
    });
    if (!found && !stateRef.current.members.some((m) => m.id === memberId)) scheduleRefresh('status', 400);
  }, [scheduleRefresh]);

  const connectSSERef = useRef<() => void>(() => {});

  const connectSSE = useCallback(() => {
    const existing = esRef.current;
    if (existing) { existing.close(); esRef.current = null; }
    if (!stateRef.current.teamId) return; // 免鉴权：无 token 也可连接

    const scheduleReconnect = () => {
      if (reconnectTimer.current) return;
      const attempt = reconnectAttempt.current;
      reconnectAttempt.current += 1;
      if (attempt >= 2) void probeAuth();
      patchUi({ conn: 'reconnecting' });
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        connectSSERef.current();
      }, Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)));
    };

    const query = new URLSearchParams({ team: stateRef.current.teamId! });
    if (getToken()) query.set('token', getToken());
    if (lastEventIdRef.current > 0) query.set('lastEventId', String(lastEventIdRef.current));
    const source = new EventSource(API_BASE + '/api/events?' + query.toString());
    esRef.current = source;
    patchUi({ conn: reconnectAttempt.current > 0 ? 'reconnecting' : 'connecting' });

    const handleFrame = (type: string, event: MessageEvent) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      const frameId = Number((event as MessageEvent & { lastEventId?: string }).lastEventId || frame.id);
      if (Number.isFinite(frameId) && frameId > lastEventIdRef.current) {
        lastEventIdRef.current = frameId;
        storeSet(STORE_LAST, String(frameId));
      }
      if (frame.teamId && stateRef.current.teamId && frame.teamId !== stateRef.current.teamId) return;
      // SSE 帧的 data 就是 payload 本身（没有 envelope）；history 回填才有 {payload}。
      const payload = (frame.payload && typeof frame.payload === 'object') ? (frame.payload as Record<string, unknown>) : (frame as Record<string, unknown>);
      const memberId = (frame.memberId || payload.memberId) as string | undefined;
      switch (type) {
        case 'member.status': {
          patchMember(memberId, {
            status: payload.status as string, step: payload.step as string, seq: payload.seq as number,
            next: payload.next as string, last: payload.last as string, leaseUntil: payload.leaseUntil as string,
          });
          break;
        }
        case 'step.append': {
          const entry = normalizeFrameEntry(frame as never, payload);
          if (entry) ingestTimelineEntry(entry, false);
          if (memberId) {
            const patch: Partial<Member> = {};
            if (payload.seq !== undefined) patch.seq = payload.seq as number;
            if (payload.action || payload.target) patch.last = [payload.action, payload.target].filter(Boolean).join(' ');
            patchMember(memberId, patch);
          }
          // Worker 步骤也是瀑布里的条：步骤事件到达时同样去抖刷新 trace
          scheduleRefresh('trace', 200);
          if (payload.action === 'task.todo') scheduleRefresh('todos', 120);
          break;
        }
        case 'task.state': scheduleRefresh('dag', 150); scheduleRefresh('tasks', 150); break;
        case 'message.delivered': scheduleRefresh('messages', 250); break;
        case 'span.append':
          // 工具调用 / 步骤跨度变化：去抖刷新瀑布树，保留正在增长中的条
          scheduleRefresh('trace', 120);
          break;
        case 'scope.request': {
          // 合成帧（scope.request / decision / lease.warn）的字段在 frame 顶层，其余事件在 payload 内。
          const domain = String(frame.domain ?? payload.domain ?? '');
          const target = String(frame.target ?? payload.target ?? '');
          toast('新的越界申请：' + memberName(memberId) + ' ' + domain + ' ' + target, 'warn', 6000);
          scheduleRefresh('approvals', 150);
          break;
        }
        case 'decision': {
          const raw = String(frame.decision ?? payload.decision ?? '');
          const decision = raw.toLowerCase();
          const verdict = decision === 'approved' ? '已批准' : decision === 'denied' ? '已驳回' : raw || '已落盘';
          toast('决策落盘：' + memberName(memberId) + ' 的申请' + verdict, decision === 'denied' ? 'warn' : 'ok');
          scheduleRefresh('approvals', 150);
          scheduleRefresh('permissions', 250);
          break;
        }
        case 'lease.warn':
          toast('租约告警：' + memberName((payload.memberId as string) || memberId) + '（leaseUntil=' + fmtClock(payload.leaseUntil as string) + '，missed=' + String(payload.missed ?? '?') + '）', 'error', 8000);
          scheduleRefresh('status', 200);
          break;
        default: break;
      }
    };

    source.onopen = () => {
      reconnectAttempt.current = 0;
      patchUi({ conn: 'live' });
      void refreshAll().catch(() => {});
    };
    source.onerror = () => {
      if (esRef.current !== source) return;
      source.close();
      esRef.current = null;
      patchUi({ conn: 'reconnecting' });
      scheduleReconnect();
    };
    for (const type of SSE_TYPES) source.addEventListener(type, (event) => handleFrame(type, event as MessageEvent));
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame && typeof frame.type === 'string' && SSE_TYPES.includes(frame.type)) handleFrame(frame.type, event);
      } catch { /* 忽略非 JSON 帧 */ }
    };
  }, [patchUi, refreshAll, scheduleRefresh, patchMember, ingestTimelineEntry, memberName, toast, probeAuth]);

  connectSSERef.current = connectSSE;

  /* ---------- 团队选择 / 启动 ---------- */
  const selectTeam = useCallback(async (teamId: string) => {
    if (!teamId) return;
    const team = stateRef.current.teams.find((t) => t.id === teamId) || null;
    stopPlayback();
    pendingTimelineRef.current = [];
    timelineIdsRef.current = new Set();
    setState((prev) => ({
      ...prev, teamId, team,
      members: [], staleMembers: new Set(), degraded: false, snapshot: null,
      dag: null, tasks: [], todos: [], trace: null, matrix: [], policies: [], scopeRequests: [], messages: [], timeline: [],
      errors: {},
    }));
    // setState 异步生效；先同步 stateRef，保证随后的 refreshAll 读到新 teamId
    stateRef.current = { ...stateRef.current, teamId, team };
    try {
      const url = new URL(location.href);
      url.searchParams.set('team', teamId);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
    await refreshAll();
    await backfillTimeline();
    connectSSE();
  }, [refreshAll, backfillTimeline, connectSSE, stopPlayback]);

  const boot = useCallback(async () => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    initUrlToken(); // 兼容旧链接里的 #token（服务端已免鉴权，直接忽略）
    setAuthOverlay(null);
    setBootError(null);
    try {
      const { ui, lastEventId } = loadUiState();
      pausedRef.current = ui.paused;
      lastEventIdRef.current = lastEventId;
      setState((prev) => ({ ...prev, tab: ui.tab, filters: ui.filters, paused: ui.paused, speed: ui.speed }));
      const teams = await refreshTeams();
      if (!teams.length) return;
      const wanted = new URLSearchParams(location.search).get('team');
      const target = wanted && teams.some((t) => t.id === wanted) ? wanted : teams[0].id;
      await selectTeam(target);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'E_UNAUTHORIZED') {
        patchUi({ conn: 'offline' });
        return;
      }
      setBootError(err instanceof Error ? err.message : String(err));
    }
  }, [patchUi, refreshTeams, selectTeam]);

  const retryBoot = useCallback(() => {
    bootedRef.current = false;
    setBootError(null);
    void boot();
  }, [boot]);

  const submitToken = useCallback((token: string) => {
    setToken(token);
    setAuthOverlay(null);
    retryBoot();
  }, [retryBoot]);

  const saveUiState = useCallback((patch: Partial<Pick<PanelState, 'tab' | 'paused' | 'speed' | 'filters'>>) => {
    const current = stateRef.current;
    storeSet(STORE_UI, JSON.stringify({
      tab: patch.tab ?? current.tab,
      filters: patch.filters ?? current.filters,
      paused: patch.paused ?? current.paused,
      speed: patch.speed ?? current.speed,
    }));
  }, []);

  const setTab = useCallback((tab: TabName) => {
    patchUi({ tab });
    saveUiState({ tab });
    if (stateRef.current.teamId) {
      const map: Partial<Record<TabName, () => Promise<void>>> = {
        home: async () => { await refreshTasks(); await refreshTodos(); },
        board: refreshStatus, dag: refreshDag, permissions: refreshPermissions,
        approvals: refreshApprovals, messages: refreshMessages,
      };
      void map[tab]?.().catch(() => {});
      if (tab === 'board') void refreshTrace().catch(() => {});
    }
  }, [patchUi, saveUiState, refreshStatus, refreshTrace, refreshDag, refreshTasks, refreshTodos, refreshPermissions, refreshApprovals, refreshMessages]);

  const setPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
    patchUi({ paused });
    saveUiState({ paused });
    if (paused) stopPlayback();
    else flushPlayback(stateRef.current.speed);
  }, [patchUi, saveUiState, stopPlayback, flushPlayback]);

  const setSpeed = useCallback((speed: 1 | 4) => {
    patchUi({ speed });
    saveUiState({ speed });
    if (playbackTimerRef.current) { stopPlayback(); flushPlayback(speed); }
  }, [patchUi, saveUiState, stopPlayback, flushPlayback]);

  const setFilterMember = useCallback((member: string) => {
    setState((prev) => ({ ...prev, filters: { ...prev.filters, member } }));
    saveUiState({ filters: { ...stateRef.current.filters, member } });
  }, [saveUiState]);

  const setFilterPhase = useCallback((phase: string) => {
    setState((prev) => ({ ...prev, filters: { ...prev.filters, phase } }));
    saveUiState({ filters: { ...stateRef.current.filters, phase } });
  }, [saveUiState]);

  const exportReport = useCallback(async () => {
    const teamId = stateRef.current.teamId;
    if (!teamId) { toast('请先选择团队', 'warn'); return; }
    try {
      const response = await api<Response>('/api/report?team=' + enc(teamId) + '&format=md', { raw: true, onUnauthorized });
      const text = await response.text();
      const fileName = 'run-' + String(stateRef.current.team?.name || teamId).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) + '.md';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('报告已开始下载（' + fileName + '）', 'ok');
    } catch (err) {
      toast('报告导出失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [toast]);

  /* ---------- 生命周期 ---------- */
  useEffect(() => {
    void boot();
    const online = () => { if (stateRef.current.teamId && !esRef.current) connectSSERef.current(); };
    const offline = () => patchUi({ conn: 'offline' });
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      esRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      stopPlayback();
      for (const timer of Object.values(refreshTimers.current)) clearTimeout(timer);
    };
  }, [boot, patchUi, stopPlayback]);

  const actions = useMemo<PanelActions>(() => ({
    state, toasts, authOverlay, bootError, memberName, toast,
    selectTeam, refreshTeams, refreshAll, decideScope, refreshPermissions, refreshMessages, refreshStatus, refreshTrace, setTraceWindow,
    setTab, setPaused, setSpeed, setFilterMember, setFilterPhase, exportReport,
    retryBoot, submitToken,
  }), [state, toasts, authOverlay, bootError, memberName, toast, selectTeam, refreshTeams, refreshAll, decideScope, refreshPermissions, refreshMessages, refreshStatus, refreshTrace, setTraceWindow, setTab, setPaused, setSpeed, setFilterMember, setFilterPhase, exportReport, retryBoot, submitToken]);

  return <PanelContext.Provider value={actions}>{children}</PanelContext.Provider>;
}

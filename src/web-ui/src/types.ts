/** 与原 vanilla 面板一致的数据契约（REST + SSE 帧）。 */

export type MemberStatus =
  | 'queued' | 'spawning' | 'running' | 'idle' | 'blocked'
  | 'interrupted' | 'inactive' | 'failed' | 'done' | string;

export interface Blocker {
  kind?: string;
  id?: string | number;
  detail?: string;
  [key: string]: unknown;
}

export interface Member {
  id: string;
  name?: string;
  role?: string;
  model?: string;
  status: MemberStatus;
  step?: string;
  seq?: number;
  currentTaskId?: string;
  last?: string;
  next?: string;
  leaseUntil?: string;
  pct?: number;
  stale?: boolean;
  blockers?: Blocker[];
}

export interface DagEdge {
  from: string;
  to: string;
  condition?: string;
  artifactPath?: string;
}

export interface DagNode {
  taskId: string;
  subject?: string;
  status?: string;
  assignee?: string;
  attempts?: number;
  dependsOn?: string[];
  ready?: boolean;
  blocked?: boolean;
}

export interface DagData {
  nodes: DagNode[];
  edges: DagEdge[];
  ready?: string[];
  criticalPath?: string[];
}

export interface Policy {
  id: string;
  subjectType?: string;
  subjectId?: string;
  domain?: string;
  matcher?: string;
  ops?: string[] | string;
  mode?: string;
  expiresAt?: string;
}

export interface MatrixRow {
  memberId: string;
  name?: string;
  role?: string;
  fs?: unknown;
  exec?: unknown;
  net?: unknown;
  env?: unknown;
}

export interface ScopeRequest {
  id: string;
  memberId: string;
  domain?: string;
  target?: string;
  risk?: string;
  reason?: string;
  diffSize?: number;
  fallback?: string;
  blockedStep?: string;
  createdAt?: string;
}

export interface TeamMessage {
  id: string;
  from?: string;
  to?: string;
  kind?: string;
  status?: string;
  correlationId?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  ackedAt?: string;
}

export interface TimelineEntry {
  id: number;
  seq?: number;
  memberId?: string;
  taskId?: string;
  ts: string;
  phase: string;
  action?: string;
  target?: string;
  result?: string;
  next?: string;
}

/** GET /api/tasks 的任务（sidecar 持久化的完整任务行，含时间戳）。 */
export interface Task {
  id: string;
  teamId: string;
  subject: string;
  assignee?: string | null;
  status: string;
  plan?: unknown[];
  writeScopes?: string[];
  acceptance?: string | null;
  attempts?: number;
  maxAttempts?: number;
  failurePolicy?: string | null;
  priority?: number;
  attemptedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
}

export interface Team {
  id: string;
  name?: string;
}

/* ---------- Trace 瀑布（成员看板） ---------- */

export type TraceKind = 'agent' | 'subagent' | 'llm' | 'tool';
export type TraceStatus = 'running' | 'done' | 'failed';

/** GET /api/trace 的节点；start/end 是相对 originMs 的毫秒数，running 节点没有 end。 */
export interface TraceNode {
  id: string;
  name: string;
  kind: TraceKind;
  status: TraceStatus;
  start: number;
  end?: number;
  detail?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  input?: string;
  output?: string;
  error?: string;
  children: TraceNode[];
}

export interface TraceStats {
  members: number;
  steps: number;
  spans: number;
  nodes: number;
  running: number;
  failed: number;
  durationMs: number;
}

export interface TraceData {
  asOf: string;
  version?: number;
  teamId: string;
  /** 时间轴原点（epoch ms），也是瀑布的 startedAt */
  originMs: number;
  /** 服务端生成时刻（epoch ms） */
  now: number;
  /** 生效的时间窗（ms，0 表示全量）与窗口起点（epoch ms） */
  windowMs?: number;
  cutoffMs?: number | null;
  root: TraceNode;
  stats: TraceStats;
}

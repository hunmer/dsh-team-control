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
  /** 派发时确定的思考强度（agent 成员才有，worker 为 null；之后不随任务变化） */
  reasoningEffort?: string | null;
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
  /** member.created_at，列表按它排序 */
  createdAt?: string;
  /** 成员在 DSH 里的会话 id（agent runtime 才有；可据此打开该成员的对话） */
  agentSessionId?: string | null;
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
  /** 消息正文等业务负载（team_send 写入 { text }） */
  payload?: Record<string, unknown>;
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

export type TeamRunStatus = 'running' | 'blocked' | 'idle' | 'empty';

export interface Team {
  id: string;
  name?: string;
  /** 团队绑定的工作区绝对路径（DSH 工作区注册表里的 path） */
  workspace?: string;
  /** 运行状态汇总（GET /api/teams 由 member_state 聚合） */
  status?: TeamRunStatus;
  memberCount?: number;
  runningCount?: number;
  blockedCount?: number;
  /** 封存时间（null/undefined 表示未封存） */
  archivedAt?: string | null;
  /** 创建该团队的 lead 会话 id（面板据此把成员会话的父会话带给 DSH） */
  leadSessionId?: string | null;
}

/** DSH 工作区注册表里的一项（/api/workspaces，Host 插件从 ctx.workspaceRegistry 同步）。 */
export interface Workspace {
  id: string;
  title: string;
  path: string;
  position?: number;
  updatedAt?: string | null;
}

/** 面板全局设置（GET/PATCH /api/settings） */
export interface PanelSettings {
  autoArchive: { enabled: boolean; days: number };
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

/** 任务计划清单（/api/todos）。Leader/成员通过 team_todo 维护，主页 Plan 区域实时渲染。 */
export interface Todo {
  id: string;
  teamId: string;
  taskId?: string | null;
  memberId?: string | null;
  title: string;
  status: string;
  orderNo: number;
  blockedBy?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** 成员产物：Host 插件从成员会话里采集的交付文件（present 声明 / workspace 改动）。 */
export interface TaskArtifact {
  id: string;
  teamId: string;
  taskId?: string | null;
  memberId?: string | null;
  path: string;
  label?: string;
  /** present = 成员显式声明的交付文件；workspace = 会话里改动过的文件 */
  source: 'present' | 'workspace' | string;
  /** 新增行数 / 删除行数（来自 workspace 变更摘要；未知为 null） */
  added?: number | null;
  deleted?: number | null;
  createdAt?: string;
}

/* ------------------------------------------------------------ 上下文分析 */

/** 上下文块类型：决定 treemap tile 的配色（与 components/context-map 对齐）。 */
export type ContextBlockKind = 'system' | 'tools' | 'memory' | 'file' | 'chat' | 'result' | 'summary';

export interface ContextBlockItem {
  label: string;
}

/** 上下文窗口里的一块占用（Host 插件从成员会话折算后上报）。 */
export interface ContextBlock {
  id: string;
  label: string;
  kind: ContextBlockKind;
  tokens: number;
  detail?: string;
  items?: ContextBlockItem[];
}

/** 最近一次压缩：before 是压缩前的 blocks，summarized / dropped 是其中被折叠 / 丢弃的 id。 */
export interface ContextCompaction {
  before: ContextBlock[];
  summarized?: string[];
  dropped?: string[];
  summary?: string;
  atSeq?: number | null;
  shadowedTokens?: number | null;
}

/** 该成员整段会话的 LLM 用量（侧车从 span 汇总：排行用的输入/输出/花费口径）。 */
export interface ContextUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
}

/** 某个成员当前的上下文快照（/api/contexts）。 */
export interface ContextSnapshot {
  teamId: string;
  memberId: string;
  sessionId?: string | null;
  model?: string | null;
  provider?: string | null;
  limit?: number | null;
  used?: number | null;
  breakdown?: { system?: number; tools?: number; messages?: number } | null;
  blocks: ContextBlock[];
  compaction?: ContextCompaction | null;
  status?: string | null;
  asOfSeq?: number | null;
  updatedAt?: string;
  /** 累计 LLM 用量；后端无法汇总时为 0。 */
  usage?: ContextUsage;
}

/** 审阅改动的风险档：沿仓库既有色板，只做静态标注，不影响任何写操作。 */
export type ChangeRisk = 'high' | 'medium' | 'low';

/** 子成员对文件的一次 write/edit 改动（/api/changes）。 */
export interface MemberChange {
  id: string;
  teamId: string;
  taskId?: string | null;
  memberId?: string | null;
  /** 展示路径（workspace 相对路径或绝对路径，已压缩成 a/… 形式供 diff 头使用） */
  path: string;
  /** add = 新文件；edit = 改动既有文件 */
  kind: 'add' | 'edit' | 'delete' | string;
  /** unified diff 文本，头部两行为 --- a/… / +++ b/…；空串表示内容无变化 */
  diff: string;
  added?: number | null;
  deleted?: number | null;
  createdAt?: string;
}

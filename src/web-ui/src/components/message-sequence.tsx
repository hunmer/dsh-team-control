/**
 * 时序图式消息视图：每个成员一列，消息按发送时间从上到下排列，
 * 箭头从发送方指向接收方；发送方与接收方相同时画一个回环。
 * 悬停箭头（或箭头中点的状态胶囊）用 PreviewCard 展示消息详情。
 *
 * 「已回复」的判定（按优先级）：
 *  1. 同 correlationId 的反向消息（强关联的一问一答）；
 *  2. 同一对成员之间、在这条消息之后发出的反向消息；
 *  3. 收件成员在这条消息之后完成了一个任务（任务完成即视为对该消息的回复）。
 * 已回复的消息画成双向绿色箭头，回执文案改成「已回复」，悬停时同时展示这条消息与其回复。
 */
import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { fmtClock } from '@/lib/format';
import type { Member, Task, TeamMessage } from '@/types';
import { Badge } from '@/components/ui/badge';
import { modelAvatar } from '@/components/ModelAvatar';
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import { cn } from '@/lib/utils';

const LANE = 220;
const GUTTER = 72;
const ROW = 64;
const HEAD = 68;

interface Participant {
  id: string;
  label: string;
  role?: string;
  model?: string;
}

/** 任务完成当作回复时的载体（没有回复消息可展示时，弹窗展示这条任务） */
export interface TaskReply {
  task: Task;
  at: string;
}

interface SequenceRow {
  message: TeamMessage;
  from: number;
  to: number;
  /** 这条消息是提问时：对应的回复（反向消息） */
  reply: TeamMessage | null;
  /** 这条消息是回复时：对应的提问 */
  request: TeamMessage | null;
  /** 没有回复消息、但收件成员完成了任务时：完成的任务 */
  taskReply: TaskReply | null;
}

export interface MessageSequenceProps {
  messages: TeamMessage[];
  members: Member[];
  tasks?: Task[];
  memberName: (id?: string | null) => string;
  className?: string;
}

const ENDPOINT = '__unknown__';

type Tone = 'muted' | 'warn' | 'error' | 'accent' | 'reply';

const statusTone = (message: TeamMessage): Tone => {
  if (message.status === 'expired') return 'error';
  if (!message.ackedAt && message.status !== 'acked') return 'warn';
  if (message.ackedAt || message.status === 'acked') return 'muted';
  return 'accent';
};

const badgeVariant = (message: TeamMessage, paired: boolean) => {
  if (paired) return 'success' as const;
  const tone = statusTone(message);
  if (tone === 'warn') return 'warning' as const;
  if (tone === 'error') return 'error' as const;
  if (tone === 'muted') return 'secondary' as const;
  return 'info' as const;
};

const ARROW_CLASS: Record<Tone, string> = {
  muted: 'text-muted-foreground',
  warn: 'text-amber-500',
  error: 'text-destructive',
  accent: 'text-sky-500',
  reply: 'text-emerald-500',
};

/** 把毫秒差转成「1m04s」这类等待时长文案 */
const fmtWait = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
};

/** 消息已等待多久（从发送到现在）；已有终态回执时返回 null */
const waitingMs = (message: TeamMessage, now: number): number | null => {
  if (message.ackedAt || message.readAt || message.status === 'acked' || message.status === 'expired') return null;
  const sent = sentTime(message.sentAt);
  return sent ? Math.max(0, now - sent) : null;
};

/** replyAt：已回复时用于展示回执时间（回复消息的发送时间或任务完成时间） */
const RECEIPT_LABEL = (message: TeamMessage, replyAt?: string | null, viaTask = false, now = Date.now()): string => {
  if (replyAt) return viaTask ? `已回复 · 任务完成 ${fmtClock(replyAt)}` : `已回复 ${fmtClock(replyAt)}`;
  if (message.ackedAt) return `acked ${fmtClock(message.ackedAt)}`;
  if (message.readAt) return `read ${fmtClock(message.readAt)}`;
  const waited = waitingMs(message, now);
  if (waited != null) return `已等 ${fmtWait(waited)}`;
  if (message.deliveredAt) return `delivered ${fmtClock(message.deliveredAt)}`;
  return '等待回执';
};

/** 箭头中点的胶囊：未回复时显示已等待时长，已回复显示「已回复」 */
const middleLabel = (message: TeamMessage, paired: boolean, now: number): string => {
  if (paired) return '已回复';
  const waited = waitingMs(message, now);
  if (waited != null) return `等 ${fmtWait(waited)}`;
  return statusLabel(message, false);
};

const statusLabel = (message: TeamMessage, paired = false) => {
  if (paired) return '已回复';
  return message.status || (message.ackedAt ? 'acked' : 'queued');
};

/** 消息正文：优先取 payload.text，其次常见别名，最后退回整段 payload JSON */
const messageText = (message: TeamMessage): string => {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  for (const key of ['text', 'message', 'body', 'content']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : '';
};

/** 时间戳比较：缺失时按 0 处理，保证顺序稳定 */
const sentTime = (value?: string | null): number => {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? 0 : t;
};

/**
 * 把消息两两配对：一条 A→B 的消息，与它之后最早的一条 B→A 消息视为一问一答。
 * 同 correlationId 优先（强关联）；一条消息只能属于一个消息对。
 * 没有反向消息时，用「收件成员之后完成的任务」兜底（任务完成视为回复）。
 */
export function pairMessages(input: TeamMessage[], tasks: Task[] = []) {
  const messages = input
    .slice()
    .sort((a, b) => String(a.sentAt || '').localeCompare(String(b.sentAt || '')) || a.id.localeCompare(b.id));
  const replyOf = new Map<string, TeamMessage>();
  const requestOf = new Map<string, TeamMessage>();
  const taskReplyOf = new Map<string, TaskReply>();
  const used = new Set<string>();
  const doneTasks = tasks
    .filter((task) => task.status === 'done' && task.assignee && task.finishedAt)
    .sort((a, b) => sentTime(a.finishedAt) - sentTime(b.finishedAt));
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message.from || !message.to || message.from === message.to) continue;
    if (used.has(message.id)) continue;
    const candidates = messages
      .slice(i + 1)
      .filter((candidate) => candidate.id !== message.id
        && !used.has(candidate.id)
        && candidate.from === message.to
        && candidate.to === message.from
        && sentTime(candidate.sentAt) >= sentTime(message.sentAt)
        && (!message.correlationId || !candidate.correlationId || candidate.correlationId === message.correlationId));
    const exact = message.correlationId
      ? candidates.find((candidate) => candidate.correlationId === message.correlationId)
      : undefined;
    const reply = exact || candidates[0];
    if (reply) {
      replyOf.set(message.id, reply);
      requestOf.set(reply.id, message);
      used.add(message.id);
      used.add(reply.id);
      continue;
    }
    // 兜底：收件成员在这条消息之后完成的最早一个任务
    const completed = doneTasks.find((task) => task.assignee === message.to
      && sentTime(task.finishedAt) >= sentTime(message.sentAt));
    if (completed) {
      taskReplyOf.set(message.id, { task: completed, at: String(completed.finishedAt) });
      used.add(message.id);
    }
  }
  return { replyOf, requestOf, taskReplyOf };
}

export function MessageSequence({ messages, members, tasks = [], memberName, className }: MessageSequenceProps) {
  // 未回复的消息要显示「已经等了多久」，每秒走一次
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { participants, rows } = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id?: string) => {
      const key = id || ENDPOINT;
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(key);
      }
    };

    // Lead 固定最左一列，成员按创建时间（后端已按 created_at 升序，这里再兜底排序），最后补消息里的未知端点。
    add('lead');
    // 后端 listMembers 已按 created_at 升序；只有双方都有 createdAt 时才重排，避免把原顺序打乱
    const ordered = members.slice().sort((a, b) => {
      if (a.createdAt && b.createdAt) return String(a.createdAt).localeCompare(String(b.createdAt));
      return 0;
    });
    for (const member of ordered) add(member.id);
    for (const message of messages) {
      add(message.from);
      add(message.to);
    }

    const known = new Map(members.map((member) => [member.id, member]));
    const list: Participant[] = ids.map((id) => {
      const member = known.get(id);
      return {
        id,
        label: id === ENDPOINT ? '未知' : id === 'lead' ? memberName(id) || 'Lead' : memberName(id) || id,
        role: member?.role,
        model: member?.model,
      };
    });

    const index = new Map(ids.map((id, i) => [id, i]));
    const sorted = messages.slice().sort((a, b) => String(a.sentAt || '').localeCompare(String(b.sentAt || '')) || a.id.localeCompare(b.id));
    const { replyOf, requestOf, taskReplyOf } = pairMessages(sorted, tasks);
    return {
      participants: list,
      rows: sorted.map((message) => ({
        message,
        from: index.get(message.from || ENDPOINT) ?? index.get(ENDPOINT) ?? 0,
        to: index.get(message.to || ENDPOINT) ?? index.get(ENDPOINT) ?? 0,
        reply: replyOf.get(message.id) ?? null,
        request: requestOf.get(message.id) ?? null,
        taskReply: taskReplyOf.get(message.id) ?? null,
      })),
    };
  }, [messages, members, tasks, memberName]);

  const width = GUTTER + Math.max(1, participants.length) * LANE;

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card', className)}
      data-view="message-sequence"
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: width }}>
          {/* 参与者列头（随纵向滚动吸顶） */}
          <div className="sticky top-0 z-20 flex border-b bg-card" style={{ height: HEAD }}>
            <div className="sticky left-0 z-30 flex w-[72px] shrink-0 items-end justify-end border-r bg-card px-2 pb-2 text-[10px] text-muted-foreground">
              时间
            </div>
            {participants.map((participant) => (
              <div
                className="flex min-w-0 shrink-0 flex-col items-center justify-center gap-0.5 px-2"
                key={participant.id}
                style={{ width: LANE }}
                title={participant.id === ENDPOINT ? '未知端点' : participant.id}
              >
                <span className="flex h-4 items-center justify-center text-muted-foreground">
                  {modelAvatar(participant.model, participant.label, null, 16) ?? <Bot aria-hidden="true" className="size-3.5" />}
                </span>
                <span className="w-full truncate text-center font-medium text-xs">{participant.label}</span>
                <span className="w-full truncate text-center text-[10px] text-muted-foreground">{participant.role || participant.id}</span>
              </div>
            ))}
          </div>

          {/* 消息行 */}
          <div className="relative">
            {rows.map(({ message, from, to, reply, request, taskReply }) => {
              // 箭头坐标相对当前行自己的 svg：线贴行底，标签在上方留出空隙。
              const y = ROW - 20;
              const c1 = from * LANE + LANE / 2;
              const c2 = to * LANE + LANE / 2;
              const mid = (c1 + c2) / 2;
              const self = from === to;
              // 一问一答：绿色双向箭头（这条消息自己可能既是提问也是回复）
              const paired = Boolean(reply || request || taskReply);
              const tone: Tone = paired ? 'reply' : statusTone(message);
              // 弹窗里按「先提问、后回复」的时间顺序排，回复在前会让人误以为顺序乱了
              const pairList = request && reply
                ? [request, reply]
                : request
                  ? [request, message]
                  : reply
                    ? [message, reply]
                    : [message];
              const requestId = pairList[0].id;
              const counterpart = reply || request;
              const replyAt = reply?.sentAt ?? taskReply?.at ?? null;
              const fromName = memberName(message.from);
              const toName = memberName(message.to);

              return (
                <div className="flex border-b last:border-b-0" key={message.id} style={{ height: ROW }}>
                  <div className="sticky left-0 z-10 flex w-[72px] shrink-0 items-center justify-end border-r bg-card px-2 text-[10px] tabular-nums text-muted-foreground">
                    {fmtClock(message.sentAt)}
                  </div>
                  <div className="relative flex-1">
                    {participants.map((participant, i) => (
                      <span
                        className="absolute inset-y-0 border-l border-dashed"
                        key={participant.id}
                        style={{ left: i * LANE, width: LANE }}
                      />
                    ))}

                    {/* 箭头层：坐标以消息区左侧为 0 */}
                    <svg
                      className={cn('absolute inset-0 h-full w-full overflow-visible', ARROW_CLASS[tone])}
                      role="img"
                      aria-label={paired ? `${fromName} 与 ${toName} 已互通消息` : `${fromName} 发送给 ${toName}`}
                    >
                      <defs>
                        <marker id={`msg-arrow-${message.id}`} markerHeight="6" markerWidth="7" orient="auto" refX="6" refY="3">
                          <path d="M0,0 L7,3 L0,6 z" fill="currentColor" />
                        </marker>
                        {paired && !self ? (
                          <marker id={`msg-arrow-back-${message.id}`} markerHeight="6" markerWidth="7" orient="auto" refX="1" refY="3">
                            <path d="M7,0 L0,3 L7,6 z" fill="currentColor" />
                          </marker>
                        ) : null}
                      </defs>
                      {self ? (
                        <path
                          d={`M ${c1 + 8},${y - 12} C ${c1 + 42},${y - 12} ${c1 + 42},${y + 12} ${c1 + 10},${y + 12}`}
                          fill="none"
                          markerEnd={`url(#msg-arrow-${message.id})`}
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                      ) : (
                        <line
                          markerEnd={`url(#msg-arrow-${message.id})`}
                          markerStart={paired ? `url(#msg-arrow-back-${message.id})` : undefined}
                          stroke="currentColor"
                          strokeWidth={paired ? 2 : 1.5}
                          x1={c1}
                          x2={c2}
                          y1={y}
                          y2={y}
                        />
                      )}
                    </svg>

                    {/* 箭头中点的悬停热区：悬停即展示 PreviewCard，胶囊居中其上 */}
                    <PreviewCard>
                      <PreviewCardTrigger
                        delay={150}
                        render={
                          <button
                            aria-label={`${fromName} 发送给 ${toName}，悬停查看消息详情`}
                            className="absolute z-10 -translate-y-1/2 cursor-help rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            style={{ left: Math.min(c1, c2) - 10, top: y, width: Math.max(20, Math.abs(c2 - c1)), height: 24 }}
                            type="button"
                          />
                        }
                      >
                        <Badge
                          className="pointer-events-none absolute top-1/2 left-1/2 h-5 -translate-x-1/2 -translate-y-1/2 px-1.5 text-[10px] shadow-sm"
                          variant={badgeVariant(message, paired)}
                        >
                          {middleLabel(message, paired, now)}
                        </Badge>
                      </PreviewCardTrigger>
                      <PreviewCardPopup className="w-96" side="right" sideOffset={10}>                        <div className="space-y-3">
                          {pairList.map((item, position) => {
                            const isReplyItem = item.id !== requestId;
                            // 弹窗里每条消息的回执：提问展示它的回复时间，回复自己看自己的 ack
                            const itemReplyAt = request && reply && item.id === request.id
                              ? reply.sentAt
                              : item.id === message.id ? replyAt : null;
                            const itemViaTask = item.id === message.id && Boolean(taskReply && !reply);
                            return (
                              <div className={cn('space-y-2', position > 0 && 'border-t pt-3')} key={item.id}>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <span>{isReplyItem ? '回复' : '消息'}</span>
                                  <span className="text-[10px]">· {fmtClock(item.sentAt)}</span>
                                </div>
                                <div className="flex items-center gap-1.5 font-medium">
                                  <span className="truncate"><span className="mr-1 text-[10px] font-normal text-muted-foreground">发送</span>{memberName(item.from)}</span>
                                  <span className={cn('text-muted-foreground', paired && 'text-emerald-500')}>{paired ? '↔' : '→'}</span>
                                  <span className="truncate"><span className="mr-1 text-[10px] font-normal text-muted-foreground">接收</span>{memberName(item.to)}</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge size="sm" variant="outline">{item.kind || 'message'}</Badge>
                                  <Badge size="sm" variant={badgeVariant(item, paired)}>{statusLabel(item, paired)}</Badge>
                                </div>
                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                                  <dt className="text-muted-foreground">回执</dt>
                                  <dd>{RECEIPT_LABEL(item, itemReplyAt, itemViaTask, now)}</dd>
                                  <dt className="text-muted-foreground">关联</dt>
                                  <dd className="truncate font-mono">{item.correlationId || '—'}</dd>
                                  <dt className="text-muted-foreground">消息 ID</dt>
                                  <dd className="truncate font-mono">{item.id}</dd>
                                </dl>
                                {messageText(item) && (
                                  <div className="space-y-1">
                                    <div className="text-xs text-muted-foreground">消息内容</div>
                                    <p className="max-h-40 overflow-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
                                      {messageText(item)}
                                    </p>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {taskReply ? (
                            <div className="space-y-2 border-t pt-3">
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span>回复</span>
                                <span className="text-[10px]">· 任务完成 · {fmtClock(taskReply.at)}</span>
                              </div>
                              <div className="flex items-center gap-1.5 font-medium">
                                <span className="truncate"><span className="mr-1 text-[10px] font-normal text-muted-foreground">发送</span>{memberName(taskReply.task.assignee)}</span>
                                <span className="text-emerald-500">↔</span>
                                <span className="truncate"><span className="mr-1 text-[10px] font-normal text-muted-foreground">接收</span>{memberName(message.from)}</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Badge size="sm" variant="success">{taskReply.task.status}</Badge>
                                <Badge size="sm" variant="outline">任务</Badge>
                              </div>
                              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                                <dt className="text-muted-foreground">任务</dt>
                                <dd className="truncate">{taskReply.task.subject || taskReply.task.id}</dd>
                                <dt className="text-muted-foreground">任务 ID</dt>
                                <dd className="truncate font-mono">{taskReply.task.id}</dd>
                              </dl>
                            </div>
                          ) : null}
                        </div>
                      </PreviewCardPopup>
                    </PreviewCard>

                    {/* 箭头两端标注收发方向，中间胶囊显示等待时长 */}
                    {!self ? (
                      <>
                        <span
                          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded bg-card px-1 text-[9px] text-muted-foreground"
                          style={{ left: c1, top: y + 4 }}
                        >
                          发送
                        </span>
                        <span
                          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded bg-card px-1 text-[9px] text-muted-foreground"
                          style={{ left: c2, top: y + 4 }}
                        >
                          接收
                        </span>
                      </>
                    ) : null}

                    {/* 箭头中点上方的消息摘要 */}
                    <div
                      className="pointer-events-none absolute -translate-x-1/2 text-center text-[10px] text-muted-foreground"
                      style={{ left: mid, top: y - 40 }}
                    >
                      <div className="flex items-center gap-1 rounded bg-card px-1.5">
                        <span className="font-medium text-foreground">{message.kind || 'message'}</span>
                        {paired ? <span className="text-emerald-500">↔</span> : null}
                        {message.correlationId ? (
                          <span className="font-mono">{message.correlationId.slice(0, 8)}</span>
                        ) : null}
                      </div>
                      <div className={cn('text-[9px]', paired && 'text-emerald-600')}>{RECEIPT_LABEL(message, replyAt, Boolean(taskReply && !reply), now)}</div>
                    </div>

                    <span className="sr-only">
                      {message.from || '?'} {paired ? '↔' : '→'} {message.to || '?'}：{message.kind || 'message'}（{statusLabel(message, paired)}）
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

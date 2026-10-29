/**
 * 时序图式消息视图：每个成员一列，消息按发送时间从上到下排列，
 * 箭头从发送方指向接收方；发送方与接收方相同时画一个回环。
 * 悬停箭头（或箭头中点的状态胶囊）用 PreviewCard 展示消息详情。
 */
import { useMemo } from 'react';
import { Bot } from 'lucide-react';
import { fmtClock } from '@/lib/format';
import type { Member, TeamMessage } from '@/types';
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

interface SequenceRow {
  message: TeamMessage;
  from: number;
  to: number;
}

export interface MessageSequenceProps {
  messages: TeamMessage[];
  members: Member[];
  memberName: (id?: string | null) => string;
  className?: string;
}

const ENDPOINT = '__unknown__';

const statusTone = (message: TeamMessage): 'muted' | 'warn' | 'error' | 'accent' => {
  if (message.status === 'expired') return 'error';
  if (!message.ackedAt && message.status !== 'acked') return 'warn';
  if (message.ackedAt || message.status === 'acked') return 'muted';
  return 'accent';
};

const badgeVariant = (message: TeamMessage) => {
  const tone = statusTone(message);
  if (tone === 'warn') return 'warning' as const;
  if (tone === 'error') return 'error' as const;
  if (tone === 'muted') return 'secondary' as const;
  return 'info' as const;
};

const ARROW_CLASS = {
  muted: 'text-muted-foreground',
  warn: 'text-amber-500',
  error: 'text-destructive',
  accent: 'text-sky-500',
} as const;

const RECEIPT_LABEL = (message: TeamMessage): string => {
  if (message.ackedAt) return `acked ${fmtClock(message.ackedAt)}`;
  if (message.readAt) return `read ${fmtClock(message.readAt)}`;
  if (message.deliveredAt) return `delivered ${fmtClock(message.deliveredAt)}`;
  return '等待回执';
};

const statusLabel = (message: TeamMessage) => message.status || (message.ackedAt ? 'acked' : 'queued');

export function MessageSequence({ messages, members, memberName, className }: MessageSequenceProps) {
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

    // 成员按看板顺序先占列，再补消息里出现过的未知端点。
    for (const member of members) add(member.id);
    for (const message of messages) {
      add(message.from);
      add(message.to);
    }

    const known = new Map(members.map((member) => [member.id, member]));
    const list: Participant[] = ids.map((id) => {
      const member = known.get(id);
      return {
        id,
        label: id === ENDPOINT ? '未知' : memberName(id) || id,
        role: member?.role,
        model: member?.model,
      };
    });

    const index = new Map(ids.map((id, i) => [id, i]));
    const sorted = messages.slice().sort((a, b) => String(a.sentAt || '').localeCompare(String(b.sentAt || '')) || a.id.localeCompare(b.id));
    return {
      participants: list,
      rows: sorted.map((message) => ({
        message,
        from: index.get(message.from || ENDPOINT) ?? index.get(ENDPOINT) ?? 0,
        to: index.get(message.to || ENDPOINT) ?? index.get(ENDPOINT) ?? 0,
      })),
    };
  }, [messages, members, memberName]);

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
            {rows.map(({ message, from, to }) => {
              // 箭头坐标相对当前行自己的 svg：线贴行底，标签在上方留出空隙。
              const y = ROW - 20;
              const c1 = from * LANE + LANE / 2;
              const c2 = to * LANE + LANE / 2;
              const mid = (c1 + c2) / 2;
              const self = from === to;
              const tone = statusTone(message);
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
                    <svg className={cn('absolute inset-0 h-full w-full overflow-visible', ARROW_CLASS[tone])} role="img" aria-label={`${fromName} 发送给 ${toName}`}>
                      <defs>
                        <marker id={`msg-arrow-${message.id}`} markerHeight="6" markerWidth="7" orient="auto" refX="6" refY="3">
                          <path d="M0,0 L7,3 L0,6 z" fill="currentColor" />
                        </marker>
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
                          stroke="currentColor"
                          strokeWidth="1.5"
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
                          variant={badgeVariant(message)}
                        >
                          {statusLabel(message)}
                        </Badge>
                      </PreviewCardTrigger>
                      <PreviewCardPopup side="right" sideOffset={10}>
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 font-medium">
                            <span className="truncate">{fromName}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="truncate">{toName}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge size="sm" variant="outline">{message.kind || 'message'}</Badge>
                            <Badge size="sm" variant={badgeVariant(message)}>{statusLabel(message)}</Badge>
                          </div>
                          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                            <dt className="text-muted-foreground">发送时间</dt>
                            <dd className="tabular-nums">{fmtClock(message.sentAt)}</dd>
                            <dt className="text-muted-foreground">回执</dt>
                            <dd>{RECEIPT_LABEL(message)}</dd>
                            <dt className="text-muted-foreground">关联</dt>
                            <dd className="truncate font-mono">{message.correlationId || '—'}</dd>
                            <dt className="text-muted-foreground">消息 ID</dt>
                            <dd className="truncate font-mono">{message.id}</dd>
                          </dl>
                        </div>
                      </PreviewCardPopup>
                    </PreviewCard>

                    {/* 箭头中点上方的消息摘要 */}
                    <div
                      className="pointer-events-none absolute -translate-x-1/2 text-center text-[10px] text-muted-foreground"
                      style={{ left: mid, top: y - 40 }}
                    >
                      <div className="flex items-center gap-1 rounded bg-card px-1.5">
                        <span className="font-medium text-foreground">{message.kind || 'message'}</span>
                        {message.correlationId ? (
                          <span className="font-mono">{message.correlationId.slice(0, 8)}</span>
                        ) : null}
                      </div>
                      <div className="text-[9px]">{RECEIPT_LABEL(message)}</div>
                    </div>

                    <span className="sr-only">
                      {message.from || '?'} → {message.to || '?'}：{message.kind || 'message'}（{statusLabel(message)}）
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

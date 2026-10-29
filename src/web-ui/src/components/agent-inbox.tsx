/**
 * 实时收件箱（coss ui 版，取代 affectui/agent-inbox）。
 *
 * 三列看板：需要你（waiting/failed）/ 进行中 / 已完成；
 * 卡片由 Card + Badge + Button + Collapsible 组成，动作由 Home 传入。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, CircleCheck, CircleX, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type AgentTaskStatus = 'running' | 'waiting' | 'done' | 'failed';

export interface AgentTaskStep {
  label: string;
  time?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  description?: string;
  agent: string;
  /** 成员头像插槽（模型图标）。 */
  logo?: ReactNode;
  status: AgentTaskStatus;
  startedAt?: number | Date;
  elapsed?: number;
  tools?: number;
  sources?: number;
  steps?: AgentTaskStep[];
}

export interface AgentInboxProps {
  tasks: AgentTask[];
  onApprove?: (task: AgentTask) => void;
  onReject?: (task: AgentTask) => void;
  onRetry?: (task: AgentTask) => void;
  onOpen?: (task: AgentTask) => void;
  title?: string;
  className?: string;
}

const LANES = [
  { id: 'needs', label: '需要你' },
  { id: 'running', label: '进行中' },
  { id: 'done', label: '已完成' },
] as const;

type LaneId = (typeof LANES)[number]['id'];

const STATUS_META = {
  waiting: { label: '待决策', variant: 'warning' as const, Icon: TriangleAlert },
  failed: { label: '失败', variant: 'error' as const, Icon: CircleX },
  running: { label: '运行中', variant: 'info' as const, Icon: LoaderCircle },
  done: { label: '完成', variant: 'success' as const, Icon: CircleCheck },
};

function laneOf(status: AgentTaskStatus): LaneId {
  if (status === 'waiting' || status === 'failed') return 'needs';
  if (status === 'running') return 'running';
  return 'done';
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  if (total < 86400) return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(total / 86400)}d ${String(Math.floor((total % 86400) / 3600)).padStart(2, '0')}h`;
}

const toTime = (value: number | Date): number => (typeof value === 'number' ? value : value.getTime());

/** 运行中卡片每秒刷新时长。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function TaskCard({ task, onApprove, onReject, onRetry, onOpen }: { task: AgentTask } & Pick<AgentInboxProps, 'onApprove' | 'onReject' | 'onRetry' | 'onOpen'>) {
  const meta = STATUS_META[task.status] ?? STATUS_META.done;
  const { Icon } = meta;
  const live = task.status === 'running' || task.status === 'waiting';
  const now = useNow(live);
  const steps = task.steps ?? [];
  const elapsed = task.elapsed ?? (task.startedAt !== undefined ? Math.max(0, now - toTime(task.startedAt)) : undefined);

  return (
    <Card className="gap-0 p-3 shadow-none">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {task.logo ?? <Sparkles className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">{task.title}</span>
            <Badge size="sm" variant={meta.variant}>
              <Icon className={cn('size-3', task.status === 'running' && 'animate-spin')} />
              {meta.label}
            </Badge>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate">{task.agent}</span>
            {elapsed !== undefined && <span className="shrink-0 tabular-nums">· {formatDuration(elapsed)}</span>}
          </div>
          {task.description && <p className="mt-1 line-clamp-3 text-muted-foreground text-xs">{task.description}</p>}

          {steps.length > 0 && (
            <Collapsible className="mt-1.5">
              <CollapsibleTrigger
                className="inline-flex items-center gap-1 rounded text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                <ChevronDown className="size-3" />
                {steps.length} 个步骤
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ol className="mt-1 space-y-0.5 border-l pl-2">
                  {steps.map((step, index) => (
                    <li className="flex items-baseline gap-1.5 text-xs" key={`${step.label}-${index}`}>
                      <span className="text-muted-foreground">{index + 1}.</span>
                      <span className="min-w-0 flex-1 truncate">{step.label}</span>
                      {step.time && <span className="shrink-0 text-muted-foreground tabular-nums">{step.time}</span>}
                    </li>
                  ))}
                </ol>
              </CollapsibleContent>
            </Collapsible>
          )}

          <div className="mt-2 flex items-center gap-1.5">
            {task.status === 'waiting' && (
              <>
                <Button onClick={() => onReject?.(task)} size="xs" type="button" variant="outline">
                  驳回
                </Button>
                <Button onClick={() => onApprove?.(task)} size="xs" type="button">
                  批准
                </Button>
              </>
            )}
            {task.status === 'failed' && (
              <Button onClick={() => onRetry?.(task)} size="xs" type="button">
                重试
              </Button>
            )}
            {(task.status === 'running' || task.status === 'done') && onOpen && (
              <Button onClick={() => onOpen(task)} size="xs" type="button" variant="ghost">
                打开
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function AgentInbox({ tasks, onApprove, onReject, onRetry, onOpen, title = '实时收件箱', className }: AgentInboxProps) {
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm">{title}</span>
        <span className="text-muted-foreground text-xs">{tasks.length} 张卡</span>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {LANES.map((lane) => {
          const items = tasks.filter((task) => laneOf(task.status) === lane.id);
          return (
            <div className="flex min-w-0 flex-col gap-2" key={lane.id}>
              <div className="flex items-center gap-1.5 px-1">
                <span className="font-medium text-muted-foreground text-xs">{lane.label}</span>
                <Badge size="sm" variant="secondary">{items.length}</Badge>
              </div>
              <div className="max-h-[520px] space-y-2 overflow-y-auto pr-0.5">
                {items.length ? (
                  items.map((task) => (
                    <TaskCard
                      key={task.id}
                      onApprove={onApprove}
                      onOpen={onOpen}
                      onReject={onReject}
                      onRetry={onRetry}
                      task={task}
                    />
                  ))
                ) : (
                  <p className="rounded-lg border border-dashed px-2 py-4 text-center text-muted-foreground text-xs">暂无</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

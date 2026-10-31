/**
 * 实时收件箱（coss ui 版，取代 affectui/agent-inbox）。
 *
 * 瀑布流：所有成员卡片按「等待中 → 进行中 → 已完成」排序后进多列布局，列宽随容器宽度自动
 * 增减，卡片各按内容高度排列（非等高）；卡片由 Card + Badge + Button 组成，动作由 Home 传入。
 * 点整张卡片即「激活」（等同于原来的「打开」按钮），激活的卡片带主题色描边。
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { CircleCheck, CircleX, FileText, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type AgentTaskStatus = 'running' | 'waiting' | 'done' | 'failed';

export interface AgentTaskStep {
  label: string;
  time?: string;
}

/** 成员产物：成员会话里 declared/改动过的文件。 */
export interface AgentTaskArtifact {
  path: string;
  label?: string;
  source?: string;
  /** 新增/删除行数；未知为 null（回退显示 label） */
  added?: number | null;
  deleted?: number | null;
}

export interface AgentTask {
  id: string;
  title: string;
  description?: string;
  agent: string;
  /** 成员 id：用于「查看对话」唤起该成员的 DSH 会话。 */
  memberId?: string;
  /** 成员头像插槽（模型图标）。 */
  logo?: ReactNode;
  status: AgentTaskStatus;
  startedAt?: number | Date;
  elapsed?: number;
  tools?: number;
  sources?: number;
  steps?: AgentTaskStep[];
  /** 产物文件（折叠步骤已改为展示产物）。 */
  artifacts?: AgentTaskArtifact[];
}

export interface AgentInboxProps {
  tasks: AgentTask[];
  onApprove?: (task: AgentTask) => void;
  onReject?: (task: AgentTask) => void;
  onRetry?: (task: AgentTask) => void;
  /** 点整张卡片 =「激活」该任务（Plan/Activity 跟随），不再单独给按钮。 */
  onOpen?: (task: AgentTask) => void;
  /** 当前激活的任务 id：卡片描边高亮。 */
  activeId?: string;
  /** 点击产物 → 跳到「审阅」并选中该文件。 */
  onOpenArtifact?: (task: AgentTask, artifact: AgentTaskArtifact) => void;
  /** 「查看对话」→ 打开该成员成员的 DSH 会话记录。 */
  onOpenChat?: (task: AgentTask) => void;
  title?: string;
  className?: string;
}

const LANES = [
  { id: 'needs', label: '等待中', tone: 'warning' as const },
  { id: 'running', label: '进行中', tone: 'info' as const },
  { id: 'done', label: '已完成', tone: 'success' as const },
] as const;

/** 泳道标题配色：需要你=琥珀、进行中=天蓝、已完成=翠绿。 */
const LANE_TONE = {
  warning: { text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  info: { text: 'text-sky-600 dark:text-sky-400', dot: 'bg-sky-500' },
  success: { text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
} as const;

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

/** 产物路径只显示文件名，完整路径放 title。 */
function fileName(path: string): string {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

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

function TaskCard({ task, active, onApprove, onReject, onRetry, onOpen, onOpenArtifact, onOpenChat }: { task: AgentTask; active?: boolean } & Pick<AgentInboxProps, 'onApprove' | 'onReject' | 'onRetry' | 'onOpen' | 'onOpenArtifact' | 'onOpenChat'>) {
  const meta = STATUS_META[task.status] ?? STATUS_META.done;
  const { Icon } = meta;
  const live = task.status === 'running' || task.status === 'waiting';
  const now = useNow(live);
  const steps = task.steps ?? [];
  const artifacts = task.artifacts ?? [];
  const elapsed = task.elapsed ?? (task.startedAt !== undefined ? Math.max(0, now - toTime(task.startedAt)) : undefined);

  const clickable = typeof onOpen === 'function';
  /** 卡内的按钮（批准/驳回/重试/产物/查看对话）自己处理点击，不要连带激活整张卡。 */
  const onCardClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if ((event.target as HTMLElement).closest('button, a')) return;
    onOpen(task);
  };
  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(task);
  };

  return (
    <Card
      aria-pressed={clickable ? !!active : undefined}
      className={cn(
        'min-w-0 gap-0 overflow-hidden p-3 shadow-none transition-colors',
        clickable && 'cursor-pointer hover:border-primary/40',
        active && 'border-primary/60 ring-2 ring-primary/25',
      )}
      data-active={active ? '' : undefined}
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
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
          {task.description && (
            <p className="mt-1 line-clamp-3 break-words text-muted-foreground text-xs">{task.description}</p>
          )}

          {artifacts.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 border-l pl-2">
              {artifacts.map((file) => {
                const body = (
                  <>
                    <FileText className="size-3 shrink-0 self-center text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={file.path}>
                      {fileName(file.path)}
                    </span>
                    {file.added != null || file.deleted != null ? (
                      <span className="shrink-0 tabular-nums">
                        <span className="text-emerald-600 dark:text-emerald-400">+{file.added ?? 0}</span>
                        <span className="ms-1 text-rose-600 dark:text-rose-400">-{file.deleted ?? 0}</span>
                      </span>
                    ) : file.label ? (
                      <span className="max-w-[45%] shrink-0 truncate text-muted-foreground" title={file.label}>
                        {file.label}
                      </span>
                    ) : null}
                  </>
                );
                return (
                  <li key={file.path}>
                    {onOpenArtifact ? (
                      <button
                        className="-mx-1 flex w-[calc(100%+0.5rem)] items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
                        onClick={() => onOpenArtifact(task, file)}
                        title={`${file.path} · 点击在「审阅」里查看`}
                        type="button"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex items-baseline gap-1.5 text-xs" title={file.path}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : steps.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 border-l pl-2">
              {steps.map((step, index) => (
                <li className="flex items-baseline gap-1.5 text-xs" key={`${step.label}-${index}`}>
                  <span className="min-w-0 flex-1 truncate" title={step.label}>
                    {step.label}
                  </span>
                  {step.time && <span className="shrink-0 text-muted-foreground tabular-nums">{step.time}</span>}
                </li>
              ))}
            </ul>
          ) : null}

          {(task.status === 'waiting' || task.status === 'failed'
            || ((task.status === 'running' || task.status === 'done') && onOpenChat)) && (
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
              {(task.status === 'running' || task.status === 'done') && onOpenChat && (
                <Button onClick={() => onOpenChat(task)} size="xs" type="button" variant="ghost">
                  查看对话
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

const LANE_ORDER: Record<LaneId, number> = { needs: 0, running: 1, done: 2 };

export function AgentInbox({ tasks, activeId, onApprove, onReject, onRetry, onOpen, onOpenArtifact, onOpenChat, title = '实时收件箱', className }: AgentInboxProps) {
  // 等待决策的排前面，其次进行中，最后已完成；同组内保持传入顺序
  const sorted = [...tasks].sort((a, b) => LANE_ORDER[laneOf(a.status)] - LANE_ORDER[laneOf(b.status)]);
  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-sm">{title}</span>
        <span className="text-muted-foreground text-xs">{tasks.length} 张卡</span>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {LANES.map((lane) => (
            <span className="flex items-center gap-1" key={lane.id}>
              <span className={`size-1.5 shrink-0 rounded-full ${LANE_TONE[lane.tone].dot}`} />
              <span className={`font-medium text-xs ${LANE_TONE[lane.tone].text}`}>{lane.label}</span>
              <span className="font-medium text-xs tabular-nums">{tasks.filter((task) => laneOf(task.status) === lane.id).length}</span>
            </span>
          ))}
        </span>
      </div>
      {/* 瀑布流：多列布局（列宽最小 15rem，按容器宽度自动增减），卡片各按自己的内容高度
          排列、互不拉平；break-inside-avoid 保证一张卡不会被拆到两列。 */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto pr-0.5', sorted.length && 'columns-[15rem] gap-x-2')}>
        {sorted.length ? (
          sorted.map((task) => (
            <div className="mb-2 break-inside-avoid" key={task.id}>
              <TaskCard
                active={!!activeId && task.id === activeId}
                onApprove={onApprove}
                onOpen={onOpen}
                onOpenArtifact={onOpenArtifact}
                onOpenChat={onOpenChat}
                onReject={onReject}
                onRetry={onRetry}
                task={task}
              />
            </div>
          ))
        ) : (
          <p className="rounded-lg border border-dashed px-2 py-4 text-center text-muted-foreground text-xs">暂无</p>
        )}
      </div>
    </div>
  );
}

/**
 * 任务计划清单（coss ui 版，取代 affectui/plan-steps）。
 *
 * 只保留面板真正用到的只读展示：步骤状态、进度、阻塞原因。
 */
import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export type PlanStepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  tool?: string;
  status?: PlanStepStatus;
  /** 毫秒，仅 done 时展示。 */
  duration?: number;
  error?: string;
}

export type PlanPhase = 'draft' | 'running' | 'done';

export interface PlanStepsProps {
  steps?: PlanStep[];
  status?: PlanPhase;
  title?: string;
  className?: string;
}

const STATUS_META = {
  pending: { label: '未开始', variant: 'outline' as const, Icon: CircleDashed },
  active: { label: '进行中', variant: 'info' as const, Icon: LoaderCircle },
  done: { label: '已完成', variant: 'success' as const, Icon: CircleCheck },
  failed: { label: '失败', variant: 'error' as const, Icon: CircleX },
  skipped: { label: '已跳过', variant: 'secondary' as const, Icon: CircleMinus },
};

const PHASE_META = {
  draft: { label: '草稿', variant: 'outline' as const },
  running: { label: '进行中', variant: 'info' as const },
  done: { label: '已完成', variant: 'success' as const },
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

export function PlanSteps({ steps = [], status = 'running', title, className }: PlanStepsProps) {
  const done = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length;
  const phase = PHASE_META[status] ?? PHASE_META.running;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {title && <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>}
        <Badge variant={phase.variant}>{phase.label}</Badge>
        <span className="text-muted-foreground text-xs tabular-nums">
          {done}/{steps.length}
        </span>
      </div>
      <Progress aria-label="计划完成度" max={steps.length || 1} value={done}>
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
      <ol className="space-y-1">
        {steps.map((step) => {
          const meta = STATUS_META[step.status ?? 'pending'] ?? STATUS_META.pending;
          const { Icon } = meta;
          const dim = step.status === 'done' || step.status === 'skipped';
          return (
            <li className="flex items-start gap-2 rounded-md px-1 py-1.5 hover:bg-accent/40" key={step.id}>
              <Icon
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  step.status === 'active' && 'animate-spin text-info-foreground',
                  step.status === 'done' && 'text-success-foreground',
                  step.status === 'failed' && 'text-destructive-foreground',
                  step.status === 'skipped' && 'text-muted-foreground',
                  (step.status === 'pending' || !step.status) && 'text-muted-foreground',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className={cn('text-sm', dim && 'text-muted-foreground line-through')}>{step.title}</div>
                {step.detail && <div className="text-muted-foreground text-xs">{step.detail}</div>}
                {step.error && <div className="text-destructive-foreground text-xs">{step.error}</div>}
              </div>
              {step.tool && <Badge size="sm" variant="outline">{step.tool}</Badge>}
              {step.duration !== undefined && (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatDuration(step.duration)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

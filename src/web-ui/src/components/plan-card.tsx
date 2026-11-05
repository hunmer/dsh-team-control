/**
 * 任务计划卡片（从 Home 右列抽离）：header（Plan + 任务名 + 完成状态/成员/尝试次数）
 * + PlanSteps 清单 + 空态。todo → PlanStep 的状态映射与「全完成才算 done」的阶段判定内聚在此。
 */
import { ClipboardList } from 'lucide-react';
import { PlanSteps, type PlanStep, type PlanStepStatus } from '@/components/plan-steps';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { cn } from '@/lib/utils';

/** sidecar todo.status → PlanSteps 状态。blocked 不是失败，按未开始渲染，阻塞原因走 detail。 */
const PLAN_STATUS: Record<string, PlanStepStatus> = {
  open: 'pending',
  active: 'active',
  done: 'done',
  blocked: 'pending',
  skipped: 'skipped',
};

/** todo 行（store 的 Todo / todosApi 的 TodoItem 同构字段）→ PlanStep。 */
export function toPlanStep(todo: {
  id: string;
  title: string;
  status: string;
  blockedBy?: string[] | null;
}): PlanStep {
  return {
    id: todo.id,
    title: todo.title,
    detail:
      todo.blockedBy && todo.blockedBy.length
        ? `blocked by ${todo.blockedBy.join(', ')}`
        : undefined,
    status: PLAN_STATUS[todo.status] ?? 'pending',
  };
}

export interface PlanCardProps {
  /** 卡片副标题：Home 传任务名，TaskProgress 传团队名。 */
  title: string;
  steps: PlanStep[];
  /** header 右侧的完成判定；缺省按「清单全部完成」内聚判定。 */
  done?: boolean;
  /** header 右侧成员名（可选）。 */
  memberName?: string;
  /** 第 N 次尝试（可选，>0 才显示）。 */
  attempts?: number;
  /** 空态提示文案。 */
  emptyHint?: string;
  className?: string;
}

export function PlanCard({
  title,
  steps,
  done,
  memberName,
  attempts,
  emptyHint = 'Leader 用 team_todo 写入',
  className,
}: PlanCardProps) {
  /** PlanSteps 的阶段：清单全部完成才算 done（任务 done 但清单还有 open 项时不显示 Done in ...）。 */
  const phase =
    steps.length > 0 && steps.every((step) => step.status === 'done' || step.status === 'skipped')
      ? 'done'
      : 'running';

  return (
    <div className={cn('flex h-full flex-col rounded-xl border bg-card', className)}>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-semibold">Plan</span>
        <span className="truncate text-sm text-muted-foreground">{title}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>{(done ?? phase === 'done') ? '已完成' : '进行中'}</span>
          {memberName && <span>· {memberName}</span>}
          {attempts ? <span>· 第 {attempts} 次尝试</span> : null}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {steps.length ? (
          <PlanSteps title={title} steps={steps} status={phase} />
        ) : (
          <Empty className="gap-4 px-4 py-8 md:py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="mb-3">
                <ClipboardList />
              </EmptyMedia>
              <EmptyTitle className="text-sm">暂无计划</EmptyTitle>
              <EmptyDescription>{emptyHint}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * 主页 = AffectUI 组件 + 真实 sidecar 数据（不保留 demo 数据）。
 *
 * 左列：Plan（任务计划清单，来自 `team_todo` 工具写入的 /api/todos）+ Activity（任务事件流；
 *        两者都按「当前选中的任务」过滤）。
 * 右列：`AgentInbox` 三列看板（Needs / Running / Done）。
 *
 * 真实数据源：
 * - `GET /api/scope-requests?status=pending` → Needs you 卡；Approve/Reject → POST decide；
 * - `GET /api/tasks` + `GET /api/dag` → 任务卡（标题、成员、起止时间、验收标准）；
 * - `GET /api/todos?team=` → Plan 清单（Leader/成员用 team_todo 维护）；
 * - `GET /api/events/history` → Activity；卡片展开的步骤也用这些事件；
 * - Open → 选中该任务（Plan/Activity 跟随）；Retry（失败任务）→ 按原参数重建任务再排队。
 */
import { useMemo, useState } from 'react';
import { ClipboardList, ListTree } from 'lucide-react';
import { usePanel } from '@/store';
import { api } from '@/lib/api';
import { fmtClockSec } from '@/lib/format';
import type { ScopeRequest, Task, TimelineEntry, Todo } from '@/types';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  AgentInbox,
  type AgentTask,
  type AgentTaskStatus,
  type AgentTaskStep,
} from '@/affectui/agent-inbox';
import { PlanSteps, type PlanStep, type PlanStepStatus } from '@/affectui/plan-steps';
import { ToolCall } from '@/affectui/tool-calls';

const SCOPE_PREFIX = 'scope:';

/** 申请/任务 → 看板状态。没有可执行动作的状态（pending/ready/blocked）不进看板。 */
function laneStatus(status: string): AgentTaskStatus | null {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress' || status === 'running' || status === 'assigned') return 'running';
  return null;
}

/** sidecar todo.status → PlanSteps 状态。blocked 不是失败，按未开始渲染，阻塞原因走 detail。 */
const PLAN_STATUS: Record<string, PlanStepStatus> = {
  open: 'pending',
  active: 'active',
  done: 'done',
  blocked: 'pending',
  skipped: 'skipped',
};

/** `task.dispatch` / `task.retry` / `task.done` / `task.fail` / `task.todo` → 卡片步骤文案。 */
const ACTION_LABELS: Record<string, string> = {
  'task.dispatch': '派发',
  'task.retry': '重试',
  'task.done': '完成',
  'task.fail': '失败',
  'task.todo': '更新计划',
  'scope.request': '越界申请',
};

function stepOf(entry: TimelineEntry): AgentTaskStep {
  const action = entry.action || entry.phase;
  return {
    label: ACTION_LABELS[action] ?? action,
    time: fmtClockSec(entry.ts),
  };
}

function ms(value?: string | null): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/** 用落盘时间算卡片时长：已完成 = finished - attempted，运行中 = 由组件按 startedAt 走秒。 */
function elapsedOf(task?: Task): number | undefined {
  if (!task) return undefined;
  const end = ms(task.finishedAt);
  const start = ms(task.attemptedAt) ?? ms(task.createdAt);
  return end !== undefined && start !== undefined ? Math.max(0, end - start) : undefined;
}

/** 事件结果 → ToolCall 状态。落盘 result 是 OK / BLOCKED / FAIL 之类的短串。 */
function eventStatus(entry: TimelineEntry): 'running' | 'success' | 'error' {
  const result = String(entry.result ?? '').toUpperCase();
  if (/FAIL|ERROR|DENIED|BLOCKED|TIMEOUT|ABORT/.test(result)) return 'error';
  if (!result && (entry.phase === 'wait' || entry.phase === 'step')) return 'running';
  return 'success';
}

export function HomeView() {
  const { state, decideScope, refreshAll, setTab, setFilterMember, memberName, toast } =
    usePanel();
  const { dag, tasks, todos, scopeRequests, timeline, members } = state;

  /** 点击收件箱卡片的 Open 时切换 Plan/Activity 跟随的任务。 */
  const [selectedId, setSelectedId] = useState('');
  /** 展开更多 Activity 条数（默认最近 20 条）。 */
  const [activityLimit, setActivityLimit] = useState(20);

  /** 任务 id → 成员 id，供 Open 过滤时间线使用。 */
  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of dag?.nodes ?? []) if (node.assignee) map.set(node.taskId, node.assignee);
    for (const task of tasks) if (task.assignee) map.set(task.id, task.assignee);
    return map;
  }, [dag, tasks]);

  /** 任务 id → 最近 4 条真实事件（时间线回填里带 taskId 的条目）。 */
  const stepsByTask = useMemo(() => {
    const map = new Map<string, AgentTaskStep[]>();
    for (const entry of timeline) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(stepOf(entry));
      if (list.length > 4) list.shift();
      map.set(entry.taskId, list);
    }
    return map;
  }, [timeline]);

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /** 默认跟随：最新一个运行中的任务；否则最近的任务行。 */
  const fallbackId = useMemo(() => {
    const running = [...(dag?.nodes ?? [])].reverse().find((node) =>
      ['in_progress', 'running', 'assigned'].includes(node.status ?? ''),
    );
    if (running) return running.taskId;
    const latestTask = [...tasks].reverse().find((task) => task.status !== 'pending');
    return latestTask?.id ?? dag?.nodes?.[dag.nodes.length - 1]?.taskId ?? '';
  }, [dag, tasks]);

  const activeId = selectedId || fallbackId;
  const activeNode = (dag?.nodes ?? []).find((node) => node.taskId === activeId);
  const activeTask = taskById.get(activeId);
  const activeMemberId = activeNode?.assignee ?? activeTask?.assignee ?? assignees.get(activeId);
  const activeTitle =
    activeNode?.subject || activeTask?.subject || (activeId ? activeId : '未选择任务');
  const activeDone = activeTask?.status === 'done' || activeNode?.status === 'done';

  const planSteps = useMemo<PlanStep[]>(
    () =>
      todos
        .filter((todo: Todo) => todo.taskId === activeId)
        .map((todo) => ({
          id: todo.id,
          title: todo.title,
          detail:
            todo.blockedBy && todo.blockedBy.length
              ? `blocked by ${todo.blockedBy.join(', ')}`
              : undefined,
          status: PLAN_STATUS[todo.status] ?? 'pending',
        })),
    [todos, activeId],
  );

  /** PlanSteps 的阶段：清单全部完成才算 done（任务 done 但清单还有 open 项时不显示 Done in ...）。 */
  const planPhase: 'running' | 'done' =
    planSteps.length > 0 && planSteps.every((step) => step.status === 'done' || step.status === 'skipped')
      ? 'done'
      : 'running';

  /** 当前任务的真实事件流（时间线回填 + SSE 增量都在 state.timeline 里），按时间正序。 */
  const activity = useMemo(
    () => timeline.filter((entry) => entry.taskId === activeId),
    [timeline, activeId],
  );
  const visibleActivity = activity.slice(-activityLimit);

  const board = useMemo<AgentTask[]>(() => {
    const approvals = scopeRequests.map((request: ScopeRequest): AgentTask => {
      const steps: AgentTaskStep[] = [];
      if (request.blockedStep) steps.push({ label: `blocked step：${request.blockedStep}` });
      if (request.risk) steps.push({ label: `risk：${request.risk}` });
      if (request.fallback) steps.push({ label: `fallback：${request.fallback}` });
      return {
        id: SCOPE_PREFIX + request.id,
        title: `${request.domain || 'scope'} · ${request.target || '未指定目标'}`,
        description:
          request.reason ||
          (request.fallback
            ? `若拒绝将走 fallback：${request.fallback}`
            : '成员请求越界操作，等待你的决策。'),
        agent: memberName(request.memberId),
        status: 'waiting',
        startedAt: ms(request.createdAt),
        steps,
      };
    });

    const active = (dag?.nodes ?? [])
      .map((node): AgentTask | null => {
        const status = laneStatus(node.status ?? '');
        if (!status) return null;
        const row = taskById.get(node.taskId);
        const assignee = node.assignee ?? row?.assignee ?? undefined;
        const startedAt = ms(row?.attemptedAt) ?? ms(row?.createdAt);
        const attempts = row?.attempts ?? node.attempts ?? 0;
        const maxAttempts = row?.maxAttempts;
        const stepHint = status === 'failed' && attempts && maxAttempts
          ? `已尝试 ${attempts}/${maxAttempts} 次`
          : undefined;
        const description =
          (stepHint ? `${stepHint} · ` : '') +
          (row?.acceptance ? row.acceptance : '（无验收标准）');
        return {
          id: node.taskId,
          title: node.subject || node.taskId,
          description,
          agent: memberName(assignee),
          status,
          startedAt,
          elapsed: status === 'done' ? elapsedOf(row) : undefined,
          steps: stepsByTask.get(node.taskId) ?? [],
        };
      })
      .filter((task): task is AgentTask => task !== null);

    // 需要你决策的排最前；同列内按开始时间倒序，最新的在最上面。
    const order: Record<AgentTaskStatus, number> = { waiting: 0, running: 1, failed: 1, done: 2 };
    return [...approvals, ...active].sort((a, b) => {
      const lane = Number(order[a.status] ?? 9) - Number(order[b.status] ?? 9);
      if (lane !== 0) return lane;
      const at = (task: AgentTask) => (typeof task.startedAt === 'number' ? task.startedAt : 0);
      return at(b) - at(a);
    });
  }, [scopeRequests, dag, taskById, stepsByTask, memberName]);

  const queued = (dag?.nodes ?? []).filter((node) => !laneStatus(node.status ?? '')).length;
  const staleMembers = members.filter((member) => member.stale).length;

  const decide = (task: AgentTask, decision: 'approved' | 'denied') => {
    const request = scopeRequests.find((item) => SCOPE_PREFIX + item.id === task.id);
    if (!request) return;
    const verdict = decision === 'approved' ? '批准' : '驳回';
    if (
      !window.confirm(
        `确认${verdict} ${memberName(request.memberId)} 的 ${request.domain || '?'} 申请「${request.target || '?'}」？决策将事务落盘为 decision。`,
      )
    )
      return;
    void decideScope(request.id, decision).catch((err) =>
      toast(verdict + '失败：' + (err instanceof Error ? err.message : String(err)), 'error'),
    );
  };

  /** Open：Plan / Activity 切换到这张卡对应的任务（不再跳走，时间线视图仍保留）。 */
  const openTask = (task: AgentTask) => {
    if (task.id.startsWith(SCOPE_PREFIX)) return;
    setSelectedId(task.id);
  };

  /**
   * sidecar 没有「原地重试」路由：按原任务的主题/验收/写域/依赖建一条新任务，
   * 让调度器重新排队（新 taskId 会出现在依赖 DAG 与看板里）。
   */
  const retry = async (task: AgentTask) => {
    const row = taskById.get(task.id);
    const teamId = state.teamId;
    if (!row || !teamId) return;
    const node = dag?.nodes.find((item) => item.taskId === task.id);
    if (
      !window.confirm(
        `sidecar 不支持原地重试。将按原任务「${row.subject}」的主题/验收/写域/依赖新建一条任务重新排队（旧任务保持 failed），是否继续？`,
      )
    )
      return;
    try {
      const created = await api<Task>('/api/tasks', {
        method: 'POST',
        body: {
          teamId,
          subject: row.subject,
          assignee: row.assignee ?? null,
          plan: row.plan ?? [],
          writeScopes: row.writeScopes ?? [],
          acceptance: row.acceptance ?? null,
          priority: row.priority ?? 0,
          failurePolicy: row.failurePolicy ?? null,
          maxAttempts: row.maxAttempts ?? null,
          deps: (node?.dependsOn ?? []).map((from) => ({ from, condition: 'all_success' })),
        },
      });
      toast(`已重建任务 ${created.id}：${created.subject}`, 'ok');
      await refreshAll();
    } catch (err) {
      toast('重试失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const jumpToTimeline = () => {
    setFilterMember(activeMemberId ?? '');
    setTab('timeline');
  };

  return (
    <>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ---------------- Plan + Activity（真实数据，跟随选中任务） ---------------- */}
        <section className="min-w-0 space-y-3">
          <div className="rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <span className="text-sm font-semibold">Plan</span>
              <span className="truncate text-sm text-muted-foreground">{activeTitle}</span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                <span>{activeDone ? '已完成' : '进行中'}</span>
                {activeMemberId && <span>· {memberName(activeMemberId)}</span>}
                {activeTask?.attempts ? <span>· 第 {activeTask.attempts} 次尝试</span> : null}
              </span>
            </header>
            <div className="p-3">
              {planSteps.length ? (
                <PlanSteps key={activeId} title={activeTitle} steps={planSteps} status={planPhase} />
              ) : (
                <Empty className="gap-4 px-4 py-8 md:py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon" className="mb-3">
                      <ClipboardList />
                    </EmptyMedia>
                    <EmptyTitle className="text-sm">暂无计划</EmptyTitle>
                    <EmptyDescription>Leader 用 team_todo 写入</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <span className="text-sm font-semibold">Activity</span>
              <span className="text-xs text-muted-foreground">
                {activity.length ? `当前任务 ${activity.length} 条事件` : '暂无事件'}
              </span>
              <button
                type="button"
                className="ml-auto text-xs underline underline-offset-2 hover:text-foreground"
                onClick={jumpToTimeline}
              >
                在时间线视图查看
              </button>
            </header>
            <div className="max-h-[420px] space-y-1 overflow-y-auto p-3">
              {visibleActivity.length ? (
                visibleActivity.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2">
                    {/* 高度对齐 ToolCall 头部（min-height 44px），展开时时间也不会被拉偏 */}
                    <span className="flex h-11 w-14 shrink-0 items-center justify-end text-[11px] leading-none tabular-nums text-muted-foreground">
                      {fmtClockSec(entry.ts)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <ToolCall
                        name={entry.action || entry.phase}
                        summary={
                          <span>
                            {entry.phase}
                            {entry.target ? ` · ${entry.target}` : ''}
                            {entry.memberId ? ` · ${memberName(entry.memberId)}` : ''}
                          </span>
                        }
                        status={eventStatus(entry)}
                        args={{ phase: entry.phase, action: entry.action, target: entry.target, next: entry.next }}
                        result={entry.result ? { result: entry.result } : undefined}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <Empty className="gap-4 px-4 py-8 md:py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon" className="mb-3">
                      <ListTree />
                    </EmptyMedia>
                    <EmptyTitle className="text-sm">暂无事件</EmptyTitle>
                    <EmptyDescription>成员开始执行后实时出现</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {activity.length > visibleActivity.length && (
                <button
                  type="button"
                  className="mt-2 w-full rounded-md border py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setActivityLimit((limit) => limit + 40)}
                >
                  显示更早的 {activity.length - visibleActivity.length} 条
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ---------------- AgentInbox（真实卡 + 真实动作） ---------------- */}
        <section className="min-w-0">
          <div className="rounded-xl border bg-card">
            <div className="p-3">
              <AgentInbox
                tasks={board}
                title="实时收件箱"
                onApprove={(task) => decide(task, 'approved')}
                onReject={(task) => decide(task, 'denied')}
                onRetry={(task) => void retry(task)}
                onOpen={openTask}
              />
            </div>
          </div>
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 text-xs text-muted-foreground">
        {queued > 0 && (
          <button
            type="button"
            className="text-left underline underline-offset-2 hover:text-foreground"
            onClick={() => setTab('dag')}
          >
            另有 {queued} 个待派发 / 阻塞任务 · 查看依赖 DAG
          </button>
        )}
        {staleMembers > 0 && (
          <span className="text-amber-600">stale 成员 {staleMembers} 个（seq 与事件流不一致）</span>
        )}
      </footer>
    </>
  );
}

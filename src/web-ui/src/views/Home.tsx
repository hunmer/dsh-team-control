/**
 * 主页 = AffectUI `AgentInbox` 组件（vendored 在 src/affectui/agent-inbox.tsx）。
 *
 * 三列看板的每一张卡都来自 sidecar 的真实数据：
 * - `Needs you` 列：`GET /api/scope-requests?status=pending` 的越界申请（Approve/Reject → `POST /api/scope-requests/:id/decide`）；
 * - `Running` / `Done` 列：`GET /api/tasks` + `GET /api/dag` 的活跃任务（标题、成员、起止时间都是落盘行）；
 * - 卡片展开后的步骤：`GET /api/events/history` 里该任务的 `task.dispatch` / `task.retry` / `task.done` 等真实事件；
 * - `Open` → 时间线视图并按该成员过滤；`Retry`（仅失败任务）→ 按原任务参数重建一条任务重新排队。
 *
 * 未派发 / 阻塞的任务没有可执行的真实动作，不进看板，只在底部汇总一条提示。
 */
import { useMemo } from 'react';
import { usePanel } from '@/store';
import { api } from '@/lib/api';
import { fmtClock } from '@/lib/format';
import type { ScopeRequest, Task, TimelineEntry } from '@/types';
import {
  AgentInbox,
  type AgentTask,
  type AgentTaskStatus,
  type AgentTaskStep,
} from '@/affectui/agent-inbox';

const SCOPE_PREFIX = 'scope:';

/** 申请/任务 → 看板状态。没有可执行动作的状态（pending/ready/blocked）不进看板。 */
function laneStatus(status: string): AgentTaskStatus | null {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress' || status === 'running' || status === 'assigned') return 'running';
  return null;
}

/** `task.dispatch` / `task.retry` / `task.done` / `task.fail` → 卡片步骤文案。 */
const ACTION_LABELS: Record<string, string> = {
  'task.dispatch': '派发',
  'task.retry': '重试',
  'task.done': '完成',
  'task.fail': '失败',
};

function stepOf(entry: TimelineEntry): AgentTaskStep {
  const action = entry.action || entry.phase;
  return {
    label: ACTION_LABELS[action] ?? action,
    time: fmtClock(entry.ts),
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

export function HomeView() {
  const { state, decideScope, refreshAll, setTab, setFilterMember, memberName, toast } =
    usePanel();
  const { dag, tasks, scopeRequests, timeline, members } = state;

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

  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

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
    const order = { waiting: 0, running: 1, done: 2, failed: 1 } as const;
    return [...approvals, ...active].sort((a, b) => {
      const lane = order[a.status] - order[b.status];
      if (lane !== 0) return lane;
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });
  }, [scopeRequests, dag, taskById, stepsByTask, memberName]);

  const queued = (dag?.nodes ?? []).filter(
    (node) => !laneStatus(node.status ?? ''),
  ).length;
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

  const openTimeline = (task: AgentTask) => {
    const memberId = assignees.get(task.id);
    setFilterMember(memberId ?? '');
    setTab('timeline');
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

  return (
    <>
      <div className="space-y-3">
        <AgentInbox
          tasks={board}
          title="实时收件箱"
          onApprove={(task) => decide(task, 'approved')}
          onReject={(task) => decide(task, 'denied')}
          onRetry={(task) => void retry(task)}
          onOpen={openTimeline}
        />
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
          <span>
            数据源：/api/tasks · /api/dag · /api/scope-requests · /api/events/history（SSE 实时刷新）
          </span>
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
          {board.length === 0 && (
            <span>当前团队还没有可展示的任务：用 CLI / REST 建任务后这里会实时出现。</span>
          )}
        </footer>
      </div>
    </>
  );
}

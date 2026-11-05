/**
 * 主页 = AffectUI 组件 + 真实 sidecar 数据（不保留 demo 数据）。
 *
 * 布局（xl 及以上）：左列 `AgentInbox` 三列看板（Needs / Running / Done）占满高度，
 *      右列上 Plan（任务计划清单，来自 `team_todo` 工具写入的 /api/todos）、下 Activity
 *      （任务事件流），两者都按「当前选中的任务」过滤；窄屏时依次上下堆叠。
 *
 * 真实数据源：
 * - `GET /api/approvals?status=pending` → 待审批提示（审批由 Lead 用 `team_approve` 决定）；
 * - `GET /api/tasks` + `GET /api/dag` → 任务卡（标题、成员、起止时间、验收标准）；
 * - `GET /api/todos?team=` → Plan 清单（Leader/成员用 team_todo 维护）；
 * - `GET /api/events/history` → Activity；卡片展开的步骤也用这些事件；
 * - Open → 选中该任务（Plan/Activity 跟随）；Retry（失败任务）→ 按原参数重建任务再排队。
 */
import { useMemo, useState } from 'react';
import { usePanel } from '@/store';
import { api } from '@/lib/api';
import { openMemberConversation } from '@/lib/dsh-bridge';
import { fmtClockSec } from '@/lib/format';
import type { Task, TimelineEntry, Todo } from '@/types';
import { Button } from '@/components/ui/button';
import { ActivityFeed } from '@/components/activity-feed';
import {
  AgentInbox,
  type AgentTask,
  type AgentTaskArtifact,
  type AgentTaskStatus,
  type AgentTaskStep,
} from '@/components/agent-inbox';
import type { PlanStep } from '@/components/plan-steps';
import { PlanCard, toPlanStep } from '@/components/plan-card';
import { modelAvatar } from '@/components/ModelAvatar';


/** 申请/任务 → 看板状态。没有可执行动作的状态（pending/ready/blocked）不进看板。 */
function laneStatus(status: string): AgentTaskStatus | null {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress' || status === 'running' || status === 'assigned') return 'running';
  return null;
}

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

export function HomeView() {
  const { state, refreshAll, setTab, setFilterMember, memberName, toast, focusReview } =
    usePanel();
  const { dag, tasks, todos, timeline, members, artifacts } = state;

  /** 点击收件箱卡片的 Open 时切换 Plan/Activity 跟随的任务。 */
  const [selectedId, setSelectedId] = useState('');

  /** 任务 id → 成员 id，供 Open 过滤时间线使用。 */
  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of dag?.nodes ?? []) if (node.assignee) map.set(node.taskId, node.assignee);
    for (const task of tasks) if (task.assignee) map.set(task.id, task.assignee);
    return map;
  }, [dag, tasks]);

  /** 任务 id → 成员产物（/api/artifacts：Host 插件从成员会话采集的交付文件）。 */
  const artifactsByTask = useMemo(() => {
    const map = new Map<string, AgentTaskArtifact[]>();
    for (const item of artifacts) {
      if (!item.taskId) continue;
      const list = map.get(item.taskId) ?? [];
      list.push({ path: item.path, label: item.label, source: item.source, added: item.added ?? null, deleted: item.deleted ?? null });
      map.set(item.taskId, list);
    }
    return map;
  }, [artifacts]);

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /** 成员 id → 模型（决定卡片头像用哪个厂商图标）。 */
  const modelByMember = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) if (member.model) map.set(member.id, member.model);
    return map;
  }, [members]);

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
    () => todos.filter((todo: Todo) => todo.taskId === activeId).map(toPlanStep),
    [todos, activeId],
  );

  /** 当前任务的真实事件流（时间线回填 + SSE 增量都在 state.timeline 里），按时间正序。 */
  const activity = useMemo(
    () => timeline.filter((entry) => entry.taskId === activeId),
    [timeline, activeId],
  );

  const board = useMemo<AgentTask[]>(() => {
    const logoOf = (memberId?: string) =>
      memberId
        ? modelAvatar(modelByMember.get(memberId), memberName(memberId), undefined, 16)
        : undefined;
    const active = (dag?.nodes ?? [])
      .map((node): AgentTask | null => {
        let status = laneStatus(node.status ?? '');
        if (!status) return null;
        const row = taskById.get(node.taskId);
        const assignee = node.assignee ?? row?.assignee ?? undefined;
        // 完成与否看成员是否还在跑：todo 全勾完但成员仍在收尾时保持「运行中」；
        // 成员已停下（idle/failed/interrupted）时，即使任务状态还没落 done 也显示「完成」。
        // 失败保持失败；成员缺失或心跳过期（stale）时退回 DAG 状态，避免误判。
        const member = assignee ? members.find((item) => item.id === assignee) : undefined;
        if (status !== 'failed' && member && !member.stale) {
          if (member.status === 'running' && status === 'done') status = 'running';
          else if (member.status !== 'running' && status === 'running') status = 'done';
        }
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
          memberId: assignee,
          logo: logoOf(assignee),
          status,
          startedAt,
          elapsed: status === 'done' ? elapsedOf(row) : undefined,
          artifacts: artifactsByTask.get(node.taskId) ?? [],
        };
      })
      .filter((task): task is AgentTask => task !== null);

    // 需要你决策的排最前；同列内按开始时间倒序，最新的在最上面。
    const order: Record<AgentTaskStatus, number> = { waiting: 0, running: 1, failed: 1, done: 2 };
    return active.sort((a, b) => {
      const lane = Number(order[a.status] ?? 9) - Number(order[b.status] ?? 9);
      if (lane !== 0) return lane;
      const at = (task: AgentTask) => (typeof task.startedAt === 'number' ? task.startedAt : 0);
      return at(b) - at(a);
    });
  }, [dag, taskById, artifactsByTask, members, memberName, modelByMember]);

  const queued = (dag?.nodes ?? []).filter((node) => !laneStatus(node.status ?? '')).length;
  const staleMembers = members.filter((member) => member.stale).length;

  /** Open：Plan / Activity 切换到这张卡对应的任务（不再跳走，时间线视图仍保留）。 */
  const openTask = (task: AgentTask) => {
    setSelectedId(task.id);
  };

  /** 点产物 → 跳到「审阅」并选中这条改动（按路径匹配，文件名兜底）。 */
  const openArtifact = (task: AgentTask, artifact: AgentTaskArtifact) => {
    focusReview(artifact.path, task.memberId);
  };

  /** 查看对话：复用 member-info 里的 openMemberConversation（要求面板嵌在 DSH 页面里）。 */
  const openChat = (task: AgentTask) => {
    const member = members.find((item) => item.id === task.memberId);
    if (!member) {
      toast('找不到该成员，无法打开对话', 'warn');
      return;
    }
    const result = openMemberConversation(member, state.team?.leadSessionId);
    if (result === 'no-session') toast('该成员没有 DSH 会话（worker 运行时没有会话）', 'warn');
    else if (result === 'not-embedded') toast('面板不在 DSH 页面里打开，无法唤起成员对话', 'warn');
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
    <div className="flex min-h-0 flex-col gap-3 xl:h-full">
      <div className="grid min-h-0 gap-3 xl:flex-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ---------------- 左列：实时收件箱占满高度 ---------------- */}
        <section className="min-w-0 xl:min-h-0">
          <div className="flex h-full flex-col rounded-xl border bg-card">
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <AgentInbox
                activeId={activeId}
                className="min-h-0 flex-1"
                tasks={board}
                title="实时收件箱"
                onRetry={(task) => void retry(task)}
                onOpen={openTask}
                onOpenArtifact={openArtifact}
                onOpenChat={openChat}
              />
            </div>
          </div>
        </section>

        {/* ---------------- 右列：上 Plan、下 Activity ---------------- */}
        <div className="grid min-h-0 gap-3 xl:grid-rows-2">
          <section className="min-w-0 xl:min-h-0">
            <PlanCard
              key={activeId}
              title={activeTitle}
              steps={planSteps}
              done={activeDone}
              memberName={activeMemberId ? memberName(activeMemberId) : undefined}
              attempts={activeTask?.attempts}
            />
          </section>

          <section className="min-w-0 xl:min-h-0">
            <ActivityFeed entries={activity} memberName={memberName} onOpenTimeline={jumpToTimeline} />
          </section>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 text-xs text-muted-foreground">
        {queued > 0 && (
          <Button onClick={() => setTab('dag')} size="xs" type="button" variant="link">
            另有 {queued} 个待派发 / 阻塞任务 · 查看依赖 DAG
          </Button>
        )}
        {staleMembers > 0 && (
          <span className="text-amber-600">stale 成员 {staleMembers} 个（seq 与事件流不一致）</span>
        )}
      </footer>
    </div>
  );
}

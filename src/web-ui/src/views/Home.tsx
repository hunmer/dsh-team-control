/**
 * 主页 = AffectUI 组件 + 真实 sidecar 数据（不保留 demo 数据）。
 *
 * 布局（xl 及以上）：左列每个 agent 成员一张 `AgentSteering`（成员引导 + 队列回复），
 *      卡片按两列网格排布、点卡片选中它当前的任务（头部图标用成员模型图标）；
 *      右列上 Plan（任务计划清单，来自 `team_todo` 工具写入的 /api/todos）、下 Activity
 *      （任务事件流），两者都按「当前选中的任务」过滤；窄屏时依次上下堆叠。
 *
 * 真实数据源：
 * - `GET /api/status` → 成员（每个 agent 成员一个 steering 卡片）；
 * - `GET /api/todos?team=` → 成员步骤（成员用 team_todo / todo_write 维护）；
 * - `GET /api/messages?team=` → 排队回复（kind=steer 且 status=queued 的消息）；
 * - `POST /api/messages` → 面板排队一条 steer 消息，Host 插件负责投进成员会话；
 * - `GET /api/tasks` + `GET /api/dag` → Plan/Activity 跟随的任务（点卡片选中）；
 * - `GET /api/events/history` → Activity。
 */
import { useMemo, useState } from 'react';
import { usePanel } from '@/store';
import { api, enc } from '@/lib/api';
import type { Member, Task, Todo } from '@/types';
import { Button } from '@/components/ui/button';
import { ActivityFeed } from '@/components/activity-feed';
import { AgentSteering, type SteerNote, type SteerStatus, type SteerStep } from '@/components/agent-steering';
import { modelAvatar } from '@/components/ModelAvatar';
import type { PlanStep } from '@/components/plan-steps';
import { PlanCard, toPlanStep } from '@/components/plan-card';

/** todo 状态 → steering 步骤状态。 */
function steerStepStatus(status?: string): SteerStep['status'] {
  if (status === 'done') return 'done';
  if (status === 'active' || status === 'in_progress' || status === 'running') return 'active';
  return 'pending';
}

/** 成员状态 → steering 卡片三态：跑着的才算 running，退场/失败封口，其余（排队·空闲·阻塞·中断）按暂停。 */
function steerStatusOf(member: Member): SteerStatus {
  if (['retired', 'inactive', 'removed', 'failed', 'done'].includes(member.status)) return 'done';
  if (['running', 'provisioning'].includes(member.status)) return 'running';
  return 'paused';
}

/** 卡片状态文案：running/done 交给组件显示「Running · 时长 / Done in 时长」，其余显示真实成员状态。 */
function steerStateLabelOf(member: Member): string | undefined {
  switch (member.status) {
    case 'provisioning':
      return '启动中';
    case 'queued':
      return '排队中';
    case 'idle':
      return '空闲';
    case 'blocked':
      return '阻塞';
    case 'interrupted':
      return '已中断';
    case 'failed':
      return '失败';
    case 'retired':
    case 'inactive':
    case 'removed':
      return '已下线';
    default:
      return undefined;
  }
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
  const { state, refreshMessages, setTab, setFilterMember, memberName, toast } = usePanel();
  const { dag, tasks, todos, timeline, members, messages } = state;

  /** 点成员卡片时切换 Plan/Activity 跟随的任务。 */
  const [selectedId, setSelectedId] = useState('');

  /** 任务 id → 成员 id，供 Activity 过滤使用。 */
  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of dag?.nodes ?? []) if (node.assignee) map.set(node.taskId, node.assignee);
    for (const task of tasks) if (task.assignee) map.set(task.id, task.assignee);
    return map;
  }, [dag, tasks]);

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /**
   * 成员 id → 可点选的任务：`memberView` 只把 running 任务算成 currentTaskId，成员空闲时
   * currentTaskId 是 null，所以要退回该成员最近一次被派发的任务，否则点卡片没反应。
   */
  const taskIdByMember = useMemo(() => {
    const latest = new Map<string, { id: string; at: number }>();
    for (const task of tasks) {
      if (!task.id || !task.assignee) continue;
      const at = ms(task.createdAt) ?? ms(task.attemptedAt) ?? 0;
      const prev = latest.get(task.assignee);
      if (!prev || at >= prev.at) latest.set(task.assignee, { id: task.id, at });
    }
    for (const node of dag?.nodes ?? []) {
      if (!node.taskId || !node.assignee || latest.has(node.assignee)) continue;
      latest.set(node.assignee, { id: node.taskId, at: ms(taskById.get(node.taskId)?.createdAt) ?? 0 });
    }
    return new Map([...latest].map(([memberId, entry]) => [memberId, entry.id]));
  }, [tasks, dag, taskById]);

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

  /** 能收到面板消息的成员：只有 agent 运行时才有 DSH 会话（worker 没有会话）。 */
  const steerable = useMemo(() => members.filter((member) => !!member.agentSessionId), [members]);

  /** 成员 id → 卡片步骤：该成员当前任务的 todo（按 orderNo 升序），没有 todo 时退化成单步任务卡。 */
  const stepsByMember = useMemo(() => {
    const map = new Map<string, SteerStep[]>();
    for (const member of steerable) {
      const taskId = member.currentTaskId;
      const task = taskId ? taskById.get(taskId) : undefined;
      const rows = todos
        .filter(
          (todo: Todo) =>
            todo.memberId === member.id && (!taskId || !todo.taskId || todo.taskId === taskId),
        )
        .sort((a, b) => a.orderNo - b.orderNo);
      const steps: SteerStep[] = rows.map((todo) => ({
        id: todo.id,
        title: todo.title,
        status: steerStepStatus(todo.status),
        startedAt: ms(todo.createdAt) ?? Date.now(),
      }));
      if (!steps.length && taskId) {
        steps.push({
          id: taskId,
          title: task?.subject ?? taskId,
          status: task?.status === 'done' ? 'done' : 'active',
          startedAt: ms(task?.attemptedAt) ?? ms(task?.createdAt) ?? Date.now(),
        });
      }
      map.set(member.id, steps);
    }
    return map;
  }, [steerable, todos, taskById]);

  /** 成员 id → 队列里的 steer 消息（sidecar 里 kind='steer' 且仍是 queued）。 */
  const queueByMember = useMemo(() => {
    const map = new Map<string, SteerNote[]>();
    for (const message of messages) {
      if (message.kind !== 'steer' || message.status !== 'queued' || !message.to) continue;
      const text = String(message.payload?.text ?? '').trim();
      if (!text) continue;
      const list = map.get(message.to) ?? [];
      list.push({ id: message.id, text });
      map.set(message.to, list);
    }
    // sidecar 按 sent_at 倒序返回，队列按「先来先投」正序展示。
    for (const list of map.values()) list.reverse();
    return map;
  }, [messages]);

  const queued = (dag?.nodes ?? []).filter(
    (node) =>
      !['done', 'failed', 'in_progress', 'running', 'assigned'].includes(node.status ?? ''),
  ).length;
  const staleMembers = members.filter((member) => member.stale).length;

  /**
   * 面板发一条 steer 消息到 sidecar 信箱，由 dsh-plugin 的 steer 泵投递进成员会话。
   * immediate=true 只表示「插到队列最前优先投递」（subagents.sendMessage 不打断当前回合）。
   */
  const sendSteer = async (member: Member, text: string, immediate = false) => {
    const body = text.trim();
    if (!body) return;
    try {
      await api('/api/messages', {
        method: 'POST',
        body: {
          teamId: state.teamId,
          from: 'lead',
          to: member.id,
          kind: 'steer',
          payload: immediate ? { text: body, immediate: true } : { text: body },
        },
      });
      await refreshMessages();
    } catch (err) {
      toast('排队失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /** 从队列里撤掉一条 steer 消息：ack 到终态后泵不会再投递。 */
  const dropSteer = async (id: string) => {
    try {
      await api('/api/messages/' + enc(id) + '/ack', { method: 'POST', body: { state: 'acked' } });
      await refreshMessages();
    } catch (err) {
      toast('撤销失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const jumpToTimeline = () => {
    setFilterMember(activeMemberId ?? '');
    setTab('timeline');
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 xl:h-full">
      <div className="grid min-h-0 gap-3 xl:flex-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ---------------- 左列：每个 agent 成员一张成员引导卡 ---------------- */}
        <section className="min-w-0 xl:min-h-0">
          <div className="flex h-full min-h-0 flex-col rounded-xl border bg-card">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
              <div className="text-sm font-medium">成员引导 · 队列回复</div>
              <div className="text-xs text-muted-foreground">
                {steerable.length} 个 agent 成员 · 点卡片跟随其任务
              </div>
            </div>
            <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-2">
              {steerable.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                  还没有 agent 成员（worker 成员没有会话，收不到面板消息）。
                </div>
              )}
              {steerable.map((member) => {
                const memberTaskId = member.currentTaskId || taskIdByMember.get(member.id) || '';
                const task = memberTaskId ? taskById.get(memberTaskId) : undefined;
                const selected = memberTaskId !== '' && memberTaskId === activeId;
                const pick = () => {
                  if (memberTaskId) setSelectedId(memberTaskId);
                };
                return (
                  <div
                    key={member.id}
                    role={memberTaskId ? 'button' : undefined}
                    tabIndex={memberTaskId ? 0 : undefined}
                    aria-pressed={memberTaskId ? selected : undefined}
                    aria-label={memberTaskId ? `选中 ${memberName(member.id)} 的任务` : undefined}
                    onClick={(event) => {
                      // 卡片里还有文本框 / 队列 chip：交互它们时不要顺带切右侧面板
                      if ((event.target as HTMLElement).closest('textarea,input,button,a')) return;
                      pick();
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        pick();
                      }
                    }}
                    className={[
                      'rounded-xl outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring',
                      memberTaskId ? 'cursor-pointer' : 'cursor-default',
                      selected
                        ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                        : memberTaskId
                          ? 'hover:ring-2 hover:ring-border'
                          : '',
                    ].join(' ')}
                  >
                    <AgentSteering
                      className="max-w-none!"
                      icon={modelAvatar(member.model, memberName(member.id), undefined, 14)}
                      agent={[member.model, member.role].filter(Boolean).join(' · ') || undefined}
                      title={memberName(member.id)}
                      status={steerStatusOf(member)}
                      stateLabel={steerStateLabelOf(member)}
                      startedAt={
                        ms(task?.attemptedAt) ??
                        ms(task?.createdAt) ??
                        ms(member.createdAt) ??
                        Date.now()
                      }
                      steps={stepsByMember.get(member.id) ?? []}
                      queue={queueByMember.get(member.id) ?? []}
                      placeholder={`给 ${memberName(member.id)} 排队一条消息（↵ 排队，⌘/Ctrl+↵ 优先投递）`}
                      onQueue={(text) => void sendSteer(member, text)}
                      onInterrupt={(text, queuedId) => {
                        if (queuedId) void dropSteer(queuedId);
                        void sendSteer(member, text, true);
                      }}
                      onRemove={(id) => void dropSteer(id)}
                    />
                  </div>
                );
              })}
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

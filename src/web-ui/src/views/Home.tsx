/**
 * 主页 = AffectUI 组件 + 真实 sidecar 数据（不保留 demo 数据）。
 *
 * 布局：上方是成员列表，每个 agent 成员一张 `AgentSteering`（成员引导 + 队列回复），
 *      卡片按两列网格排布；下方内嵌时间线。
 *
 * 真实数据源：
 * - `GET /api/status` → 成员（每个 agent 成员一个 steering 卡片）；
 * - `GET /api/todos?team=` → 成员步骤（成员用 team_todo / todo_write 维护）；
 * - `GET /api/messages?team=` → 排队回复（kind=steer 且 status=queued 的消息）；
 * - `POST /api/messages` → 面板排队一条 steer 消息，Host 插件负责投进成员会话；
 * - `GET /api/tasks` + `GET /api/dag` → 卡片跟随的任务（用于时长/步骤）。
 */
import { useMemo } from 'react';
import { usePanel } from '@/store';
import { api, enc } from '@/lib/api';
import type { ContextSnapshot, Member, Task, Todo } from '@/types';
import { AgentSteering, type SteerMetrics, type SteerNote, type SteerStatus, type SteerStep } from '@/components/agent-steering';
import { modelAvatar } from '@/components/ModelAvatar';
import { openMemberConversation } from '@/lib/dsh-bridge';
import { TimelineView } from '@/views/Timeline';

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

/** 状态点颜色跟真实状态走：运行中橙、空闲蓝、已完成绿、失败/阻塞红、其余灰。 */
function steerStateToneOf(member: Member): 'blue' | 'orange' | 'green' | 'red' | 'muted' {
  switch (member.status) {
    case 'running':
    case 'provisioning':
      return 'orange';
    case 'idle':
      return 'blue';
    case 'done':
      return 'green';
    case 'failed':
    case 'blocked':
      return 'red';
    default:
      return 'muted';
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
  const { state, refreshMessages, memberName, toast } = usePanel();
  const { dag, tasks, todos, members, messages, contexts } = state;

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /**
   * 成员 id → 卡片跟随的任务：`memberView` 只把 running 任务算成 currentTaskId，成员空闲时
   * currentTaskId 是 null，所以要退回该成员最近一次被派发的任务，时长/步骤才不会跳。
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

  /** 成员 id → 底部执行指标（Host 从 DSH 会话投影折出的轮数/速度/token/缓存/上下文）。 */
  const metricsByMember = useMemo(() => {
    const map = new Map<string, SteerMetrics>();
    for (const snapshot of contexts as ContextSnapshot[]) {
      const stats = snapshot.stats;
      if (!stats) continue;
      // listContexts 按 updated_at DESC 返回，先到的是最新快照。
      if (map.has(snapshot.memberId)) continue;
      map.set(snapshot.memberId, {
        turns: stats.turns,
        steps: stats.steps,
        decodeTokens: stats.decodeTokens,
        decodeMs: stats.decodeMs,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheHitRate: stats.inputTokens > 0 ? stats.cacheReadTokens / stats.inputTokens : null,
        contextUsed: snapshot.used ?? 0,
        contextLimit: snapshot.limit ?? 0,
      });
    }
    return map;
  }, [contexts]);

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

  /** 请宿主页面（DSH 侧栏）打开该成员的对话；面板独立打开时没法唤起。 */
  const openChat = (member: Member) => {
    const result = openMemberConversation(member, state.team?.leadSessionId);
    if (result === 'no-session') toast('该成员还没有绑定 DSH 会话', 'warn');
    else if (result === 'not-embedded') toast('面板不在 DSH 页面里打开，无法唤起成员对话', 'warn');
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ---------------- 成员列表：每个 agent 成员一张成员引导卡 ---------------- */}
      <section className="min-w-0">
        <div className="flex flex-col rounded-xl border bg-card">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <div className="text-sm font-medium">成员列表</div>
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
              return (
                <div key={member.id}>
                  <AgentSteering
                    className="max-w-none!"
                    icon={modelAvatar(member.model, memberName(member.id), undefined, 14)}
                    agent={
                      [member.model, member.role, member.reasoningEffort ? `思考 ${member.reasoningEffort}` : null]
                        .filter(Boolean)
                        .join(' · ') || undefined
                    }
                    title={memberName(member.id)}
                    status={steerStatusOf(member)}
                    stateLabel={steerStateLabelOf(member)}
                    stateTone={steerStateToneOf(member)}
                    startedAt={
                      ms(task?.attemptedAt) ??
                      ms(task?.createdAt) ??
                      ms(member.createdAt) ??
                      Date.now()
                    }
                    steps={stepsByMember.get(member.id) ?? []}
                    metrics={metricsByMember.get(member.id)}
                    queue={queueByMember.get(member.id) ?? []}
                    onQueue={(text) => void sendSteer(member, text)}
                    onInterrupt={(text, queuedId) => {
                      if (queuedId) void dropSteer(queuedId);
                      void sendSteer(member, text, true);
                    }}
                    onRemove={(id) => void dropSteer(id)}
                    onOpenChat={() => openChat(member)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- 下方：内嵌时间线（原独立 timeline 页签已取消，路由并入主页） ---------------- */}
      <section className="min-h-[50vh] min-w-0">
        <TimelineView />
      </section>
    </div>
  );
}

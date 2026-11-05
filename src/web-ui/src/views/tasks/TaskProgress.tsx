/**
 * 看板详情容器里的「团队执行进度」卡片。
 * 数据来自选中任务关联团队的 todo（不是看板任务 id）：成员用 todo_write 提交的待办。
 * 同一 done_at 的多个 todo 是「一次勾好几个」的同一批，合成 AgentLanes 里的一个进度块。
 * 底部附 PlanCard（与首页右列同款）：该团队的 todo 计划清单。
 */
import { useEffect, useMemo, useState } from 'react';
import { AgentLanes, type LaneAgent, type LaneTask } from '@/components/agent-lanes/agent-lanes';
import { PlanCard, toPlanStep } from '@/components/plan-card';
import { buildTodoBatches, fmtDuration, todoDuration, todosApi, type TodoItem } from '@/lib/todos';
import type { Member } from '@/types';
import { errText } from './shared';

const POLL_MS = 2500;
const MIN_SPAN_MS = 30 * 60_000;
const MAX_SPAN_MS = 7 * 24 * 60 * 60_000;

export function TaskProgress({ teamId }: { teamId: string }) {
  const [teamName, setTeamName] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    setTeamName('');
    todosApi
      .teams()
      .then((res) => {
        if (!alive) return;
        setTeamName(res.items.find((item) => item.id === teamId)?.name || '');
      })
      .catch(() => { /* 名字只是装饰，失败时后面用 teamId 兜底 */ });
    return () => { alive = false; };
  }, [teamId]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async (first: boolean) => {
      try {
        const [todoRes, statusRes] = await Promise.all([
          todosApi.list(teamId),
          todosApi.members(teamId),
        ]);
        if (!alive) return;
        setTodos(todoRes.items || []);
        setMembers(statusRes.members || []);
        setError('');
      } catch (err) {
        if (alive && first) setError(errText(err));
      } finally {
        if (alive && first) setLoading(false);
      }
    };
    setLoading(true);
    setError('');
    void load(true);
    timer = window.setInterval(() => void load(false), POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [teamId]);

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  /** 全团队 todo → PlanCard 步骤（与首页右列 Plan 卡片同款展示）。 */
  const planSteps = useMemo(() => todos.map(toPlanStep), [todos]);

  const batches = useMemo(() => buildTodoBatches(todos, tick), [todos, tick]);
  const agentIds = useMemo(() => [...new Set(batches.map((batch) => batch.memberId || 'unassigned'))], [batches]);

  const agents = useMemo<LaneAgent[]>(() => agentIds.map((id) => {
    const member = id === 'unassigned' ? null : memberById.get(id);
    return {
      id,
      name: id === 'unassigned' ? '未分配成员' : (member?.name || member?.role || id.slice(0, 8)),
      model: member?.model,
    };
  }), [agentIds, memberById]);

  const laneTasks = useMemo<LaneTask[]>(() => batches.map((batch) => {
    const count = batch.todos.length;
    const took = fmtDuration(Math.max(0, batch.end - batch.start));
    const first = batch.todos[0]?.title || '';
    const label = batch.status === 'done'
      ? `完成 ${count} 项`
      : `${batch.status === 'failed' ? '阻塞' : '进行中'}${count > 1 ? ` ${count} 项` : ''} · ${first}`;
    return {
      id: batch.id,
      agentId: batch.memberId || 'unassigned',
      title: `${label} · ${took}`,
      status: batch.status,
      start: batch.start,
      end: batch.end,
      summary: batch.todos.map((todo) => `${todo.title} · ${fmtDuration(todoDuration(todo, tick))}`),
    };
  }), [batches, tick]);

  const span = useMemo(() => {
    if (!batches.length) return MIN_SPAN_MS;
    const earliest = Math.min(...batches.map((batch) => batch.start));
    return Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, tick - earliest + 5 * 60_000));
  }, [batches, tick]);

  return (
    <section className="ui-tb__progress" aria-label="团队执行进度">
      {loading ? (
        <div className="ui-tb__progress-empty">正在加载团队执行进度…</div>
      ) : error ? (
        <div className="ui-tb__progress-empty" data-error="true">{error}</div>
      ) : !todos.length ? (
        <div className="ui-tb__progress-empty">
          该团队还没有待办记录。成员调用 <code>todo_write</code> 后会显示在这里。
        </div>
      ) : (
        <>
          {batches.length > 0 && (
            <AgentLanes
              agents={agents}
              tasks={laneTasks}
              span={span}
              now={tick}
              title={`执行进度 · ${teamName || teamId.slice(0, 8)}`}
            />
          )}
          <PlanCard
            title={teamName || teamId.slice(0, 8)}
            steps={planSteps}
            emptyHint="成员调用 todo_write 后会显示在这里"
          />
        </>
      )}
    </section>
  );
}


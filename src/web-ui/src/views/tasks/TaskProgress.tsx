/**
 * 看板详情容器里的「团队执行进度」卡片。
 * 数据来自选中任务关联团队的 todo（不是看板任务 id）：成员用 todo_write 提交的待办。
 * 同一 done_at 的多个 todo 是「一次勾好几个」的同一批，合成 AgentLanes 里的一个进度块。
 */
import { useEffect, useMemo, useState } from 'react';
import { AgentLanes, type LaneAgent, type LaneTask } from '@/components/agent-lanes/agent-lanes';
import { buildTodoBatches, fmtDuration, todoDuration, todosApi, type TodoBatch, type TodoItem } from '@/lib/todos';
import type { Member } from '@/types';
import { errText } from './shared';

const POLL_MS = 2500;
const MIN_SPAN_MS = 30 * 60_000;
const MAX_SPAN_MS = 7 * 24 * 60 * 60_000;

const STATUS_TEXT: Record<string, string> = {
  open: '待开始',
  active: '进行中',
  done: '已完成',
  blocked: '阻塞',
  skipped: '已跳过',
};

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
        const [todoRes, statusRes] = await Promise.all([todosApi.list(teamId), todosApi.members(teamId)]);
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
  const memberName = useMemo(() => (id: string | null) => {
    if (!id) return '未分配成员';
    const member = memberById.get(id);
    return member?.name || member?.role || id.slice(0, 8);
  }, [memberById]);

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

  const groups = useMemo(() => {
    const ids: string[] = [];
    const byMember = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      const id = todo.memberId || '';
      if (!byMember.has(id)) { byMember.set(id, []); ids.push(id); }
      byMember.get(id)!.push(todo);
    }
    return ids.map((id) => ({
      id,
      name: memberName(id || null),
      todos: byMember.get(id) || [],
      batches: batches.filter((batch) => (batch.memberId || '') === id),
    }));
  }, [todos, batches, memberName]);

  const doneCount = todos.filter((todo) => todo.status === 'done').length;

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
          <div className="ui-tb__progress-list">
            <div className="ui-tb__progress-summary">
              <span>共 {todos.length} 项待办</span>
              <span>已完成 {doneCount} 项</span>
            </div>
            {groups.map((group) => {
              const open = group.todos.filter((todo) => todo.status === 'open' || todo.status === 'skipped');
              const total = group.todos.length;
              const done = group.todos.filter((todo) => todo.status === 'done').length;
              return (
                <section className="ui-tb__progress-member" key={group.id || 'unassigned'}>
                  <header className="ui-tb__progress-member-head">
                    <span className="ui-tb__progress-name">{group.name}</span>
                    <span className="ui-tb__progress-count">{done}/{total} 完成</span>
                  </header>
                  {group.batches.map((batch) => (
                    <BatchBlock key={batch.id} batch={batch} now={tick} />
                  ))}
                  {open.length > 0 && (
                    <div className="ui-tb__batch" data-status="open">
                      <div className="ui-tb__batch-head">
                        <span>待开始 {open.length} 项</span>
                        <span className="ui-tb__batch-time" />
                      </div>
                      <ul>
                        {open.map((todo) => (
                          <li key={todo.id}>
                            <span className="ui-tb__todo-title" title={todo.title}>
                              <span className="ui-tb__todo-dot" data-status={todo.status} />
                              <span className="ui-tb__todo-text">{todo.title}</span>
                            </span>
                            <span className="ui-tb__todo-dur">{STATUS_TEXT[todo.status] || todo.status}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function BatchBlock({ batch, now }: { batch: TodoBatch; now: number }) {
  const label = batch.status === 'done'
    ? `完成 ${batch.todos.length} 项`
    : `${batch.status === 'failed' ? '阻塞' : '进行中'}${batch.todos.length > 1 ? ` ${batch.todos.length} 项` : ''}`;
  return (
    <div className="ui-tb__batch" data-status={batch.status}>
      <div className="ui-tb__batch-head">
        <span>{label}</span>
        <span className="ui-tb__batch-time">{fmtDuration(Math.max(0, batch.end - batch.start))}</span>
      </div>
      <ul>
        {batch.todos.map((todo) => (
          <li key={todo.id}>
            <span className="ui-tb__todo-title" title={todo.title}>
              <span className="ui-tb__todo-dot" data-status={todo.status} />
              <span className="ui-tb__todo-text">{todo.title}</span>
            </span>
            <span className="ui-tb__todo-dur">{fmtDuration(todoDuration(todo, now))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 成员队列浮窗 —— 把 affectUI Agent Queue 挂到面板右下角，展示各成员的实时状态。
 *
 * 数据映射：
 *   workers = 团队成员（头像用模型品牌图标）
 *   jobs    = 待办清单里的每个步骤（active→running / blocked→failed / done→done / open→queued），
 *             成员正在跑但还没有待办的，补一条「当前步骤」job。
 * 原组件的 Pause 与并发加减按钮依赖 onPausedChange / onConcurrencyChange，
 * 这里不传这两个回调，右上角就只剩标题与状态胶囊。
 */
import { useMemo, useState } from 'react';
import { usePanel } from '@/store';
import { storeGet, storeSet } from '@/lib/format';
import { MemberAvatarButton } from '@/components/member-info';
import { AgentQueue, type QueueJob, type QueueWorker } from '@/components/agent-queue/agent-queue';

const OPEN_KEY = 'dsh-team.panel.queue.v1';

const QueueGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="1.6" y="2.4" width="5.2" height="2.6" rx="1" fill="currentColor" opacity="0.9" />
    <rect x="1.6" y="6.7" width="5.2" height="2.6" rx="1" fill="currentColor" opacity="0.6" />
    <rect x="1.6" y="11" width="5.2" height="2.6" rx="1" fill="currentColor" opacity="0.35" />
    <circle cx="12" cy="8" r="2.6" fill="currentColor" />
  </svg>
);

/** 待办状态 → 队列状态 */
function todoStatus(status: string): QueueJob['status'] {
  if (status === 'done') return 'done';
  if (status === 'active') return 'running';
  if (status === 'blocked') return 'failed';
  return 'queued';
}

export function AgentQueueDock() {
  const { state, memberName } = usePanel();
  const { teamId, team, members, todos } = state;
  // 展开状态记住上次的选择；第一次访问时按屏宽决定默认值（窄屏默认收起）。
  const [open, setOpen] = useState(() => {
    const stored = storeGet(OPEN_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
    if (typeof window === 'undefined') return false;
    return window.innerWidth >= 768;
  });

  const toggle = (next: boolean) => {
    setOpen(next);
    storeSet(OPEN_KEY, next ? '1' : '0');
  };

  const workerById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const workers = useMemo<QueueWorker[]>(
    () =>
      members.map((m) => ({
        id: m.id,
        name: memberName(m.id),
        detail: m.status,
        icon: <MemberAvatarButton member={m} size={14} />,
      })),
    [members, memberName],
  );

  const jobs = useMemo<QueueJob[]>(() => {
    const now = Date.now();
    const at = (value?: string | null): number | null => {
      if (!value) return null;
      const t = Date.parse(value);
      return Number.isFinite(t) ? t : null;
    };
    const rows: QueueJob[] = todos.map((todo, index) => {
      const status = todoStatus(todo.status);
      const created = at(todo.createdAt) ?? now - (todos.length - index) * 1000;
      const updated = at(todo.updatedAt) ?? created;
      const member = todo.memberId ? workerById.get(todo.memberId) : undefined;
      return {
        id: todo.id,
        name: todo.title,
        kind: 'agent',
        status,
        enqueuedAt: created,
        startedAt: status === 'queued' ? undefined : created,
        endedAt: status === 'done' || status === 'failed' ? updated : undefined,
        worker: status === 'running' || status === 'done' ? member?.id : undefined,
        progress: status === 'running' && typeof member?.pct === 'number' ? Math.min(1, Math.max(0, member.pct / 100)) : undefined,
        detail: member ? memberName(member.id) : undefined,
      };
    });

    // 没有待办、但成员确实在跑：补一条「当前步骤」，让队列反映实时状态。
    const covered = new Set(rows.filter((row) => row.status === 'running').map((row) => row.worker));
    for (const member of members) {
      if (member.status !== 'running' || covered.has(member.id)) continue;
      const started = at(member.createdAt) ?? now;
      rows.push({
        id: `member:${member.id}`,
        name: member.step || member.last || '执行中',
        kind: 'agent',
        status: 'running',
        enqueuedAt: started,
        startedAt: started,
        worker: member.id,
        progress: typeof member.pct === 'number' ? Math.min(1, Math.max(0, member.pct / 100)) : undefined,
        detail: memberName(member.id),
      });
    }
    return rows;
  }, [todos, members, workerById, memberName]);

  if (!teamId || (!members.length && !todos.length)) return null;

  const running = members.filter((m) => m.status === 'running').length;
  const waiting = jobs.filter((j) => j.status === 'queued').length;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => toggle(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border bg-card/95 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent"
        aria-expanded={false}
        title="展开成员队列"
      >
        <span className="text-muted-foreground">
          <QueueGlyph />
        </span>
        成员队列
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {running} 运行
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {waiting} 等待
        </span>
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-40 w-[min(760px,calc(100vw-2rem))] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl shadow-xl"
      onKeyDown={(event) => {
        if (event.key === 'Escape') toggle(false);
      }}
    >
      <AgentQueue
        jobs={jobs}
        workers={workers}
        title="成员队列"
        name={team?.name ?? undefined}
      />
      <button
        type="button"
        onClick={() => toggle(false)}
        className="absolute right-2.5 top-2.5 z-10 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        aria-label="收起成员队列"
        title="收起（Esc）"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export default AgentQueueDock;

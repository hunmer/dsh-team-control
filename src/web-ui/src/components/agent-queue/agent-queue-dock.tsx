/**
 * 成员队列 —— 顶栏右侧的按钮 + Popover，展示各成员的实时状态。
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
import { MemberAvatarButton } from '@/components/member-info';
import { TeamRunMenu } from '@/components/TeamRunMenu';
import { AgentQueue, type QueueJob, type QueueWorker } from '@/components/agent-queue/agent-queue';
import { Button } from '@/components/ui/button';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';

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
  const [open, setOpen] = useState(false);

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

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 px-2 text-xs"
            aria-label="成员队列"
            title="成员队列"
          />
        }
      >
        <span className="text-muted-foreground">
          <QueueGlyph />
        </span>
        队列
        <span className="tabular-nums text-muted-foreground">
          {running}/{waiting}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[min(760px,calc(100vw-2.5rem))] [&_[data-slot=popover-viewport]]:p-0"
      >
        <div className="relative max-h-[min(72vh,640px)] overflow-y-auto rounded-lg">
          <AgentQueue
            jobs={jobs}
            workers={workers}
            title="成员队列"
            name={team?.name ?? undefined}
            actions={
              <span className="flex items-center gap-1">
                <TeamRunMenu />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                  aria-label="收起成员队列"
                  title="收起（Esc）"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            }
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export default AgentQueueDock;

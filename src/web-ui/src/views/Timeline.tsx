/**
 * 时间线 —— 单列竖向时间轴（参考 Trace 瀑布的紧凑行样式）。
 * 一条竖线 + 左侧时间，事件按时间正序逐行展开；不再提供时间窗缩放 / 横向回看，
 * 所有事件都在同一页里纵向滚动，信息再多也不出屏。
 */
import { useEffect, useMemo, useRef } from 'react';
import { PHASES, usePanel } from '@/store';
import { fmtClockSec, fmtDateTime, safeToken } from '@/lib/format';
import type { Member, TimelineEntry } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { modelAvatar } from '@/components/ModelAvatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

const FILTER_ALL = '__all__';

/** phase → 事件节点颜色（竖线上的圆点） */
const PHASE_DOT: Record<string, string> = {
  init: 'bg-muted-foreground/50',
  read: 'bg-sky-500',
  write: 'bg-amber-500',
  exec: 'bg-violet-500',
  net: 'bg-cyan-500',
  env: 'bg-teal-500',
  msg: 'bg-blue-500',
  wait: 'bg-muted-foreground/50',
  verify: 'bg-indigo-500',
  interrupt: 'bg-orange-500',
  resume: 'bg-lime-500',
  done: 'bg-emerald-500',
  fail: 'bg-red-500',
  decision: 'bg-fuchsia-500',
  recover: 'bg-yellow-500',
};

/** phase → 徽章描边色 */
const PHASE_TONE: Record<string, string> = {
  init: 'border-border',
  read: 'border-sky-500/40',
  write: 'border-amber-500/40',
  exec: 'border-violet-500/40',
  net: 'border-cyan-500/40',
  env: 'border-teal-500/40',
  msg: 'border-blue-500/40',
  wait: 'border-border',
  verify: 'border-indigo-500/40',
  interrupt: 'border-orange-500/50',
  resume: 'border-lime-500/40',
  done: 'border-emerald-500/50',
  fail: 'border-red-500/60',
  decision: 'border-fuchsia-500/40',
  recover: 'border-yellow-500/40',
};

const dayOf = (ts: string) => (ts || '').slice(0, 10);

export function TimelineView() {
  const { state, setPaused, setFilterMember, setFilterPhase, memberName } = usePanel();
  const { timeline, filters, paused, errors, members } = state;
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  // 时间正序（旧的在上、新的在下）
  const rows = useMemo(() => {
    const list = timeline.filter((entry) =>
      (!filters.member || entry.memberId === filters.member) &&
      (!filters.phase || entry.phase === filters.phase));
    return list.slice().sort((a, b) => {
      const ta = Date.parse(a.ts);
      const tb = Date.parse(b.ts);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });
  }, [timeline, filters.member, filters.phase]);

  /** 事件 → 成员，用于在行首展示该成员所用模型的厂商图标 */
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  /** 首次进入 / 切换团队时定位到最新一条 */
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    stickToBottom.current = true;
    node.scrollTop = node.scrollHeight;
  }, [state.teamId]);

  /** 新事件进来时，若本来就在底部则继续跟随 */
  useEffect(() => {
    const node = listRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [rows.length]);

  const onScroll = () => {
    const node = listRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  };

  return (
    <section className="relative space-y-3" data-view="timeline">
      <SectionHead
        title="时间线"
        meta={<MetaLine>
          {rows.length}/{timeline.length} 条事件
          {paused ? ' · 已暂停（实时更新冻结）' : ' · 按时间正序'}
        </MetaLine>}
        controls={
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Select value={filters.member || FILTER_ALL} onValueChange={(v) => setFilterMember(!v || v === FILTER_ALL ? '' : v)}>
              <SelectTrigger size="sm" className="w-36"><SelectValue>{filters.member ? (members.find((m) => m.id === filters.member)?.name || filters.member) : '全部成员'}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ALL}>全部成员</SelectItem>
                {members.map((m) => <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.phase || FILTER_ALL} onValueChange={(v) => setFilterPhase(!v || v === FILTER_ALL ? '' : v)}>
              <SelectTrigger size="sm" className="w-32"><SelectValue>{filters.phase || '全部 phase'}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ALL}>全部 phase</SelectItem>
                {PHASES.map((phase) => <SelectItem key={phase} value={phase}>{phase}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={paused ? 'default' : 'outline'}
              onClick={() => setPaused(!paused)}
            >
              {paused ? '继续' : '暂停'}
            </Button>
          </div>
        }
      />
      {errors.timeline && !timeline.length
        ? <EmptyState title="时间线加载失败" detail={errors.timeline} />
        : !timeline.length
          ? <EmptyState title="暂无时间线事件" />
          : !rows.length
            ? <EmptyState title="当前过滤条件下没有事件" detail="清空成员 / phase 过滤" />
            : (
              <div
                ref={listRef}
                onScroll={onScroll}
                className="max-h-[calc(100vh-13rem)] overflow-auto rounded-xl border bg-card/30"
              >
                <ol className="relative ms-[5.5rem] me-3 border-s border-border/70 py-2">
                  {rows.map((entry, index) => {
                    const prev = index > 0 ? rows[index - 1] : null;
                    const newDay = !prev || dayOf(prev.ts) !== dayOf(entry.ts);
                    return (
                      <TimelineRow
                        key={entry.id}
                        entry={entry}
                        newDay={newDay}
                        member={entry.memberId ? memberById.get(entry.memberId) : undefined}
                        memberName={memberName}
                      />
                    );
                  })}
                </ol>
              </div>
            )}
    </section>
  );
}

function TimelineRow({ entry, newDay, member, memberName }: {
  entry: TimelineEntry;
  newDay: boolean;
  member?: Member;
  memberName: (id?: string | null) => string;
}) {
  const tone = PHASE_DOT[safeToken(entry.phase)] ?? 'bg-muted-foreground/50';
  return (
    <>
      {newDay ? (
        <li className="relative -ms-px list-none py-2 ps-3">
          <span className="text-[11px] font-medium text-muted-foreground">{fmtDateTime(entry.ts).slice(0, 10)}</span>
        </li>
      ) : null}
      <li className="relative list-none py-1 ps-4 pe-2">
        <span
          aria-hidden="true"
          className={`absolute size-2 rounded-full ring-2 ring-background ${tone}`}
          style={{ insetInlineStart: -5, top: 9 }}
        />
        <time
          className="absolute top-[3px] text-right font-mono text-[11px] tabular-nums text-muted-foreground"
          style={{ insetInlineStart: '-5rem', width: '4.25rem' }}
          title={fmtDateTime(entry.ts)}
        >
          {fmtClockSec(entry.ts)}
        </time>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="flex min-w-0 shrink-0 items-center gap-1 text-foreground/75" title={member?.model ? `${memberName(entry.memberId)} · ${member.model}` : memberName(entry.memberId)}>
            {member ? modelAvatar(member.model, member.name, undefined, 13) : null}
            <span className="max-w-[9rem] truncate">{memberName(entry.memberId)}</span>
          </span>
          <Badge variant="outline" className={`shrink-0 text-[10px] ${PHASE_TONE[safeToken(entry.phase)] ?? 'border-border'}`}>
            {entry.phase || '—'}
          </Badge>
          <span className="min-w-0 truncate font-medium" title={entry.action || ''}>{entry.action || '—'}</span>
          {entry.target ? (
            <span className="min-w-0 truncate text-muted-foreground" title={entry.target}>· {entry.target}</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {entry.result ? <span className="min-w-0 truncate" title={entry.result}>result {entry.result}</span> : null}
          {entry.next ? <span className="min-w-0 truncate" title={entry.next}>next {entry.next}</span> : null}
          {entry.taskId ? <span className="min-w-0 truncate font-mono opacity-70" title={entry.taskId}>{entry.taskId}</span> : null}
        </div>
      </li>
    </>
  );
}

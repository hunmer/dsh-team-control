/**
 * 时间线 —— 单列竖向时间轴（行样式参考 agent-checkpoints 的卡片行）。
 * 一条竖线 + 行内白芯圆点，事件按时间正序逐行展开；hover 行浮起胶囊背景。
 * 所有事件同页纵向滚动。
 */
import { useEffect, useMemo, useRef } from 'react';
import { PHASES, usePanel } from '@/store';
import { fmtClockSec, fmtDateTime, safeToken } from '@/lib/format';
import type { Member, TimelineEntry } from '@/types';
import { Button } from '@/components/ui/button';
import { modelAvatar } from '@/components/ModelAvatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

const FILTER_ALL = '__all__';

/** phase → 圆点描边色（竖线上的节点；最新一条固定 primary 实心，见 tl-dot-head） */
const PHASE_RING: Record<string, string> = {
  init: 'border-foreground/35',
  read: 'border-sky-500/80',
  write: 'border-amber-500/80',
  exec: 'border-violet-500/80',
  net: 'border-cyan-500/80',
  env: 'border-teal-500/80',
  msg: 'border-blue-500/80',
  wait: 'border-foreground/35',
  verify: 'border-indigo-500/80',
  interrupt: 'border-orange-500/90',
  resume: 'border-lime-500/80',
  done: 'border-emerald-500/90',
  fail: 'border-red-500/90',
  decision: 'border-fuchsia-500/80',
  recover: 'border-yellow-600/80',
};

/** phase → 徽章软底色 chip（弱化底色 + 同系文字色） */
const PHASE_CHIP: Record<string, string> = {
  init: 'bg-foreground/[0.06] text-foreground/60',
  read: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  write: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  exec: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  net: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  env: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  msg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  wait: 'bg-foreground/[0.06] text-foreground/60',
  verify: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  interrupt: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  resume: 'bg-lime-500/10 text-lime-600 dark:text-lime-400',
  done: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  fail: 'bg-red-500/10 text-red-600 dark:text-red-400',
  decision: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
  recover: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
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
          <span className="tabular-nums">{rows.length}/{timeline.length}</span> 条事件
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
                className="max-h-[calc(100vh-13rem)] overflow-auto overscroll-contain rounded-xl bg-card
                  shadow-[0_0_0_0.5px_var(--color-border),0_1px_2px_-1px_rgb(0_0_0/0.07),0_1px_3px_0_rgb(0_0_0/0.05)]
                  dark:shadow-[0_0_0_0.5px_var(--color-border),0_2px_6px_-1px_rgb(0_0_0/0.4)]"
              >
                <ol className="tl-list relative ms-4 me-1 border-s border-border/60 py-1.5">
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
  const name = memberName(entry.memberId);
  const avatar = modelAvatar(member?.model, member?.name, undefined, 11);
  const chip = PHASE_CHIP[safeToken(entry.phase)] ?? PHASE_CHIP.init;
  const hasMeta = Boolean(entry.result || entry.next || entry.taskId);
  return (
    <>
      {newDay ? (
        <li className="tl-day sticky top-0 z-[2] -ms-px list-none bg-card/95 py-1.5 ps-3 backdrop-blur-sm">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground/90">{fmtDateTime(entry.ts).slice(0, 10)}</span>
        </li>
      ) : null}
      <li className="tl-row group relative list-none py-1 ps-4 pe-3">
        <span
          aria-hidden="true"
          className={`tl-dot absolute z-[1] size-[9px] rounded-full border-[1.5px] border bg-card ${PHASE_RING[safeToken(entry.phase)] ?? 'border-foreground/35'}`}
          style={{ insetInlineStart: -5.25, top: 9 }}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-card shadow-[0_0_0_0.5px_var(--color-border),0_1px_1px_-1px_rgb(0_0_0/0.09)]"
            title={member?.model ? `${name} · ${member.model}` : name}
          >
            {avatar ?? <span className="text-[9px] leading-none font-medium text-muted-foreground">{name.slice(0, 1)}</span>}
          </span>
          <span className="max-w-[9rem] shrink-0 truncate text-foreground/70" title={name}>{name}</span>
          <span className={`h-[18px] shrink-0 rounded-[5px] px-1.5 text-[11px] leading-[18px] font-medium ${chip}`}>
            {entry.phase || '—'}
          </span>
          <span className="min-w-0 truncate font-medium text-foreground/90" title={entry.action || ''}>{entry.action || '—'}</span>
          {entry.target ? (
            <span className="min-w-0 max-w-[38%] truncate text-muted-foreground/85" title={entry.target}>· {entry.target}</span>
          ) : null}
          <time
            className="ms-auto shrink-0 pl-3 font-mono text-[11px] tabular-nums text-muted-foreground/70"
            title={fmtDateTime(entry.ts)}
          >
            {fmtClockSec(entry.ts)}
          </time>
        </div>
        {hasMeta ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 ps-[26px] text-[11px] text-muted-foreground/75">
            {entry.result ? <span className="min-w-0 truncate" title={entry.result}>result {entry.result}</span> : null}
            {entry.next ? <span className="min-w-0 truncate" title={entry.next}>next {entry.next}</span> : null}
            {entry.taskId ? <span className="min-w-0 truncate font-mono opacity-60" title={entry.taskId}>{entry.taskId}</span> : null}
          </div>
        ) : null}
      </li>
    </>
  );
}

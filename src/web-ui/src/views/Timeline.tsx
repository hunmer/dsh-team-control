/**
 * 时间线 —— 使用 affectui agent-lanes 的泳道 UI 效果渲染。
 * 每个成员一条泳道；事件流按成员聚合成时间块：
 *   start = 该事件 ts，end = 同成员下一事件 ts（最新一条不设 end → 延伸到 now 呈现 Running）。
 * 窗口随真实时钟滑动；「暂停」冻结时钟（组件 now prop）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PHASES, usePanel } from '@/store';
import { fmtClock, truncate } from '@/lib/format';
import type { Member, TimelineEntry } from '@/types';
import { AgentLanes, type LaneAgent, type LaneTask, type LaneTaskStatus } from '@/components/agent-lanes/agent-lanes';
import { Badge } from '@/components/ui/badge';
import { modelAvatar } from '@/components/ModelAvatar';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import { safeToken, storeGet, storeSet } from '@/lib/format';

const MIN = 60_000;
const FILTER_ALL = '__all__';
const SPAN_MIN_MS = 2 * MIN;
const SPAN_MAX_MS = 7 * 1440 * MIN;

const SPAN_OPTIONS = [
  { value: '10m', label: '最近 10 分钟', ms: 10 * MIN },
  { value: '30m', label: '最近 30 分钟', ms: 30 * MIN },
  { value: '1h', label: '最近 1 小时', ms: 60 * MIN },
  { value: '6h', label: '最近 6 小时', ms: 360 * MIN },
  { value: '24h', label: '最近 24 小时', ms: 1440 * MIN },
  { value: 'all', label: '全部时间窗', ms: 0 },
] as const;

function statusOf(entry: TimelineEntry, open: boolean, member?: Member): LaneTaskStatus {
  if (/fail/i.test(String(entry.result || ''))) return 'failed';
  if (open) {
    if (member?.status === 'blocked') return 'waiting';
    if (member?.status === 'running') return 'running';
    return 'done'; // 成员已停：末块按已完成收尾
  }
  return 'done';
}

export function TimelineView() {
  const { state, setPaused, setFilterMember, setFilterPhase, memberName } = usePanel();
  const { timeline, filters, paused, errors, members } = state;
  const [spanKey, setSpanKey] = useState<string>('all');
  const [customSpan, setCustomSpan] = useState<number | null>(null);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [panMs, setPanMs] = useState(0); // 横向滚动：向左回看的时长
  const [, setClockTick] = useState(0);
  const [mode, setMode] = useState<'lanes' | 'list'>(() => (storeGet('dsh-team.panel.timeline.mode.v1') === 'list' ? 'list' : 'lanes'));
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const switchMode = (next: 'lanes' | 'list') => {
    setMode(next);
    storeSet('dsh-team.panel.timeline.mode.v1', next);
    if (next === 'lanes') setPanMs(0);
  };

  // 暂停 / 回看时需要自驱动时钟（组件只在 now===undefined 时自己走表）
  const clockDriven = paused || panMs > 0;
  useEffect(() => {
    if (!clockDriven) return;
    const id = window.setInterval(() => setClockTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [clockDriven]);

  const frozenNow = frozenAt ?? Date.now();
  // now 传给组件：实时（undefined）/ 暂停冻结 / 回看平移（now - pan）
  const now = clockDriven ? frozenNow - panMs : undefined;
  const nowMs = frozenNow - panMs;

  const lanes = useMemo(() => {
    const shownMembers = filters.member ? members.filter((m) => m.id === filters.member) : members;
    const agents: LaneAgent[] = shownMembers.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      model: [m.role, m.model].filter(Boolean).join(' · ') || undefined,
      avatar: modelAvatar(m.model, m.name, undefined, 16),
    }));
    const memberById = new Map(members.map((m) => [m.id, m]));

    // 每成员按序聚合事件块
    const byMember = new Map<string, TimelineEntry[]>();
    for (const entry of timeline) {
      if (!entry.memberId) continue;
      if (filters.member && entry.memberId !== filters.member) continue;
      if (filters.phase && entry.phase !== filters.phase) continue;
      if (!byMember.has(entry.memberId)) byMember.set(entry.memberId, []);
      byMember.get(entry.memberId)!.push(entry);
    }
    const tasks: LaneTask[] = [];
    for (const [memberId, entries] of byMember) {
      const sorted = entries.sort((a, b) => a.id - b.id);
      sorted.forEach((entry, index) => {
        const next = sorted[index + 1];
        const open = !next;
        const start = new Date(entry.ts).getTime();
        if (!Number.isFinite(start)) return;
        const endTs = next ? new Date(next.ts).getTime() : undefined;
        const status = statusOf(entry, open, memberById.get(memberId));
        tasks.push({
          id: String(entry.id),
          agentId: memberId,
          title: truncate([entry.action || entry.phase, entry.target].filter(Boolean).join(' · '), 40) || entry.phase,
          status,
          start,
          end: open && status === 'running' ? undefined : (endTs ?? Math.min(nowMs, start + 5_000)),
          ask: status === 'waiting' ? (memberById.get(memberId)?.blockers?.length ? '被阻塞：等待依赖 / 审批' : '被阻塞：等待依赖 / 审批') : undefined,
          summary: [
            `${fmtClock(entry.ts)} · phase ${entry.phase || '—'}`,
            entry.taskId ? `task ${entry.taskId}` : '',
            entry.result ? `result ${entry.result}` : '',
            entry.next ? `next ${entry.next}` : '',
          ].filter(Boolean),
          tools: [entry.phase?.slice(0, 2).toUpperCase() || '··'],
        });
      });
    }
    return { agents, tasks };
  }, [timeline, members, filters.member, filters.phase, nowMs]);

  const spanMs = useMemo(() => {
    if (spanKey === 'custom') {
      if (customSpan) return Math.max(SPAN_MIN_MS, Math.min(SPAN_MAX_MS, customSpan));
    }
    const option = SPAN_OPTIONS.find((o) => o.value === spanKey);
    if (option?.ms) return option.ms;
    const starts = lanes.tasks.map((t) => new Date(t.start).getTime()).filter(Number.isFinite);
    if (!starts.length) return 30 * MIN;
    return Math.max(5 * MIN, nowMs - Math.min(...starts) + 2 * MIN);
  }, [spanKey, customSpan, lanes.tasks, nowMs]);

  // 可回看的最大范围：最早事件之前停住
  const maxPanMs = useMemo(() => {
    const starts = lanes.tasks.map((t) => new Date(t.start).getTime()).filter(Number.isFinite);
    if (!starts.length) return 0;
    return Math.max(0, Date.now() - Math.min(...starts) + 2 * MIN);
  }, [lanes.tasks]);

  // 滚轮交互（需非被动监听才能阻止浏览器默认行为）：
  //   Ctrl + 滚轮 —— 以 0.5 分钟粒度缩放时间窗；
  //   横滑 / Shift+滚轮 / 直接滚轮 —— 横向滚动（回看历史），左滚看更早，右滚回最新。
  useEffect(() => {
    const node = lanesRef.current;
    if (!node) return;
    const zoomFactorPx = 0.35 * MIN; // 每 px 滚动折算的时间
    const onWheel = (event: WheelEvent) => {
      const horizontal = event.ctrlKey ? 0 : (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : (event.shiftKey ? event.deltaY : 0));
      if (event.ctrlKey) {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1 / 1.25 : 1.25;
        setCustomSpan((prev) => {
          const base = prev ?? spanMs;
          return Math.max(SPAN_MIN_MS, Math.min(SPAN_MAX_MS, Math.round((base * factor) / (0.5 * MIN)) * (0.5 * MIN)));
        });
        setSpanKey('custom');
        return;
      }
      if (!horizontal) return;
      event.preventDefault();
      setPanMs((prev) => Math.max(0, Math.min(maxPanMs, prev + horizontal * zoomFactorPx)));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [spanMs, maxPanMs]);

  const visibleCount = lanes.tasks.length;
  const spanMinutes = Math.round(spanMs / MIN);
  const panMinutes = Math.round(panMs / MIN);

  return (
    <section className="space-y-3" data-view="timeline">
      <SectionHead
        title="时间线"
        meta={<MetaLine>
          {mode === 'list'
            ? `${timeline.length}/2000 条事件`
            : `${timeline.length}/2000 条事件 · 聚合 ${visibleCount} 块 · 时间窗 ${spanMinutes}m`}
          {paused ? ' · 已暂停（窗口冻结）' : ''}
          {mode === 'lanes' && panMinutes > 0 ? ` · 回看中（−${panMinutes}m）` : ''}
        </MetaLine>}
        controls={
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <SegmentedControl aria-label="时间线展示模式">
              <SegmentedControlItem data-checked={mode === 'lanes' ? '' : undefined} onClick={() => switchMode('lanes')}>泳道</SegmentedControlItem>
              <SegmentedControlItem data-checked={mode === 'list' ? '' : undefined} onClick={() => switchMode('list')}>列表</SegmentedControlItem>
            </SegmentedControl>
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
            {mode === 'lanes' ? (
              <>
                <Select value={spanKey} onValueChange={(v) => setSpanKey((v ?? '30m') as typeof spanKey)}>
                  <SelectTrigger size="sm" className="w-32"><SelectValue>{spanKey === 'custom' ? `自定义 · ${spanMinutes}m` : SPAN_OPTIONS.find((o) => o.value === spanKey)?.label}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {SPAN_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                    {spanKey === 'custom' ? <SelectItem value="custom">自定义 · {spanMinutes}m</SelectItem> : null}
                  </SelectContent>
                </Select>
                <span className="hidden items-center gap-1 text-muted-foreground md:flex">
                  <Kbd>Ctrl</Kbd>+滚动缩放 · 横滑/Shift+滚动回看
                </span>
                {panMinutes > 0 ? (
                  <Button size="sm" variant="outline" onClick={() => setPanMs(0)}>回到最新</Button>
                ) : null}
              </>
            ) : null}
            <Button
              size="sm"
              variant={paused ? 'default' : 'outline'}
              onClick={() => { if (paused) setFrozenAt(null); else setFrozenAt(Date.now()); setPaused(!paused); }}
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
          : mode === 'list'
            ? <TimelineGrid entries={timeline} filters={filters} memberName={memberName} />
            : !lanes.agents.length
              ? <EmptyState title="当前过滤条件下没有泳道" detail="清空成员过滤后即可看到成员泳道。" />
              : (
                <div className="space-y-2">
                  <div ref={lanesRef} className="ui-alc-zoom">
                    <AgentLanes agents={lanes.agents} tasks={lanes.tasks} span={spanMs} now={now} title="成员泳道" />
                  </div>
                  <PanScrollbar
                    total={spanMs + maxPanMs}
                    viewport={spanMs}
                    offset={maxPanMs - panMs} // 窗口左端相对最早时间的位置
                    onPan={(nextOffset) => setPanMs(Math.max(0, Math.min(maxPanMs, maxPanMs - nextOffset)))}
                  />
                </div>
              )}
    </section>
  );
}

/** 原网格列表视图：time / member / phase / action / target / result / next。 */
const PHASE_TONE: Record<string, string> = {
  init: 'border-border', read: 'border-sky-500/40', write: 'border-amber-500/40', exec: 'border-violet-500/40',
  net: 'border-cyan-500/40', env: 'border-teal-500/40', msg: 'border-blue-500/40', wait: 'border-border',
  verify: 'border-indigo-500/40', interrupt: 'border-orange-500/50', resume: 'border-lime-500/40',
  done: 'border-emerald-500/50', fail: 'border-red-500/60', decision: 'border-fuchsia-500/40', recover: 'border-yellow-500/40',
};

function TimelineGrid({ entries, filters, memberName }: {
  entries: TimelineEntry[];
  filters: { member: string; phase: string };
  memberName: (id?: string | null) => string;
}) {
  const visible = entries.filter((entry) =>
    (!filters.member || entry.memberId === filters.member) &&
    (!filters.phase || entry.phase === filters.phase));
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-[7.5rem_6rem_5.5rem_1fr] gap-2 border-b bg-card/60 px-2 py-1.5 text-[11px] font-medium text-muted-foreground md:grid-cols-[7.5rem_6rem_5.5rem_1fr_1fr_10rem_10rem]">
        <span>time</span><span>member</span><span>phase</span><span>action</span>
        <span className="hidden md:block">target</span><span className="hidden md:block">result</span><span className="hidden md:block">next</span>
      </div>
      <div className="max-h-[60vh] overflow-auto">
        {visible.length ? visible.map((entry) => (
          <div key={entry.id} className="grid grid-cols-[7.5rem_6rem_5.5rem_1fr] items-center gap-2 rounded px-2 py-1 text-xs md:grid-cols-[7.5rem_6rem_5.5rem_1fr_1fr_10rem_10rem]">
            <span className="font-mono text-muted-foreground">{fmtClock(entry.ts)}</span>
            <span className="truncate" title={entry.memberId || ''}>{memberName(entry.memberId)}</span>
            <span>
              <Badge variant="outline" className={`text-[10px] ${PHASE_TONE[safeToken(entry.phase)] ?? 'border-border'}`}>{entry.phase || '?'}</Badge>
            </span>
            <span className="truncate" title={entry.action || ''}>{entry.action || '—'}</span>
            <span className="hidden truncate text-muted-foreground md:block" title={entry.target || ''}>{entry.target || '—'}</span>
            <span className="hidden truncate text-muted-foreground md:block" title={entry.result || ''}>{entry.result || '—'}</span>
            <span className="hidden truncate text-muted-foreground/80 md:block" title={entry.next || ''}>{entry.next || '—'}</span>
          </div>
        )) : (
          <div className="p-6">
            <EmptyState
              title={entries.length ? '当前过滤条件下没有事件' : '暂无时间线事件'}
              detail={entries.length ? '清空成员 / phase 过滤' : '等待成员事件'}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** 横向滚动条：thumb 宽度 = 视窗占比，位置 = 当前窗口；可点击跳转 / 拖拽平移。 */
function PanScrollbar({ total, viewport, offset, onPan }: { total: number; viewport: number; offset: number; onPan: (offset: number) => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  if (total <= 0 || viewport >= total) {
    return <div className="h-4" aria-hidden="true" />; // 全部内容都在窗口内：留白占位
  }
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const thumbPct = clamp01(viewport / total) * 100;
  const leftPct = clamp01(offset / (total - viewport)) * (100 - thumbPct);

  const panFromEvent = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = clamp01((clientX - rect.left) / rect.width);
    // 点击/拖拽位置对应 thumb 中心
    onPan(ratio * (total - viewport) - viewport / 2);
  };

  return (
    <div
      ref={trackRef}
      className="group relative h-4 cursor-pointer select-none"
      role="scrollbar"
      aria-orientation="horizontal"
      aria-label="时间线横向滚动"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        panFromEvent(event.clientX);
      }}
      onPointerMove={(event) => { if (dragging.current) panFromEvent(event.clientX); }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-border/70" />
      <div
        className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full border border-border bg-muted-foreground/45 transition-[background-color] group-hover:bg-muted-foreground/70"
        style={{ left: `${leftPct}%`, width: `${Math.max(thumbPct, 4)}%` }}
      />
    </div>
  );
}

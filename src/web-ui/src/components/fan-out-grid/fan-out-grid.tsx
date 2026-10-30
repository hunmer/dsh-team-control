/**
 * Fan-out Grid（cossui 版）—— 由 affectUI fan-out-grid 移植。
 * 原组件展示「一个 agent 把大任务派给很多 worker，每个任务一格」；这里换成语义相同的
 * 用量网格：**每个格子代表一份固定额度的 token**，格子按成员的累计用量自动增加，
 * 左下角图例从「任务状态」改为「每个颜色 = 一个成员」，展示头像 + tokens + 花费。
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { FAN_OUT_GRID_CSS } from './fan-out-grid-css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FanoutMember {
  id: string;
  name: string;
  /** 累计 token 数（输入 + 输出） */
  tokens: number;
  /** 累计花费 */
  cost: number;
  /** 头像；不传则用名字首字母 */
  icon?: ReactNode;
  /** 悬浮时追加的一行成员明细（例如模型 + 上下文窗口占用），不同成员应不同 */
  detail?: string;
}

/** 一次 LLM 调用的切片；按时间顺序排列时，每个切片独立成格，格子因此能读出「这一刻发生了什么」。 */
export interface FanoutSlice {
  memberId: string;
  /** 本次调用消耗的 tokens（输入 + 输出），用于切分格子 */
  tokens: number;
  /** 发生时间（epoch ms） */
  at?: number;
  /** 模型名或说明 */
  note?: string;
  inTokens?: number;
  outTokens?: number;
  cost?: number;
}

export interface MemberFanoutGridProps {
  members: FanoutMember[];
  /** 按时间顺序的调用切片；传了就按时间铺格子，不传则按成员成块铺 */
  slices?: FanoutSlice[];
  /** 标题，默认「成员总览」 */
  title?: string;
  /** 标题右侧的说明，默认「全部成员累计」 */
  job?: string;
  /** 每格代表的 token 数；不传则按总量自适应 */
  quantum?: number;
  /** 网格格子上限，默认 360（超出后自动放大每格额度） */
  maxCells?: number;
  formatCost?: (amount: number) => string;
  /** 选中成员（点格子或点图例），null 表示取消 */
  onSelect?: (member: FanoutMember | null) => void;
  icon?: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 每格 token 额度的候选阶梯：取第一个让格子数不超过上限的值。 */
const QUANTUM_LADDER = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

const fmtDollars = (amount: number): string => {
  if (amount === 0) return '$0';
  if (amount < 0.001) return '<$0.001';
  if (amount < 0.01) return `$${amount.toFixed(3)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString('en-US')}`;
};

const fmtTokens = (n: number): string => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e5) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

/** 第 index 个成员用的图表色（coss 主题的 --chart-1..5 循环）。 */
const colorVar = (index: number): string => `var(--chart-${(index % 5) + 1})`;

const memberColorStyle = (index: number): CSSProperties =>
  ({
    '--k-bg': `color-mix(in oklab, ${colorVar(index)} 24%, transparent)`,
    '--k-edge': `color-mix(in oklab, ${colorVar(index)} 55%, transparent)`,
    '--k-ink': colorVar(index),
  }) as CSSProperties;

const FanOutMarkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="3" cy="8" r="1.9" fill="currentColor" />
    <rect x="10.2" y="1.6" width="3.6" height="3.6" rx="1" fill="currentColor" opacity="0.9" />
    <rect x="10.2" y="6.2" width="3.6" height="3.6" rx="1" fill="currentColor" opacity="0.6" />
    <rect x="10.2" y="10.8" width="3.6" height="3.6" rx="1" fill="currentColor" opacity="0.3" />
    <path
      d="M4.9 8H7c.6 0 .9-.3 1-.9l.4-2.4c.1-.6.4-.9 1-.9h.6M4.9 8h5.1M4.9 8H7c.6 0 .9.3 1 .9l.4 2.4c.1.6.4.9 1 .9h.6"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------

interface CellProps {
  i: number;
  bg: string;
  edge: string;
  ink: string;
  dim: boolean;
  on: boolean;
  pinned: boolean;
  setRef: (i: number, el: HTMLSpanElement | null) => void;
  onEnter: (i: number) => void;
  onPick: (i: number) => void;
}

const Cell = memo(function Cell({ i, bg, edge, ink, dim, on, pinned, setRef, onEnter, onPick }: CellProps) {
  return (
    <span
      ref={(el) => setRef(i, el)}
      className="ui-fogc__cell"
      data-dim={dim ? '' : undefined}
      data-on={on ? '' : undefined}
      data-pinned={pinned ? '' : undefined}
      style={{ '--k-bg': bg, '--k-edge': edge, '--k-ink': ink, '--i': i, '--d': Math.min(i, 240) } as CSSProperties}
      onMouseEnter={() => onEnter(i)}
      onClick={() => onPick(i)}
    />
  );
});

// ---------------------------------------------------------------------------
// MemberFanoutGrid
// ---------------------------------------------------------------------------

/** 一个格子：要么属于某次调用（slices 模式），要么属于某成员的累计用量。 */
interface GridCell {
  key: string;
  memberId: string;
  color: number;
  /** 该成员（或该次调用）内的第几格 */
  k: number;
  slice?: FanoutSlice;
  sliceCells?: number;
}

export function MemberFanoutGrid({
  members,
  slices,
  title = '成员总览',
  job = '全部成员累计',
  quantum,
  maxCells = 360,
  formatCost = fmtDollars,
  onSelect,
  icon,
  className,
}: MemberFanoutGridProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cellEls = useRef<Array<HTMLSpanElement | null>>([]);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [filterId, setFilterId] = useState<string | null>(null);

  // --- 排序 + 每格额度 + 格子清单 -----------------------------------------
  const { sorted, totalTokens, totalCost } = useMemo(() => {
    const list = [...members].sort((a, b) => b.tokens - a.tokens);
    return {
      sorted: list,
      totalTokens: list.reduce((sum, m) => sum + Math.max(0, m.tokens), 0),
      totalCost: list.reduce((sum, m) => sum + Math.max(0, m.cost), 0),
    };
  }, [members]);

  const memberById = useMemo(() => new Map(sorted.map((m) => [m.id, m])), [sorted]);
  const indexById = useMemo(() => new Map(sorted.map((m, i) => [m.id, i])), [sorted]);

  /** slices 的总量可能和成员累计不一致（只统计到本次 trace 窗口），取大者决定每格额度。 */
  const sliceTokens = useMemo(() => (slices ?? []).reduce((sum, s) => sum + Math.max(0, s.tokens), 0), [slices]);

  const step = useMemo(() => {
    if (quantum && quantum > 0) return quantum;
    const total = Math.max(totalTokens, sliceTokens);
    return QUANTUM_LADDER.find((q) => total / q <= Math.max(1, maxCells)) ?? QUANTUM_LADDER[QUANTUM_LADDER.length - 1];
  }, [quantum, totalTokens, sliceTokens, maxCells]);

  /**
   * 格子清单：有 slices 就按时间顺序铺——每次调用独占若干格（至少一格），
   * 不同成员的格子因此交错出现；没有 slices 则退回「一个成员一段」的累计视图。
   */
  const cells = useMemo<GridCell[]>(() => {
    const out: GridCell[] = [];
    if (slices && slices.length) {
      slices.forEach((slice, si) => {
        const n = Math.max(1, Math.ceil(Math.max(0, slice.tokens) / step));
        for (let k = 0; k < n && out.length < 1200; k++) {
          out.push({
            key: `${slice.memberId}#${si}#${k}`,
            memberId: slice.memberId,
            color: indexById.get(slice.memberId) ?? 0,
            k,
            slice,
            sliceCells: n,
          });
        }
      });
      return out;
    }
    sorted.forEach((member, ci) => {
      const n = Math.max(1, Math.ceil(Math.max(0, member.tokens) / step));
      const count = member.tokens > 0 || members.length <= 24 ? n : 0;
      for (let k = 0; k < count && out.length < 1200; k++) out.push({ key: `${member.id}#${k}`, memberId: member.id, color: ci, k });
    });
    return out;
  }, [slices, sorted, step, members.length, indexById]);

  const pinnedIdx = pinnedKey ? cells.findIndex((c) => c.key === pinnedKey) : -1;
  const shownIdx = pinnedIdx >= 0 ? pinnedIdx : hoverIdx;
  const shownCell = shownIdx !== null && shownIdx >= 0 ? cells[shownIdx] : undefined;
  const shown = shownCell ? memberById.get(shownCell.memberId) : undefined;

  const pick = (idx: number | null) => {
    const cell = idx === null ? undefined : cells[idx];
    const key = cell && cell.key !== pinnedKey ? cell.key : null;
    setPinnedKey(key);
    onSelect?.(key && cell ? memberById.get(cell.memberId) ?? null : null);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const stablePick = useCallback((idx: number) => pickRef.current(idx), []);
  const setCellRef = useCallback((i: number, el: HTMLSpanElement | null) => {
    cellEls.current[i] = el;
  }, []);

  // --- tooltip 定位（沿用原组件的「靠近顶部就翻到下方」逻辑） ----------------
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const panel = panelRef.current;
    const cell = shownIdx === null ? null : cellEls.current[shownIdx];
    if (!tip || !panel || !cell) return;
    const panelRect = panel.getBoundingClientRect();
    const scale = panel.offsetWidth ? panelRect.width / panel.offsetWidth : 1;
    const cellRect = cell.getBoundingClientRect();
    const cellCx = (cellRect.left + cellRect.width / 2 - panelRect.left) / scale;
    const cellTop = (cellRect.top - panelRect.top) / scale;
    const cellBottom = (cellRect.bottom - panelRect.top) / scale;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const below = cellTop - tipH - 10 < 4;
    const left = Math.max(8, Math.min(cellCx - tipW / 2, panel.offsetWidth - tipW - 8));
    // 纵向也夹在面板内：面板底部已预留空白，卡片向下展开时不会越界把外层撑出滚动条
    const wanted = below ? cellBottom + 10 : cellTop - tipH - 10;
    const top = Math.max(4, Math.min(wanted, panel.offsetHeight - tipH - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.setProperty('--x', `${cellCx - left}px`);
    tip.dataset.side = below ? 'below' : 'above';
  });

  const styleProps = {
    href: 'ui-fan-out-grid-clean',
    precedence: 'default',
    children: FAN_OUT_GRID_CSS,
  } as unknown as HTMLAttributes<HTMLStyleElement>;

  const announce = slices?.length
    ? `共 ${sorted.length} 个成员、${slices.length} 次调用，按时间顺序排列，累计 ${fmtInt(totalTokens)} tokens，花费 ${formatCost(totalCost)}。每格约 ${fmtInt(step)} tokens。`
    : `共 ${sorted.length} 个成员，累计 ${fmtInt(totalTokens)} tokens，花费 ${formatCost(totalCost)}。每格约 ${fmtInt(step)} tokens。`;

  // 悬浮格子的区间信息：slices 模式下区间落在「本次调用」内部，否则落在成员的累计用量里。
  const shownSlice = shownCell?.slice;
  const shownName = shown?.name ?? shownCell?.memberId ?? '';
  const shownCellCount = shownSlice
    ? Math.max(1, shownCell?.sliceCells ?? 1)
    : shown
      ? Math.max(1, Math.ceil(Math.max(0, shown.tokens) / step))
      : 0;
  const cellFrom = shownCell ? shownCell.k * step : 0;
  const cellTo = shownCell ? Math.min(shownSlice ? shownSlice.tokens : (shown?.tokens ?? 0), (shownCell.k + 1) * step) : 0;
  const shownShare = shown && totalTokens > 0 ? (shown.tokens / totalTokens) * 100 : 0;
  const callShare = shownSlice && totalTokens > 0 ? (shownSlice.tokens / totalTokens) * 100 : 0;

  return (
    <div className={['ui-fogc', className].filter(Boolean).join(' ')}>
      <style {...styleProps} />
      <header className="ui-fogc__bar">
        <span className="ui-fogc__mark">{icon ?? <FanOutMarkIcon />}</span>
        <span className="ui-fogc__title" title={title}>
          {title}
        </span>
        <span className="ui-fogc__job" dir="auto" title={job}>
          {job}
        </span>
        <span className="ui-fogc__sum">
          <span>
            <b>{fmtTokens(totalTokens)}</b> tokens
          </span>
          <span>
            <b>{formatCost(totalCost)}</b>
          </span>
          <span className="ui-fogc__hint">每格 ≈ {fmtTokens(step)}</span>
        </span>
      </header>
      <div ref={panelRef} className="ui-fogc__panel">
        <div
          className="ui-fogc__grid"
          role="group"
          aria-label={`${sorted.length} 个成员的用量，每格约 ${fmtInt(step)} tokens`}
          onMouseLeave={() => setHoverIdx(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setPinnedKey(null);
              onSelect?.(null);
            }
          }}
        >
          {cells.map((cell, i) => {
            const color = memberColorStyle(cell.color);
            return (
              <Cell
                key={cell.key}
                i={i}
                bg={String((color as Record<string, string>)['--k-bg'])}
                edge={String((color as Record<string, string>)['--k-edge'])}
                ink={String((color as Record<string, string>)['--k-ink'])}
                dim={!!filterId && filterId !== cell.memberId}
                on={shownIdx === i}
                pinned={pinnedKey === cell.key}
                setRef={setCellRef}
                onEnter={setHoverIdx}
                onPick={stablePick}
              />
            );
          })}
        </div>
        {/* 左下角：每个颜色 = 一个成员（头像 + tokens + 花费），点击可只看该成员 */}
        <div className="ui-fogc__foot">
          <div className="ui-fogc__legend" role="group" aria-label="按成员筛选">
            {sorted.map((member) => {
              const idx = indexById.get(member.id) ?? 0;
              return (
                <button
                  key={member.id}
                  type="button"
                  className="ui-fogc__key"
                  style={memberColorStyle(idx)}
                  aria-pressed={filterId === member.id}
                  data-off={filterId && filterId !== member.id ? '' : undefined}
                  onClick={() => setFilterId((cur) => (cur === member.id ? null : member.id))}
                >
                  <span className="ui-fogc__ava" aria-hidden="true">
                    {member.icon ?? member.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="ui-fogc__name">{member.name}</span>
                  <span className="ui-fogc__tok">{fmtTokens(member.tokens)}</span>
                  <span className="ui-fogc__cost">{formatCost(member.cost)}</span>
                </button>
              );
            })}
          </div>
        </div>
        {shownCell && (
          <div
            key={shownCell.key}
            ref={tipRef}
            role="tooltip"
            className="ui-fogc__tip"
            style={memberColorStyle(indexById.get(shownCell.memberId) ?? 0)}
          >
            <span className="ui-fogc__tip-head">
              <span className="ui-fogc__tip-label" dir="auto">
                {shownName}
              </span>
              <span className="ui-fogc__pill">{fmtTokens(shownSlice ? shownSlice.tokens : (shown?.tokens ?? 0))}</span>
            </span>
            {shownSlice ? (
              <>
                <span className="ui-fogc__tip-meta">
                  第 {shownCell.k + 1} / {shownCellCount} 格 · 本次 {fmtTokens(cellFrom)}–{fmtTokens(cellTo)} tokens
                </span>
                <span className="ui-fogc__tip-meta">
                  {shownSlice.note ?? '模型未记录'} · {shownSlice.at ? fmtClock(shownSlice.at) : '时间未记录'}
                </span>
                <span className="ui-fogc__tip-meta">
                  输入 {fmtInt(shownSlice.inTokens ?? 0)} · 输出 {fmtInt(shownSlice.outTokens ?? 0)} · 花费{' '}
                  {formatCost(shownSlice.cost ?? 0)} · 占总量 {callShare.toFixed(1)}%
                </span>
                {shown ? (
                  <span className="ui-fogc__tip-meta">
                    成员累计 {fmtInt(shown.tokens)} tokens · {formatCost(shown.cost)} · 占总量 {shownShare.toFixed(1)}%
                  </span>
                ) : null}
              </>
            ) : (
              <>
                {shown?.detail ? <span className="ui-fogc__tip-meta">{shown.detail}</span> : null}
                <span className="ui-fogc__tip-meta">
                  第 {shownCell.k + 1} / {shownCellCount} 格 · {fmtTokens(cellFrom)}–{fmtTokens(cellTo)} tokens
                </span>
                <span className="ui-fogc__tip-meta">
                  累计 {fmtInt(shown?.tokens ?? 0)} tokens · {formatCost(shown?.cost ?? 0)} · 占总量{' '}
                  {shownShare.toFixed(1)}%
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="ui-fogc__sr" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
    </div>
  );
}

export default MemberFanoutGrid;

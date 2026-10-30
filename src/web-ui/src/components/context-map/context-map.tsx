/**
 * ContextMap — 一个 agent 的上下文窗口被什么填满：活体 treemap。
 *
 * 系统提示、工具、记忆、每个文件、对话与工具结果都是会滑动的 tile，空闲空间用斜线表示；
 * 压缩（compaction）把旧轮次挤成摘要，可以在 before / after 之间对比。
 *
 * 从 affectUI "clean" 风格（https://www.affectui.com/components/context-map）1:1 移植：
 * 布局、动画、a11y 逻辑保持原样，基础控件换成 coss ui（Menu / SegmentedControl / Spinner / Button）。
 * 品牌 logo 不由组件内置，用 `icon` 传入。
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { CONTEXT_MAP_CSS } from "./context-map-css";

/* ------------------------------------------------------------------ types */

export type ContextBlockKind = "system" | "tools" | "memory" | "file" | "chat" | "result" | "summary";

export interface ContextItem {
  label: string;
  icon?: ReactNode;
}

export interface ContextBlock {
  /** 稳定 id：id 让 tile 停在原位并平滑滑动 */
  id: string;
  label: string;
  /** 决定 tile 的配色 */
  kind: ContextBlockKind;
  tokens: number;
  /** tooltip 里 meta 下面的一行说明 */
  detail?: string;
  /** tile 上的小图标 */
  icon?: ReactNode;
  /** hover 时列出的明细（label + icon） */
  items?: ContextItem[];
}

export interface ContextAgent {
  id: string;
  name: string;
  model?: string;
  icon?: ReactNode;
  /** 这个 agent 的窗口大小 — 选中时覆盖 `limit` */
  limit: number;
}

export type CompactionFate = "kept" | "summarized" | "dropped";

export interface ContextCompaction {
  /** 最近一次压缩之前的 blocks */
  before: ContextBlock[];
  /** 其中哪些被折进摘要 */
  summarized?: string[];
  /** 其中哪些被直接丢掉 */
  dropped?: string[];
  /** `blocks` 里那个摘要块的 id */
  summary?: string;
}

export interface ContextMapProps {
  /** 上下文的每一部分，按 tile 排列顺序给出 */
  blocks: ContextBlock[];
  /** 上下文窗口大小（tokens） */
  limit: number;
  /** 标题旁的模型名与厂商 logo */
  model?: string;
  modelIcon?: ReactNode;
  /** 可切换的 agent */
  agents?: ContextAgent[];
  agent?: string;
  onAgentChange?: (id: string) => void;
  compaction?: ContextCompaction | null;
  /** 受控：展示压缩的哪一侧 */
  view?: "before" | "after";
  onViewChange?: (view: "before" | "after") => void;
  /** 顶部的一行短状态，如「Compacting」 */
  status?: string;
  /** 点了某个 tile — 空闲空间是 null */
  onSelect?: (block: ContextBlock | null) => void;
  title?: string;
  className?: string;
}

/* --------------------------------------------------------------- constants */

const FREE_ID = "__free";

const KIND_LABEL: Record<ContextBlockKind, string> = {
  system: "System prompt",
  tools: "Tools",
  memory: "Memory",
  file: "File",
  chat: "Chat",
  result: "Tool result",
  summary: "Summary",
};

const FATE_SUFFIX: Record<CompactionFate, string> = {
  kept: "· kept",
  summarized: "· summarized",
  dropped: "· dropped",
};

/* --------------------------------------------------------------- helpers */

/** 最近可滚动祖先的 rect — tooltip 不出这个框 */
const clipRect = (el: Element): { left: number; top: number; right: number; bottom: number } => {
  let parent: HTMLElement | null = el.parentElement;
  while (parent && parent !== document.body && getComputedStyle(parent).overflow === "visible") {
    parent = parent.parentElement;
  }
  return parent && parent !== document.body
    ? parent.getBoundingClientRect()
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
};

/** 1234 → "1.2k"，128000 → "128k"，780 → "780" */
const fmtTokens = (v: number): string =>
  v >= 1e5 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(v));

interface SliceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 二分「按值的一半切分」的 treemap：每步在最接近总价值一半的位置切分，
 * 沿 rect 的长边切 — 保持给定顺序。
 */
const sliceTreemap = (items: { id: string; value: number }[], rect: SliceRect, out: Map<string, SliceRect>): void => {
  if (!items.length) return;
  if (items.length === 1) {
    out.set(items[0].id, rect);
    return;
  }
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let acc = 0;
  let split = 1;
  for (let i = 0; i < items.length - 1 && ((acc += items[i].value), (split = i + 1), !(acc >= total / 2)); i++);
  const frac = items.slice(0, split).reduce((s, i) => s + i.value, 0) / total;
  if (rect.w >= rect.h) {
    const w = rect.w * frac;
    sliceTreemap(items.slice(0, split), { x: rect.x, y: rect.y, w, h: rect.h }, out);
    sliceTreemap(items.slice(split), { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h }, out);
  } else {
    const h = rect.h * frac;
    sliceTreemap(items.slice(0, split), { x: rect.x, y: rect.y, w: rect.w, h }, out);
    sliceTreemap(items.slice(split), { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h }, out);
  }
};

/* ------------------------------------------------------------- UI icons */

const CheckIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m2.5 6.3 2.3 2.2 4.7-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m3.2 3.2 5.6 5.6M8.8 3.2 3.2 8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const SqueezeIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path
      d="M6 1.5v3.2M4.4 3.3 6 4.9l1.6-1.6M6 10.5V7.3M4.4 8.7 6 7.1l1.6 1.6M2 6h8"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const FATE_ICON: Record<CompactionFate, () => ReactNode> = {
  kept: CheckIcon,
  summarized: SqueezeIcon,
  dropped: XIcon,
};

const MarkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="1.8" y="1.8" width="7" height="12.4" rx="1.6" fill="currentColor" />
    <rect x="10" y="1.8" width="4.2" height="6" rx="1.4" fill="currentColor" opacity="0.6" />
    <rect x="10" y="9" width="4.2" height="5.2" rx="1.4" fill="currentColor" opacity="0.3" />
  </svg>
);

const ChevronIcon = () => (
  <svg className="ui-cmc__chev" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m3.5 4.75 2.5 2.5 2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ------------------------------------------------------------ roll text */

/** key 变化时向上滚动的文本：旧行滑出，新行从下方进入。 */
function RollText({ k, children }: { k: string; children: ReactNode }) {
  const currentRef = useRef<{ k: string; node: ReactNode }>({ k, node: children });
  const [leaving, setLeaving] = useState<{ k: string; node: ReactNode } | null>(null);

  if (currentRef.current.k !== k) {
    const old = currentRef.current;
    currentRef.current = { k, node: children };
    setLeaving(old);
  } else {
    currentRef.current.node = children;
  }

  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(null), 360);
    return () => clearTimeout(id);
  }, [leaving]);

  return (
    <span className="ui-cmc__roll">
      {leaving ? (
        <span className="ui-cmc__roll-out" aria-hidden="true" key={`out-${leaving.k}`}>
          {leaving.node}
        </span>
      ) : null}
      <span className="ui-cmc__roll-in" data-rolling={leaving ? "" : undefined} key={k}>
        {children}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------- component */

export function ContextMap({
  blocks,
  limit,
  model,
  modelIcon,
  agents,
  agent,
  onAgentChange,
  compaction,
  view: viewProp,
  onViewChange,
  status,
  onSelect,
  title = "Context",
  className,
}: ContextMapProps) {
  const uid = useId();
  const currentAgent = agents?.find((a) => a.id === agent) ?? agents?.[0];
  const effLimit = currentAgent?.limit ?? limit;

  /* -------------------------------------------------- hover and pin */

  const areaRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  useEffect(() => {
    if (!pinnedId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPinnedId(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pinnedId]);

  /* ------------------------------------------------ before | after */

  const [viewState, setViewState] = useState<"before" | "after">("after");
  const view = compaction ? (viewProp ?? viewState) : "after";
  const setView = (v: "before" | "after") => {
    setViewState(v);
    onViewChange?.(v);
  };
  useEffect(() => setViewState("after"), [compaction]);

  const fateOf = (id: string): CompactionFate =>
    compaction?.summarized?.includes(id) ? "summarized" : compaction?.dropped?.includes(id) ? "dropped" : "kept";

  const shown = view === "before" && compaction ? compaction.before : blocks;

  /* --------------------------------------------------- measure area */

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ------------------------------------------------ token accounting */

  const used = shown.reduce((s, b) => s + Math.max(0, b.tokens), 0);
  const freeTokens = Math.max(0, effLimit - used);
  const fill = used / effLimit;
  const level = fill >= 0.95 ? "full" : fill >= 0.8 ? "high" : undefined;

  // blocks by id — 保留旧条目，切换视图时 tooltip 不会闪空
  const byId = useRef(new Map<string, ContextBlock>());
  for (const b of shown) byId.current.set(b.id, b);

  /* -------------------------------------------- stable tile order */

  const orderRef = useRef<string[]>([]);
  const liveIds = shown.filter((b) => b.tokens > 0).map((b) => b.id);
  {
    const order = [...orderRef.current];
    liveIds.forEach((id, i) => {
      if (order.includes(id)) return;
      const anchor = liveIds.slice(0, i).reverse().find((prev) => order.includes(prev));
      order.splice(anchor ? order.indexOf(anchor) + 1 : 0, 0, id);
    });
    orderRef.current = order;
  }

  /* ------------------------------------------------ glide animation */

  const targets = new Map<string, number>([
    ...orderRef.current.map((id) => [id, Math.max(0, shown.find((b) => b.id === id)?.tokens ?? 0)] as const),
    [FREE_ID, freeTokens] as const,
  ]);

  const animSizes = useRef(new Map<string, number>());
  const [, forceTick] = useState(0);
  const lastFrameTs = useRef(0);

  // 每个 id 各自指数逼近；归零的 id 离开顺序表
  useEffect(() => {
    let raf = 0;
    const step = (now: number) => {
      const dt = lastFrameTs.current ? Math.min(64, Math.max(0, now - lastFrameTs.current)) : 16;
      lastFrameTs.current = now;
      const alpha = 1 - Math.exp(-dt / 110);
      let moving = false;
      for (const [id, target] of targets) {
        const cur = animSizes.current.get(id) ?? 0;
        const next = Math.abs(target - cur) < 1 ? target : cur + (target - cur) * alpha;
        if (next !== target) moving = true;
        animSizes.current.set(id, next);
      }
      for (const id of [...animSizes.current.keys()]) {
        if (targets.has(id)) {
          if (id !== FREE_ID && (targets.get(id) ?? 0) === 0 && (animSizes.current.get(id) ?? 0) === 0) {
            orderRef.current = orderRef.current.filter((o) => o !== id);
          }
        } else animSizes.current.delete(id);
      }
      forceTick((n) => n + 1);
      if (moving) raf = requestAnimationFrame(step);
      else lastFrameTs.current = 0;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });

  /* ------------------------------------------------------ treemap */

  const layoutItems = [...orderRef.current, FREE_ID]
    .map((id) => ({ id, value: animSizes.current.get(id) ?? 0 }))
    .filter((i) => i.value > 0.5);
  const rects = new Map<string, SliceRect>();
  if (size.w && size.h) sliceTreemap(layoutItems, { x: 3, y: 3, w: size.w - 6, h: size.h - 6 }, rects);

  // 被 pin 的 tile 离开地图时自动松手
  if (pinnedId && !orderRef.current.includes(pinnedId)) setPinnedId(null);

  const activeId = hoverId && hoverId !== FREE_ID ? hoverId : pinnedId;
  const activeBlock = activeId ? (byId.current.get(activeId) ?? null) : null;

  /* --------------------------------------------- tooltip placement */

  const tipRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const area = areaRef.current;
    const rect = activeId ? rects.get(activeId) : undefined;
    if (!tip || !area || !rect) return;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const areaBox = area.getBoundingClientRect();
    const clip = clipRect(area);
    const bounds = {
      l: clip.left - areaBox.left + 8,
      t: clip.top - areaBox.top + 8,
      r: clip.right - areaBox.left - 8,
      b: clip.bottom - areaBox.top - 8,
    };
    const left = Math.max(bounds.l, Math.min(rect.x + rect.w / 2 - tw / 2, bounds.r - tw));
    const above = rect.y - th - 8;
    const below = rect.y + rect.h + 8;
    const top =
      above >= bounds.t ? above : below + th <= bounds.b ? below : Math.max(bounds.t, Math.min(rect.y + 8, bounds.b - th));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });

  /* -------------------------------------------------------- render */

  return (
    <div className={["ui-cmc", className].filter(Boolean).join(" ")}>
      {/* React 19 hoists once per document */}
      <style href="ui-context-map-clean" precedence="default">
        {CONTEXT_MAP_CSS}
      </style>
      <header className="ui-cmc__bar">
        <span className="ui-cmc__mark">
          <MarkIcon />
        </span>
        <span className="ui-cmc__title" id={uid}>
          {title}
        </span>
        {currentAgent ? (
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="sm" className="ui-cmc__who ui-cmc__agent" aria-haspopup="menu" />
              }
            >
              {currentAgent.icon ? (
                <span className="ui-cmc__logo" aria-hidden="true">
                  {currentAgent.icon}
                </span>
              ) : null}
              <span className="ui-cmc__model">{currentAgent.name}</span>
              <span className="ui-cmc__limit">{fmtTokens(effLimit)}</span>
              <ChevronIcon />
            </MenuTrigger>
            <MenuPopup align="start" className="w-64">
              <MenuRadioGroup
                value={currentAgent.id}
                onValueChange={(id) => {
                  if (id !== currentAgent.id) onAgentChange?.(String(id));
                }}
              >
                {agents!.map((a) => (
                  <MenuRadioItem key={a.id} value={a.id} className="items-center">
                    {a.icon ? (
                      <span className="ui-cmc__logo" aria-hidden="true">
                        {a.icon}
                      </span>
                    ) : null}
                    <span className="ui-cmc__option-text">
                      <span className="ui-cmc__option-name">{a.name}</span>
                      {a.model ? <span className="ui-cmc__option-model">{a.model}</span> : null}
                    </span>
                    <span className="ui-cmc__limit">{fmtTokens(a.limit)}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        ) : model || modelIcon ? (
          <span className="ui-cmc__who">
            {modelIcon ? (
              <span className="ui-cmc__logo" aria-hidden="true">
                {modelIcon}
              </span>
            ) : null}
            {model ? <span className="ui-cmc__model">{model}</span> : null}
            <span className="ui-cmc__limit">{fmtTokens(effLimit)}</span>
          </span>
        ) : null}
        {status ? (
          <span className="ui-cmc__status">
            <Spinner className="ui-cmc__spin" />
            {status}
          </span>
        ) : null}
        <span className="ui-cmc__sum">
          {compaction ? (
            <SegmentedControl size="sm" className="ui-cmc__compare" aria-label="Compaction">
              {(["before", "after"] as const).map((v) => (
                <SegmentedControlItem
                  key={v}
                  aria-current={view === v ? "page" : undefined}
                  onClick={() => setView(v)}
                >
                  {v === "before" ? "Before" : "After"}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          ) : null}
          <span>
            <b className="ui-cmc__used">{fmtTokens(used)}</b>
            {" / "}
            {fmtTokens(effLimit)}
          </span>
          <span className="ui-cmc__pct" data-level={level}>
            {Math.round(fill * 100)}%
          </span>
        </span>
      </header>
      <div
        ref={areaRef}
        className="ui-cmc__area"
        role="list"
        aria-labelledby={uid}
        onMouseLeave={() => setHoverId(null)}
      >
        {layoutItems.map((item) => {
          const rect = rects.get(item.id);
          if (!rect) return null;
          const block = byId.current.get(item.id);
          const isFree = item.id === FREE_ID;
          const showName = rect.w >= 54 && rect.h >= 28;
          const showTokens = showName && rect.h >= 44;
          const showKind = showTokens && rect.w >= 120;
          const inBefore = view === "before" && compaction?.before.some((b) => b.id === item.id);
          const fate = inBefore ? fateOf(item.id) : undefined;
          const style = { "--x": `${rect.x}px`, "--y": `${rect.y}px`, "--w": `${rect.w}px`, "--h": `${rect.h}px` } as CSSProperties;

          return (
            <div
              key={item.id}
              role="listitem"
              className="ui-cmc__tile"
              data-kind={isFree ? "free" : block?.kind}
              data-fate={
                isFree || !compaction
                  ? undefined
                  : view === "before"
                    ? inBefore
                      ? fate
                      : undefined
                    : item.id === compaction.summary
                      ? "summary"
                      : undefined
              }
              data-dim={hoverId && hoverId !== item.id ? "" : undefined}
              style={style}
              aria-label={
                isFree
                  ? `Free – ${fmtTokens(item.value)} tokens`
                  : `${block?.label}, ${block ? KIND_LABEL[block.kind] : ""} – ${fmtTokens(item.value)} tokens`
              }
              onMouseEnter={() => setHoverId(item.id)}
              data-pinned={pinnedId === item.id ? "" : undefined}
              onClick={() => {
                if (isFree) return onSelect?.(null);
                setPinnedId((p) => (p === item.id ? null : item.id));
                onSelect?.(block ?? null);
              }}
            >
              {inBefore && fate === "summarized" && rect.w >= 40 && rect.h >= 28 ? (
                <span className="ui-cmc__badge" title="Summarized – click for more" aria-hidden="true">
                  <SqueezeIcon />
                </span>
              ) : null}
              <span className="ui-cmc__label" aria-hidden="true">
                <span className="ui-cmc__name" data-show={showName ? "" : undefined}>
                  {block?.icon && !isFree ? <span className="ui-cmc__icon">{block.icon}</span> : null}
                  {isFree ? "Free" : block?.label}
                </span>
                <span className="ui-cmc__tokens" data-show={showTokens ? "" : undefined}>
                  {fmtTokens(targets.get(item.id) || item.value)}
                  {!isFree && block ? (
                    <span className="ui-cmc__kind" data-show={showKind ? "" : undefined}>
                      {" "}
                      {inBefore ? (
                        <RollText k={fateOf(item.id)}>
                          <span data-fate={fateOf(item.id)}>{FATE_SUFFIX[fateOf(item.id)]}</span>
                        </RollText>
                      ) : (
                        <RollText k="kind">{`· ${KIND_LABEL[block.kind]}`}</RollText>
                      )}
                    </span>
                  ) : null}
                </span>
              </span>
            </div>
          );
        })}
        {activeBlock ? (
          <div ref={tipRef} className="ui-cmc__tip" role="tooltip">
            <span className="ui-cmc__tip-head">
              {activeBlock.icon ? (
                <span className="ui-cmc__logo" aria-hidden="true">
                  {activeBlock.icon}
                </span>
              ) : (
                <span className="ui-cmc__swatch" data-kind={activeBlock.kind} aria-hidden="true" />
              )}
              <span className="ui-cmc__tip-name">{activeBlock.label}</span>
            </span>
            <span className="ui-cmc__tip-meta">
              {KIND_LABEL[activeBlock.kind]}
              {` · `}
              {fmtTokens(activeBlock.tokens)}
              {` tokens · `}
              {Math.round((activeBlock.tokens / effLimit) * 1e3) / 10}
              {`%`}
            </span>
            {activeBlock.detail ? <span className="ui-cmc__tip-detail">{activeBlock.detail}</span> : null}
            {compaction && view === "before" && compaction.before.some((b) => b.id === activeBlock.id) ? (
              <span className="ui-cmc__tip-fate" data-fate={fateOf(activeBlock.id)}>
                {(() => {
                  const Icon = FATE_ICON[fateOf(activeBlock.id)];
                  return <Icon />;
                })()}
                {fateOf(activeBlock.id) === "summarized"
                  ? "Folded into the summary"
                  : fateOf(activeBlock.id) === "dropped"
                    ? "Dropped when it compacted"
                    : "Kept as it was"}
              </span>
            ) : null}
            {compaction && view === "after" && activeBlock.id === compaction.summary ? (
              <span className="ui-cmc__tip-fate" data-fate="summary">
                <SqueezeIcon />
                {`From `}
                {compaction.summarized?.length ?? 0}
                {` blocks, `}
                {fmtTokens(
                  compaction.before
                    .filter((b) => compaction.summarized?.includes(b.id))
                    .reduce((s, b) => s + b.tokens, 0),
                )}
                {` before`}
              </span>
            ) : null}
            {activeBlock.items && activeBlock.items.length > 0 ? (
              <ul className="ui-cmc__tip-items">
                {activeBlock.items.map((item) => (
                  <li key={item.label}>
                    {item.icon ? (
                      <span className="ui-cmc__logo" aria-hidden="true">
                        {item.icon}
                      </span>
                    ) : null}
                    {item.label}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      {compaction !== undefined ? <FatesRow compaction={compaction} after={blocks} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------ fates row */

function FatesRow({ compaction, after }: { compaction: ContextCompaction | null; after: ContextBlock[] }) {
  if (!compaction) {
    return (
      <div className="ui-cmc__fates-row">
        <RollText k="none">
          <p className="ui-cmc__fates ui-cmc__fates--none">Not compacted yet – once it is, compare before and after here.</p>
        </RollText>
      </div>
    );
  }

  const sum = (list: ContextBlock[]) => list.reduce((s, b) => s + Math.max(0, b.tokens), 0);
  const withFate = (fate: CompactionFate) =>
    compaction.before.filter(
      (b) =>
        (compaction.summarized?.includes(b.id) ? "summarized" : compaction.dropped?.includes(b.id) ? "dropped" : "kept") ===
        fate,
    );
  const kept = withFate("kept");
  const summarized = withFate("summarized");
  const dropped = withFate("dropped");
  const summary = after.find((b) => b.id === compaction.summary);

  return (
    <div className="ui-cmc__fates-row">
      <RollText k="done">
        <p className="ui-cmc__fates">
          <b>
            {fmtTokens(sum(compaction.before))}
            {` → `}
            {fmtTokens(sum(after))}
          </b>
          <span className="ui-cmc__fate" data-fate="kept">
            {kept.length}
            {` kept · `}
            {fmtTokens(sum(kept))}
          </span>
          {summarized.length > 0 ? (
            <span className="ui-cmc__fate" data-fate="summarized">
              {summarized.length}
              {` summarized · `}
              {fmtTokens(sum(summarized))}
              {summary ? ` into ${fmtTokens(summary.tokens)}` : null}
            </span>
          ) : null}
          {dropped.length > 0 ? (
            <span className="ui-cmc__fate" data-fate="dropped">
              {dropped.length}
              {` dropped · `}
              {fmtTokens(sum(dropped))}
            </span>
          ) : null}
        </p>
      </RollText>
    </div>
  );
}

export default ContextMap;

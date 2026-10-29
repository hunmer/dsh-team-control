import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TRACE_WATERFALL_CSS } from "./trace-waterfall-css";
import { Badge } from "@/components/ui/badge";
import { JsonViewer } from "@/components/JsonViewer";
import { parseLooseJson } from "@/lib/json";
import { Button } from "@/components/ui/button";
import { modelAvatar } from "@/components/ModelAvatar";
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxEmpty, ComboboxItem,
  ComboboxList, ComboboxPopup, ComboboxValue,
} from "@/components/ui/combobox";
import {
  Bot, FileText, FolderSearch, GitBranch, Globe, ListChecks, PenLine, Search, Terminal, Wrench,
  type LucideIcon,
} from "lucide-react";

export type SpanKind = "agent" | "subagent" | "llm" | "tool";
export type SpanStatus = "running" | "done" | "failed";

/** One span of the run. Pass the whole tree every time something changes -
 *  ids keep rows in place, new ids slide in and grow. */
export interface TraceSpan {
  id: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  /** ms from the start of the run; leave `end` out while it runs */
  start: number;
  end?: number;
  /** a few muted words after the name, e.g. the model or the query */
  detail?: string;
  /** small mark before the name; defaults to the member's model logo or a kind icon */
  icon?: ReactNode;
  model?: string;
  /** the span's own - agents add up their children, so don't pre-sum */
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  /** ISO 币种（`CNY` / `USD`），缺省按 USD 渲染 */
  currency?: string;
  /** short previews shown in the details window */
  input?: string;
  output?: string;
  error?: string;
  children?: TraceSpan[];
}

export interface TraceWaterfallProps {
  root: TraceSpan;
  /** the clock in ms from the start of the run - e.g. a faster one for a demo */
  now?: number;
  /** epoch ms; without `now`, the component ticks its own clock from here */
  startedAt?: number;
  collapsed?: string[];
  defaultCollapsed?: string[];
  onCollapsedChange?: (collapsed: string[]) => void;
  openId?: string | null;
  defaultOpenId?: string | null;
  onOpenChange?: (id: string | null, span?: TraceSpan) => void;
  /** marks the slowest finished LLM or tool call with a small "Slowest" tag */
  markSlowest?: boolean;
  /** shortest time the axis shows, ms - grows in round steps */
  minRange?: number;
  formatCost?: (amount: number) => string;
  title?: string;
  className?: string;
}

/** Input/Output 多为 JSON 串：能解析（含被截断的）就折叠展示，否则退回纯文本。 */
function Payload({ label, value }: { label: string; value: string }) {
  const json = jsonDetail(value);
  return (
    <div className="ui-twc__pop-io">
      <span>
        {label}
        {json?.truncated && <span className="ui-twc__pop-hint">已截断</span>}
      </span>
      {json ? (
        <div className="max-h-56 overflow-auto rounded-md border">
          <JsonViewer data={json.value} defaultExpanded={1} mini />
        </div>
      ) : (
        <p dir="auto">{value}</p>
      )}
    </div>
  );
}

/** 工具 span 的 detail 常常是参数的 JSON 串；能解析成对象/数组就交给 JsonViewer。 */
const jsonDetail = (text?: string) => parseLooseJson(text);

const KIND_LABEL: Record<SpanKind, string> = {
  agent: `Agent run`,
  subagent: `Sub-agent`,
  llm: `LLM call`,
  tool: `Tool call`,
};
const STATUS_VARIANT: Record<SpanStatus, `info` | `success` | `error`> = {
  running: `info`,
  done: `success`,
  failed: `error`,
};

const STATUS_LABEL: Record<SpanStatus, string> = {
  running: `Running`,
  done: `Done`,
  failed: `Failed`,
};

const SEC = 1e3;
/** candidate axis widths, ms */
const RANGE_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 450, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200].map((s) => s * SEC);
/** candidate tick steps, ms */
const TICK_STEPS = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * SEC);
/** the axis glides to its new width over this many ms */
const RANGE_GLIDE_MS = 720;
/** stagger between rows entering, ms */
const ENTER_STAGGER = 36;

const CURRENCY_SYMBOL: Record<string, string> = { CNY: `¥`, USD: `$`, EUR: `€` };

const formatMoney = (v: number, currency = `USD`) => {
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return v === 0
    ? `${symbol}0`
    : v < 0.001
      ? `<${symbol}0.001`
      : v < 0.01
        ? `${symbol}${v.toFixed(3)}`
        : v < 10
          ? `${symbol}${v.toFixed(2)}`
          : `${symbol}${Math.round(v).toLocaleString(`en-US`)}`;
};

/** the currency of a subtree: the root's, else the first span that declares one */
const currencyOf = (s: TraceSpan): string =>
  s.currency ?? flatten(s).find((x) => x.currency)?.currency ?? `USD`;

/** "412ms" / "1.3s" / "2m 05s" */
const fmtMs = (ms: number) => {
  if (ms < SEC) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10 * SEC) return `${(ms / SEC).toFixed(1)}s`;
  const t = Math.round(ms / SEC);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m ${String(t % 60).padStart(2, `0`)}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${String(m % 60).padStart(2, `0`)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** axis labels: "30s" / "2m 30s" / "1h 30m" */
const fmtTick = (ms: number) => {
  const t = Math.round(ms / SEC);
  if (t < 60) return `${t}s`;
  if (t >= 3600)
    return t % 3600 ? `${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m` : `${t / 3600}h`;
  return t % 60 ? `${Math.floor(t / 60)}m ${t % 60}s` : `${t / 60}m`;
};

/** "412" / "41.2k" / "1.2M" */
const fmtTokens = (v: number) =>
  v < 1e3
    ? String(Math.round(v))
    : v < 1e5
      ? `${(v / 1e3).toFixed(1)}k`
      : v < 999500
        ? `${Math.round(v / 1e3)}k`
        : `${(v / 1e6).toFixed(1)}M`;

const intFmt = (v: number) => v.toLocaleString(`en-US`);

const flatten = (s: TraceSpan): TraceSpan[] => [s, ...(s.children ?? []).flatMap(flatten)];

/** the span's own cost plus everything below it */
const costOf = (s: TraceSpan): number =>
  (s.cost ?? 0) + (s.children ?? []).reduce((sum, c) => sum + costOf(c), 0);

/** [tokensIn, tokensOut] summed over the subtree */
const tokensOf = (s: TraceSpan): [number, number] =>
  (s.children ?? []).reduce(
    ([inSum, outSum], c) => {
      const [i, o] = tokensOf(c);
      return [inSum + i, outSum + o];
    },
    [s.tokensIn ?? 0, s.tokensOut ?? 0],
  );

const prefersReduced = () =>
  typeof window !== `undefined` &&
  window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;

const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;

const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z"
      fill="currentColor"
    />
    <circle cx="11.6" cy="11.4" r="1.1" fill="currentColor" opacity="0.55" />
  </svg>
);

/** 工具名 → 分类 + 图标：先看动作语义（写/读/执行/查/找/取/版本/协作），识别不出归到 other */
type ToolKind = `write` | `read` | `exec` | `search` | `find` | `net` | `git` | `team` | `other`;

const TOOL_KINDS: Array<{ id: ToolKind; pattern: RegExp; icon: LucideIcon }> = [
  { id: `write`, pattern: /write|edit|patch|rename/, icon: PenLine },
  { id: `read`, pattern: /read|cat\b|view|head\b|tail\b/, icon: FileText },
  { id: `exec`, pattern: /bash|shell|exec|command|terminal|run\b/, icon: Terminal },
  { id: `search`, pattern: /grep|search|query|\brg\b/, icon: Search },
  { id: `find`, pattern: /glob|find|list|\bls\b|dir/, icon: FolderSearch },
  { id: `net`, pattern: /fetch|http|url|web|curl|navigate|page/, icon: Globe },
  { id: `git`, pattern: /\bgit\b/, icon: GitBranch },
  { id: `team`, pattern: /team_|task|todo|member|agent|spawn|report/, icon: ListChecks },
];

const toolIconOf = (kind: ToolKind): LucideIcon =>
  TOOL_KINDS.find((k) => k.id === kind)?.icon ?? Wrench;

/** Worker 步骤的 span.name 只是 S1/S2，真正的工具在 detail 的 `phase · action · target` 里 */
const STEP_NAME = /^S\d+$/i;

function toolNameOf(span: TraceSpan): string {
  if (!STEP_NAME.test(span.name)) return span.name;
  const action = (span.detail ?? ``).split(` · `)[1];
  return action || span.name;
}

function toolKindOf(span: TraceSpan): ToolKind {
  const hay = `${span.name} ${span.detail ?? ``}`.toLowerCase();
  return TOOL_KINDS.find((k) => k.pattern.test(hay))?.id ?? `other`;
}

function toolMark(span: TraceSpan): ReactNode {
  const Icon = toolIconOf(toolKindOf(span));
  return <Icon aria-hidden="true" />;
}

/** 行首标记：成员用模型厂标，工具按工具名取图标，其余按种类退化到图标而不是色块 */
function spanMark(span: TraceSpan): ReactNode {
  if (span.icon) return span.icon;
  if (span.kind === `tool`) return toolMark(span);
  if (span.kind === `llm`) return modelAvatar(span.model, null, null, 13) ?? <SparkIcon />;
  return modelAvatar(span.model, span.name, null, 13) ?? <Bot aria-hidden="true" />;
}

// Hugeicons Free (MIT) chevron-down
const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </svg>
);

// Hugeicons Free (MIT) alert-triangle
const WarnIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
    <path d="M12 9V13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    <path d="M12 16.8V17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" />
  </svg>
);

const SpinIcon = () => (
  <svg className="ui-twc__spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
    <path d="M12 3.5A8.5 8.5 0 0 1 20.5 12" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
  </svg>
);

// Hugeicons Free (MIT) cancel/close
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M19 5L5 19M5 5L19 19"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </svg>
);

/** a folded span's calls shown as small marks on its bar */
const FoldMark = memo(function FoldMark({
  kind,
  status,
  start,
  dur,
}: {
  kind: SpanKind;
  status: SpanStatus;
  start: number;
  dur: number;
}) {
  return (
    <span
      className="ui-twc__mark"
      data-kind={kind}
      data-status={status}
      style={{ "--s": start, "--d": dur } as CSSProperties}
      aria-hidden="true"
    />
  );
});

interface RowHandlers {
  click: (id: string) => void;
  fold: (id: string) => void;
  focus: (id: string) => void;
  key: (e: React.KeyboardEvent, id: string) => void;
  el: (id: string, node: HTMLElement | null) => void;
}

interface RowProps {
  span: TraceSpan;
  depth: number;
  hidden: boolean;
  leaving?: number;
  folded: boolean;
  open: boolean;
  focusable: boolean;
  slowest: boolean;
  now?: number;
  range: number;
  trackW: number;
  delay: number;
  formatCost: (v: number) => string;
  on: RowHandlers;
}

const Row = memo(function Row({
  span,
  depth,
  hidden,
  leaving,
  folded,
  open,
  focusable,
  slowest,
  now,
  range,
  trackW,
  delay,
  formatCost,
  on,
}: RowProps) {
  const children = span.children ?? [];
  const isLeaving = leaving !== void 0;
  const endOf = (s: TraceSpan) =>
    s.end ?? (s.status === `running` ? Math.max(now ?? s.start, s.start) : s.start);
  const durOf = (s: TraceSpan) => Math.max(0, endOf(s) - s.start);
  const dur = durOf(span);
  const cost = children.length ? costOf(span) : span.cost;
  const showCost = cost !== void 0 && cost > 0 && (span.kind !== `tool` || span.cost !== void 0);
  const label = `${fmtMs(dur)}${showCost ? ` \u00b7 ${formatCost(cost)}` : ``}`;

  const toX = (ms: number) => (ms / range) * trackW;
  const tagW = label.length * 6.4 + (slowest ? 58 : 0) + 8;
  const side =
    !trackW || toX(span.start + dur) + 6 + tagW <= trackW
      ? (`after` as const)
      : toX(dur) >= tagW + 10
        ? (`inside` as const)
        : toX(span.start) >= tagW + 6
          ? (`before` as const)
          : (`inside` as const);

  const hiddenCount = folded ? flatten(span).length - 1 : 0;
  // folded calls shown as small marks on the parent's bar
  const marks =
    folded || children.length
      ? flatten(span).slice(1).filter((s) => s.kind === `llm` || s.kind === `tool`)
      : [];

  const barStyle = { "--s": span.start, "--d": dur } as CSSProperties;

  return (
    <div
      ref={isLeaving ? void 0 : (el) => on.el(span.id, el)}
      className="ui-twc__row"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={children.length ? !folded : void 0}
      aria-selected={open}
      aria-hidden={hidden || isLeaving || void 0}
      aria-label={`${span.name}, ${KIND_LABEL[span.kind]}, ${STATUS_LABEL[span.status]}, ${label}`}
      tabIndex={focusable ? 0 : -1}
      data-kind={span.kind}
      data-status={span.status}
      data-parent={children.length ? `` : void 0}
      data-hidden={hidden ? `` : void 0}
      data-folded={folded ? `` : void 0}
      data-leaving={isLeaving ? `` : void 0}
      data-open={open ? `` : void 0}
      style={{ animationDelay: `${isLeaving ? leaving : delay}ms` } as CSSProperties}
      onClick={() => !isLeaving && on.click(span.id)}
      onFocus={(e) => e.target === e.currentTarget && on.focus(span.id)}
      onKeyDown={(e) => on.key(e, span.id)}
    >
      <div className="ui-twc__name">
        {depth > 0 && (
          <span
            className="ui-twc__guides"
            style={{ width: `calc(min(${depth}, var(--ui-twc-depth)) * var(--ui-twc-indent))` }}
            aria-hidden="true"
          />
        )}
        <span
          className="ui-twc__chev"
          data-leaf={children.length ? void 0 : ``}
          aria-hidden="true"
          onClick={(e) => {
            if (children.length && !isLeaving) {
              e.stopPropagation();
              on.fold(span.id);
            }
          }}
        >
          {children.length > 0 && <ChevronDown />}
        </span>
        <span className="ui-twc__icon" data-kind={span.kind}>
          {spanMark(span)}
        </span>
        <span className="ui-twc__label">
          <span className="ui-twc__title" dir="auto">
            {span.name}
          </span>
          {span.detail && (
            <span className="ui-twc__detail" dir="auto">
              {span.detail}
            </span>
          )}
        </span>
        {hiddenCount > 0 && (
          <Badge size="sm" variant="secondary">{`+`}{intFmt(hiddenCount)}</Badge>
        )}
        {span.status === `running` && !children.length && (
          <span className="ui-twc__state" data-status="running">
            <SpinIcon />
          </span>
        )}
        {span.status === `failed` && (
          <span className="ui-twc__state" data-status="failed">
            <WarnIcon />
          </span>
        )}
        <span className="ui-twc__meta">
          {slowest && (
            <Badge size="sm" title="Slowest" variant="warning">
              Slowest
            </Badge>
          )}
          <span className="ui-twc__amount" data-live={span.status === `running` ? `` : void 0}>
            {fmtMs(dur)}
            {showCost && <span className="ui-twc__meta-cost">{` \u00b7 ${formatCost(cost)}`}</span>}
          </span>
        </span>
      </div>
      <div className="ui-twc__track">
        <span
          className="ui-twc__bar"
          data-bar=""
          data-kind={span.kind}
          data-status={span.status}
          style={{ ...barStyle, animationDelay: `${delay + 60}ms` } as CSSProperties}
        />
        {marks.map((m) => (
          <FoldMark key={m.id} kind={m.kind} status={m.status} start={m.start} dur={durOf(m)} />
        ))}
        <span className="ui-twc__tag" data-side={side} style={barStyle}>
          <span className="ui-twc__amount" data-live={span.status === `running` ? `` : void 0}>
            {label}
          </span>
          {slowest && <Badge size="sm" variant="warning">Slowest</Badge>}
        </span>
      </div>
    </div>
  );
});

interface RowEntry {
  span: TraceSpan;
  depth: number;
  parentId?: string;
  hidden: boolean;
  leaving?: number;
}

export function TraceWaterfall({
  root,
  now,
  startedAt,
  collapsed,
  defaultCollapsed = [],
  onCollapsedChange,
  openId,
  defaultOpenId = null,
  onOpenChange,
  markSlowest = true,
  minRange = 10 * SEC,
  formatCost: fmtCostProp,
  title = `Trace`,
  className,
}: TraceWaterfallProps) {
  // 金额默认按根节点的币种渲染（CNY→¥ / USD→$）；调用方仍可用 formatCost 完全接管
  const fmtCost = fmtCostProp ?? ((v: number) => formatMoney(v, currencyOf(root)));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());

  const [uncollapsed, setUncollapsed] = useState(defaultCollapsed);
  const collapsedList = collapsed ?? uncollapsed;
  const toggleFold = (id: string) => {
    const next = collapsedList.includes(id)
      ? collapsedList.filter((c) => c !== id)
      : [...collapsedList, id];
    setUncollapsed(next);
    onCollapsedChange?.(next);
  };

  const [unopen, setUnopen] = useState(defaultOpenId);
  const [toolFilter, setToolFilter] = useState<string[]>([]);
  const flat = flatten(root);

  // 候选工具：当前瀑布里真实出现过的工具（按出现次数排序），没有数据时为空
  const toolOptionList = (() => {
    const map = new Map<string, { name: string; kind: ToolKind; count: number }>();
    for (const span of flat) {
      if (span.kind !== `tool`) continue;
      const name = toolNameOf(span);
      const hit = map.get(name);
      if (hit) hit.count += 1;
      else map.set(name, { name, kind: toolKindOf(span), count: 1 });
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  })();
  const open = openId === void 0 ? unopen : openId;
  const openSpan = open ? flat.find((s) => s.id === open) : void 0;
  const setOpen = (id: string | null) => {
    setUnopen(id);
    onOpenChange?.(id, id ? flat.find((s) => s.id === id) : void 0);
  };

  // own 100ms clock while something runs and `now` is not driven
  const anyRunning = flat.some((s) => s.status === `running`);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== void 0 || startedAt === void 0 || !anyRunning) return;
    const id = window.setInterval(() => setTick(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [anyRunning, now, startedAt]);

  const lastEnd = Math.max(0, ...flat.map((s) => s.end ?? s.start));
  const nowMs = now ?? (startedAt !== void 0 && anyRunning ? tick - startedAt : lastEnd);
  const endOf = (s: TraceSpan) =>
    s.end ?? (s.status === `running` ? Math.max(nowMs, s.start) : s.start);
  const durOf = (s: TraceSpan) => Math.max(0, endOf(s) - s.start);

  const [trackW, setTrackW] = useState(0);
  const maxEnd = Math.max(anyRunning ? nowMs : 0, ...flat.map(endOf));
  const wanted = Math.max(minRange, maxEnd * 1.2);
  const range = RANGE_STEPS.find((s) => s >= wanted) ?? Math.ceil(wanted / 36e5) * 36e5;
  const maxTicks = Math.min(8, Math.max(3, Math.round((trackW || 600) / 96)));
  const tickStep = TICK_STEPS.find((s) => range / s <= maxTicks) ?? range / maxTicks;
  const ticks: number[] = [];
  for (let t = 0; t < range - 1; t += tickStep) ticks.push(t);

  // ticks that fell out of the axis fade away where they are
  const prevTicks = useRef<number[]>([]);
  const [leavingTicks, setLeavingTicks] = useState<number[]>([]);
  const ticksKey = ticks.join(`,`);
  useLayoutEffect(() => {
    const gone = prevTicks.current.filter((t) => !ticks.includes(t));
    prevTicks.current = ticks;
    if (gone.length && !prefersReduced()) {
      setLeavingTicks((prev) => [
        ...prev.filter((t) => !ticks.includes(t) && !gone.includes(t)),
        ...gone,
      ]);
      window.setTimeout(
        () =>
          setLeavingTicks((prev) =>
            prev.filter((t) => !gone.includes(t) || prevTicks.current.includes(t)),
          ),
        520,
      );
    }
  }, [ticksKey]);

  // the axis glides to its new width instead of jumping
  const rangeRef = useRef(range);
  const rafRef = useRef(0);
  const firstRange = useRef(true);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (v: number) => {
      rangeRef.current = v;
      el.style.setProperty(`--ui-twc-range`, String(v));
    };
    cancelAnimationFrame(rafRef.current);
    if (firstRange.current || prefersReduced()) {
      firstRange.current = false;
      apply(range);
      return;
    }
    const from = rangeRef.current;
    if (from === range) return;
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / RANGE_GLIDE_MS);
      apply(from + (range - from) * easeInOutCubic(p));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [range]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const ro = new ResizeObserver(() => setTrackW(layer.offsetWidth));
    ro.observe(layer);
    return () => ro.disconnect();
  }, []);

  // rows to render: the tree with folded branches hidden, plus leaving ghosts
  const visible: RowEntry[] = [];
  const keepRow = (span: TraceSpan) =>
    toolFilter.length === 0 || span.kind !== `tool` || toolFilter.includes(toolNameOf(span));
  const collect = (span: TraceSpan, depth: number, parentId: string | undefined, hidden: boolean) => {
    if (!keepRow(span)) return;
    visible.push({ span, depth, parentId, hidden });
    const nowHidden = hidden || collapsedList.includes(span.id);
    for (const c of span.children ?? []) collect(c, depth + 1, span.id, nowHidden);
  };
  collect(root, 0, void 0, false);
  const visibleIds = new Set(visible.map((r) => r.span.id));

  // rows that left (a new run, removed data, folded parents) close up bottom first
  const [leavingRows, setLeavingRows] = useState<{ row: RowEntry; index: number }[]>([]);
  const prevRows = useRef<RowEntry[]>([]);
  useLayoutEffect(() => {
    const prev = prevRows.current;
    prevRows.current = visible;
    if (prefersReduced()) return;
    const gone = prev.filter((r) => !visibleIds.has(r.span.id));
    if (!gone.length) return;
    const entries = gone.map((row, i) => ({
      row: { ...row, leaving: Math.min(240, (gone.length - 1 - i) * 22) },
      index: prev.indexOf(row),
    }));
    const ids = new Set(entries.map((e) => e.row.span.id));
    setLeavingRows((prevGhosts) => [
      ...prevGhosts.filter((g) => !ids.has(g.row.span.id)),
      ...entries,
    ]);
    window.setTimeout(
      () => setLeavingRows((prevGhosts) => prevGhosts.filter((g) => !ids.has(g.row.span.id))),
      580,
    );
  });

  const allRows = [...visible];
  const ghosts = leavingRows
    .filter((g) => !visibleIds.has(g.row.span.id))
    .sort((a, b) => a.index - b.index);
  const rootLeaving = ghosts.some((g) => g.row.depth === 0);
  for (const g of ghosts) {
    if (rootLeaving) allRows.push(g.row);
    else allRows.splice(Math.min(g.index, allRows.length), 0, g.row);
  }

  const navRows = allRows.filter((r) => !r.hidden && r.leaving === void 0);

  // staggered enter delays for rows that just appeared
  const enterDelays = useRef(new Map<string, number>());
  const mounted = useRef(false);
  let newIdx = 0;
  for (const r of allRows) {
    if (r.leaving !== void 0 || enterDelays.current.has(r.span.id)) continue;
    enterDelays.current.set(
      r.span.id,
      Math.min(400, (mounted.current ? 0 : 60) + newIdx++ * ENTER_STAGGER),
    );
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const keep = new Set(allRows.filter((r) => r.leaving === void 0).map((r) => r.span.id));
    for (const id of [...enterDelays.current.keys()]) if (!keep.has(id)) enterDelays.current.delete(id);
  });

  // roving focus: exactly one row is in the tab order
  const [focusId, setFocusId] = useState(root.id);
  const findRow = (id: string) => allRows.find((r) => r.span.id === id);
  let activeId: string | undefined = focusId;
  for (let r = findRow(activeId); r && (r.hidden || r.leaving !== void 0); r = findRow(r.parentId!)) {
    activeId = r.parentId ?? root.id;
  }
  if (!navRows.some((r) => r.span.id === activeId)) activeId = navRows[0]?.span.id ?? root.id;

  const focusRow = (row?: RowEntry) => {
    if (!row) return;
    setFocusId(row.span.id);
    rowEls.current.get(row.span.id)?.focus();
  };

  const onKey = (e: React.KeyboardEvent, id: string) => {
    if (e.target !== e.currentTarget) return;
    const row = findRow(id);
    if (!row || row.leaving !== void 0) return;
    const i = navRows.findIndex((r) => r.span.id === row.span.id);
    const hasKids = (row.span.children ?? []).length > 0;
    const folded = collapsedList.includes(row.span.id);
    const actions: Record<string, () => void> = {
      ArrowDown: () => focusRow(navRows[i + 1]),
      ArrowUp: () => focusRow(navRows[i - 1]),
      Home: () => focusRow(navRows[0]),
      End: () => focusRow(navRows[navRows.length - 1]),
      ArrowRight: () => (hasKids && folded ? toggleFold(row.span.id) : hasKids ? focusRow(navRows[i + 1]) : void 0),
      ArrowLeft: () => (hasKids && !folded ? toggleFold(row.span.id) : focusRow(findRow(row.parentId!))),
      Enter: () => setOpen(open === row.span.id ? null : row.span.id),
      " ": () => setOpen(open === row.span.id ? null : row.span.id),
      Escape: () => open && setOpen(null),
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  // the details window plays its closing animation before it goes away
  const [closingSpan, setClosingSpan] = useState<TraceSpan | null>(null);
  const prevOpenRef = useRef<TraceSpan | undefined>(undefined);
  useLayoutEffect(() => {
    const prev = prevOpenRef.current;
    prevOpenRef.current = openSpan;
    if (prev && !openSpan && !prefersReduced()) {
      setClosingSpan(prev);
      const t = window.setTimeout(() => setClosingSpan(null), 170);
      return () => window.clearTimeout(t);
    }
    if (openSpan) setClosingSpan(null);
  }, [openSpan?.id]);
  const shownSpan = openSpan ?? closingSpan ?? void 0;

  // close the details on an outside pointer press
  useEffect(() => {
    if (!openSpan) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !rowsRef.current?.contains(t)) setOpen(null);
    };
    document.addEventListener(`pointerdown`, onDown);
    return () => document.removeEventListener(`pointerdown`, onDown);
  });

  // place the details window under (or above) its row, at the bar's left edge
  useLayoutEffect(() => {
    const pop = popRef.current;
    const body = bodyRef.current;
    const row = shownSpan ? rowEls.current.get(shownSpan.id) : void 0;
    if (!pop || !body || !row) return;
    const bodyRect = body.getBoundingClientRect();
    const zoom = body.offsetWidth ? bodyRect.width / body.offsetWidth : 1;
    const rowRect = row.getBoundingClientRect();
    const barRect = row.querySelector(`[data-bar]`)?.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    const top = (rowRect.top - bodyRect.top) / zoom;
    const below = (rowRect.bottom - bodyRect.top) / zoom + 6;
    const rowH = row.offsetHeight || 1;
    const rowsTop = rowsRef.current ? (rowsRef.current.getBoundingClientRect().top - bodyRect.top) / zoom + 4 : 0;
    const aboveRaw = top - popH - 6;
    const aboveSnap = rowsTop + Math.floor((aboveRaw - rowsTop) / rowH) * rowH;
    const above = aboveSnap >= rowsTop ? aboveSnap : aboveRaw;
    const finalTop = below + popH > body.offsetHeight + 24 && above > 0 ? above : below;
    const barLeft = barRect ? (barRect.left - bodyRect.left) / zoom : 8;
    pop.style.left = `${Math.max(8, Math.min(barLeft, body.offsetWidth - popW - 8))}px`;
    pop.style.top = `${finalTop}px`;
    pop.dataset.side = finalTop === above ? `above` : `below`;
  });

  const calls = flat.filter((s) => s.kind === `llm` || s.kind === `tool`);
  const [rootTokensIn, rootTokensOut] = tokensOf(root);
  const errorCount = flat.filter((s) => s.status === `failed`).length;
  const finishedCalls = calls.filter((s) => s.status !== `running` && s.end !== void 0);
  const slowest =
    markSlowest && finishedCalls.length > 1
      ? finishedCalls.reduce((a, b) => (durOf(b) > durOf(a) ? b : a))
      : void 0;
  const runState: SpanStatus =
    root.status === `running` || anyRunning ? `running` : root.status === `failed` ? `failed` : `done`;

  // spans whose subtree still runs grow their bars into `now`
  const liveIds = new Set<string>();
  const markLive = (s: TraceSpan): boolean => {
    let live = s.status === `running`;
    for (const c of s.children ?? []) if (markLive(c)) live = true;
    if (live) liveIds.add(s.id);
    return live;
  };
  markLive(root);

  // stable-ish handler bundle handed to every row
  const handlers = useRef<RowHandlers | null>(null);
  handlers.current = {
    click: (id) => {
      setFocusId(id);
      setOpen(open === id ? null : id);
    },
    fold: (id) => {
      setFocusId(id);
      toggleFold(id);
    },
    focus: (id) => setFocusId(id),
    key: (e, id) => onKey(e, id),
    el: (id, node) => {
      if (node) rowEls.current.set(id, node);
      else rowEls.current.delete(id);
    },
  };
  const on = handlers.current!;

  const details = (span: TraceSpan) => {
    const hasKids = (span.children ?? []).length > 0;
    const detailJson = jsonDetail(span.detail);
    const [tin, tout] = tokensOf(span);
    const cost = hasKids ? costOf(span) : span.cost;
    const stats: [string, string][] = [
      [`Duration`, fmtMs(durOf(span))],
      [`Started`, `+${fmtMs(span.start)}`],
      ...(cost !== void 0 && cost > 0 ? ([[`Cost`, fmtCost(cost)]] as [string, string][]) : []),
      ...(tin > 0 ? ([[`Tokens in`, fmtTokens(tin)]] as [string, string][]) : []),
      ...(tout > 0 ? ([[`Tokens out`, fmtTokens(tout)]] as [string, string][]) : []),
      ...(hasKids ? ([[`Spans`, intFmt(flatten(span).length - 1)]] as [string, string][]) : []),
    ];
    return (
      <div
        ref={popRef}
        className="ui-twc__pop"
        role="dialog"
        aria-label={`${span.name} details`}
        data-closing={openSpan ? void 0 : ``}
        data-kind={span.kind}
        data-status={span.status}
        onKeyDown={(e) => {
          if (e.key === `Escape`) {
            e.stopPropagation();
            setOpen(null);
            rowEls.current.get(span.id)?.focus();
          }
        }}
      >
        <div className="ui-twc__pop-head">
          <span className="ui-twc__icon" data-kind={span.kind}>
            {spanMark(span)}
          </span>
          <span className="ui-twc__pop-who">
            <span className="ui-twc__pop-name" dir="auto">
              {span.name}
            </span>
            <span className="ui-twc__pop-kind">
              {KIND_LABEL[span.kind]}
              {span.model ? ` \u00b7 ${span.model}` : span.detail && !detailJson ? ` \u00b7 ${span.detail}` : ``}
            </span>
          </span>
          <Badge size="sm" variant={STATUS_VARIANT[span.status]}>
            {STATUS_LABEL[span.status]}
          </Badge>
          <Button
            size="icon-sm"
            variant="ghost"
            type="button"
            aria-label="Close details"
            onClick={() => {
              setOpen(null);
              rowEls.current.get(span.id)?.focus();
            }}
          >
            <CloseIcon />
          </Button>
        </div>
        <dl className="ui-twc__pop-stats">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {detailJson && (
          <div className="ui-twc__pop-io">
            <span>
              参数
              {detailJson.truncated && <span className="ui-twc__pop-hint">已截断</span>}
            </span>
            <div className="max-h-56 overflow-auto rounded-md border">
              <JsonViewer data={detailJson.value} defaultExpanded={1} mini />
            </div>
          </div>
        )}
        {span.error && (
          <p className="ui-twc__pop-error">
            <WarnIcon />
            <span className="ui-twc__pop-error-text" dir="auto">
              {span.error}
            </span>
          </p>
        )}
        {span.input && <Payload label="Input" value={span.input} />}
        {span.output && <Payload label="Output" value={span.output} />}
      </div>
    );
  };

  const barStats = [
    { label: `Duration`, value: fmtMs(durOf(root)), live: runState === `running` },
    { label: `Cost`, value: fmtCost(costOf(root)), live: runState === `running` },
    { label: `Tokens`, value: fmtTokens(rootTokensIn + rootTokensOut), live: runState === `running` },
    { label: `LLM calls`, value: intFmt(flat.filter((s) => s.kind === `llm`).length) },
    { label: `Tool calls`, value: intFmt(flat.filter((s) => s.kind === `tool`).length) },
    { label: `Errors`, value: intFmt(errorCount), kind: errorCount ? (`failed` as const) : void 0 },
  ];

  const tickRender = [
    ...ticks.map((v) => ({ v, leaving: false })),
    ...leavingTicks.filter((v) => !ticks.includes(v)).map((v) => ({ v, leaving: true })),
  ];

  return (
    <div
      ref={rootRef}
      className={[`ui-twc`, className].filter(Boolean).join(` `)}
      data-live={runState === `running` ? `` : void 0}
      style={{ "--ui-twc-at": nowMs } as CSSProperties}
    >
      <style href="ui-trace-waterfall-clean" precedence="default">
        {TRACE_WATERFALL_CSS}
      </style>
      <header className="ui-twc__bar-head">
        <span className="ui-twc__spark">
          <SparkIcon />
        </span>
        <span className="ui-twc__heading" title={title}>
          {title}
        </span>
        <span className="ui-twc__task" dir="auto">
          {root.input ?? root.name}
        </span>
        <Badge size="sm" variant={STATUS_VARIANT[runState]} aria-live="polite">
          {runState === `running` && <span className="ui-twc__pulse" aria-hidden="true" />}
          {runState === `running` ? `Live` : STATUS_LABEL[runState]}
        </Badge>
        <div className="ui-twc__filter">
          <Combobox
            items={toolOptionList.map((option) => option.name)}
            multiple
            value={toolFilter}
            onValueChange={(value) => setToolFilter(value as string[])}
          >
            <ComboboxValue>
              {(value: string[]) => (
                <ComboboxChips className="w-44" data-size="sm">
                  {value.map((name) => {
                    const option = toolOptionList.find((o) => o.name === name);
                    const Icon = toolIconOf(option?.kind ?? `other`);
                    return (
                      <ComboboxChip key={name} className="gap-1">
                        <Icon aria-hidden="true" />
                        <span className="max-w-28 truncate">{name}</span>
                      </ComboboxChip>
                    );
                  })}
                  <ComboboxChipsInput
                    size="sm"
                    placeholder={value.length ? `` : `全部工具`}
                    aria-label="过滤工具"
                    title="按工具名过滤，可多选"
                  />
                </ComboboxChips>
              )}
            </ComboboxValue>
            <ComboboxPopup>
              <ComboboxEmpty>没有匹配的工具</ComboboxEmpty>
              <ComboboxList>
                {(item: string) => {
                  const option = toolOptionList.find((o) => o.name === item);
                  const Icon = toolIconOf(option?.kind ?? `other`);
                  return (
                    <ComboboxItem key={item} value={item}>
                      <span className="flex w-full items-center gap-2">
                        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{item}</span>
                        <span className="text-muted-foreground text-xs tabular-nums">{option?.count ?? 0}</span>
                      </span>
                    </ComboboxItem>
                  );
                }}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
        </div>
      </header>
      <div className="ui-twc__card">
        <dl className="ui-twc__stats">
          {barStats.map((s) => (
            <div className="ui-twc__stat" data-kind={s.kind} key={s.label}>
              <dt>{s.label}</dt>
              <dd>
                <span className="ui-twc__amount" data-live={s.live ? `` : void 0}>
                  {s.value}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <div ref={bodyRef} className="ui-twc__body">
          <div ref={layerRef} className="ui-twc__layer" aria-hidden="true">
            {tickRender.map(({ v, leaving }) => (
              <span
                key={v}
                className="ui-twc__tick"
                data-zero={v === 0 ? `` : void 0}
                data-leaving={leaving ? `` : void 0}
                style={{ "--v": v } as CSSProperties}
              >
                <span>{fmtTick(v)}</span>
              </span>
            ))}
            {runState === `running` && <span className="ui-twc__now" />}
          </div>
          <div className="ui-twc__axis" aria-hidden="true">
            <span>Span</span>
          </div>
          <div ref={rowsRef} className="ui-twc__rows" role="tree" aria-label={title}>
            {allRows.map((r) => (
              <Row
                key={r.leaving === void 0 ? r.span.id : `${r.span.id}~out`}
                span={r.span}
                depth={r.depth}
                hidden={r.hidden}
                leaving={r.leaving}
                folded={(r.span.children ?? []).length > 0 && collapsedList.includes(r.span.id)}
                open={open === r.span.id}
                focusable={!r.hidden && r.leaving === void 0 && activeId === r.span.id}
                slowest={slowest?.id === r.span.id}
                now={liveIds.has(r.span.id) ? nowMs : void 0}
                range={range}
                trackW={trackW}
                delay={enterDelays.current.get(r.span.id) ?? 0}
                formatCost={fmtCost}
                on={on}
              />
            ))}
          </div>
          {shownSpan && details(shownSpan)}
        </div>
      </div>
    </div>
  );
}

export default TraceWaterfall;

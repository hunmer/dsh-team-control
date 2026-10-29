import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AGENT_TREE_CSS } from "./agent-tree-css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** One agent in the tree. Pass the whole tree every time something changes -
 *  ids keep the cards in place, new ids grow in with a drawn connector. */
export interface TreeAgent {
  id: string;
  name: string;
  task: string;
  model?: string;
  avatar?: ReactNode;
  /** small marks shown as overlapping tiles before the task */
  tools?: ReactNode[];
  status: AgentStatus;
  /** what a waiting agent needs you to decide */
  ask?: string;
  /** what went wrong for a failed one */
  error?: string;
  /** the agent's own spend - the component adds the children up */
  cost?: number;
  /** ms timestamps */
  started?: number;
  ended?: number;
  children?: TreeAgent[];
}

export type AgentStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";

export type ResolveAction = "approve" | "reject" | "retry" | "dismiss";

export interface AgentTreeProps {
  root: TreeAgent;
  /** ids of folded branches (controlled) */
  collapsed?: string[];
  /** ids of folded branches (uncontrolled initial value) */
  defaultCollapsed?: string[];
  onCollapsedChange?: (collapsed: string[]) => void;
  /** makes the cards clickable */
  onSelect?: (agent: TreeAgent) => void;
  /** an answer from the "needs you" / "failed" window */
  onResolve?: (agent: TreeAgent, action: ResolveAction) => void;
  /** the clock for running times; defaults to Date.now(), ticking 1s */
  now?: number;
  formatCost?: (amount: number) => string;
  title?: string;
  className?: string;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: `Queued`,
  running: `Running`,
  waiting: `Needs you`,
  done: `Done`,
  failed: `Failed`,
  stopped: `Stopped`,
};

const STATUS_VARIANT: Record<AgentStatus, `info` | `warning` | `success` | `error` | `outline` | `secondary`> = {
  queued: `outline`,
  running: `info`,
  waiting: `warning`,
  done: `success`,
  failed: `error`,
  stopped: `secondary`,
};

const formatCost = (v: number) =>
  v > 0 && v < 0.005 ? `<$0.01` : `$${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString(`en-US`)}`;

const intFmt = new Intl.NumberFormat(`en-US`);

const formatDuration = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1e3));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, `0`)}s`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${String(min % 60).padStart(2, `0`)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** two-letter initials from the first letters of the first two words */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ``))[0])
    .filter(Boolean)
    .slice(0, 2)
    .join(``)
    .toUpperCase();

const flattenAgents = (a: TreeAgent): TreeAgent[] => [
  a,
  ...(a.children ?? []).flatMap(flattenAgents),
];

/** the agent's own cost plus everything below it */
const branchCost = (a: TreeAgent): number =>
  (a.cost ?? 0) + (a.children ?? []).reduce((sum, c) => sum + branchCost(c), 0);

const prefersReducedMotion = () =>
  typeof window !== `undefined` &&
  window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;

/** offsetLeft/Top accumulated up to (excluding) `until` - zoom-proof rects */
const offsetRect = (el: HTMLElement, until: Element) => {
  let x = 0,
    y = 0,
    node: HTMLElement | null = el;
  while (node && node !== until) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
};

const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z"
      fill="currentColor"
    />
    <circle cx="11.6" cy="11.4" r="1.1" fill="currentColor" opacity="0.55" />
  </svg>
);

const StatusGlyph = ({ status }: { status: AgentStatus }) =>
  status === `running` ? (
    <svg className="ui-agtc__spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M12 3.5A8.5 8.5 0 0 1 20.5 12" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
    </svg>
  ) : status === `done` ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 14L8.5 17.5L19 6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  ) : status === `failed` ? (
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
  ) : status === `waiting` ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 7.5V12L14.5 14.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  ) : status === `stopped` ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );

// Hugeicons Free (MIT) chevron-down
const ChevronDown = ({ className }: { className?: string }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    <path
      d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </svg>
);

/** leave animation total / card move / stagger between leaving agents, ms */
const LEAVE_MS = 280;
const MOVE_MS = 420;
const STAGGER_MS = 60;
const EASE = `cubic-bezier(0.32, 0.72, 0.24, 1)`;

/** the tree actually rendered: agents with folded children, plus leaving ghosts */
interface ShownNode {
  agent: TreeAgent;
  kids: ShownNode[];
  /** set on leaving ghosts: delay before the leave animation starts */
  leaving?: number;
}

const flattenShown = (n: ShownNode): ShownNode[] => [n, ...n.kids.flatMap(flattenShown)];

/** how many levels hang below this node */
const depthOf = (n: ShownNode): number => Math.max(0, ...n.kids.map((k) => depthOf(k) + 1));

/** one shared 1s clock for every running timer in the page */
const sharedClock = { subs: new Set<() => void>(), id: 0 };
function useSharedClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    sharedClock.subs.add(tick);
    sharedClock.id ||= window.setInterval(() => sharedClock.subs.forEach((f) => f()), 1e3);
    return () => {
      sharedClock.subs.delete(tick);
      if (!sharedClock.subs.size) {
        window.clearInterval(sharedClock.id);
        sharedClock.id = 0;
      }
    };
  }, [active]);
  return now;
}

/** live "12s" / "1m 04s" that ticks on the shared clock while it runs */
const LiveTime = ({
  since,
  until,
  now,
}: {
  since: number;
  until?: number;
  now?: number;
}) => {
  const internal = useSharedClock(until === void 0 && now === void 0);
  return <>{formatDuration((until ?? now ?? internal) - since)}</>;
};

export function AgentTree({
  root,
  collapsed,
  defaultCollapsed = [],
  onCollapsedChange,
  onSelect,
  onResolve,
  now,
  formatCost: fmtCost = formatCost,
  title = `Agents`,
  className,
}: AgentTreeProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultCollapsed);
  const collapsedList = collapsed ?? uncontrolled;
  const toggleCollapse = (id: string) => {
    const next = collapsedList.includes(id)
      ? collapsedList.filter((c) => c !== id)
      : [...collapsedList, id];
    setUncontrolled(next);
    onCollapsedChange?.(next);
  };

  // "needs you" / "failed" dialog in the bar
  const [dialog, setDialog] = useState<`waiting` | `failed` | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setDialog(null);
    };
    document.addEventListener(`pointerdown`, onDown);
    return () => document.removeEventListener(`pointerdown`, onDown);
  }, [dialog]);

  const allAgents = flattenAgents(root);

  // shown tree with folded branches emptied; leaving ghosts woven back in below
  const buildShown = (agent: TreeAgent): ShownNode => ({
    agent,
    kids: collapsedList.includes(agent.id) ? [] : (agent.children ?? []).map(buildShown),
  });
  const shown = buildShown(root);
  const visibleIds = new Set(flattenShown(shown).map((n) => n.agent.id));

  const [leaving, setLeaving] = useState<LeavingEntry[]>([]);
  // ghosts still worth showing: their agent left the visible tree
  const stillShown = leaving.filter((g) => !visibleIds.has(g.shown.agent.id));
  const weave = (n: ShownNode): ShownNode => {
    const kids = n.kids.map(weave);
    stillShown
      .filter((g) => g.parent === n.agent.id)
      .sort((a, b) => a.index - b.index)
      .forEach((g) => kids.splice(Math.min(g.index, kids.length), 0, g.shown));
    return { ...n, kids };
  };
  const renderRoot = weave(shown);
  const flatNodes = flattenShown(renderRoot);

  // wide mode: first level side by side fits
  const [metrics, setMetrics] = useState<{ w: number; card: number; indent: number } | null>(null);
  const wide =
    !metrics ||
    metrics.w >=
      Math.max(
        560,
        renderRoot.kids.reduce(
          (sum, k) => sum + metrics.card + metrics.indent * Math.max(1, depthOf(k)),
          0,
        ) +
          Math.max(0, renderRoot.kids.length - 1) * 8,
      );

  // enter delays for cards that just appeared (staggered, one after another)
  const enterDelays = useRef(new Map<string, number>());
  const mounted = useRef(false);
  let newCount = 0;
  for (const n of flatNodes) {
    if (n.leaving !== void 0 || enterDelays.current.has(n.agent.id)) continue;
    enterDelays.current.set(
      n.agent.id,
      n === renderRoot ? 0 : (mounted.current ? 160 : 200) + Math.min(newCount++, 12) * STAGGER_MS,
    );
  }

  // measured connectors + canvas size
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<LinkSeg[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const linkFirstSeen = useRef(new Map<string, number>());

  const layoutKey = JSON.stringify([
    wide,
    collapsedList,
    flatNodes.map((n) => [
      n.agent.id,
      n.agent.status,
      n.leaving ?? ``,
      n.kids.map((k) => k.agent.id),
    ]),
  ]);

  const measure = () => {
    const tree = treeRef.current;
    if (!tree) return;
    const treeRect = tree.getBoundingClientRect();
    const zoom = tree.offsetWidth ? treeRect.width / tree.offsetWidth : 1;
    // tree 现在可内部滚动：换算成内容坐标时要加回滚动偏移
    const scrollLeft = tree.scrollLeft;
    const scrollTop = tree.scrollTop;
    const relRect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return {
        x: (r.left - treeRect.left + scrollLeft) / zoom,
        y: (r.top - treeRect.top + scrollTop) / zoom,
        w: r.width / zoom,
        h: r.height / zoom,
      };
    };
    const segs: LinkSeg[] = [];
    const level = tree.querySelector(`:scope > .ui-agtc__level`);
    const levelY = level ? relRect(level as HTMLElement).y : null;

    const walk = (node: ShownNode, depth: number) => {
      for (const kid of node.kids) {
        const parentEl = nodeEls.current.get(node.agent.id);
        const kidEl = nodeEls.current.get(kid.agent.id);
        if (parentEl && kidEl) {
          const p = relRect(parentEl);
          const c = relRect(kidEl);
          const muted = kid.agent.status === `queued` || kid.agent.status === `stopped`;
          const base = {
            id: `${node.agent.id}>${kid.agent.id}`,
            muted,
            leaving: kid.leaving,
            enter: enterDelays.current.get(kid.agent.id) ?? 0,
          };
          if (wide && depth === 0) {
            // side by side: a shared stem under the root, then an S-curve
            const px = Math.round(p.x + p.w / 2);
            const py = p.y + p.h;
            const cx = c.x + c.w / 2;
            const cy = c.y;
            const midY = Math.round(py + ((levelY ?? cy) - py) / 2);
            const dx = cx - px;
            const corner = Math.max(0, Math.min(8, Math.abs(dx) / 2, (cy - midY) / 2));
            const dir = Math.sign(dx);
            const stem = muted ? `M${px} ${midY}` : `M${px} ${py}V${midY}`;
            const d =
              Math.abs(dx) < 12
                ? `${stem}V${cy}`
                : `${stem}H${cx - dir * corner}Q${cx} ${midY} ${cx} ${midY + corner}V${cy}`;
            segs.push({ ...base, d, dot: [px, py] });
            const stemId = `${node.agent.id}>stem`;
            const prev = segs.find((s) => s.id === stemId);
            if (prev) {
              prev.muted = prev.muted && muted;
              prev.leaving =
                prev.leaving === void 0 || kid.leaving === void 0
                  ? void 0
                  : Math.max(prev.leaving, kid.leaving);
              prev.enter = Math.min(prev.enter, base.enter);
            } else {
              segs.push({
                id: stemId,
                d: `M${px} ${py}V${midY}`,
                dot: [px, py],
                muted,
                leaving: kid.leaving,
                enter: base.enter,
              });
            }
          } else {
            // narrow: connectors run down the left, from the parent's dot
            const px = p.x + 21;
            const py = p.y + p.h;
            const cx = c.x;
            const cy = c.y + 20;
            const corner = Math.max(0, Math.min(8, (cx - px) / 2, (cy - py) / 2));
            const d =
              cx - px < 2
                ? `M${px} ${py}V${c.y}`
                : `M${px} ${py}V${cy - corner}Q${px} ${cy} ${px + corner} ${cy}H${cx}`;
            segs.push({ ...base, d, dot: [px, py] });
          }
        }
        walk(kid, depth + 1);
      }
    };
    walk(renderRoot, 0);

    for (const id of [...linkFirstSeen.current.keys()])
      if (!segs.some((s) => s.id === id)) linkFirstSeen.current.delete(id);
    setLinks(segs);

    const rects = [...nodeEls.current.values()].map(relRect);
    setSize({
      w: Math.ceil(Math.max(tree.clientWidth, ...rects.map((r) => r.x + r.w))),
      h: Math.ceil(Math.max(tree.clientHeight, ...rects.map((r) => r.y + r.h))),
    });
  };

  // rAF loop that keeps re-measuring while any animation runs
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const framesUntil = useRef(0);
  const rafId = useRef(0);
  const keepFrames = (ms: number) => {
    framesUntil.current = Math.max(framesUntil.current, performance.now() + ms);
    if (rafId.current) return;
    const tick = () => {
      measureRef.current();
      rafId.current =
        performance.now() < framesUntil.current ? requestAnimationFrame(tick) : 0;
    };
    rafId.current = requestAnimationFrame(tick);
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    },
    [],
  );

  // cards glide to their new place: FLIP translate animation on real moves
  const prevRects = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    let moved = false;
    for (const [id, el] of nodeEls.current) {
      const rect = offsetRect(el, tree);
      const prev = prevRects.current.get(id);
      if (
        prev &&
        (Math.abs(prev.x - rect.x) > 0.5 || Math.abs(prev.y - rect.y) > 0.5) &&
        !prefersReducedMotion()
      ) {
        el.animate(
          [
            { translate: `${prev.x - rect.x}px ${prev.y - rect.y}px` },
            { translate: `0px 0px` },
          ],
          { duration: MOVE_MS, easing: EASE },
        );
        moved = true;
      }
      prevRects.current.set(id, rect);
    }
    for (const id of [...prevRects.current.keys()])
      if (!nodeEls.current.has(id)) prevRects.current.delete(id);
    if (moved) keepFrames(460);
  });

  // agents that left the tree (folded or removed) fade out bottom first,
  // their connectors pull back into the parent, then they are dropped
  const prevShown = useRef<ShownNode | null>(null);
  useLayoutEffect(() => {
    const prev = prevShown.current;
    prevShown.current = shown;
    mounted.current = true;
    for (const id of [...enterDelays.current.keys()])
      if (!flatNodes.some((n) => n.agent.id === id && n.leaving === void 0))
        enterDelays.current.delete(id);
    if (!prev || prefersReducedMotion()) return;

    const removed: LeavingEntry[] = [];
    const collect = (n: ShownNode) => {
      n.kids.forEach((kid, index) => {
        if (visibleIds.has(kid.agent.id)) collect(kid);
        else removed.push({ shown: kid, parent: n.agent.id, index });
      });
    };
    collect(prev);
    if (!removed.length) return;

    // bottom-most first: reverse flatten order, 60ms apart
    const subtree = removed.flatMap((r) => flattenShown(r.shown).reverse());
    const delays = new Map(subtree.map((n, i) => [n.agent.id, i * STAGGER_MS]));
    const markLeaving = (n: ShownNode): ShownNode => ({
      ...n,
      leaving: delays.get(n.agent.id) ?? 0,
      kids: n.kids.map(markLeaving),
    });
    // only ghosts whose parent is still visible (or the root) are woven in
    const kept = removed
      .filter((r) => visibleIds.has(r.parent) || r.parent === root.id)
      .map((r) => ({ ...r, shown: markLeaving(r.shown) }));
    const keptIds = new Set(kept.map((r) => r.shown.agent.id));
    setLeaving((prevGhosts) => [
      ...prevGhosts.filter((g) => !keptIds.has(g.shown.agent.id)),
      ...kept,
    ]);
    const total = LEAVE_MS + (subtree.length - 1) * STAGGER_MS;
    window.setTimeout(
      () => setLeaving((g) => g.filter((x) => !keptIds.has(x.shown.agent.id))),
      total + 30,
    );
    keepFrames(total + MOVE_MS + 60);
  });

  // re-measure whenever the shape changes, and let enters draw themselves
  useLayoutEffect(() => {
    measure();
    keepFrames(900 + Math.min(newCount, 12) * STAGGER_MS);
  }, [layoutKey]);

  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const ro = new ResizeObserver(() => {
      const style = getComputedStyle(tree);
      setMetrics({
        w: tree.offsetWidth,
        card: parseFloat(style.getPropertyValue(`--ui-agtc-card-w`)) || 216,
        indent: parseFloat(style.getPropertyValue(`--ui-agtc-indent`)) || 32,
      });
      measureRef.current();
    });
    ro.observe(tree);
    return () => ro.disconnect();
  }, []);

  // links that just appeared draw themselves in
  const seenAt = Date.now();
  for (const s of links) if (!linkFirstSeen.current.has(s.id)) linkFirstSeen.current.set(s.id, seenAt);
  const freshIds = new Set(
    links
      .filter((s) => seenAt - linkFirstSeen.current.get(s.id)! < 700 + s.enter)
      .map((s) => s.id),
  );

  const nodeCard = (node: ShownNode, depth: number) => {
    const agent = node.agent;
    const children = agent.children ?? [];
    const folded = collapsedList.includes(agent.id);
    const cost = children.length ? branchCost(agent) : (agent.cost ?? 0);
    const until =
      agent.ended ??
      (agent.status === `running` || agent.status === `waiting` ? void 0 : agent.started);
    const hidden = folded ? flattenAgents(agent).length - 1 : 0;
    const leavingNow = node.leaving !== void 0;
    return (
      <div
        className="ui-agtc__node"
        data-status={agent.status}
        data-depth={depth}
        data-leaving={leavingNow ? `` : void 0}
        aria-hidden={leavingNow || void 0}
        style={{ animationDelay: `${leavingNow ? node.leaving : enterDelays.current.get(agent.id) ?? 0}ms` } as CSSProperties}
        ref={(el) => {
          if (el) nodeEls.current.set(agent.id, el);
          else nodeEls.current.delete(agent.id);
        }}
        onClick={onSelect && !leavingNow ? () => onSelect(agent) : void 0}
        tabIndex={onSelect && !leavingNow ? 0 : void 0}
        onKeyDown={
          onSelect
            ? (e) => {
                if (e.target === e.currentTarget && (e.key === `Enter` || e.key === ` `)) {
                  e.preventDefault();
                  onSelect(agent);
                }
              }
            : void 0
        }
        data-clickable={onSelect ? `` : void 0}
      >
        <div className="ui-agtc__top">
          <span className="ui-agtc__avatar" data-logo={agent.avatar ? `` : void 0}>
            {agent.avatar ?? initials(agent.name)}
          </span>
          <span className="ui-agtc__who">
            <span className="ui-agtc__name" dir="auto" title={agent.name}>
              {agent.name}
            </span>
            {agent.model && (
              <span className="ui-agtc__model" title={agent.model}>
                {agent.model}
              </span>
            )}
          </span>
          <Badge size="sm" variant={STATUS_VARIANT[agent.status]}>
            <StatusGlyph status={agent.status} />
            {STATUS_LABEL[agent.status]}
          </Badge>
        </div>
        {agent.task || agent.tools?.length ? (
          <p className="ui-agtc__task" dir="auto" title={agent.task}>
            {agent.tools && agent.tools.length > 0 && (
              <span className="ui-agtc__tools" aria-hidden="true">
                {(agent.tools.length > 4 ? agent.tools.slice(0, 3) : agent.tools).map((t, i) => (
                  <span className="ui-agtc__tool" key={i}>
                    {t}
                  </span>
                ))}
                {agent.tools.length > 4 && (
                  <span className="ui-agtc__tool ui-agtc__tool--more">
                    {`+`}
                    {agent.tools.length - 3}
                  </span>
                )}
              </span>
            )}
            {agent.task}
          </p>
        ) : null}
        <div className="ui-agtc__meta">
          <span
            className="ui-agtc__cost"
            title={children.length ? `This branch, with its sub-agents` : void 0}
          >
            <span
              className="ui-agtc__amount"
              data-live={
                flattenAgents(agent).some((a) => a.status === `running`) ? `` : void 0
              }
            >
              {fmtCost(cost)}
            </span>
            {agent.started ? (
              <span className="ui-agtc__time">
                {` · `}
                <LiveTime since={agent.started} until={until} now={now} />
              </span>
            ) : null}
          </span>
          {children.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              className="h-5 gap-0.5 px-1 text-[11px]"
              type="button"
              aria-expanded={!folded}
              aria-label={
                folded
                  ? `Show ${hidden} sub-agents of ${agent.name}`
                  : `Fold the sub-agents of ${agent.name}`
              }
              tabIndex={leavingNow ? -1 : void 0}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(agent.id);
              }}
            >
              {folded ? `+${hidden}` : children.length}
              <ChevronDown
                className={folded ? `rotate-[-90deg] transition-transform` : `transition-transform`}
              />
            </Button>
          )}
        </div>
      </div>
    );
  };

  const hangItem = (node: ShownNode, depth: number) => (
    <div
      className="ui-agtc__hang"
      key={node.agent.id}
      style={depth === 1 ? ({ "--ui-agtc-col": Math.max(1, depthOf(node)) } as CSSProperties) : void 0}
      role="treeitem"
      aria-expanded={
        node.agent.children?.length ? !collapsedList.includes(node.agent.id) : void 0
      }
      aria-label={`${node.agent.name}: ${STATUS_LABEL[node.agent.status]}`}
    >
      {nodeCard(node, depth)}
      {node.kids.length > 0 && (
        <div className="ui-agtc__below" role="group">
          {node.kids.map((k) => hangItem(k, depth + 1))}
        </div>
      )}
    </div>
  );

  const maxDepthOf = (n: ShownNode, d: number): number =>
    Math.max(d, ...n.kids.map((k) => maxDepthOf(k, d + 1)));
  const treeDepth = maxDepthOf(renderRoot, 0);
  const totalCost = branchCost(root);
  const runningCount = allAgents.filter((a) => a.status === `running`).length;
  const waitingCount = allAgents.filter((a) => a.status === `waiting`).length;
  const failedCount = allAgents.filter((a) => a.status === `failed`).length;
  const dialogAgents = dialog ? allAgents.filter((a) => a.status === dialog) : [];
  const resolve = (agent: TreeAgent, action: ResolveAction) => {
    onResolve?.(agent, action);
    if (dialogAgents.length <= 1) setDialog(null);
  };

  // parent dots shared by sibling connectors
  const dots = new Map<string, { at: [number, number]; muted: boolean; leaving?: number }>();
  for (const s of links) {
    const key = s.dot.join(`,`);
    const prev = dots.get(key);
    if (prev) {
      dots.set(key, {
        at: prev.at,
        muted: prev.muted && s.muted,
        leaving:
          prev.leaving === void 0 || s.leaving === void 0
            ? void 0
            : Math.max(prev.leaving, s.leaving),
      });
    } else {
      dots.set(key, { at: s.dot, muted: s.muted, leaving: s.leaving });
    }
  }

  return (
    <div className={[`ui-agtc`, className].filter(Boolean).join(` `)} data-wide={wide ? `` : void 0}>
      <style href="ui-agent-tree-clean" precedence="default">
        {AGENT_TREE_CSS}
      </style>
      <header ref={barRef} className="ui-agtc__bar">
        <span className="ui-agtc__spark">
          <SparkIcon />
        </span>
        <span className="ui-agtc__title" dir="auto" title={title}>
          {title}
        </span>
        <span className="ui-agtc__sum" aria-live="polite">
          <span>{allAgents.length === 1 ? `1 agent` : `${intFmt.format(allAgents.length)} agents`}</span>
          {runningCount > 0 && (
            <span className="ui-agtc__sum-run">
              {intFmt.format(runningCount)}
              {` running`}
            </span>
          )}
          {waitingCount > 0 && (
            <Badge
              size="sm"
              variant="warning"
              aria-expanded={dialog === `waiting`}
              aria-haspopup="dialog"
              render={<button type="button" />}
              onClick={() => setDialog((d) => (d === `waiting` ? null : `waiting`))}
            >
              {intFmt.format(waitingCount)}
              {` needs you`}
              <ChevronDown
                className={dialog === `waiting` ? `rotate-180 transition-transform` : `transition-transform`}
              />
            </Badge>
          )}
          {failedCount > 0 && (
            <Badge
              size="sm"
              variant="error"
              aria-expanded={dialog === `failed`}
              aria-haspopup="dialog"
              render={<button type="button" />}
              onClick={() => setDialog((d) => (d === `failed` ? null : `failed`))}
            >
              {intFmt.format(failedCount)}
              {` failed`}
              <ChevronDown
                className={dialog === `failed` ? `rotate-180 transition-transform` : `transition-transform`}
              />
            </Badge>
          )}
          <span className="ui-agtc__sum-cost">
            <span className="ui-agtc__amount" data-live={runningCount > 0 ? `` : void 0}>
              {fmtCost(totalCost)}
            </span>
          </span>
        </span>
        {dialog && dialogAgents.length > 0 && (
          <div
            className="ui-agtc__pop"
            role="dialog"
            aria-label={dialog === `waiting` ? `Agents that need you` : `Agents that failed`}
            onKeyDown={(e) => e.key === `Escape` && setDialog(null)}
          >
            {dialogAgents.map((agent, i) => (
              <div className="ui-agtc__pop-item" key={agent.id}>
                <span className="ui-agtc__pop-head">
                  <Badge size="sm" variant={STATUS_VARIANT[agent.status]}>
                    <StatusGlyph status={agent.status} />
                  </Badge>
                  <span className="ui-agtc__pop-name" dir="auto">
                    {agent.name}
                  </span>
                  <span className="ui-agtc__pop-task" dir="auto">
                    {agent.task}
                  </span>
                </span>
                {(dialog === `waiting` ? agent.ask : agent.error) && (
                  <span className="ui-agtc__pop-text" dir="auto">
                    {dialog === `waiting` ? agent.ask : agent.error}
                  </span>
                )}
                <span className="ui-agtc__pop-actions">
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    onClick={() => resolve(agent, dialog === `waiting` ? `reject` : `dismiss`)}
                  >
                    {dialog === `waiting` ? `Reject` : `Dismiss`}
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    autoFocus={i === 0}
                    onClick={() => resolve(agent, dialog === `waiting` ? `approve` : `retry`)}
                  >
                    {dialog === `waiting` ? `Approve` : `Retry`}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </header>
      <div
        ref={treeRef}
        className="ui-agtc__tree"
        role="tree"
        aria-label={title}
        style={{ "--ui-agtc-depth": treeDepth } as CSSProperties}
      >
        <svg className="ui-agtc__links" width={size.w} height={size.h} aria-hidden="true">
          {links.map((s) => (
            <g
              key={s.id}
              data-muted={s.muted ? `` : void 0}
              data-fresh={
                freshIds.has(s.id) && s.leaving === void 0 && !prefersReducedMotion()
                  ? ``
                  : void 0
              }
              data-leaving={s.leaving === void 0 ? void 0 : ``}
            >
              <path
                d={s.d}
                pathLength={1}
                className="ui-agtc__link"
                style={{
                  animationDelay: `${s.leaving === void 0 ? Math.max(0, s.enter - 160) : s.leaving}ms`,
                } as CSSProperties}
              />
            </g>
          ))}
        </svg>
        <div
          className="ui-agtc__root"
          role="treeitem"
          aria-expanded={root.children?.length ? !collapsedList.includes(root.id) : void 0}
          aria-label={`${root.name}: ${STATUS_LABEL[root.status]}`}
        >
          {nodeCard(renderRoot, 0)}
        </div>
        {renderRoot.kids.length > 0 && (
          <div className="ui-agtc__level" role="group">
            {renderRoot.kids.map((k) => hangItem(k, 1))}
          </div>
        )}
        <svg className="ui-agtc__links ui-agtc__dots" width={size.w} height={size.h} aria-hidden="true">
          {[...dots].map(([key, dot]) => (
            <circle
              key={key}
              cx={dot.at[0]}
              cy={dot.at[1]}
              r={3.25}
              className="ui-agtc__dot"
              data-muted={dot.muted ? `` : void 0}
              data-leaving={dot.leaving === void 0 ? void 0 : ``}
              style={
                dot.leaving === void 0
                  ? void 0
                  : ({ animationDelay: `${dot.leaving}ms` } as CSSProperties)
              }
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

interface LeavingEntry {
  shown: ShownNode;
  parent: string;
  index: number;
}

interface LinkSeg {
  id: string;
  d: string;
  dot: [number, number];
  muted: boolean;
  leaving?: number;
  enter: number;
}

export default AgentTree;

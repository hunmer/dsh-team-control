import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { AGENT_INBOX_CSS } from "./agent-inbox-css";

export type AgentTaskStatus = "running" | "waiting" | "done" | "failed";
export type AgentInboxView = "board" | "list";
export type AgentLaneId = "needs" | "running" | "done";

export interface AgentTaskStep {
  label: string;
  time?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  description?: string;
  agent: string;
  status: AgentTaskStatus;
  startedAt?: number | Date;
  elapsed?: number;
  tools?: number;
  sources?: number;
  steps?: AgentTaskStep[];
}

export interface AgentInboxProps {
  tasks: AgentTask[];
  onApprove?: (task: AgentTask) => void;
  onReject?: (task: AgentTask) => void;
  onRetry?: (task: AgentTask) => void;
  onOpen?: (task: AgentTask) => void;
  title?: string;
  view?: AgentInboxView;
  defaultView?: AgentInboxView;
  onViewChange?: (view: AgentInboxView) => void;
  className?: string;
}

const EASE = "cubic-bezier(0.32, 0.72, 0.24, 1)";

const compactFormat = new Intl.NumberFormat("en", { notation: "compact" });
const fullFormat = new Intl.NumberFormat("en");

const toTime = (value: number | Date): number =>
  typeof value === "number" ? value : value.getTime();

const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return `${days}d ${String(hours).padStart(2, "0")}h`;
};

// --- shared 1s ticker -------------------------------------------------------

interface Ticker {
  subs: Set<() => void>;
  id: number;
}

const globalTicker: Ticker = { subs: new Set(), id: 0 };

function subscribeTicker(fn: () => void): () => void {
  if (globalTicker.subs.size === 0) {
    globalTicker.id = window.setInterval(() => {
      for (const sub of [...globalTicker.subs]) sub();
    }, 1000);
  }
  globalTicker.subs.add(fn);
  return () => {
    globalTicker.subs.delete(fn);
    if (globalTicker.subs.size === 0) window.clearInterval(globalTicker.id);
  };
}

function useLive(fn: () => void): void {
  useEffect(() => subscribeTicker(fn), [fn]);
}

// --- icons ------------------------------------------------------------------

const Spark = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z"
      fill="currentColor"
    />
    <circle cx="11.6" cy="11.4" r="1.1" fill="currentColor" opacity="0.55" />
  </svg>
);

const StateIcon = ({ status }: { status: AgentTaskStatus }) => {
  if (status === "running") {
    return (
      <svg className="ui-aic__spin" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M7 2a5 5 0 0 1 5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "waiting") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M7 2.2 12.6 11.4H1.4Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "done") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="3.4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.9 4.9l4.2 4.2M9.1 4.9L4.9 9.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
};

const ToolIcon = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M7.6 1.6a2.6 2.6 0 0 1 3.6 0l1.2 1.2a2.6 2.6 0 0 1 0 3.6l-1.6 1.6a1 1 0 0 1-1.4-1.4l1.6-1.6a.6.6 0 0 0 0-.8l-1.2-1.2a.6.6 0 0 0-.8 0L7.4 4.6a1 1 0 0 1-1.4-1.4ZM6.4 12.4a2.6 2.6 0 0 1-3.6 0L1.6 11.2a2.6 2.6 0 0 1 0-3.6l1.6-1.6a1 1 0 0 1 1.4 1.4L3 9a.6.6 0 0 0 0 .8l1.2 1.2a.6.6 0 0 0 .8 0l1.6-1.6a1 1 0 0 1 1.4 1.4Z"
      fill="currentColor"
    />
  </svg>
);

const SourceIcon = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="6.2" cy="6.2" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M9.4 9.4 12.6 12.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const BoardIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="1.5" y="1.5" width="4.6" height="11" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="7.9" y="1.5" width="4.6" height="6.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const ListIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2 3.6h10M2 7h10M2 10.4h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// --- helpers ----------------------------------------------------------------

const laneOf = (status: AgentTaskStatus): AgentLaneId => {
  if (status === "waiting" || status === "failed") return "needs";
  if (status === "running") return "running";
  return "done";
};

const LANES: { id: AgentLaneId; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
];

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const sinceOf = (task: AgentTask, startRefs: { current: Record<string, number> }): number => {
  const active = task.status === "running" || task.status === "waiting";
  if (!active) return 0;
  if (task.startedAt === undefined) {
    const refs = startRefs.current ?? {};
    return Date.now() - (task.elapsed ?? 0) - (refs[task.id] ?? 0);
  }
  return toTime(task.startedAt);
};

// --- card -------------------------------------------------------------------

interface CardProps {
  task: AgentTask;
  open: boolean;
  onToggle: () => void;
  since: number;
  onApprove?: (task: AgentTask) => void;
  onReject?: (task: AgentTask) => void;
  onRetry?: (task: AgentTask) => void;
  onOpen?: (task: AgentTask) => void;
}

function Elapsed({ since }: { since: number }) {
  const [, force] = useState(0);
  useLive(() => force((n) => n + 1));
  return <>{formatDuration(Date.now() - since)}</>;
}

function FixedElapsed({ ms }: { ms: number }) {
  return <>{formatDuration(ms)}</>;
}

function TaskCard({ task, open, onToggle, since, onApprove, onReject, onRetry, onOpen }: CardProps) {
  const steps = task.steps ?? [];
  const visibleSteps = steps.slice(-4);
  const isWaiting = task.status === "waiting";
  const isFailed = task.status === "failed";
  const stateWord =
    task.status === "done"
      ? "Done in "
      : task.status === "failed"
        ? "Failed"
        : `${task.status === "waiting" ? "Waiting for you" : "Running"} · `;

  return (
    <li
      className="ui-aic__card"
      data-id={task.id}
      data-status={task.status}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="ui-aic__card-main"
        aria-expanded={open}
        aria-controls={`ui-aic-fold-${task.id}`}
        onClick={onToggle}
      >
        <span className="ui-aic__title-row">
          <span className="ui-aic__spark">
            <Spark />
          </span>
          <span className="ui-aic__title" dir="auto">
            {task.title}
          </span>
        </span>
        {task.description && (
          <span className="ui-aic__desc" dir="auto">
            {task.description}
          </span>
        )}
        <span className="ui-aic__foot">
          <span className="ui-aic__state" data-status={task.status}>
            <span className="ui-aic__state-icon" data-status={task.status}>
              <StateIcon status={task.status} />
            </span>
            <span className="ui-aic__state-word">{stateWord}</span>
            {task.status !== "failed" && (
              <span className="ui-aic__time">
                {task.status === "done" ? (
                  <FixedElapsed ms={task.elapsed ?? 0} />
                ) : (
                  <Elapsed since={since} />
                )}
              </span>
            )}
          </span>
          <span className="ui-aic__meta">
            {task.sources !== undefined && (
              <span title={`Sources read: ${fullFormat.format(task.sources)}`}>
                <SourceIcon /> {compactFormat.format(task.sources)}
              </span>
            )}
            {task.tools !== undefined && (
              <span title={`Tool calls: ${fullFormat.format(task.tools)}`}>
                <ToolIcon /> {compactFormat.format(task.tools)}
              </span>
            )}
          </span>
        </span>
      </button>
      <div
        id={`ui-aic-fold-${task.id}`}
        className="ui-aic__fold"
        data-open={open || undefined}
        inert={!open}
      >
        <div className="ui-aic__clip">
          <div className="ui-aic__more">
            <div className="ui-aic__agent">{task.agent}</div>
            {visibleSteps.length > 0 && (
              <ol className="ui-aic__steps">
                {visibleSteps.map((step, index) => (
                  <li key={`${step.label}-${index}`} data-last={index === visibleSteps.length - 1 || undefined}>
                    <span dir="auto">{step.label}</span>
                    {step.time && <time>{step.time}</time>}
                  </li>
                ))}
              </ol>
            )}
            <div className="ui-aic__actions">
              {isWaiting && (
                <>
                  <button type="button" className="ui-aic__btn" onClick={() => onReject?.(task)}>
                    Reject
                  </button>
                  <button
                    type="button"
                    className="ui-aic__btn ui-aic__btn--primary"
                    onClick={() => onApprove?.(task)}
                  >
                    Approve
                  </button>
                </>
              )}
              {isFailed && (
                <button type="button" className="ui-aic__btn ui-aic__btn--primary" onClick={() => onRetry?.(task)}>
                  Retry
                </button>
              )}
              {(task.status === "running" || task.status === "done") && onOpen && (
                <button type="button" className="ui-aic__btn" onClick={() => onOpen(task)}>
                  Open
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

// --- main component ---------------------------------------------------------

export function AgentInbox({
  tasks,
  onApprove,
  onReject,
  onRetry,
  onOpen,
  title = "Agent inbox",
  view,
  defaultView = "board",
  onViewChange,
  className,
}: AgentInboxProps) {
  const [viewState, setViewState] = useState<AgentInboxView>(defaultView);
  const currentView = view ?? viewState;
  const setView = (next: AgentInboxView) => {
    if (view === undefined) setViewState(next);
    onViewChange?.(next);
  };

  const [overrides, setOverrides] = useState<Record<string, Partial<AgentTask>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const startRefs = useRef<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useMemo(prefersReducedMotion, []);

  const resolved = tasks.map((task) => {
    const override = overrides[task.id];
    return override ? ({ ...task, ...override } as AgentTask) : task;
  });

  // displayed lane per task (for FLIP)
  const [displayed, setDisplayed] = useState<Record<string, AgentLaneId>>(() =>
    Object.fromEntries(resolved.map((task) => [task.id, laneOf(task.status)])),
  );
  const flipKey = useRef("");

  // default handlers mutate the board when no callback is given
  const applyDefault = (task: AgentTask, patch: Partial<AgentTask>, stepLabel?: string) => {
    setOverrides((prev) => {
      const merged = { ...(prev[task.id] ?? {}), ...patch } as Partial<AgentTask>;
      if (stepLabel) {
        merged.steps = [...(merged.steps ?? task.steps ?? []), { label: stepLabel, time: "now" }];
      }
      return { ...prev, [task.id]: merged };
    });
  };

  const handleApprove = (task: AgentTask) => {
    if (onApprove) {
      onApprove(task);
      return;
    }
    applyDefault(task, { status: "running", startedAt: Date.now() }, "Approved – running");
  };
  const handleReject = (task: AgentTask) => {
    if (onReject) {
      onReject(task);
      return;
    }
    applyDefault(task, { status: "failed", elapsed: 0 }, "Rejected");
  };
  const handleRetry = (task: AgentTask) => {
    if (onRetry) {
      onRetry(task);
      return;
    }
    applyDefault(task, { status: "running", startedAt: Date.now(), elapsed: undefined }, "Retrying");
  };

  const cardsRef = useRef<HTMLDivElement>(null);

  // status-change: show new state in place, then move lane after a beat (FLIP)
  useLayoutEffect(() => {
    const key = JSON.stringify(displayed) + currentView;
    if (flipKey.current === key) return;
    const prevRects = new Map<string, DOMRect>();
    if (cardsRef.current) {
      for (const el of cardsRef.current.querySelectorAll<HTMLElement>(".ui-aic__card[data-id]")) {
        prevRects.set(el.dataset.id ?? "", el.getBoundingClientRect());
      }
    }
    flipKey.current = key;
    const nextDisplayed: Record<string, AgentLaneId> = {};
    for (const task of resolved) nextDisplayed[task.id] = laneOf(task.status);
    setDisplayed(nextDisplayed);
    const raf = requestAnimationFrame(() => {
      if (!cardsRef.current) return;
      const duration = reduced ? 0 : 560;
      for (const el of cardsRef.current.querySelectorAll<HTMLElement>(".ui-aic__card[data-id]")) {
        const id = el.dataset.id ?? "";
        const prev = prevRects.get(id);
        if (!prev) {
          if (!reduced) {
            el.animate(
              [
                { opacity: 0, transform: "translateY(6px)" },
                { opacity: 1, transform: "translateY(0)" },
              ],
              { duration: 300, easing: EASE },
            );
          }
          continue;
        }
        const now = el.getBoundingClientRect();
        if (prev.left === now.left && prev.top === now.top) continue;
        el.animate(
          [
            { transform: `translate(${prev.left - now.left}px, ${prev.top - now.top}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration, easing: EASE },
        );
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(displayed), currentView, tasks]);

  // delayed lane move: 900ms beat before the card glides
  useEffect(() => {
    const changed = resolved.filter((task) => displayed[task.id] !== laneOf(task.status));
    if (changed.length === 0) return;
    const timer = window.setTimeout(
      () => {
        setDisplayed((prev) => {
          const next = { ...prev };
          for (const task of resolved) next[task.id] = laneOf(task.status);
          return next;
        });
      },
      reduced ? 0 : 900,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Escape closes the open card and refocuses it
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openCard = rootRef.current?.querySelector<HTMLElement>(".ui-aic__card[data-open]");
      if (!openCard) return;
      setOpenId(null);
      window.setTimeout(() => openCard.querySelector<HTMLElement>(".ui-aic__card-main")?.focus(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lanes = useMemo(() => {
    const groups: Record<AgentLaneId, AgentTask[]> = { needs: [], running: [], done: [] };
    for (const task of resolved) groups[displayed[task.id] ?? laneOf(task.status)].push(task);
    return groups;
  }, [resolved, displayed]);

  const needsCount = resolved.filter((t) => t.status === "waiting" || t.status === "failed").length;
  const runningCount = resolved.filter((t) => t.status === "running").length;
  const isBoard = currentView === "board";

  return (
    <div className={["ui-aic", className].filter(Boolean).join(" ")} data-view={currentView} ref={rootRef}>
      <style href="ui-agent-inbox-clean" precedence="default">
        {AGENT_INBOX_CSS}
      </style>
      <header className="ui-aic__bar">
        <span className="ui-aic__heading">
          <span className="ui-aic__crumb">Agents</span>
          <span className="ui-aic__slash" aria-hidden="true">
            /
          </span>
          <span className="ui-aic__heading-title" title={title}>
            {title}
          </span>
        </span>
        <div className="ui-aic__views" role="radiogroup" aria-label="Layout">
          <button
            type="button"
            role="radio"
            aria-checked={isBoard}
            className="ui-aic__view"
            onClick={() => setView("board")}
          >
            <BoardIcon />
            Board
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!isBoard}
            className="ui-aic__view"
            onClick={() => setView("list")}
          >
            <ListIcon />
            List
          </button>
        </div>
      </header>
      <div className="ui-aic__lanes" ref={cardsRef}>
        {LANES.map((lane) => {
          const laneTasks = lanes[lane.id];
          const count =
            lane.id === "needs"
              ? needsCount
              : lane.id === "running"
                ? runningCount
                : lanes.done.length;
          return (
            <section key={lane.id} className="ui-aic__lane" aria-label={lane.label}>
              <header className="ui-aic__lane-head">
                <span className="ui-aic__lane-spark" aria-hidden="true">
                  <Spark />
                </span>
                <span className="ui-aic__lane-name">{lane.label}</span>
                <span className="ui-aic__count">{count}</span>
              </header>
              <ul className="ui-aic__cards">
                {laneTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    open={openId === task.id}
                    onToggle={() => setOpenId(openId === task.id ? null : task.id)}
                    since={sinceOf(task, startRefs)}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onRetry={handleRetry}
                    onOpen={onOpen}
                  />
                ))}
                {laneTasks.length === 0 && <li className="ui-aic__empty">Nothing here</li>}
              </ul>
            </section>
          );
        })}
      </div>
      <span className="ui-aic__sr" aria-live="polite">
        {needsCount} {needsCount === 1 ? "need" : "needs"} you, {runningCount} running
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo (verbatim scenario from the site's demo bundle)
// ---------------------------------------------------------------------------

const MINUTE = 6e4;

const freshTasks = (): AgentTask[] => {
  const now = Date.now();
  return [
    {
      id: "migrate",
      title: "Migrate users table",
      description: "Split users into accounts and profiles on Postgres 17. The dry run on staging passed.",
      agent: "Opus 5.5",
      status: "waiting",
      startedAt: now - 6 * MINUTE - 12e3,
      tools: 14,
      sources: 9,
      steps: [
        { label: "Read schema and 14 migrations", time: "6m ago" },
        { label: "Wrote migration 0042_split_users", time: "4m ago" },
        { label: "Dry run on staging – no errors", time: "2m ago" },
        { label: "Wants to run it on production", time: "1m ago" },
      ],
    },
    {
      id: "crm",
      title: "Clean up CRM contacts",
      description: "Matched 1,312 likely duplicates, then the merge hit the API rate limit.",
      agent: "Haiku 5.5",
      status: "failed",
      elapsed: 161e3,
      tools: 6,
      sources: 2,
      steps: [
        { label: "Loaded 18,240 contacts", time: "9m ago" },
        { label: "Matched 1,312 likely duplicates", time: "8m ago" },
        { label: "Merge stopped – API rate limit (429)", time: "7m ago" },
      ],
    },
    {
      id: "review",
      title: "Review PR #482",
      description: "Billing webhooks: reading the diff and the test run, writing comments.",
      agent: "Sonnet 5.5",
      status: "running",
      startedAt: now - 3 * MINUTE - 4e4,
      tools: 21,
      sources: 12,
      steps: [
        { label: "Read 12 changed files", time: "2m ago" },
        { label: "Ran the test suite – 214 passed", time: "1m ago" },
        { label: "Writing review comments", time: "now" },
      ],
    },
    {
      id: "notes",
      title: "Release notes v2.4",
      description: "Grouping 23 merged pull requests into features and fixes.",
      agent: "Sonnet 5.5",
      status: "running",
      startedAt: now - 1 * MINUTE - 18e3,
      tools: 5,
      sources: 23,
      steps: [
        { label: "Collected 23 merged pull requests", time: "1m ago" },
        { label: "Drafting the highlights", time: "now" },
      ],
    },
    {
      id: "digest",
      title: "Weekly metrics digest",
      description: "Pulled numbers from three dashboards and posted the summary to #metrics.",
      agent: "Haiku 5.5",
      status: "done",
      elapsed: 252e3,
      tools: 8,
      sources: 3,
      steps: [
        { label: "Pulled numbers from 3 dashboards", time: "22m ago" },
        { label: "Posted to #metrics", time: "18m ago" },
      ],
    },
  ];
};

export function AgentInboxDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [runId, setRunId] = useState(0);
  const [tasks, setTasks] = useState(freshTasks);
  const stopped = useRef(false);
  const timers = useRef<number[]>([]);

  const patch = (id: string, changes: Partial<AgentTask>, stepLabel?: string) =>
    setTasks((prev) =>
      prev.map((task) =>
        task.id === id
          ? { ...task, ...changes, steps: stepLabel ? [...(task.steps ?? []), { label: stepLabel, time: "now" }] : task.steps }
          : task,
      ),
    );
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  const handleApprove = (task: AgentTask) => {
    patch(task.id, { status: "running", startedAt: Date.now() - 6 * MINUTE }, "Approved by you – running on production");
    later(() => patch(task.id, { status: "done", elapsed: 408e3, tools: 17 }, "Migrated 48,210 rows"), 4200);
  };
  const handleRetry = (task: AgentTask) => {
    patch(task.id, { status: "running", startedAt: Date.now(), elapsed: undefined }, "Retrying with a slower pace");
    later(() => patch(task.id, { status: "done", elapsed: 4200 }, "Merged 1,312 duplicates"), 4200);
  };
  const handleReject = (task: AgentTask) => patch(task.id, { status: "failed", elapsed: 6 * MINUTE }, "Rejected by you");

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  useEffect(() => {
    const click = (selector: string) => () => rootRef.current?.querySelector<HTMLElement>(selector)?.click();
    const script: [number, () => void][] = [
      [700, click(".ui-aic__card[data-status='waiting'] .ui-aic__card-main")],
      [2600, click(".ui-aic__card[data-open] .ui-aic__btn--primary")],
      [1400, click(".ui-aic__card[data-open] .ui-aic__card-main")],
      [
        7e3,
        () => {
          timers.current.forEach((id) => window.clearTimeout(id));
          timers.current = [];
          setTasks(freshTasks());
          setRunId((n) => n + 1);
        },
      ],
    ];
    let index = 0;
    let timer = 0;
    const step = () => {
      if (stopped.current || index >= script.length) return;
      timer = window.setTimeout(() => {
        if (stopped.current) return;
        script[index][1]();
        index += 1;
        step();
      }, script[index][0]);
    };
    step();
    return () => window.clearTimeout(timer);
  }, [runId]);

  const stop = () => {
    stopped.current = true;
  };
  return (
    <div
      ref={rootRef}
      className="aic-demo"
      onPointerEnter={stop}
      onPointerDownCapture={stop}
      onKeyDownCapture={stop}
      onFocusCapture={stop}
    >
      <AgentInbox tasks={tasks} onApprove={handleApprove} onReject={handleReject} onRetry={handleRetry} onOpen={() => {}} />
    </div>
  );
}

export default AgentInboxDemo;

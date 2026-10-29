import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState,
  type AnimationEvent as ReactAnimationEvent,
  type ChangeEvent as ReactChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent } from "react";
import { PLAN_STEPS_CSS } from "./plan-steps-css";

export type PlanStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  tool?: string;
  status?: PlanStepStatus;
  /** Milliseconds the step took; shown for done steps. */
  duration?: number;
  error?: string;
}

export type PlanPhase = "draft" | "running" | "done";

export interface PlanStepsProps {
  steps?: PlanStep[];
  defaultSteps?: PlanStep[];
  status?: PlanPhase;
  onChange?: (steps: PlanStep[]) => void;
  onRun?: (steps: PlanStep[]) => void;
  onCancel?: () => void;
  onRetry?: (id: string) => void;
  title?: string;
  estimate?: string;
  className?: string;
}

const STATUS_LABELS: Record<PlanStepStatus, string> = {
  pending: "Pending",
  active: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const SPINNER_LINES: number[] = Array.from({ length: 8 }, (_value: undefined, index: number) => index);

let idCounter = 0;
const makeId = (): string => `step-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

const arrayMove = (items: PlanStep[], from: number, to: number): PlanStep[] => {
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const computedTranslateY = (element: HTMLElement): number => {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pad2 = (value: number): string => String(value).padStart(2, "0");

const formatLongDuration = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(totalSeconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${pad2(minutes % 60)}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const formatDuration = (milliseconds: unknown): string => {
  const seconds = Math.max(0, finiteNumber(milliseconds) ?? 0) / 1e3;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return formatLongDuration(Math.round(seconds));
};

const formatWholeDuration = (milliseconds: unknown): string => {
  const seconds = Math.max(1, Math.round((finiteNumber(milliseconds) ?? 0) / 1e3));
  if (seconds < 60) return `${seconds}s`;
  return formatLongDuration(seconds);
};

const numberFormat = new Intl.NumberFormat("en");

/** Shared 100 ms ticker so many elapsed timers only create one interval. */
const elapsedTicker: { subs: Set<() => void>; id: number } = { subs: new Set(), id: 0 };

const useNow = (enabled: boolean): number => {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const tick = (): void => setNow(Date.now());
    tick();
    elapsedTicker.subs.add(tick);
    elapsedTicker.id ||= window.setInterval(() => elapsedTicker.subs.forEach((subscriber: () => void) => subscriber()), 100);
    return () => {
      elapsedTicker.subs.delete(tick);
      if (!elapsedTicker.subs.size) {
        window.clearInterval(elapsedTicker.id);
        elapsedTicker.id = 0;
      }
    };
  }, [enabled]);
  return now;
};

function Elapsed({ since, whole }: { since: number | undefined; whole?: boolean }) {
  const now = useNow(since !== undefined);
  const elapsed = since === undefined ? 0 : now - since;
  return <Fragment>{whole ? formatWholeDuration(elapsed) : formatDuration(elapsed)}</Fragment>;
}

interface DragState {
  id: string;
  pointer: number;
  ids: string[];
  from: number;
  to: number;
  startY: number;
  scale: number;
  dy: number;
  tops: number[];
  heights: number[];
}

interface RenamingState {
  id: string;
  value: string;
}

function SpinnerIcon() {
  return (
    <svg className="ui-pl__spinner" viewBox="0 0 16 16">
      {SPINNER_LINES.map((line: number) => (
        <line
          key={line}
          x1="8"
          y1="1.75"
          x2="8"
          y2="4.75"
          transform={`rotate(${line * 45} 8 8)`}
          style={{ animationDelay: `${(line - 8) * 100}ms` }}
        />
      ))}
    </svg>
  );
}

export function PlanSteps({
  steps,
  defaultSteps = [],
  status = "draft",
  onChange,
  onRun,
  onCancel,
  onRetry,
  title,
  estimate,
  className,
}: PlanStepsProps) {
  const [localSteps, setLocalSteps] = useState<PlanStep[]>(defaultSteps);
  const allSteps = steps ?? localSteps;
  const isDraft = status === "draft";
  const stepsRef = useRef<PlanStep[]>(allSteps);
  stepsRef.current = allSteps;

  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const renamingRef = useRef<RenamingState | null>(renaming);
  renamingRef.current = renaming;

  const [newTitle, setNewTitle] = useState<string>("");
  const [removing, setRemoving] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState<string>("");
  const [doneElapsed, setDoneElapsed] = useState<number | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const itemTops = useRef<Map<string, number>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const focusTargetId = useRef<string | null>(null);
  const enteredIds = useRef<Set<string>>(new Set());
  const pendingTimers = useRef<Set<number>>(new Set());
  const activeStarts = useRef<Map<string, number>>(new Map());
  const doneDurations = useRef<Map<string, number>>(new Map());
  const runStartRef = useRef<number | null>(null);
  const prevStatuses = useRef<Map<string, PlanStepStatus>>(new Map());
  const hintId = useId();

  const scheduleTask = (callback: () => void, delayMs: number): void => {
    const timerId = window.setTimeout(() => {
      pendingTimers.current.delete(timerId);
      callback();
    }, delayMs);
    pendingTimers.current.add(timerId);
  };

  useEffect(() => {
    const timers = pendingTimers.current;
    return () => timers.forEach((timerId: number) => window.clearTimeout(timerId));
  }, []);

  const commit = (nextSteps: PlanStep[]): void => {
    if (steps === undefined) setLocalSteps(nextSteps);
    onChange?.(nextSteps);
  };

  const announce = (message: string): void =>
    setLiveMessage((previous: string) => (previous === message ? `${message} ` : message));

  const idsKey = allSteps
    .map((step: PlanStep) => step.id)
    .join("\n");
  const idsKeyRef = useRef<string>(idsKey);

  useLayoutEffect(() => {
    const moved = idsKeyRef.current !== idsKey;
    idsKeyRef.current = idsKey;
    const nextTops = new Map<string, number>();
    const animate = moved && !prefersReducedMotion();
    itemRefs.current.forEach((element: HTMLLIElement, id: string) => {
      const top = element.offsetTop;
      nextTops.set(id, top);
      if (!moved) return;
      const previousTop = itemTops.current.get(id);
      if (animate && previousTop !== undefined && previousTop !== top) {
        element.style.transition = "none";
        element.style.transform = `translateY(${previousTop - top}px)`;
        element.getBoundingClientRect();
      }
      element.style.transition = "";
      element.style.transform = "";
    });
    itemTops.current = nextTops;
    if (focusTargetId.current) {
      const element = itemRefs.current.get(focusTargetId.current);
      focusTargetId.current = null;
      if (element && document.activeElement !== element) element.focus();
    }
  });

  const phaseRef = useRef<PlanPhase>(status);
  useLayoutEffect(() => {
    const previousPhase = phaseRef.current;
    phaseRef.current = status;
    if (status === "running" && (runStartRef.current === null || previousPhase === "done")) {
      runStartRef.current = Date.now();
    }
    if (status === "draft") {
      runStartRef.current = null;
      setDoneElapsed(null);
    }
    if (status === "done") {
      const measured = stepsRef.current.reduce(
        (sum: number, step: PlanStep) => sum + (finiteNumber(step.duration) ?? doneDurations.current.get(step.id) ?? 0),
        0
      );
      setDoneElapsed(runStartRef.current === null ? measured : Date.now() - runStartRef.current);
    }
  }, [status]);

  useLayoutEffect(() => {
    allSteps.forEach((step: PlanStep) => {
      const stepStatus = step.status ?? "pending";
      if (stepStatus === "active") {
        if (!activeStarts.current.has(step.id)) activeStarts.current.set(step.id, Date.now());
      } else if (activeStarts.current.has(step.id)) {
        if (stepStatus === "done") {
          doneDurations.current.set(step.id, Date.now() - (activeStarts.current.get(step.id) as number));
        }
        activeStarts.current.delete(step.id);
      }
      if (stepStatus === "pending") doneDurations.current.delete(step.id);
    });
  });

  useEffect(() => {
    const messages: string[] = [];
    allSteps.forEach((step: PlanStep, index: number) => {
      const stepStatus = step.status ?? "pending";
      const previousStatus = prevStatuses.current.get(step.id);
      if (!isDraft && previousStatus !== undefined && previousStatus !== stepStatus) {
        if (stepStatus === "done") messages.push(`Step ${index + 1} done: ${step.title}`);
        if (stepStatus === "failed") messages.push(`Step ${index + 1} failed: ${step.title}${step.error ? `. ${step.error}` : ""}`);
        if (stepStatus === "skipped") messages.push(`Step ${index + 1} skipped`);
      }
      prevStatuses.current.set(step.id, stepStatus);
    });
    if (messages.length) announce(messages.join(". "));
  });

  useEffect(() => {
    if (status === "running") announce("Running plan");
    if (status === "done" && doneElapsed !== null) announce(`Plan done in ${formatWholeDuration(doneElapsed)}`);
  }, [status, doneElapsed]);

  useEffect(() => {
    if (!isDraft) {
      setRenaming(null);
      setNewTitle("");
    }
  }, [isDraft]);

  const focusStepOrAddInput = (id?: string): void => {
    if (id) {
      ((itemRefs.current.get(id) ?? null) as HTMLElement | null)?.focus();
    } else {
      addInputRef.current?.focus();
    }
  };

  const moveStep = (id: string, offset: number): void => {
    const current = stepsRef.current;
    const from = current.findIndex((step: PlanStep) => step.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= current.length) return;
    focusTargetId.current = id;
    commit(arrayMove(current, from, to));
    announce(`Moved “${current[from].title}” to position ${to + 1} of ${current.length}`);
  };

  const removeStep = (id: string): void => {
    if (!isDraft || removing.includes(id)) return;
    const current = stepsRef.current;
    const index = current.findIndex((step: PlanStep) => step.id === id);
    if (index < 0) return;
    const element = itemRefs.current.get(id);
    if (element?.contains(document.activeElement)) {
      focusStepOrAddInput((current[index + 1] ?? current[index - 1])?.id);
    }
    announce(`Removed “${current[index].title}”`);
    if (!element || prefersReducedMotion()) {
      commit(current.filter((step: PlanStep) => step.id !== id));
      return;
    }
    element.style.height = `${element.offsetHeight}px`;
    element.getBoundingClientRect();
    setRemoving((previous: string[]) => [...previous, id]);
    scheduleTask(() => {
      element.style.height = "";
      setRemoving((previous: string[]) => previous.filter((removedId: string) => removedId !== id));
      commit(stepsRef.current.filter((step: PlanStep) => step.id !== id));
    }, 260);
  };

  const beginRename = (id: string): void => {
    if (!isDraft) return;
    const step = stepsRef.current.find((candidate: PlanStep) => candidate.id === id);
    if (step) setRenaming({ id, value: step.title });
  };

  const commitRename = (save: boolean, refocus = false): void => {
    const pending = renamingRef.current;
    if (!pending) return;
    renamingRef.current = null;
    setRenaming(null);
    if (refocus) focusTargetId.current = pending.id;
    const trimmed = pending.value.trim();
    const step = stepsRef.current.find((candidate: PlanStep) => candidate.id === pending.id);
    if (save && step && trimmed && trimmed !== step.title) {
      commit(stepsRef.current.map((candidate: PlanStep) => (candidate.id === pending.id ? { ...candidate, title: trimmed } : candidate)));
      announce(`Renamed to “${trimmed}”`);
    }
  };

  const addStep = (): void => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const id = makeId();
    enteredIds.current.add(id);
    commit([...stepsRef.current, { id, title: trimmed }]);
    setNewTitle("");
    announce(`Added “${trimmed}” as step ${stepsRef.current.length + 1}`);
  };

  const onStepKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, id: string): void => {
    if (!isDraft || event.target !== event.currentTarget) return;
    const current = stepsRef.current;
    const index = current.findIndex((step: PlanStep) => step.id === id);
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveStep(id, event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const neighbor = current[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (neighbor) {
        focusStepOrAddInput(neighbor.id);
      } else if (event.key === "ArrowDown") {
        addInputRef.current?.focus();
      }
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginRename(id);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeStep(id);
    }
  };

  const onGripPointerDown = (event: ReactPointerEvent<HTMLSpanElement>, id: string): void => {
    if (!isDraft || event.button !== 0 || renamingRef.current || removing.length) return;
    const ids = stepsRef.current.map((step: PlanStep) => step.id);
    const elements = ids.map((stepId: string) => itemRefs.current.get(stepId));
    if (elements.some((element: HTMLLIElement | undefined) => !element)) return;
    const ordered = elements as HTMLLIElement[];
    const from = ids.indexOf(id);
    const dragged = ordered[from];
    const scale = dragged.offsetHeight ? dragged.getBoundingClientRect().height / dragged.offsetHeight : 1;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    dragRef.current = {
      id,
      pointer: event.pointerId,
      ids,
      from,
      to: from,
      startY: event.clientY,
      scale: scale || 1,
      dy: 0,
      tops: ordered.map((element: HTMLLIElement) => element.offsetTop),
      heights: ordered.map((element: HTMLLIElement) => element.offsetHeight),
    };
    setDraggingId(id);
  };

  const onGripPointerMove = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const lastIndex = drag.ids.length - 1;
    const minDy = drag.tops[0] - drag.tops[drag.from];
    const maxDy = drag.tops[lastIndex] + drag.heights[lastIndex] - (drag.tops[drag.from] + drag.heights[drag.from]);
    drag.dy = Math.min(maxDy, Math.max(minDy, (event.clientY - drag.startY) / drag.scale));
    itemRefs.current.get(drag.id)?.style.setProperty("transform", `translateY(${drag.dy}px)`);
    const draggedCenter = drag.tops[drag.from] + drag.dy + drag.heights[drag.from] / 2;
    let target = 0;
    drag.ids.forEach((stepId: string, index: number) => {
      if (index !== drag.from && drag.tops[index] + drag.heights[index] / 2 < draggedCenter) target++;
    });
    if (target === drag.to) return;
    drag.to = target;
    const draggedHeight = drag.heights[drag.from];
    drag.ids.forEach((stepId: string, index: number) => {
      if (index === drag.from) return;
      const shift =
        drag.from < target && index > drag.from && index <= target
          ? -draggedHeight
          : target < drag.from && index >= target && index < drag.from
            ? draggedHeight
            : 0;
      const element = itemRefs.current.get(stepId);
      if (element) element.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  };

  const onGripPointerEnd = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragRef.current = null;
    setDraggingId(null);
    if (drag.to === drag.from) {
      const element = itemRefs.current.get(drag.id);
      if (element) element.style.transform = "";
      return;
    }
    itemRefs.current.forEach((element: HTMLLIElement, id: string) => {
      itemTops.current.set(id, element.offsetTop + computedTranslateY(element));
      element.style.transition = "none";
      element.style.transform = "";
    });
    const current = stepsRef.current;
    const draggedStep = current.find((step: PlanStep) => step.id === drag.id);
    commit(arrayMove(current, drag.from, drag.to));
    requestAnimationFrame(() => itemRefs.current.forEach((element: HTMLLIElement) => (element.style.transition = "")));
    if (draggedStep) announce(`Moved “${draggedStep.title}” to position ${drag.to + 1} of ${current.length}`);
  };

  const stepCount = allSteps.length;
  const stepStatusOf = (step: PlanStep): PlanStepStatus => step.status ?? "pending";
  const activeIndex = allSteps.findIndex((step: PlanStep) => stepStatusOf(step) === "active");
  const failedIndex = allSteps.findIndex((step: PlanStep) => stepStatusOf(step) === "failed");
  const settledCount = allSteps.filter(
    (step: PlanStep) => stepStatusOf(step) === "done" || stepStatusOf(step) === "skipped"
  ).length;
  let phase: "draft" | "running" | "done" | "failed" = "draft";
  let phaseLabel = "";
  if (status === "done") {
    phase = "done";
    phaseLabel = `Done in ${formatWholeDuration(doneElapsed ?? 0)}`;
  } else if (status === "running") {
    if (failedIndex >= 0 && activeIndex < 0) {
      phase = "failed";
      phaseLabel = `Stopped · step ${numberFormat.format(failedIndex + 1)} failed`;
    } else {
      phase = "running";
      phaseLabel = `Running · ${numberFormat.format(activeIndex >= 0 ? activeIndex + 1 : Math.min(settledCount + 1, stepCount))} of ${numberFormat.format(stepCount)}`;
    }
  }

  return (
    <div
      ref={rootRef}
      className={["ui-pl", className].filter(Boolean).join(" ")}
      data-status={status}
      data-dragging={draggingId ? "" : undefined}
    >
      <style href="ui-agent-plan" precedence="default">{PLAN_STEPS_CSS}</style>
      <div className="ui-pl__card">
        <div className="ui-pl__head">
          <div className="ui-pl__meta">
            <span className="ui-pl__state">
              <span className="ui-pl__state-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" />
                  <circle cx="3.25" cy="4.5" r=".6" />
                  <circle cx="3.25" cy="8" r=".6" />
                  <circle cx="3.25" cy="11.5" r=".6" />
                </svg>
              </span>
              <span className="ui-pl__state-label">
                Plan · {numberFormat.format(stepCount)} {stepCount === 1 ? "step" : "steps"}
              </span>
            </span>
            {isDraft && estimate ? (
              <span className="ui-pl__estimate" title={estimate}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M8 5v3.2l2 1.3" />
                </svg>
                <span>
                  <span className="ui-pl__sr">Estimated time </span>
                  {estimate}
                </span>
              </span>
            ) : null}
          </div>
          {title && <h3 className="ui-pl__title" dir="auto">{title}</h3>}
        </div>
        <p id={hintId} className="ui-pl__sr">
          Press Enter to rename, Alt plus arrow keys to move, Delete to remove.
        </p>
        <ol className="ui-pl__list" aria-label={title ? `Plan: ${title}` : "Plan"}>
          {allSteps.map((step: PlanStep, index: number) => {
            const stepStatus = stepStatusOf(step);
            const isRenaming = isDraft && renaming?.id === step.id;
            const measuredDuration = finiteNumber(step.duration) ?? doneDurations.current.get(step.id);
            const activeStart = activeStarts.current.get(step.id);
            return (
              <li
                key={step.id}
                ref={(node: HTMLLIElement | null) => {
                  if (node) itemRefs.current.set(step.id, node);
                  return () => {
                    itemRefs.current.delete(step.id);
                  };
                }}
                className="ui-pl__step"
                data-step={isDraft ? undefined : stepStatus}
                data-dragging={draggingId === step.id ? "" : undefined}
                data-removing={removing.includes(step.id) ? "" : undefined}
                data-enter={enteredIds.current.has(step.id) ? "" : undefined}
                onAnimationEnd={(event: ReactAnimationEvent<HTMLLIElement>) => {
                  if (event.target === event.currentTarget) enteredIds.current.delete(step.id);
                }}
                tabIndex={isDraft && !isRenaming ? 0 : undefined}
                aria-describedby={isDraft ? hintId : undefined}
                aria-current={stepStatus === "active" && !isDraft ? "step" : undefined}
                onKeyDown={(event: ReactKeyboardEvent<HTMLLIElement>) => onStepKeyDown(event, step.id)}
              >
                {isDraft && (
                  <span
                    className="ui-pl__grip"
                    aria-hidden="true"
                    title="Drag to reorder"
                    onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => onGripPointerDown(event, step.id)}
                    onPointerMove={onGripPointerMove}
                    onPointerUp={onGripPointerEnd}
                    onPointerCancel={onGripPointerEnd}
                  >
                    <svg viewBox="0 0 16 16">
                      <circle cx="6" cy="4" r="1.1" />
                      <circle cx="10" cy="4" r="1.1" />
                      <circle cx="6" cy="8" r="1.1" />
                      <circle cx="10" cy="8" r="1.1" />
                      <circle cx="6" cy="12" r="1.1" />
                      <circle cx="10" cy="12" r="1.1" />
                    </svg>
                  </span>
                )}
                <span className="ui-pl__marker" aria-hidden="true">
                  {isDraft || stepStatus === "pending" ? (
                    <span className="ui-pl__num">{index + 1}</span>
                  ) : stepStatus === "active" ? (
                    <SpinnerIcon />
                  ) : stepStatus === "done" ? (
                    <svg viewBox="0 0 16 16" className="ui-pl__mark">
                      <path d="M4.2 8.4 6.8 11l5-5.6" pathLength={1} className="ui-pl__draw" />
                    </svg>
                  ) : stepStatus === "failed" ? (
                    <svg viewBox="0 0 16 16" className="ui-pl__mark">
                      <path d="M8 4.2v4.4M8 11.6h.01" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" className="ui-pl__mark">
                      <path d="M5 8h6" />
                    </svg>
                  )}
                </span>
                <div className="ui-pl__main">
                  {isRenaming ? (
                    <input
                      className="ui-pl__edit"
                      dir="auto"
                      value={renaming!.value}
                      aria-label={`Rename step ${index + 1}`}
                      autoFocus={true}
                      onFocus={(event: ReactFocusEvent<HTMLInputElement>) => event.currentTarget.select()}
                      onChange={(event: ReactChangeEvent<HTMLInputElement>) =>
                        setRenaming({ id: step.id, value: event.target.value })
                      }
                      onBlur={() => commitRename(true)}
                      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename(true, true);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          commitRename(false, true);
                        }
                      }}
                    />
                  ) : (
                    <span className="ui-pl__name" dir="auto" onDoubleClick={() => beginRename(step.id)}>
                      {step.title}
                    </span>
                  )}
                  {(step.detail || step.tool) && (
                    <span className="ui-pl__sub">
                      {step.detail && <span className="ui-pl__detail" dir="auto">{step.detail}</span>}
                      {step.tool && <code className="ui-pl__tool" title={step.tool}>{step.tool}</code>}
                    </span>
                  )}
                  {!isDraft && <span className="ui-pl__sr">, {STATUS_LABELS[stepStatus]}</span>}
                  {!isDraft && stepStatus === "failed" && (
                    <span className="ui-pl__fail">
                      <span className="ui-pl__error" dir="auto">{step.error ?? "This step failed"}</span>
                      {onRetry && (
                        <button
                          type="button"
                          className="ui-pl__retry"
                          onClick={() => onRetry(step.id)}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M13 8a5 5 0 1 1-1.6-3.7" />
                            <path d="M13 3v2.6h-2.6" />
                          </svg>
                          Retry from here
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <span className="ui-pl__aside">
                  {isDraft ? (
                    <button
                      type="button"
                      className="ui-pl__remove"
                      aria-label={`Remove step ${index + 1}: ${step.title}`}
                      onClick={() => removeStep(step.id)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                  ) : stepStatus === "active" ? (
                    <span className="ui-pl__time" aria-hidden="true">
                      <Elapsed since={activeStart} />
                    </span>
                  ) : stepStatus === "done" && measuredDuration !== undefined ? (
                    <span className="ui-pl__time ui-pl__time--done">
                      <span className="ui-pl__sr">took </span>
                      {formatDuration(measuredDuration)}
                    </span>
                  ) : stepStatus === "skipped" ? (
                    <span className="ui-pl__time" aria-hidden="true">Skipped</span>
                  ) : null}
                </span>
                {index < stepCount - 1 && <span className="ui-pl__rail" aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
        <div className="ui-pl__tail" inert={!isDraft}>
          <div className="ui-pl__tail-inner">
            <label className="ui-pl__add">
              <span className="ui-pl__add-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M8 4.5v7M4.5 8h7" />
                </svg>
              </span>
              <input
                ref={addInputRef}
                value={newTitle}
                placeholder="Add step"
                aria-label="Add a step at the end"
                enterKeyHint="done"
                onChange={(event: ReactChangeEvent<HTMLInputElement>) => setNewTitle(event.target.value)}
                onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addStep();
                  } else if (event.key === "Escape") {
                    setNewTitle("");
                  } else if (event.key === "ArrowUp" && !newTitle) {
                    const last = stepsRef.current[stepsRef.current.length - 1];
                    if (last) {
                      event.preventDefault();
                      focusStepOrAddInput(last.id);
                    }
                  }
                }}
              />
            </label>
          </div>
        </div>
      </div>
      <div className="ui-pl__foot" data-phase={phase} key={phase}>
        {phase === "draft" ? (
          <Fragment>
            <span className="ui-pl__hint" aria-hidden="true">
              Drag to reorder · double-click to rename
            </span>
            <span className="ui-pl__actions">
              {onCancel && (
                <button type="button" className="ui-pl__btn ui-pl__btn--quiet" onClick={onCancel}>
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="ui-pl__btn ui-pl__btn--primary ui-pl__run"
                disabled={!stepCount}
                onClick={() => onRun?.(stepsRef.current)}
              >
                Run plan
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M5.5 3.8v8.4L12 8z" />
                </svg>
              </button>
            </span>
          </Fragment>
        ) : (
          <Fragment>
            <span className="ui-pl__status">
              <span className="ui-pl__status-icon" aria-hidden="true">
                {phase === "running" ? (
                  <SpinnerIcon />
                ) : phase === "done" ? (
                  <svg viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M5.4 8.2 7.2 10l3.4-3.8" pathLength={1} className="ui-pl__draw" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M8 4.9v3.6M8 11h.01" />
                  </svg>
                )}
              </span>
              <span className="ui-pl__status-label">{phaseLabel}</span>
            </span>
            {phase === "running" ? (
              <span className="ui-pl__elapsed" aria-hidden="true">
                <Elapsed since={runStartRef.current ?? undefined} whole={true} />
              </span>
            ) : phase === "done" && onRun ? (
              <span className="ui-pl__actions">
                <button
                  type="button"
                  className="ui-pl__btn ui-pl__btn--quiet ui-pl__again"
                  onClick={() => onRun(stepsRef.current)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
                    <path d="M13 3v2.6h-2.6" />
                  </svg>
                  Run again
                </button>
              </span>
            ) : null}
          </Fragment>
        )}
      </div>
      <p className="ui-pl__sr" role="status" aria-live="polite">
        {liveMessage}
      </p>
    </div>
  );
}

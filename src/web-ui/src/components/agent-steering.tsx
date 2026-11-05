import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { AGENT_STEERING_CSS } from "./agent-steering-css";

/* ---------- formatting & clock ---------- */

const toMs = (v: number | Date): number => (typeof v === "number" ? v : v.getTime());

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "42s" / "3m 05s" / "2h 06m" / "1d 3h". */
const formatLong = (ms: number) => {
  const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${pad2(m % 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** "3.4s" under a minute, then the long form. */
const formatShort = (ms: number) =>
  Number.isFinite(ms) ? (ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatLong(ms)) : "";

const intFmt = new Intl.NumberFormat("en");

/* One 100ms interval shared by every ticking clock on the page. */
const ticker = { subs: new Set<() => void>(), id: 0 };

function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const tick = () => setNow(Date.now());
    tick();
    ticker.subs.add(tick);
    ticker.id ||= window.setInterval(() => ticker.subs.forEach((fn) => fn()), 100);
    return () => {
      ticker.subs.delete(tick);
      if (!ticker.subs.size) {
        window.clearInterval(ticker.id);
        ticker.id = 0;
      }
    };
  }, [live]);
  return now;
}

/** A live elapsed time — ticks while `live`, freezes otherwise. */
const Elapsed = ({ from, live, format }: { from: number; live: boolean; format: (ms: number) => string }) => {
  const now = useNow(live);
  return <>{format(now - from)}</>;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const isApple = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const EASE = "cubic-bezier(0.32, 0.72, 0.24, 1)";

/* ---------- types ---------- */

export type SteerStatus = "running" | "paused" | "done";
export type StepStatus = "done" | "active" | "pending";

export interface SteerNote {
  id: string;
  text: string;
  /** Set when the agent took the note in — "next" at a step start, "now" for an interrupt. */
  picked?: "next" | "now";
}

export interface SteerStep {
  id: string;
  title: string;
  status?: StepStatus;
  /** ms the step took, shown once done. */
  duration?: number;
  /** Give it when the step becomes active, so its clock is right after re-renders. */
  startedAt?: number | Date;
  notes?: SteerNote[];
}

export interface AgentSteeringProps {
  title: string;
  agent?: string;
  steps: SteerStep[];
  queue: SteerNote[];
  status?: SteerStatus;
  startedAt?: number | Date;
  /** ↵ in the field: add the note to your queue. */
  onQueue?: (text: string) => void;
  /** ⌘↵ / Ctrl↵ or "Now" on a queued note — attach it to the active step right away. */
  onInterrupt?: (text: string, queuedId?: string) => void;
  /** ✕ on a queued note. */
  onRemove?: (id: string) => void;
  /** Shows Pause while running and Resume while paused. */
  onPause?: () => void;
  onResume?: () => void;
  /** Controlled field text. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  placeholder?: string;
  className?: string;
}

/* ---------- icons (UI icons are Hugeicons Free, MIT) ---------- */

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z" fill="currentColor" />
    <circle cx="11.6" cy="11.4" r="1.1" fill="currentColor" opacity="0.55" />
  </svg>
);

const StepIcon = ({ status }: { status: StepStatus }) => (
  <span className="ui-stc__step-icon" data-status={status} aria-hidden="true">
    {status === "done" && (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.5" fill="currentColor" />
        <path d="m5.4 8.2 1.8 1.8 3.4-3.7" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
    {status === "active" && (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.6" />
        <path d="M8 2.2a5.8 5.8 0 0 1 5.8 5.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )}
    {status === "pending" && (
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2.2" />
      </svg>
    )}
  </span>
);

const PauseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4.2" y="3.4" width="2.6" height="9.2" rx="0.9" fill="currentColor" />
    <rect x="9.2" y="3.4" width="2.6" height="9.2" rx="0.9" fill="currentColor" />
  </svg>
);

const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5 3.6v8.8c0 .6.6.9 1.1.6l6.6-4.4a.7.7 0 0 0 0-1.2L6.1 3c-.5-.3-1.1 0-1.1.6Z" fill="currentColor" />
  </svg>
);

const BoltIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6.9 1 2.6 6.6h3l-.5 4.4 4.3-5.6h-3L6.9 1Z" fill="currentColor" />
  </svg>
);

const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m3.4 3.4 5.2 5.2M8.6 3.4 3.4 8.6" {...STROKE} />
  </svg>
);

const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 12.6V3.6M4.2 7.2 8 3.4l3.8 3.8" {...STROKE} strokeWidth={1.6} />
  </svg>
);

const CheckSmallIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m2.8 6.2 2 2 4.4-4.6" {...STROKE} strokeWidth={1.5} />
  </svg>
);

const NoteCornerIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 2.4v3.4c0 .9.7 1.6 1.6 1.6h4.6M7.6 5.6l1.8 1.8-1.8 1.8" {...STROKE} strokeWidth={1.2} />
  </svg>
);

/* ---------- component ---------- */

export function AgentSteering({
  title,
  agent,
  steps,
  queue,
  status = "running",
  startedAt,
  onQueue,
  onInterrupt,
  onRemove,
  draft,
  onDraftChange,
  onPause,
  onResume,
  placeholder = "Steer the agent…",
  className,
}: AgentSteeringProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [innerDraft, setInnerDraft] = useState("");
  const text = draft ?? innerDraft;
  const setDraft = (value: string) => {
    setInnerDraft(value);
    onDraftChange?.(value);
  };

  const [announcement, setAnnouncement] = useState("");
  const modKey = isApple() ? "⌘" : "Ctrl";
  const isRunning = status === "running";

  const startedRef = useRef(Date.now());
  const runStartedAt = startedAt === undefined ? startedRef.current : toMs(startedAt);

  const stepStartCache = useRef(new Map<string, number>());
  const stepStart = (step: SteerStep) => {
    if (step.startedAt !== undefined) return toMs(step.startedAt);
    let at = stepStartCache.current.get(step.id);
    if (at === undefined) stepStartCache.current.set(step.id, (at = Date.now()));
    return at;
  };

  const doneCount = steps.filter((s) => s.status === "done").length;
  const canSteer = status !== "done";

  /* FLIP: steps, notes, queued chips and the boxes around them are tracked by key;
     a queued note that becomes a step note glides over (queued:x → note:x). */
  const nodes = useRef(new Map<string, HTMLElement>());
  const trackRef = (key: string) => (el: HTMLElement | null) => {
    el ? nodes.current.set(key, el) : nodes.current.delete(key);
  };
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevCardHeight = useRef(0);

  const signature = JSON.stringify([
    steps.map((s) => [s.id, s.status, s.title, (s.notes ?? []).map((n) => n.id)]),
    queue.map((n) => n.id),
  ]);
  const signatureRef = useRef(signature);

  // Captured during render, before the DOM updates — where everything sits now.
  if (rootRef.current && signature !== signatureRef.current) {
    prevRects.current = new Map(
      [...nodes.current].map(([key, el]) => [key, el.getBoundingClientRect()]),
    );
    prevCardHeight.current = cardRef.current?.offsetHeight ?? 0;
  }

  useLayoutEffect(() => {
    if (signatureRef.current === signature || ((signatureRef.current = signature), prefersReducedMotion()))
      return;
    // The card's height follows its content, so the queue opening never jumps.
    const card = cardRef.current;
    if (card && prevCardHeight.current && Math.abs(card.offsetHeight - prevCardHeight.current) > 1) {
      card.animate(
        [{ height: `${prevCardHeight.current}px` }, { height: `${card.offsetHeight}px` }],
        { duration: 480, easing: EASE },
      );
    }
    for (const [key, el] of nodes.current) {
      const id = key.slice(key.indexOf(":") + 1);
      const before =
        prevRects.current.get(key) ??
        (key.startsWith("note:") ? prevRects.current.get(`queued:${id}`) : undefined);
      const after = el.getBoundingClientRect();
      if (!before) {
        el.animate(
          [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
          { duration: 360, easing: EASE },
        );
        continue;
      }
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const landed = !prevRects.current.has(key); // a queued note arriving in its step
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 2 }, { transform: "none", zIndex: 2 }],
        { duration: landed ? 620 : 480, easing: EASE },
      );
      landed && el.setAttribute("data-landed", "");
    }
  }, [signature]);

  // Announce each note the agent picks up, once.
  const pickedSignature = steps
    .flatMap((s) => (s.notes ?? []).filter((n) => n.picked).map((n) => n.id))
    .join("|");
  const announced = useRef(new Set(pickedSignature.split("|").filter(Boolean)));
  useEffect(() => {
    for (const step of steps)
      for (const note of step.notes ?? [])
        if (note.picked && !announced.current.has(note.id)) {
          announced.current.add(note.id);
          setAnnouncement(`${agent ?? "The agent"} picked up: ${note.text}`);
        }
  }, [pickedSignature]);

  const submit = (interrupt: boolean) => {
    const trimmed = text.trim();
    if (trimmed && canSteer) {
      interrupt ? onInterrupt?.(trimmed) : onQueue?.(trimmed);
      setAnnouncement(interrupt ? `Interrupting: ${trimmed}` : `Queued for the next step: ${trimmed}`);
      setDraft("");
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape" && text) {
      e.stopPropagation();
      setDraft("");
    }
  };

  // The field grows with its content, up to three lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, 60)}px`;
    }
  }, [text]);

  const elapsed = <Elapsed from={runStartedAt} live={isRunning} format={formatLong} />;
  const stateLabel =
    status === "done" ? (
      <>
        Done in {elapsed}
      </>
    ) : status === "paused" ? (
      "Paused"
    ) : (
      <>
        Running · {elapsed}
      </>
    );

  return (
    <div ref={rootRef} className={["ui-stc", className].filter(Boolean).join(" ")} data-status={status}>
      <style href="ui-agent-steering-clean" precedence="default">
        {AGENT_STEERING_CSS}
      </style>
      <div ref={cardRef} className="ui-stc__card">
        <header className="ui-stc__head">
          <span className="ui-stc__spark">
            <SparkIcon />
          </span>
          <div className="ui-stc__heading">
            <span className="ui-stc__title" dir="auto" title={title}>
              {title}
            </span>
            <span className="ui-stc__sub">
              {agent && (
                <>
                  <span className="ui-stc__agent" title={agent}>
                    {agent}
                  </span>
                  {steps.length > 0 && (
                    <span className="ui-stc__dot" aria-hidden="true">
                      ·
                    </span>
                  )}
                </>
              )}
              {steps.length > 0 && (
                <span className="ui-stc__count">
                  {status === "done"
                    ? `${intFmt.format(steps.length)} ${steps.length === 1 ? "step" : "steps"}`
                    : `Step ${intFmt.format(Math.min(doneCount + 1, steps.length))} of ${intFmt.format(steps.length)}`}
                </span>
              )}
            </span>
          </div>
          <span className="ui-stc__state" data-status={status}>
            <span className="ui-stc__pulse" aria-hidden="true" />
            {stateLabel}
          </span>
          {status === "running" && onPause && (
            <button
              type="button"
              className="ui-stc__icon-btn"
              aria-label="Pause the run"
              title="Pause"
              onClick={onPause}
            >
              <PauseIcon />
            </button>
          )}
          {status === "paused" && onResume && (
            <button
              type="button"
              className="ui-stc__icon-btn"
              aria-label="Resume the run"
              title="Resume"
              onClick={onResume}
            >
              <PlayIcon />
            </button>
          )}
        </header>
        {steps.length > 0 && (
          <ol className="ui-stc__plan" aria-label="Plan">
            {steps.map((step) => {
              const stepStatus = step.status ?? "pending";
              return (
                <li
                  key={step.id}
                  ref={trackRef(`step:${step.id}`)}
                  className="ui-stc__step"
                  data-status={stepStatus}
                  aria-current={stepStatus === "active" ? "step" : undefined}
                >
                  <div className="ui-stc__step-row">
                    <StepIcon status={stepStatus} />
                    <span className="ui-stc__step-title" dir="auto" title={step.title}>
                      {step.title}
                    </span>
                    <span className="ui-stc__step-time">
                      {stepStatus === "done" && step.duration !== undefined ? (
                        formatShort(step.duration)
                      ) : stepStatus === "active" && status === "running" ? (
                        <Elapsed from={stepStart(step)} live format={formatShort} />
                      ) : (
                        ""
                      )}
                    </span>
                  </div>
                  {(step.notes ?? []).map((note) => (
                    <div
                      key={note.id}
                      ref={trackRef(`note:${note.id}`)}
                      className="ui-stc__note"
                      data-picked={note.picked ?? undefined}
                    >
                      <NoteCornerIcon />
                      <span className="ui-stc__note-text" dir="auto">
                        {note.text}
                      </span>
                      {note.picked && (
                        <span className="ui-stc__note-tag">
                          <CheckSmallIcon />
                          {note.picked === "now" ? "Interrupted" : "Picked up"}
                        </span>
                      )}
                    </div>
                  ))}
                </li>
              );
            })}
          </ol>
        )}
        {queue.length > 0 && (
          <div className="ui-stc__queue" ref={trackRef("queue:box")}>
            <div className="ui-stc__label">
              Queued for the next step <span>{intFmt.format(queue.length)}</span>
            </div>
            <ul className="ui-stc__queued">
              {queue.map((note) => (
                <li key={note.id} ref={trackRef(`queued:${note.id}`)} className="ui-stc__chip">
                  <span className="ui-stc__chip-text" dir="auto">
                    {note.text}
                  </span>
                  {onInterrupt && canSteer && (
                    <button
                      type="button"
                      className="ui-stc__chip-btn"
                      title={`Apply now (${modKey}↵)`}
                      onClick={() => onInterrupt(note.text, note.id)}
                    >
                      <BoltIcon />
                      Now
                    </button>
                  )}
                  {onRemove && (
                    <button
                      type="button"
                      className="ui-stc__chip-x"
                      aria-label={`Remove “${note.text}”`}
                      onClick={() => onRemove(note.id)}
                    >
                      <XIcon />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="ui-stc__compose" ref={trackRef("compose:box")} data-disabled={canSteer ? undefined : ""}>
          <div
            className="ui-stc__field"
            onClick={(e: ReactMouseEvent<HTMLDivElement>) =>
              !(e.target as HTMLElement).closest("button") &&
              textareaRef.current?.focus({ preventScroll: true })
            }
          >
            <textarea
              ref={textareaRef}
              id={`${uid}-field`}
              rows={1}
              value={text}
              disabled={!canSteer}
              placeholder={canSteer ? placeholder : "The run has finished"}
              aria-label="Steer the agent"
              dir="auto"
              aria-describedby={`${uid}-hint`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button
              type="button"
              className="ui-stc__send"
              aria-label="Queue for the next step"
              disabled={!text.trim() || !canSteer}
              onClick={() => submit(false)}
            >
              <SendIcon />
            </button>
          </div>
          <div className="ui-stc__hint" id={`${uid}-hint`}>
            {canSteer ? (
              <>
                <span>
                  <kbd>↵</kbd> next step
                </span>
                {onInterrupt && (
                  <span>
                    <kbd>{modKey}</kbd>
                    <kbd>↵</kbd> interrupt now
                  </span>
                )}
              </>
            ) : (
              <span>Notes still in the queue were not used</span>
            )}
          </div>
        </div>
      </div>
      <span className="ui-stc__sr" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

export default AgentSteering;

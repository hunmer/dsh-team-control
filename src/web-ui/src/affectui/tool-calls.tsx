import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TOOL_CALLS_CSS } from "./tool-calls-css";

type ToolCallStatus = "running" | "success" | "error";

export interface ToolCallProps {
  name: string;
  summary?: ReactNode;
  icon?: ReactNode;
  status: ToolCallStatus;
  error?: ReactNode;
  args?: unknown;
  result?: unknown;
  startedAt?: number;
  duration?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  openOnError?: boolean;
  onRetry?: () => void;
  maxCodeHeight?: number;
  className?: string;
}

export interface ToolCallGroupProps {
  children: ReactNode;
  label?: string;
  runningLabel?: string;
  duration?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Height at which an expanded code block starts scrolling instead of growing. */
const MAX_SCROLL_HEIGHT = 640;

/* ---------- formatting helpers ---------- */

function formatDuration(ms: number, live: boolean): string {
  if (!live && ms < 1e3) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 6e4) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(seconds / 3600);
  return hours < 24
    ? `${hours}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatValue(value: unknown): { text: string; json: boolean } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
      } catch {
        // fall through: not valid JSON, use the raw string
      }
    }
    return { text: value, json: false };
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? { text: String(value), json: false } : { text, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

const JSON_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlightJson(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = new RegExp(JSON_TOKEN_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1] && match[2]) {
      parts.push(
        <span className="ui-tc__t-key" key={match.index}>
          {match[1]}
        </span>,
        match[2],
      );
    } else {
      const kind = match[1] ? "str" : /^[tfn]/.test(match[0]) ? "lit" : "num";
      parts.push(
        <span className={`ui-tc__t-${kind}`} key={match.index}>
          {match[0]}
        </span>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(fallback);
    fallback.select();
    const ok = document.execCommand("copy");
    fallback.remove();
    return ok;
  }
}

/**
 * Ticks every 100ms while `running` and returns the elapsed milliseconds.
 * With `accumulate` false the timer resets each time running turns true;
 * with it true (the group case) elapsed time accumulates across runs.
 */
function useElapsed(running: boolean, startedAt: number | undefined, accumulate: boolean): number | null {
  const markRef = useRef<number | null>(null);
  const accruedRef = useRef(0);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!running) {
      if (markRef.current !== null) {
        accruedRef.current += Date.now() - markRef.current;
        markRef.current = null;
        setElapsed(accruedRef.current);
      }
      return;
    }
    if (!accumulate) accruedRef.current = 0;
    markRef.current = startedAt ?? Date.now();
    const tick = () => setElapsed(accruedRef.current + Date.now() - (markRef.current ?? Date.now()));
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [running, startedAt, accumulate]);

  return elapsed;
}

/* ---------- icons ---------- */

function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="M10.2 2.4a3.5 3.5 0 0 0-4.3 4.6L2.6 10.3a1.4 1.4 0 0 0 2 2L7.9 9a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.6-.4-.4-1.6 1.7-2.3Z" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="ui-tc__spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25a5.75 5.75 0 0 1 5.75 5.75" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="ui-tc__err" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.4M8 10.9v.1" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="ui-tc__chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.25 8 9.75l3.5-3.5" />
    </svg>
  );
}

/* ---------- pieces ---------- */

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="ui-tc__copy"
      data-copied={copied || undefined}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      <svg className="ui-tc__copy-icon" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.25" y="5.25" width="8" height="8" rx="2" />
        <path d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-4.5a2 2 0 0 0-2 2v4.5a1.5 1.5 0 0 0 1.5 1.5h1" />
      </svg>
      <svg className="ui-tc__copy-done" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
      </svg>
    </button>
  );
}

function ValueSection({ label, value, cap }: { label: string; value: unknown; cap: number }) {
  const { text, json } = formatValue(value);
  const preRef = useRef<HTMLPreElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);

  useLayoutEffect(() => {
    const pre = preRef.current;
    const inner = pre?.firstElementChild;
    if (!pre || !inner) return;
    const measure = () => setContentHeight(pre.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [text]);

  const capped = contentHeight > cap + 24;
  return (
    <div className="ui-tc__section">
      <div className="ui-tc__section-head">
        <span className="ui-tc__label">{label}</span>
        <CopyButton text={text} label={label.toLowerCase()} />
      </div>
      <pre
        ref={preRef}
        className="ui-tc__code"
        data-capped={(capped && !expanded) || undefined}
        data-scroll={(capped && expanded && contentHeight > MAX_SCROLL_HEIGHT) || undefined}
        style={capped ? { maxHeight: expanded ? Math.min(contentHeight, MAX_SCROLL_HEIGHT) : cap } : undefined}
      >
        <code>{json ? highlightJson(text) : text}</code>
      </pre>
      {capped && (
        <button
          type="button"
          className="ui-tc__more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/* ---------- components ---------- */

export function ToolCall({
  name,
  summary,
  icon,
  status,
  args,
  result,
  error,
  startedAt,
  duration,
  defaultOpen = false,
  open,
  onOpenChange,
  openOnError = true,
  onRetry,
  maxCodeHeight = 220,
  className,
}: ToolCallProps) {
  const bodyId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const [lastStatus, setLastStatus] = useState(status);
  const [autoOpened, setAutoOpened] = useState(false);
  if (status !== lastStatus) {
    setLastStatus(status);
    if (open === undefined && openOnError) {
      if (status === "error" && !uncontrolledOpen) {
        setUncontrolledOpen(true);
        setAutoOpened(true);
      } else if (lastStatus === "error" && autoOpened) {
        setUncontrolledOpen(false);
        setAutoOpened(false);
      }
    }
  }

  const runningElapsed = useElapsed(status === "running", startedAt, false);
  const shownDuration =
    status === "running" ? (runningElapsed ?? 0) : (duration ?? runningElapsed);

  const liveText =
    status === "running"
      ? `${name} running`
      : status === "success"
        ? `${name} finished`
        : `${name} failed${error ? `: ${error}` : ""}`;

  return (
    <div
      className={["ui-tc", className].filter(Boolean).join(" ")}
      data-status={status}
      data-open={isOpen || undefined}
    >
      <style href="ui-tool-call" precedence="default">
        {TOOL_CALLS_CSS}
      </style>
      <span className="ui-tc-sr" role="status" aria-live="polite">
        {liveText}
      </span>
      <button
        type="button"
        className="ui-tc__head"
        aria-expanded={isOpen}
        aria-controls={`${bodyId}-body`}
        onClick={() => {
          setAutoOpened(false);
          setOpen(!isOpen);
        }}
      >
        <span className="ui-tc__icon" aria-hidden="true">
          {icon ?? <WrenchIcon />}
        </span>
        <span className="ui-tc__main">
          <code className="ui-tc__name" title={name}>
            {name}
          </code>
          {summary != null && (
            <span className="ui-tc__summary" dir="auto" title={typeof summary === "string" ? summary : undefined}>
              {summary}
            </span>
          )}
        </span>
        <span className="ui-tc__status" key={status}>
          {status === "running" && <SpinnerIcon />}
          {status === "success" && (
            <svg className="ui-tc__ok" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
            </svg>
          )}
          {status === "error" && <ErrorIcon />}
          <span className="ui-tc__time">
            {status === "error" ? "Failed" : shownDuration == null ? null : formatDuration(shownDuration, status === "running")}
          </span>
        </span>
        <ChevronIcon />
      </button>
      <div className="ui-tc__body" id={`${bodyId}-body`} inert={!isOpen}>
        <div className="ui-tc__clip">
          <div className="ui-tc__sections">
            {status === "error" && (
              <div className="ui-tc__error">
                <ErrorIcon />
                <p className="ui-tc__error-text" dir="auto">
                  {error ?? "The tool call failed."}
                </p>
                {onRetry && (
                  <button type="button" className="ui-tc__retry" onClick={onRetry}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77" />
                      <path d="M2.5 2.5v2.75h2.75" />
                    </svg>
                    Retry
                  </button>
                )}
              </div>
            )}
            {args !== undefined && <ValueSection label="Arguments" value={args} cap={maxCodeHeight} />}
            {result === undefined ? (
              status === "running" ? (
                <div className="ui-tc__section">
                  <div className="ui-tc__section-head">
                    <span className="ui-tc__label">Result</span>
                  </div>
                  <p className="ui-tc__pending">Waiting for result…</p>
                </div>
              ) : null
            ) : (
              <ValueSection label="Result" value={result} cap={maxCodeHeight} />
            )}
            {args === undefined && result === undefined && status === "success" && (
              <p className="ui-tc__pending">No arguments or result.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ToolCallGroup({
  children,
  label,
  runningLabel = "Using tools…",
  duration,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: ToolCallGroupProps) {
  const listId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;

  const items = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => child.props as ToolCallProps);
  const anyRunning = items.some((item) => item.status === "running");
  const failedCount = items.filter((item) => item.status === "error").length;

  const groupElapsed = useElapsed(
    anyRunning,
    items.reduce<number | undefined>(
      (earliest, item) =>
        item.status === "running" && item.startedAt != null && (earliest == null || item.startedAt < earliest)
          ? item.startedAt
          : earliest,
      undefined,
    ),
    true,
  );
  const childTotal =
    items.length > 0 && items.every((item) => item.duration != null)
      ? items.reduce((total, item) => total + (item.duration ?? 0), 0)
      : null;
  const shownDuration = anyRunning ? groupElapsed : (duration ?? childTotal ?? groupElapsed);

  const countText = `Used ${items.length.toLocaleString("en-US")} ${items.length === 1 ? "tool" : "tools"}`;
  const titleText = anyRunning ? runningLabel : (label ?? countText);
  const lastItems = items.slice(-3);

  return (
    <div
      className={["ui-tc-group", className].filter(Boolean).join(" ")}
      data-running={anyRunning || undefined}
      data-open={isOpen || undefined}
    >
      <style href="ui-tool-call" precedence="default">
        {TOOL_CALLS_CSS}
      </style>
      <span className="ui-tc-sr" role="status" aria-live="polite">
        {anyRunning ? runningLabel : `${countText}${failedCount ? `, ${failedCount} failed` : ""}`}
      </span>
      <button
        type="button"
        className="ui-tc-group__head"
        aria-expanded={isOpen}
        aria-controls={`${listId}-list`}
        onClick={() => {
          if (open === undefined) setUncontrolledOpen(!isOpen);
          onOpenChange?.(!isOpen);
        }}
      >
        <span className="ui-tc-group__stack" aria-hidden="true">
          {lastItems.map((item, index) => (
            <span className="ui-tc__icon" key={items.length - lastItems.length + index}>
              {item.icon ?? <WrenchIcon />}
            </span>
          ))}
        </span>
        <span className="ui-tc-group__title" key={anyRunning ? "busy" : "done"}>
          <span
            className={anyRunning ? "ui-tc-group__label ui-tc__shine" : "ui-tc-group__label"}
            data-text={titleText}
          >
            {titleText}
          </span>
          {!anyRunning && failedCount > 0 && (
            <span className="ui-tc-group__failed">· {failedCount} failed</span>
          )}
          {shownDuration != null && (
            <span className="ui-tc-group__time">· {formatDuration(shownDuration, anyRunning)}</span>
          )}
        </span>
        <ChevronIcon />
      </button>
      <div className="ui-tc__body" id={`${listId}-list`} inert={!isOpen}>
        <div className="ui-tc__clip">
          <div className="ui-tc-group__list">{children}</div>
        </div>
      </div>
    </div>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LOADER_CSS } from "./loader-css";

const DEFAULT_PHASES: string[] = [
  "Thinking",
  "Searching the web",
  "Reading sources",
  "Writing response",
];

const RAY_COUNT = 8;
const RAYS: number[] = Array.from({ length: RAY_COUNT }, (_unused, index: number) => index);

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type RunLoaderSize = "sm" | "md";
export type RunLoaderVariant = "pill" | "plain";

export interface RunLoaderProps {
  /** Extra class appended to the root `.ui-tl` element. */
  className?: string;
  size?: RunLoaderSize;
  /** Phase labels to roll through while running. */
  phases?: string[];
  /** Controlled phase index; when finite it overrides the internal interval counter. */
  phase?: number;
  /** Milliseconds between automatic phase advances (min 200, default 2200). */
  interval?: number;
  /** Keep cycling back to the first phase instead of stopping at the last. */
  loop?: boolean;
  /** When true the spinner swaps to a check mark and `doneLabel` is shown. */
  done?: boolean;
  /** Label (or label builder) shown when `done`. Receives elapsed seconds. */
  doneLabel?: string | ((elapsedSeconds: number) => string);
  variant?: RunLoaderVariant;
}

export function RunLoader({
  phases = DEFAULT_PHASES,
  interval = 2200,
  phase,
  loop = false,
  done = false,
  doneLabel = (elapsedSeconds: number): string => `Thought for ${formatDuration(elapsedSeconds)}`,
  size = "md",
  variant = "pill",
  className,
}: RunLoaderProps): ReactNode {
  const labelList: string[] = Array.isArray(phases)
    ? phases.map((phaseLabel: unknown) => String(phaseLabel ?? ""))
    : [];
  const safeLabels: string[] = labelList.length ? labelList : DEFAULT_PHASES.slice(0, 1);
  const safeInterval: number =
    Number.isFinite(interval) && interval > 0 ? Math.max(interval, 200) : 2200;

  const [tick, setTick] = useState<number>(0);
  const [startedAt, setStartedAt] = useState<number>(() => Date.now());
  const [frozenSeconds, setFrozenSeconds] = useState<number | null>(null);

  const elapsedSeconds: number =
    frozenSeconds ?? Math.max(1, Math.round((Date.now() - startedAt) / 1000));

  if (done && frozenSeconds === null) {
    setFrozenSeconds(elapsedSeconds);
  }
  if (!done && frozenSeconds !== null) {
    setFrozenSeconds(null);
    setStartedAt(Date.now());
    setTick(0);
  }

  useEffect(() => {
    if (done || (phase !== undefined && Number.isFinite(phase)) || safeLabels.length < 2) return;
    const timer = window.setInterval(() => {
      setTick((current: number) =>
        current + 1 < safeLabels.length ? current + 1 : loop ? 0 : current,
      );
    }, safeInterval);
    return () => window.clearInterval(timer);
  }, [done, phase, safeLabels.length, safeInterval, loop]);

  const activeIndex: number = Math.min(
    Math.max(phase !== undefined && Number.isFinite(phase) ? Math.floor(phase) : tick, 0),
    Math.max(safeLabels.length - 1, 0),
  );

  const nextText: string = String(
    (done ? (typeof doneLabel === "function" ? doneLabel(elapsedSeconds) : doneLabel) : safeLabels[activeIndex]) ?? "",
  );

  const [current, setCurrent] = useState<{ key: number; text: string }>({ key: 0, text: nextText });
  const [outgoing, setOutgoing] = useState<{ key: number; text: string } | null>(null);

  if (nextText !== current.text) {
    setOutgoing(current);
    setCurrent({ key: current.key + 1, text: nextText });
  }

  const rootRef = useRef<HTMLSpanElement | null>(null);
  const textBoxRef = useRef<HTMLSpanElement | null>(null);
  const innerLabelRef = useRef<HTMLSpanElement | null>(null);
  const firstLayoutRunRef = useRef<boolean>(false);
  const measureRef = useRef<() => void>(() => {});

  measureRef.current = (): void => {
    const root = rootRef.current;
    const textBox = textBoxRef.current;
    const innerLabel = innerLabelRef.current;
    if (!root || !textBox || !innerLabel) return;

    const requiredWidth = innerLabel.scrollWidth + 1;
    const parent = root.parentElement;
    const saved = { width: textBox.style.width, transition: textBox.style.transition };

    textBox.style.transition = "none";
    textBox.style.width = `${requiredWidth}px`;

    const parentStyle = parent ? getComputedStyle(parent) : null;
    const availableWidth =
      parent && parentStyle
        ? parent.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight)
        : 0;
    const maxBoxWidth =
      parent ? Math.floor(availableWidth - (root.offsetWidth - textBox.offsetWidth)) : requiredWidth;

    textBox.style.width = saved.width;
    textBox.getBoundingClientRect();
    textBox.style.transition = saved.transition;

    const isCut = maxBoxWidth > 0 && requiredWidth > maxBoxWidth;

    root.toggleAttribute("data-cut", isCut);
    textBox.style.width = `${isCut ? maxBoxWidth : requiredWidth}px`;
  };

  useLayoutEffect(() => {
    const textBox = textBoxRef.current;
    if (!textBox) return;
    if (!firstLayoutRunRef.current) {
      textBox.style.transition = "none";
    }
    measureRef.current();
    firstLayoutRunRef.current ||= ((textBox.getBoundingClientRect(), (textBox.style.transition = ``), true));
  }, [current.key]);

  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={rootRef}
      className={["ui-tl", className].filter(Boolean).join(" ")}
      data-size={size}
      data-variant={variant}
      data-done={done || undefined}
      role="status"
      aria-live="polite"
    >
      <style href="ui-thinking-loader" precedence="default">
        {LOADER_CSS}
      </style>
      <span className="ui-tl__icon" aria-hidden="true">
        <svg className="ui-tl__spinner" viewBox="0 0 16 16">
          {RAYS.map((rayIndex: number) => (
            <line
              key={rayIndex}
              x1="8"
              y1="1.75"
              x2="8"
              y2="4.75"
              transform={`rotate(${rayIndex * 45} 8 8)`}
              style={{ animationDelay: `${(rayIndex - RAY_COUNT) * 100}ms` }}
            />
          ))}
        </svg>
        <svg className="ui-tl__check" viewBox="0 0 16 16">
          <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
        </svg>
      </span>
      <span ref={textBoxRef} className="ui-tl__text">
        {outgoing && (
          <span
            key={outgoing.key}
            className="ui-tl__label ui-tl__label--out"
            aria-hidden="true"
            dir="auto"
            onAnimationEnd={(): void => setOutgoing(null)}
          >
            {outgoing.text}
          </span>
        )}
        <span
          key={current.key}
          ref={innerLabelRef}
          className={["ui-tl__label", current.key > 0 && "ui-tl__label--in", !done && "ui-tl__shine"]
            .filter(Boolean)
            .join(" ")}
          data-text={current.text}
          title={current.text}
          dir="auto"
        >
          {current.text}
        </span>
      </span>
    </span>
  );
}

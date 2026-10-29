import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { APPROVAL_CARD_CSS } from "./approval-card-css";
import { Button } from "@/components/ui/button";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type DenyReason = "user" | "timeout";

export type ApprovalRisk = "low" | "medium" | "high";

export type ApprovalCardActions = "card" | "tray";

export interface ApprovalDetail {
  label: ReactNode;
  value: ReactNode;
}

export interface ApprovalCardProps {
  /** Card heading; rendered as text and used as the native `title` tooltip. */
  title: string;
  description?: ReactNode;
  /** Risk level shown as a colored badge; omitted when falsy. */
  risk?: ApprovalRisk;
  /** Custom leading icon; defaults to an inline shield/check SVG. */
  icon?: ReactNode;
  /** Key/value rows rendered as a `<dl>` under the title. */
  details?: ApprovalDetail[];
  /** Arbitrary content rendered above `details` inside the preview area. */
  preview?: ReactNode;
  /** Alias for `preview` when `preview` is not provided. */
  children?: ReactNode;
  /** Controlled status; when omitted the component manages its own state. */
  status?: ApprovalStatus;
  defaultStatus?: ApprovalStatus;
  onApprove?: (options: { always: boolean }) => void | Promise<void>;
  onDeny?: (options: { reason: DenyReason }) => void;
  onEdit?: () => void;
  /** Seconds until the request auto-denies; 0 or omitted disables the timer. */
  expiresIn?: number;
  onExpire?: () => void;
  allowAlways?: boolean;
  alwaysLabel?: string;
  approveLabel?: string;
  denyLabel?: string;
  editLabel?: string;
  /** Show keyboard shortcut hints on the buttons. */
  shortcuts?: boolean;
  /** Small label strip above the card; `data-label` is set when present. */
  label?: ReactNode;
  /** Where the action buttons render: inside the card or in the outer tray. */
  actions?: ApprovalCardActions;
  className?: string;
}

const RISK_LABELS: Record<ApprovalRisk, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

function formatSeconds(totalSeconds: number): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return totalSeconds < 3600
    ? `${Math.floor(totalSeconds / 60)}:${pad(totalSeconds % 60)}`
    : `${Math.floor(totalSeconds / 3600)}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`;
}

function describeSeconds(totalSeconds: number): string {
  const [amount, unit] =
    totalSeconds < 120
      ? [totalSeconds, "second"]
      : totalSeconds < 7200
        ? [Math.round(totalSeconds / 60), "minute"]
        : [Math.round(totalSeconds / 3600), "hour"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function formatAgo(resolvedAt: number): string {
  const elapsed = Math.floor((Date.now() - resolvedAt) / 1e3);
  return elapsed < 60
    ? "just now"
    : elapsed < 3600
      ? `${Math.floor(elapsed / 60)} min ago`
      : elapsed < 86400
        ? `${Math.floor(elapsed / 3600)} h ago`
        : `${Math.floor(elapsed / 86400)} d ago`;
}

export function ApprovalCard({
  title,
  description,
  risk,
  icon,
  details,
  preview,
  children,
  status,
  defaultStatus = "pending",
  onApprove,
  onDeny,
  onEdit,
  expiresIn,
  onExpire,
  allowAlways = true,
  alwaysLabel = "Always allow this action",
  approveLabel = "Approve",
  denyLabel = "Deny",
  editLabel = "Edit",
  shortcuts = true,
  label,
  actions = "tray",
  className,
}: ApprovalCardProps) {
  const id = useId();
  const [internalStatus, setInternalStatus] = useState<ApprovalStatus>(defaultStatus);
  const effectiveStatus: ApprovalStatus = status ?? internalStatus;
  const resolved = effectiveStatus !== "pending";
  const [alwaysChecked, setAlwaysChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denyReason, setDenyReason] = useState<DenyReason>("user");
  const [resolvedAt, setResolvedAt] = useState<number | null>(() => (resolved ? Date.now() : null));
  const [liveMessage, setLiveMessage] = useState("");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [modKey, setModKey] = useState("⌘");
  const [prevStatus, setPrevStatus] = useState<ApprovalStatus>(effectiveStatus);
  const [pendingLeaving, setPendingLeaving] = useState(false);
  const [pendingEntering, setPendingEntering] = useState(false);
  // Render-phase state sync: reset pending-phase state whenever the status changes.
  if (prevStatus !== effectiveStatus) {
    setPrevStatus(effectiveStatus);
    if (effectiveStatus === "pending") {
      setPendingLeaving(false);
      setPendingEntering(true);
      setAlwaysChecked(false);
      setBusy(false);
      setDenyReason("user");
      setResolvedAt(null);
      setLiveMessage("");
    } else {
      setPendingLeaving(prevStatus === "pending");
      setPendingEntering(false);
      setResolvedAt(Date.now());
      setLiveMessage(
        `${effectiveStatus === "approved" ? "Approved" : denyReason === "timeout" ? "Expired" : "Denied"}: ${title}`,
      );
    }
  }

  const rootRef = useRef<HTMLDivElement | null>(null);
  const resolvedRef = useRef<HTMLDivElement | null>(null);
  const approveButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusResolvedRef = useRef(false);

  useEffect(() => {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform ??
      "";
    if (!/mac|iphone|ipad|ipod/i.test(platform || navigator.userAgent)) setModKey("Ctrl");
  }, []);

  const handleApprove = async (): Promise<void> => {
    if (resolved || busy) return;
    const result = onApprove?.({ always: alwaysChecked });
    if (result && typeof result.then === "function") {
      setBusy(true);
      try {
        await result;
      } catch {
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    if (status === undefined) setInternalStatus("approved");
  };

  const handleDeny = (reason: DenyReason = "user"): void => {
    if (resolved || (busy && reason === "user")) return;
    setDenyReason(reason);
    if (reason === "timeout") onExpire?.();
    onDeny?.({ reason });
    if (status === undefined) setInternalStatus("denied");
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (resolved || busy || event.defaultPrevented) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleApprove();
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleDeny("user");
    }
  };

  const expireDelayMs = expiresIn && expiresIn > 0 ? expiresIn * 1e3 : 0;
  const remainingRef = useRef(expireDelayMs);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(expireDelayMs / 1e3));
  const expireFnRef = useRef((): void => {});
  useLayoutEffect(() => {
    expireFnRef.current = () => handleDeny("timeout");
  });
  useEffect(() => {
    if (effectiveStatus === "pending") {
      remainingRef.current = expireDelayMs;
      setSecondsLeft(Math.ceil(expireDelayMs / 1e3));
    }
  }, [effectiveStatus, expireDelayMs]);

  const timerPaused = hovered || focused || busy;
  useEffect(() => {
    if (!expireDelayMs || resolved || timerPaused) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      remainingRef.current -= now - last;
      last = now;
      setSecondsLeft(Math.max(0, Math.ceil(remainingRef.current / 1e3)));
      if (remainingRef.current <= 0) {
        expireFnRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [expireDelayMs, resolved, timerPaused]);

  const cardHeightRef = useRef(0);
  const heightAnimatingRef = useRef(false);
  const heightInitializedRef = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!heightAnimatingRef.current) cardHeightRef.current = root.offsetHeight;
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!heightInitializedRef.current) {
      heightInitializedRef.current = true;
      cardHeightRef.current = root.offsetHeight;
      return;
    }
    const activeElement = document.activeElement;
    if (resolved && activeElement && root.contains(activeElement)) {
      resolvedRef.current?.focus({ preventScroll: true });
    }
    if (!resolved && refocusResolvedRef.current) {
      approveButtonRef.current?.focus({ preventScroll: true });
    }
    refocusResolvedRef.current = false;
    const previousHeight = cardHeightRef.current;
    root.style.height = "";
    const nextHeight = root.offsetHeight;
    if (!previousHeight || previousHeight === nextHeight) return;
    heightAnimatingRef.current = true;
    root.style.height = `${previousHeight}px`;
    root.offsetHeight;
    root.style.height = `${nextHeight}px`;
    const timer = window.setTimeout(() => {
      root.style.height = "";
      heightAnimatingRef.current = false;
      cardHeightRef.current = root.offsetHeight;
    }, 560);
    return () => {
      window.clearTimeout(timer);
      root.style.height = "";
      heightAnimatingRef.current = false;
    };
  }, [resolved]);

  // Re-render resolved rows every 30s so relative timestamps stay fresh.
  const [, setResolvedTick] = useState(0);
  useEffect(() => {
    if (!resolved) return;
    const interval = window.setInterval(() => setResolvedTick((tick) => tick + 1), 3e4);
    return () => window.clearInterval(interval);
  }, [resolved]);

  const titleId = `${id}-title`;
  const rowTitleId = `${id}-row`;
  const descId = `${id}-desc`;
  const timerId = `${id}-timer`;
  const customContent: ReactNode = preview ?? children;
  const resolveWord =
    effectiveStatus === "approved" ? "Approved" : denyReason === "timeout" ? "Expired" : "Denied";
  const describedBy = [description ? descId : null, expireDelayMs && !resolved ? timerId : null]
    .filter(Boolean)
    .join(" ");

  const footer = (
    <div className="ui-ap__foot">
      {expireDelayMs > 0 && (
        <span
          className="ui-ap__expires"
          data-paused={timerPaused || undefined}
          data-low={secondsLeft <= 10 || undefined}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3.2l2 1.3" />
          </svg>
          Expires in {formatSeconds(secondsLeft)}
        </span>
      )}
      <div className="ui-ap__actions">
        {onEdit && (
          <Button
            className="panel-coss"
            variant="ghost"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={() => !busy && onEdit()}
          >
            {editLabel}
          </Button>
        )}
        <Button
          className="panel-coss"
          variant="outline"
          size="sm"
          aria-keyshortcuts="Escape"
          aria-disabled={busy || undefined}
          onClick={() => handleDeny("user")}
        >
          {denyLabel}
          {shortcuts && (
            <kbd className="ui-ap__kbd" aria-hidden="true">
              Esc
            </kbd>
          )}
        </Button>
        <Button
          ref={approveButtonRef}
          className="panel-coss ui-ap__approve"
          size="sm"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          aria-disabled={busy || undefined}
          onClick={() => void handleApprove()}
        >
          {approveLabel}
          {busy ? (
            <svg className="ui-ap__spinner" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
            </svg>
          ) : (
            shortcuts && (
              <kbd className="ui-ap__kbd" aria-hidden="true">
                {modKey === "⌘" ? "⌘↵" : "Ctrl ↵"}
              </kbd>
            )
          )}
        </Button>
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={["ui-ap", className].filter(Boolean).join(" ")}
      role="group"
      aria-labelledby={resolved ? rowTitleId : titleId}
      aria-describedby={describedBy || undefined}
      aria-busy={busy || undefined}
      data-status={effectiveStatus}
      data-busy={busy || undefined}
      data-label={label ? "" : undefined}
      data-actions={actions}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <style href="ui-approval-card" precedence="default">
        {APPROVAL_CARD_CSS}
      </style>
      {label && (
        <div className="ui-ap__label" title={typeof label === "string" ? label : undefined}>
          {label}
        </div>
      )}
      {(!resolved || pendingLeaving) && (
        <div
          className="ui-ap__pending"
          data-leaving={pendingLeaving || undefined}
          data-entering={pendingEntering || undefined}
          inert={pendingLeaving}
          aria-hidden={pendingLeaving || undefined}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) {
              if (pendingLeaving) setPendingLeaving(false);
              if (pendingEntering) setPendingEntering(false);
            }
          }}
        >
          <div className="ui-ap__card">
            <div className="ui-ap__head">
              <span className="ui-ap__icon" aria-hidden="true">
                {icon ?? (
                  <svg viewBox="0 0 24 24">
                    <path d="M12 3 5 5.8v5.4c0 4.3 2.9 8.2 7 9.8 4.1-1.6 7-5.5 7-9.8V5.8L12 3Z" />
                    <path d="m9.2 12.2 2 2 3.8-4" />
                  </svg>
                )}
              </span>
              <div className="ui-ap__titles">
                <h3
                  className="ui-ap__title"
                  dir="auto"
                  title={title}
                  id={pendingLeaving ? undefined : titleId}
                >
                  {title}
                </h3>
                {description && (
                  <p
                    className="ui-ap__desc"
                    dir="auto"
                    title={typeof description === "string" ? description : undefined}
                    id={pendingLeaving ? undefined : descId}
                  >
                    {description}
                  </p>
                )}
              </div>
              {risk && (
                <span className="ui-ap__risk" data-risk={risk}>
                  <span className="ui-ap__risk-dot" aria-hidden="true" />
                  {RISK_LABELS[risk]}
                  <span className="ui-ap__risk-word"> risk</span>
                </span>
              )}
            </div>
            {(customContent || details?.length) && (
              <div className="ui-ap__preview">
                {customContent && <div className="ui-ap__custom">{customContent}</div>}
                {details?.length ? (
                  <dl className="ui-ap__details">
                    {details.map((detail, index) => (
                      <div className="ui-ap__detail" key={String(detail.label) + index}>
                        <dt>{detail.label}</dt>
                        <dd dir="auto">{detail.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            )}
            {allowAlways && (
              <label className="ui-ap__always">
                <span className="ui-ap__box">
                  <input
                    type="checkbox"
                    checked={alwaysChecked}
                    disabled={busy}
                    onChange={(event) => setAlwaysChecked(event.target.checked)}
                  />
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 8.3 6.8 11 12 5.2" />
                  </svg>
                </span>
                <span className="ui-ap__always-label">{alwaysLabel}</span>
              </label>
            )}
            {actions === "card" && footer}
          </div>
          {actions === "tray" && footer}
          {expireDelayMs > 0 && (
            <span className="ui-ap__sr" id={pendingLeaving ? undefined : timerId}>
              Expires in {describeSeconds(secondsLeft)} unless approved. The timer pauses while the
              card is hovered or focused.
            </span>
          )}
        </div>
      )}
      {resolved && (
        <div
          ref={resolvedRef}
          className="ui-ap__card ui-ap__resolved"
          tabIndex={-1}
          data-status={effectiveStatus}
          onFocus={() => {
            refocusResolvedRef.current = true;
          }}
          onBlur={(event) => {
            if (event.relatedTarget || event.currentTarget.isConnected) {
              refocusResolvedRef.current = false;
            }
          }}
        >
          <span className="ui-ap__mark" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              {effectiveStatus === "approved" ? (
                <path d="M4.2 8.4 6.9 11 11.8 5.6" pathLength={1} />
              ) : (
                <path d="M5.2 5.2 10.8 10.8M10.8 5.2 5.2 10.8" pathLength={1} />
              )}
            </svg>
          </span>
          <span className="ui-ap__row-title" dir="auto" title={title} id={rowTitleId}>
            {title}
          </span>
          <span className="ui-ap__row-status">
            {resolveWord}
            {effectiveStatus === "approved" && alwaysChecked && (
              <span className="ui-ap__row-extra"> · Always</span>
            )}
            {resolvedAt !== null && <span className="ui-ap__row-time"> · {formatAgo(resolvedAt)}</span>}
          </span>
        </div>
      )}
      <span className="ui-ap__sr" role="status" aria-live="polite">
        {liveMessage}
      </span>
    </div>
  );
}

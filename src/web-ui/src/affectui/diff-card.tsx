import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DIFF_CARD_CSS } from "./diff-card-css";

type Decision = "accepted" | "rejected";

type TokenOp = 0 | 1 | 2; // 0 = equal, 1 = removed (from original), 2 = inserted (from suggested)

type TokenEdit = { t: TokenOp; s: string };

type DiffSegment =
  | { type: "equal"; text: string }
  | { type: "change"; remove: string; insert: string };

type RawChange = { seg: number; type?: "change"; remove: string; insert: string };

/** Splits on whitespace, words (letters/marks/numbers/_/apostrophes), emoji ZWJ sequences, regional-indicator pairs, or punctuation runs. */
const TOKEN_RE = new RegExp(
  `\\s+|[\\p{L}\\p{M}\\p{N}_'’]+|\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}\\uFE0F\\u20E3]*(?:\\u200D\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}\\uFE0F]*)*|\\p{Regional_Indicator}{2}|[^\\s\\p{L}\\p{N}_]\\p{M}*`,
  "gu",
);

const isWhitespaceOnly = (token: string): boolean => /^\s+$/.test(token);

/**
 * Myers diff over token arrays with an edit-distance budget. Returns the edit
 * script, or null when the budget was exhausted before reaching the end.
 */
function myersDiff(fromTokens: string[], toTokens: string[], maxCost: number = 1500): TokenEdit[] | null {
  const fromLen = fromTokens.length;
  const toLen = toTokens.length;
  const center = fromLen + toLen + 1;
  const frontier = new Int32Array(2 * center + 1);
  const frontierSnapshots: Int32Array[] = [];
  let finalCost = -1;

  for (let cost = 0; cost <= Math.min(maxCost, fromLen + toLen) && finalCost < 0; cost++) {
    frontierSnapshots.push(frontier.slice(center - cost - 1, center + cost + 2));
    for (let k = -cost; k <= cost; k += 2) {
      let x =
        k === -cost || (k !== cost && frontier[center + k - 1] < frontier[center + k + 1])
          ? frontier[center + k + 1]
          : frontier[center + k - 1] + 1;
      let y = x - k;
      for (; x < fromLen && y < toLen && fromTokens[x] === toTokens[y];) {
        x++;
        y++;
      }
      frontier[center + k] = x;
      if (x >= fromLen && y >= toLen) {
        finalCost = cost;
        break;
      }
    }
  }
  if (finalCost < 0) return null;

  const edits: TokenEdit[] = [];
  let x = fromLen;
  let y = toLen;
  for (let cost = finalCost; cost > 0; cost--) {
    const snapshot = frontierSnapshots[cost];
    const at = (k: number): number => snapshot[k + cost + 1];
    const k = x - y;
    const down = k === -cost || (k !== cost && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    for (; x > prevX && y > prevY;) {
      x--;
      y--;
      edits.push({ t: 0, s: fromTokens[x] });
    }
    if (down) {
      y--;
      edits.push({ t: 2, s: toTokens[y] });
    } else {
      x--;
      edits.push({ t: 1, s: fromTokens[x] });
    }
  }
  for (; x > 0 && y > 0;) {
    x--;
    y--;
    edits.push({ t: 0, s: fromTokens[x] });
  }
  return edits.reverse();
}

/** Word-level diff between the two texts: LCS for small inputs, budgeted Myers for large ones. */
function diffTextToSegments(original: string, suggested: string): DiffSegment[] {
  const fromTokens = original.match(TOKEN_RE) ?? [];
  const toTokens = suggested.match(TOKEN_RE) ?? [];

  let sharedPrefix = 0;
  while (
    sharedPrefix < fromTokens.length &&
    sharedPrefix < toTokens.length &&
    fromTokens[sharedPrefix] === toTokens[sharedPrefix]
  ) {
    sharedPrefix++;
  }
  let sharedSuffix = 0;
  while (
    sharedSuffix < fromTokens.length - sharedPrefix &&
    sharedSuffix < toTokens.length - sharedPrefix &&
    fromTokens[fromTokens.length - 1 - sharedSuffix] === toTokens[toTokens.length - 1 - sharedSuffix]
  ) {
    sharedSuffix++;
  }

  const fromMiddle = fromTokens.slice(sharedPrefix, fromTokens.length - sharedSuffix);
  const toMiddle = toTokens.slice(sharedPrefix, toTokens.length - sharedSuffix);
  const fromLen = fromMiddle.length;
  const toLen = toMiddle.length;

  const edits: TokenEdit[] = fromTokens.slice(0, sharedPrefix).map((token) => ({ t: 0, s: token }));

  if (fromLen * toLen > 4_000_000) {
    const budgeted = myersDiff(fromMiddle, toMiddle);
    if (budgeted) {
      edits.push(...budgeted);
    } else {
      fromMiddle.forEach((token) => edits.push({ t: 1, s: token }));
      toMiddle.forEach((token) => edits.push({ t: 2, s: token }));
    }
  } else {
    // Longest-common-subsequence table.
    const rowWidth = toLen + 1;
    const lcs = new Uint16Array((fromLen + 1) * rowWidth);
    for (let i = fromLen - 1; i >= 0; i--) {
      for (let j = toLen - 1; j >= 0; j--) {
        lcs[i * rowWidth + j] =
          fromMiddle[i] === toMiddle[j]
            ? lcs[(i + 1) * rowWidth + j + 1] + 1
            : Math.max(lcs[(i + 1) * rowWidth + j], lcs[i * rowWidth + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    for (; i < fromLen && j < toLen;) {
      if (fromMiddle[i] === toMiddle[j]) {
        edits.push({ t: 0, s: fromMiddle[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * rowWidth + j] >= lcs[i * rowWidth + j + 1]) {
        edits.push({ t: 1, s: fromMiddle[i++] });
      } else {
        edits.push({ t: 2, s: toMiddle[j++] });
      }
    }
    for (; i < fromLen;) edits.push({ t: 1, s: fromMiddle[i++] });
    for (; j < toLen;) edits.push({ t: 2, s: toMiddle[j++] });
  }

  fromTokens.slice(fromTokens.length - sharedSuffix).forEach((token) => edits.push({ t: 0, s: token }));

  // Pair trailing deletions with the equal run that follows them when the equal
  // run is whitespace-only repeated from the deletion, so "a cat " -> "a bat "
  // keeps the trailing space inside the change instead of around it.
  for (let index = 0; index < edits.length; index++) {
    if (edits[index].t === 0 || (index > 0 && edits[index - 1].t !== 0)) continue;
    const op = edits[index].t;
    let runEnd = index;
    while (runEnd < edits.length && edits[runEnd].t === op) runEnd++;
    if (runEnd >= edits.length || edits[runEnd].t !== 0) continue;
    for (; runEnd < edits.length && edits[runEnd].t === 0 && edits[runEnd].s === edits[index].s && isWhitespaceOnly(edits[index].s);) {
      edits[runEnd] = { t: op, s: edits[runEnd].s };
      edits[index] = { t: 0, s: edits[index].s };
      index++;
      runEnd++;
    }
    index = runEnd - 1;
  }

  // Collapse consecutive equal / change tokens into segments.
  const segments: DiffSegment[] = [];
  for (const edit of edits) {
    const last = segments[segments.length - 1];
    if (edit.t === 0) {
      if (last?.type === "equal") {
        last.text += edit.s;
      } else {
        segments.push({ type: "equal", text: edit.s });
      }
    } else {
      if (last?.type !== "change") segments.push({ type: "change", remove: "", insert: "" });
      const changeSeg = segments[segments.length - 1] as unknown as RawChange;
      if (edit.t === 1) {
        changeSeg.remove += edit.s;
      } else {
        changeSeg.insert += edit.s;
      }
    }
  }

  // Merge change segments separated only by whitespace.
  const merged: DiffSegment[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const last = merged[merged.length - 1];
    const next = segments[index + 1];
    if (segment.type === "equal" && isWhitespaceOnly(segment.text) && last?.type === "change" && next?.type === "change") {
      last.remove += segment.text + next.remove;
      last.insert += segment.text + next.insert;
      index++;
      continue;
    }
    merged.push({ ...segment });
  }

  // Split shared whitespace off the edges of each change so highlights don't cover the gaps between words.
  const result: DiffSegment[] = [];
  const pushEqual = (text: string): void => {
    if (!text) return;
    const last = result[result.length - 1];
    if (last?.type === "equal") {
      last.text += text;
    } else {
      result.push({ type: "equal", text });
    }
  };
  for (const segment of merged) {
    if (segment.type === "equal") {
      pushEqual(segment.text);
      continue;
    }
    let { remove, insert } = segment;
    let leadWhitespace = "";
    let trailWhitespace = "";
    if (remove && insert) {
      const lead = remove.match(/^\s+/)?.[0] ?? "";
      if (lead && insert.startsWith(lead) && lead.length < remove.length && lead.length < insert.length) {
        leadWhitespace = lead;
        remove = remove.slice(lead.length);
        insert = insert.slice(lead.length);
      }
      const trail = remove.match(/\s+$/)?.[0] ?? "";
      if (trail && insert.endsWith(trail) && trail.length < remove.length && trail.length < insert.length) {
        trailWhitespace = trail;
        remove = remove.slice(0, -trail.length);
        insert = insert.slice(0, -trail.length);
      }
    }
    pushEqual(leadWhitespace);
    result.push({ type: "change", remove, insert });
    pushEqual(trailWhitespace);
  }
  return result;
}

const stringifyValue = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : String(value);

/** Normalizes externally supplied change segments, dropping empty ones. */
const normalizeChanges = (changes: unknown): DiffSegment[] =>
  (Array.isArray(changes) ? changes : []).flatMap((change: unknown): DiffSegment[] => {
    const entry = change as Partial<DiffSegment> | null | undefined;
    if (entry?.type === "equal") {
      const text = stringifyValue((entry as { text?: unknown }).text);
      return text ? [{ type: "equal", text }] : [];
    }
    if (entry?.type === "change") {
      const remove = stringifyValue((entry as { remove?: unknown }).remove);
      const insert = stringifyValue((entry as { insert?: unknown }).insert);
      return remove || insert ? [{ type: "change", remove, insert }] : [];
    }
    return [];
  });

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const formatSuggestionsLeft = (count: number): string =>
  `${count.toLocaleString("en-US")} suggestion${count === 1 ? "" : "s"}`;

const quoteText = (text: string): string => `“${text.trim()}”`;

const describeChange = (change: { remove: string; insert: string }): string =>
  change.remove.trim() && change.insert.trim()
    ? `replace ${quoteText(change.remove)} with ${quoteText(change.insert)}`
    : change.insert.trim()
      ? `add ${quoteText(change.insert)}`
      : `remove ${quoteText(change.remove)}`;

export type DiffCardHandle = {
  highlight: (index: number) => void;
  accept: (index: number) => void;
  reject: (index: number) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  undo: () => void;
  reset: () => void;
};

export type DiffCardProps = {
  original?: string;
  suggested?: string;
  changes?: unknown;
  onChange?: (text: string) => void;
  onDone?: (text: string) => void;
  label?: string;
  ref?: React.Ref<DiffCardHandle>;
  className?: string;
};

export function DiffCard({
  original = "",
  suggested = "",
  changes,
  onChange,
  onDone,
  label,
  ref,
  className,
}: DiffCardProps) {
  const segments = useMemo<DiffSegment[]>(
    () => (changes ? normalizeChanges(changes) : diffTextToSegments(String(original ?? ""), String(suggested ?? ""))),
    [changes, original, suggested],
  );
  const segmentsKey = useMemo(() => JSON.stringify(segments), [segments]);

  const changeList = useMemo(() => {
    const list: RawChange[] = [];
    segments.forEach((segment, index) => {
      if (segment.type === "change") list.push({ seg: index, remove: segment.remove, insert: segment.insert });
    });
    return list;
  }, [segments]);

  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [history, setHistory] = useState<number[][]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("");
  const [lastSegmentsKey, setLastSegmentsKey] = useState(segmentsKey);
  if (lastSegmentsKey !== segmentsKey) {
    setLastSegmentsKey(segmentsKey);
    setDecisions({});
    setHistory([]);
    setHoveredIndex(null);
    setFocusedIndex(null);
    setHighlightIndex(null);
  }

  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement | null>(null);
  const changeRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const hoverTimerRef = useRef(0);
  const lastNavIndexRef = useRef<number | null>(null);
  const postApplyFocusRef = useRef<number | "undo" | null>(null);
  const callbacksRef = useRef({ onChange, onDone });
  callbacksRef.current = { onChange, onDone };

  const pendingIndices = changeList.map((_, index) => index).filter((index) => !decisions[index]);
  const allDone = changeList.length > 0 && pendingIndices.length === 0;

  const buildText = (currentDecisions: Record<number, Decision>): string => {
    let changeIdx = -1;
    return segments
      .map((segment) =>
        segment.type === "equal"
          ? segment.text
          : (changeIdx++, currentDecisions[changeIdx] === "accepted" ? segment.insert : segment.remove),
      )
      .join("");
  };

  const liveRef = useRef({ decisions, history, list: changeList, pending: pendingIndices });
  liveRef.current = { decisions, history, list: changeList, pending: pendingIndices };

  const applyDecisions = (indices: number[], decision: Decision, refocus = false): void => {
    const { decisions: currentDecisions, list } = liveRef.current;
    const targets = indices.filter((index) => index >= 0 && index < list.length && !currentDecisions[index]);
    if (!targets.length) return;

    const nextDecisions = { ...currentDecisions };
    targets.forEach((index) => {
      nextDecisions[index] = decision;
    });
    const remaining = list.length - Object.keys(nextDecisions).length;
    setDecisions(nextDecisions);
    setHistory((prev) => [...prev, targets]);
    setHighlightIndex(null);
    lastNavIndexRef.current = Math.max(...targets);

    const verb = decision === "accepted" ? "Accepted" : "Rejected";
    const summary =
      targets.length === 1
        ? describeChange(list[targets[0]]).replace(/^./, (first: string) => first.toUpperCase())
        : `${formatNumber(targets.length)} suggestions`;
    setStatusText(`${verb}: ${summary}. ${remaining ? `${formatSuggestionsLeft(remaining)} left.` : "All changes reviewed."}`);

    if (refocus) {
      const maxIndex = Math.max(...targets);
      const stillPending = list.map((_, index) => index).filter((index) => !nextDecisions[index]);
      postApplyFocusRef.current = remaining ? (stillPending.find((index) => index > maxIndex) ?? stillPending[0]) : "undo";
    }

    const text = buildText(nextDecisions);
    callbacksRef.current.onChange?.(text);
    if (!remaining) callbacksRef.current.onDone?.(text);
  };

  const undoLast = (refocus = false): void => {
    const { decisions: currentDecisions, history: currentHistory } = liveRef.current;
    const lastBatch = currentHistory[currentHistory.length - 1];
    if (!lastBatch) return;

    const nextDecisions = { ...currentDecisions };
    lastBatch.forEach((index) => {
      delete nextDecisions[index];
    });
    setDecisions(nextDecisions);
    setHistory(currentHistory.slice(0, -1));
    setStatusText(
      `Undone. ${formatSuggestionsLeft(liveRef.current.list.length - Object.keys(nextDecisions).length)} left.`,
    );
    if (refocus) postApplyFocusRef.current = Math.min(...lastBatch);
    callbacksRef.current.onChange?.(buildText(nextDecisions));
  };

  const resetAll = (): void => {
    setDecisions({});
    setHistory([]);
    setHighlightIndex(null);
    setHoveredIndex(null);
    setStatusText("");
    lastNavIndexRef.current = null;
  };

  useImperativeHandle(
    ref,
    (): DiffCardHandle => ({
      highlight: (index: number) => setHighlightIndex(index),
      accept: (index: number) => applyDecisions([index], "accepted"),
      reject: (index: number) => applyDecisions([index], "rejected"),
      acceptAll: () => applyDecisions(liveRef.current.pending, "accepted"),
      rejectAll: () => applyDecisions(liveRef.current.pending, "rejected"),
      undo: () => undoLast(),
      reset: resetAll,
    }),
  );

  useLayoutEffect(() => {
    const target = postApplyFocusRef.current;
    if (target !== null) {
      postApplyFocusRef.current = null;
      if (target === "undo") {
        undoButtonRef.current?.focus();
      } else {
        changeRefs.current[target]?.focus();
      }
    }
  }, [decisions]);

  const activeIndex =
    ([hoveredIndex, focusedIndex, highlightIndex].find(
      (index) => index !== null && !decisions[index] && index < changeList.length,
    ) as number | undefined) ?? null;

  useEffect(() => {
    if (activeIndex !== null) lastNavIndexRef.current = activeIndex;
  }, [activeIndex]);

  const navigate = (direction: 1 | -1): void => {
    const { pending } = liveRef.current;
    if (!pending.length) return;
    const current = activeIndex ?? lastNavIndexRef.current ?? (direction === 1 ? -1 : Infinity);
    const target =
      direction === 1
        ? (pending.find((index) => index > current) ?? pending[0])
        : ([...pending].reverse().find((index) => index < current) ?? pending[pending.length - 1]);
    window.clearTimeout(hoverTimerRef.current);
    setHoveredIndex(null);
    setHighlightIndex(target);
    lastNavIndexRef.current = target;

    const element = changeRefs.current[target];
    if (!element) return;
    if (focusedIndex !== null) element.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  };

  useEffect(() => {
    if (highlightIndex === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setHighlightIndex(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [highlightIndex]);

  const [popoverPlacement, setPopoverPlacement] = useState<{ left: number; top: number; snap: boolean; below: boolean } | null>(
    null,
  );
  const hasSnappedRef = useRef(false);

  useLayoutEffect(() => {
    const updatePlacement = (): void => {
      const card = cardRef.current;
      const popover = popoverRef.current;
      const activeEl = activeIndex === null ? null : changeRefs.current[activeIndex];
      if (!card || !popover || !activeEl) return;
      const cardRect = card.getBoundingClientRect();
      const scale = cardRect.width ? card.offsetWidth / cardRect.width : 1;
      const activeRect = activeEl.getClientRects()[0] ?? activeEl.getBoundingClientRect();
      const popWidth = popover.offsetWidth;
      const popHeight = popover.offsetHeight;
      const centerX = (activeRect.left - cardRect.left + activeRect.width / 2) * scale;
      const left = Math.min(Math.max(centerX - popWidth / 2, 8), Math.max(8, card.offsetWidth - popWidth - 8));
      const aboveTop = (activeRect.top - cardRect.top) * scale - popHeight - 6;
      const below = aboveTop < 4;
      const top = below ? (activeRect.bottom - cardRect.top) * scale + 6 : aboveTop;
      setPopoverPlacement({ left, top, snap: !hasSnappedRef.current, below });
      hasSnappedRef.current = true;
    };
    if (activeIndex === null) {
      hasSnappedRef.current = false;
      return;
    }
    updatePlacement();
    const observer = new ResizeObserver(updatePlacement);
    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [activeIndex, decisions]);

  const keepPopoverOpen = (index: number): void => {
    window.clearTimeout(hoverTimerRef.current);
    setHoveredIndex(index);
  };

  const schedulePopoverClose = (): void => {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoveredIndex(null), 140);
  };

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);

  const handleChangeKeydown = (event: React.KeyboardEvent<HTMLSpanElement>, index: number): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "y" || key === "enter") {
      event.preventDefault();
      applyDecisions([index], "accepted", true);
    } else if (key === "n" || key === "backspace" || key === "delete") {
      event.preventDefault();
      applyDecisions([index], "rejected", true);
    } else if (key === "escape") {
      event.currentTarget.blur();
    }
  };

  const changeCount = changeList.length;
  let changeCounter = -1;
  return (
    <div
      ref={rootRef}
      className={["ui-df", className].filter(Boolean).join(" ")}
      data-done={allDone || undefined}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && highlightIndex !== null) setHighlightIndex(null);
      }}
    >
      <style href="ui-inline-diff" precedence="default">{DIFF_CARD_CSS}</style>
      {label && (
        <div className="ui-df__label">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.75c.3 2.9 1.35 3.95 4.25 4.25-2.9.3-3.95 1.35-4.25 4.25C7.7 7.35 6.65 6.3 3.75 6 6.65 5.7 7.7 4.65 8 1.75Z" />
            <path d="M12.5 10.25c.15 1.25.6 1.7 1.75 1.75-1.15.15-1.6.6-1.75 1.75-.15-1.15-.6-1.6-1.75-1.75 1.15-.05 1.6-.5 1.75-1.75Z" />
          </svg>
          <span dir="auto" title={label}>
            {label}
          </span>
        </div>
      )}
      <div ref={cardRef} className="ui-df__card">
        <div className="ui-df__head">
          <div className="ui-df__bar">
            <div
              className="ui-df__layer"
              data-show={!allDone || undefined}
              inert={allDone}
              aria-hidden={allDone || undefined}
            >
              <span className="ui-df__count">
                <span className="ui-df__num">{formatNumber(pendingIndices.length)}</span>
                <span className="ui-df__word">{pendingIndices.length === 1 ? "suggestion" : "suggestions"}</span>
              </span>
              <span className="ui-df__actions">
                <span className="ui-df__nav" onMouseDown={(event: React.MouseEvent<HTMLSpanElement>) => event.preventDefault()}>
                  <button
                    type="button"
                    className="ui-df__icon"
                    onClick={() => navigate(-1)}
                    disabled={!pendingIndices.length}
                    aria-label="Previous suggestion"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M10 12.5 5.5 8 10 3.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="ui-df__icon"
                    onClick={() => navigate(1)}
                    disabled={!pendingIndices.length}
                    aria-label="Next suggestion"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 3.5 10.5 8 6 12.5" />
                    </svg>
                  </button>
                </span>
                <button type="button" className="ui-df__btn" onClick={() => applyDecisions(pendingIndices, "rejected")} disabled={!pendingIndices.length}>
                  Reject all
                </button>
                <button
                  type="button"
                  className="ui-df__btn ui-df__btn--primary"
                  onClick={() => applyDecisions(pendingIndices, "accepted")}
                  disabled={!pendingIndices.length}
                >
                  Accept all
                </button>
              </span>
            </div>
            <div
              className="ui-df__layer"
              data-show={allDone || undefined}
              inert={!allDone}
              aria-hidden={!allDone || undefined}
            >
              <span className="ui-df__count ui-df__count--done">
                <svg className="ui-df__ok" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.75 8.4 6.6 11.1 12.25 5" pathLength={1} />
                </svg>
                All changes reviewed
              </span>
              <button
                ref={undoButtonRef}
                type="button"
                className="ui-df__btn"
                onClick={() => undoLast(true)}
                disabled={!history.length}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M5.5 4 2.75 6.75 5.5 9.5" />
                  <path d="M3 6.75h6.5a3.75 3.75 0 0 1 0 7.5H7.5" />
                </svg>
                Undo
              </button>
            </div>
          </div>
        </div>
        <div className="ui-df__body">
          <p className="ui-df__text" dir="auto">
            {segments.map((segment, key) => {
              if (segment.type === "equal") return <span key={key}>{segment.text}</span>;
              changeCounter++;
              const changeIdx = changeCounter;
              const state = (decisions[changeIdx] ?? "pending") as Decision | "pending";
              const isPending = state === "pending";
              return (
                <span
                  key={key}
                  ref={(element: HTMLSpanElement | null) => {
                    changeRefs.current[changeIdx] = element;
                  }}
                  className="ui-df__chg"
                  data-state={state}
                  data-active={activeIndex === changeIdx || undefined}
                  tabIndex={isPending ? 0 : undefined}
                  role={isPending ? "button" : undefined}
                  aria-label={
                    isPending
                      ? `Suggestion ${formatNumber(changeIdx + 1)} of ${formatNumber(changeCount)}: ${describeChange(segment)}. Press Y to accept, N to reject`
                      : undefined
                  }
                  onKeyDown={isPending ? (event: React.KeyboardEvent<HTMLSpanElement>) => handleChangeKeydown(event, changeIdx) : undefined}
                  onFocus={() => setFocusedIndex(changeIdx)}
                  onBlur={() => setFocusedIndex((prev) => (prev === changeIdx ? null : prev))}
                  onMouseEnter={() => keepPopoverOpen(changeIdx)}
                  onMouseLeave={schedulePopoverClose}
                >
                  {segment.remove && (
                    <del className="ui-df__del" aria-hidden={state === "accepted" || undefined}>
                      {segment.remove}
                    </del>
                  )}
                  {segment.insert && (
                    <ins className="ui-df__ins" aria-hidden={state === "rejected" || undefined}>
                      {segment.insert}
                    </ins>
                  )}
                </span>
              );
            })}
          </p>
        </div>
        <div
          ref={popoverRef}
          className="ui-df__pop"
          data-open={activeIndex !== null || undefined}
          data-snap={popoverPlacement?.snap || undefined}
          data-below={popoverPlacement?.below || undefined}
          style={popoverPlacement ? { left: popoverPlacement.left, top: popoverPlacement.top } : undefined}
          role="group"
          aria-label="Review suggestion"
          aria-hidden={activeIndex === null || undefined}
          onMouseEnter={() => activeIndex !== null && keepPopoverOpen(activeIndex)}
          onMouseLeave={schedulePopoverClose}
          onMouseDown={(event: React.MouseEvent<HTMLDivElement>) => event.preventDefault()}
        >
          <button
            type="button"
            tabIndex={-1}
            className="ui-df__pbtn"
            aria-label="Accept suggestion"
            onClick={() => activeIndex !== null && applyDecisions([activeIndex], "accepted", focusedIndex === activeIndex)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.75 8.4 6.6 11.1 12.25 5" />
            </svg>
            Accept
            <kbd>Y</kbd>
          </button>
          <span className="ui-df__sep" aria-hidden="true" />
          <button
            type="button"
            tabIndex={-1}
            className="ui-df__pbtn"
            aria-label="Reject suggestion"
            onClick={() => activeIndex !== null && applyDecisions([activeIndex], "rejected", focusedIndex === activeIndex)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
            Reject
            <kbd>N</kbd>
          </button>
        </div>
      </div>
      <span className="ui-df__sr" role="status" aria-live="polite">
        {statusText}
      </span>
    </div>
  );
}

/**
 * affectUI Agent Queue (Clean style) — reverse-engineered readable rebuild.
 * Source: https://www.affectui.com/components/agent-queue (public demo bundle).
 *
 * The component shows the work waiting for your agents: jobs drop into a live
 * queue, glide into free worker slots as growing bars and land in Done or
 * Failed, while a depth chart shows the backlog build up when a rate limit
 * pauses the workers and drain when they resume.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { AGENT_QUEUE_CSS } from './agent-queue-css';

// ---------------------------------------------------------------------------
// Types (per the published API reference)
// ---------------------------------------------------------------------------

export type JobKind = 'llm' | 'tool' | 'agent' | 'human';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobPriority = 'high' | 'normal' | 'low';

export interface QueueJob {
  id: string;
  name: string;
  kind: JobKind;
  status: JobStatus;
  /** Epoch ms (or any clock you also pass as `now`). */
  enqueuedAt: number;
  priority?: JobPriority;
  startedAt?: number;
  endedAt?: number;
  worker?: string;
  /** 0–1 while the job runs; otherwise give `estimate` and the bar guesses. */
  progress?: number;
  /** Expected run time in ms. */
  estimate?: number;
  attempt?: number;
  maxAttempts?: number;
  detail?: string;
  /** Custom node for the job chip icon; brand logos are passed in, not built in. */
  icon?: ReactNode;
  error?: string;
}

export interface QueueWorker {
  id: string;
  name: string;
  detail?: string;
  icon?: ReactNode;
}

export interface RateLimit {
  from: number;
  until: number;
  label?: string;
}

export interface AgentQueueProps {
  jobs: QueueJob[];
  workers: QueueWorker[];
  /** The clock, on the same scale as the job times; without it the component keeps its own. */
  now?: number;
  rateLimits?: RateLimit[];
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  onConcurrencyChange?: (workers: number) => void;
  minConcurrency?: number;
  maxConcurrency?: number;
  /** A queue depth that means trouble: dashed line on the chart, Waiting turns amber above it. */
  backpressure?: number;
  /** How far back the depth chart looks, in ms. */
  window?: number;
  totals?: { done?: number; failed?: number };
  openId?: string | null;
  defaultOpenId?: string | null;
  onOpenChange?: (id: string | null, job?: QueueJob) => void;
  onPromote?: (job: QueueJob) => void;
  onCancel?: (job: QueueJob) => void;
  title?: string;
  name?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<JobKind, string> = {
  llm: 'LLM call',
  tool: 'Tool call',
  agent: 'Sub-agent',
  human: 'Human review',
};

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

const PRIORITY_RANK: Record<JobPriority, number> = { high: 0, normal: 1, low: 2 };

/** Job move transition (translate/width/height/border-radius), ms. Resolved into the CSS above. */
export const MOVE_MS = 560;
/** How long a finished job keeps animating before it is forgotten, ms. */
const GONE_MS = 1100;
/** How long a retried job flashes red in the queue, ms. */
const FLASH_MS = 1500;
/** A high-priority job lands at the back first and glides past for this long, ms. */
const GLIDE_MS = 520;
/** A retried job holds its old worker bar for this long, ms. */
const RETRY_HOLD_MS = 520;
/** A done job holds its worker bar before flying to the bin, ms. */
const DONE_HOLD_MS = 200;
/** A failed job holds its worker bar before flying to the bin, ms. */
const FAILED_HOLD_MS = 520;

const MINUTE_MS = 60_000;

/** Y-axis tick candidates for the depth chart. */
const Y_TICKS = [4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120, 160, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000];

const fmtDuration = (ms: number): string => {
  const t = Math.max(0, ms);
  if (t < 1e4) return `${(t / 1e3).toFixed(1)}s`;
  const total = Math.round(t / 1e3);
  if (total < 60) return `${total}s`;
  const mm = Math.floor(total / 60);
  if (mm < 60) return `${mm}m ${String(total % 60).padStart(2, '0')}s`;
  const hh = Math.floor(mm / 60);
  return hh < 24 ? `${hh}h ${String(mm % 60).padStart(2, '0')}m` : `${Math.floor(hh / 24)}d ${hh % 24}h`;
};

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmtCount = (n: number): string => (Math.round(n) < 1e5 ? fmtInt(n) : compactFmt.format(Math.round(n)));

const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const initials = (name: string): string => {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => Array.from(w)[0]);
  return (letters.length ? letters.join('') : (Array.from(name.trim())[0] ?? '')).toUpperCase();
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Monotone cubic (Fritsch–Carlson) spline path through [x, y] points. */
const splinePath = (points: Array<[number, number]>): string => {
  const n = points.length;
  if (n < 2) return '';
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0] || 1e-6;
    slope[i] = (points[i + 1][1] - points[i][1]) / dx[i];
  }
  const tan: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    tan[i] =
      slope[i - 1] * slope[i] <= 0
        ? 0
        : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i]);
  }
  tan[n - 1] = slope[n - 2];
  let d = `M${round2(points[0][0])},${round2(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${round2(points[i][0] + h)},${round2(points[i][1] + tan[i] * h)} ${round2(points[i + 1][0] - h)},${round2(points[i + 1][1] - tan[i + 1] * h)} ${round2(points[i + 1][0])},${round2(points[i + 1][1])}`;
  }
  return d;
};

// ---------------------------------------------------------------------------
// Flow layout
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Size of a waiting-job square in the queue well. */
const SQUARE = 12;
/** Row height of the square grid inside the queue well. */
const ROW_H = 16;
/** Height of a visible queue chip. */
const CHIP_H = 28;
/** Height of a worker slot. */
const SLOT_H = 40;
/** Vertical gap between worker slots. */
const SLOT_GAP = 6;
/** Inner padding of the queue well. */
const FLOW_PAD = 10;
/** Default gutter for the depth chart labels. */
const GUTTER = 26;

/** Grid geometry for the square cells inside the queue well. */
const queueGrid = (well: Box, rows: number) => {
  const cols = Math.max(2, Math.floor((well.w - 20 + ROW_H - SQUARE) / ROW_H));
  const gridH = rows * ROW_H - 4;
  return {
    x: well.x + FLOW_PAD,
    y: well.y + (well.h - gridH) / 2,
    cols,
    rows,
    step: (well.w - 20 - SQUARE) / (cols - 1),
  };
};

interface FlowLayout {
  narrow: boolean;
  height: number;
  pad: number;
  heads: { queue: Box; workers: Box };
  chips: Box[];
  well: Box;
  grid: { x: number; y: number; cols: number; rows: number; step: number };
  slots: Box[];
  rail: Box;
  done: Box;
  failed: Box;
}

/** Geometry of the flow area: queue column, worker slots, Done/Failed bins. */
const computeFlow = (width: number, workerCount: number): FlowLayout => {
  const narrow = width < 600;
  const slots = Math.max(1, workerCount);
  const slotsH = slots * SLOT_H + (slots - 1) * SLOT_GAP;

  if (!narrow) {
    const queueW = clamp(Math.round(width * 0.26), 188, 236);
    const leftH = Math.max(slotsH, 178);
    const workersX = 16 + queueW + 24;
    const workersW = width - 32 - queueW - 92 - 48;
    const binsX = width - 16 - 92;
    const chips = [0, 1, 2].map((i) => ({ x: 16, y: 40 + i * 32, w: queueW, h: CHIP_H }));
    const gridRows = Math.max(1, Math.floor((40 + leftH - 138 - 20 + ROW_H - SQUARE) / ROW_H));
    const well = { x: 16, y: 138, w: queueW, h: 40 + leftH - 138 };
    const railX = clamp(Math.round(workersW * 0.4), 112, 164);
    const binH = (leftH - 8) / 2;
    return {
      narrow,
      height: 40 + leftH + 18,
      pad: 16,
      heads: {
        queue: { x: 16, y: 14, w: queueW, h: 16 },
        workers: { x: workersX, y: 14, w: workersW, h: 16 },
      },
      chips,
      well,
      grid: queueGrid(well, gridRows),
      slots: Array.from({ length: slots }, (_, i) => ({ x: workersX, y: 40 + i * 46, w: workersW, h: SLOT_H })),
      rail: { x: railX, y: 6, w: workersW - railX - 6, h: CHIP_H },
      done: { x: binsX, y: 40, w: 92, h: binH },
      failed: { x: binsX, y: 40 + binH + 8, w: 92, h: binH },
    };
  }

  const innerW = width - 24;
  let cursorY = 12;
  const queueHead = { x: 12, y: cursorY, w: innerW, h: 16 };
  cursorY += 24;
  const chips = [0, 1].map((i) => ({ x: 12, y: cursorY + i * 32, w: innerW, h: CHIP_H }));
  const wellY = cursorY + 64 + 2;
  const well = { x: 12, y: wellY, w: innerW, h: 48 };
  cursorY = wellY + well.h;
  cursorY += 18;
  const workersHead = { x: 12, y: cursorY, w: innerW, h: 16 };
  cursorY += 24;
  const slotsY = cursorY;
  cursorY += slotsH;
  cursorY += 12;
  const binW = (innerW - 8) / 2;
  return {
    narrow,
    height: cursorY + 40 + 12,
    pad: 12,
    heads: { queue: queueHead, workers: workersHead },
    chips,
    well,
    grid: queueGrid(well, 2),
    slots: Array.from({ length: slots }, (_, i) => ({ x: 12, y: slotsY + i * 46, w: innerW, h: SLOT_H })),
    rail: { x: 40, y: 6, w: innerW - 40 - 6, h: CHIP_H },
    done: { x: 12, y: cursorY, w: binW, h: 40 },
    failed: { x: 12 + binW + 8, y: cursorY, w: binW, h: 40 },
  };
};

// ---------------------------------------------------------------------------
// UI icons — Hugeicons Free (MIT), https://hugeicons.com
// ---------------------------------------------------------------------------

const Icon = ({ size = 14, children }: { size?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    {children}
  </svg>
);

const QueueMarkIcon = () => (
  <Icon size={16}>
    <path
      d="M18 18H6C5.05719 18 4.58579 18 4.29289 17.7071C4 17.4142 4 16.9428 4 16C4 15.0572 4 14.5858 4.29289 14.2929C4.58579 14 5.05719 14 6 14H18C18.9428 14 19.4142 14 19.7071 14.2929C20 14.5858 20 15.0572 20 16C20 16.9428 20 17.4142 19.7071 17.7071C19.4142 18 18.9428 18 18 18Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
    <path d="M4 10H20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    <path d="M4 6H20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </Icon>
);

const PauseIcon = () => (
  <Icon>
    <path
      d="M4 7C4 5.58579 4 4.87868 4.43934 4.43934C4.87868 4 5.58579 4 7 4C8.41421 4 9.12132 4 9.56066 4.43934C10 4.87868 10 5.58579 10 7V17C10 18.4142 10 19.1213 9.56066 19.5607C9.12132 20 8.41421 20 7 20C5.58579 20 4.87868 20 4.43934 19.5607C4 19.1213 4 18.4142 4 17V7Z"
      stroke="currentColor"
      strokeWidth="1.8"
    />
    <path
      d="M14 7C14 5.58579 14 4.87868 14.4393 4.43934C14.8787 4 15.5858 4 17 4C18.4142 4 19.1213 4 19.5607 4.43934C20 4.87868 20 5.58579 20 7V17C20 18.4142 20 19.1213 19.5607 19.5607C19.1213 20 18.4142 20 17 20C15.5858 20 14.8787 20 14.4393 19.5607C14 19.1213 14 18.4142 14 17V7Z"
      stroke="currentColor"
      strokeWidth="1.8"
    />
  </Icon>
);

const PlayIcon = () => (
  <Icon>
    <path
      d="M18.8906 12.846C18.5371 14.189 16.8667 15.138 13.5257 17.0361C10.296 18.8709 8.6812 19.7884 7.37983 19.4196C6.8418 19.2671 6.35159 18.9776 5.95624 18.5787C5 17.6139 5 15.7426 5 12C5 8.2574 5 6.3861 5.95624 5.42132C6.35159 5.02245 6.8418 4.73288 7.37983 4.58042C8.6812 4.21165 10.296 5.12907 13.5257 6.96393C16.8667 8.86197 18.5371 9.811 18.8906 11.154C19.0365 11.7084 19.0365 12.2916 18.8906 12.846Z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </Icon>
);

const PlusIcon = () => (
  <Icon>
    <path d="M12 4V20M20 12H4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </Icon>
);

const MinusIcon = () => (
  <Icon>
    <path d="M20 12L4 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </Icon>
);

const CheckIcon = () => (
  <Icon size={12}>
    <path d="M5 14L8.5 17.5L19 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
  </Icon>
);

const CloseIcon = ({ size = 12, w = 2.4 }: { size?: number; w?: number }) => (
  <Icon size={size}>
    <path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={w} />
  </Icon>
);

const AlertIcon = () => (
  <Icon size={12}>
    <path
      d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
    <path d="M12 9V13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    <path d="M12 16.8V17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" />
  </Icon>
);

const RetryIcon = () => (
  <Icon size={10}>
    <path
      d="M20.4879 15C19.2524 18.4956 15.9187 21 12 21C7.02943 21 3 16.9706 3 12C3 7.02943 7.02943 3 12 3C15.7292 3 18.9286 5.26806 20.2941 8.5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.6"
    />
    <path
      d="M15 9H18C19.4142 9 20.1213 9 20.5607 8.56066C21 8.12132 21 7.41421 21 6V3"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.6"
    />
  </Icon>
);

const FrontIcon = () => (
  <Icon size={10}>
    <path d="M12 5.5V19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.8" />
    <path
      d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.8"
    />
  </Icon>
);

const KindIcon = ({ kind }: { kind: JobKind }) => {
  if (kind === 'llm') {
    return (
      <Icon size={12}>
        <path
          d="M15 2L15.5387 4.39157C15.9957 6.42015 17.5798 8.00431 19.6084 8.46127L22 9L19.6084 9.53873C17.5798 9.99569 15.9957 11.5798 15.5387 13.6084L15 16L14.4613 13.6084C14.0043 11.5798 12.4202 9.99569 10.3916 9.53873L8 9L10.3916 8.46127C12.4201 8.00431 14.0043 6.42015 14.4613 4.39158L15 2Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        <path
          d="M7 12L7.38481 13.7083C7.71121 15.1572 8.84275 16.2888 10.2917 16.6152L12 17L10.2917 17.3848C8.84275 17.7112 7.71121 18.8427 7.38481 20.2917L7 22L6.61519 20.2917C6.28879 18.8427 5.15725 17.7112 3.70827 17.3848L2 17L3.70827 16.6152C5.15725 16.2888 6.28879 15.1573 6.61519 13.7083L7 12Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </Icon>
    );
  }
  if (kind === 'tool') {
    return (
      <Icon size={12}>
        <path
          d="M20.3584 13.3567C19.1689 14.546 16.9308 14.4998 13.4992 14.4998C11.2914 14.4998 9.50138 12.7071 9.50024 10.4993C9.50024 7.07001 9.454 4.83065 10.6435 3.64138C11.8329 2.45212 12.3583 2.50027 17.6274 2.50027C18.1366 2.49809 18.3929 3.11389 18.0329 3.47394L15.3199 6.18714C14.6313 6.87582 14.6294 7.99233 15.3181 8.68092C16.0068 9.36952 17.1234 9.36959 17.8122 8.68109L20.5259 5.96855C20.886 5.60859 21.5019 5.86483 21.4997 6.37395C21.4997 11.6422 21.5479 12.1675 20.3584 13.3567Z"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M13.5 14.5L7.32842 20.6716C6.22386 21.7761 4.433 21.7761 3.32843 20.6716C2.22386 19.567 2.22386 17.7761 3.32843 16.6716L9.5 10.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        />
      </Icon>
    );
  }
  if (kind === 'agent') {
    return (
      <Icon size={12}>
        <path
          d="M13 7H11C8.19108 7 6.78661 7 5.77772 7.67412C5.34096 7.96596 4.96596 8.34096 4.67412 8.77772C4 9.78661 4 11.1911 4 14C4 16.8089 4 18.2134 4.67412 19.2223C4.96596 19.659 5.34096 20.034 5.77772 20.3259C6.78661 21 8.19108 21 11 21H13C15.8089 21 17.2134 21 18.2223 20.3259C18.659 20.034 19.034 19.659 19.3259 19.2223C20 18.2134 20 16.8089 20 14C20 11.1911 20 9.78661 19.3259 8.77772C19.034 8.34096 18.659 7.96596 18.2223 7.67412C17.2134 7 15.8089 7 13 7Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        <path d="M15 11V13M9 11V13M10 17H14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        <path
          d="M12 7C12 5.11438 12 4.17157 11.4142 3.58579C10.8284 3 9.88562 3 8 3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </Icon>
    );
  }
  return (
    <Icon size={12}>
      <path
        d="M20 21.0001C19.713 17.269 16.7289 14.3151 12.995 14.0662L12 13.9999C11.6446 14.0096 11.3134 14.0225 11.0008 14.0378C7.3 14.2192 4.28417 17.3057 4 21.0001"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="6.99988" r="4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </Icon>
  );
};

// ---------------------------------------------------------------------------
// Placement of a job in the flow area
// ---------------------------------------------------------------------------

type JobShape = 'chip' | 'square' | 'bar' | 'gone';

interface PlacedJob {
  job: QueueJob;
  shape: JobShape;
  box: Box;
  index?: number;
  flash: boolean;
  /** Override progress (retry/gone bars hold full). */
  p?: number;
}

// ---------------------------------------------------------------------------
// AgentQueue
// ---------------------------------------------------------------------------

export function AgentQueue({
  jobs,
  workers,
  now: nowProp,
  rateLimits = [],
  paused = false,
  onPausedChange,
  onConcurrencyChange,
  minConcurrency = 1,
  maxConcurrency = 8,
  backpressure,
  window: windowMs = 2 * MINUTE_MS,
  totals,
  openId: openIdProp,
  defaultOpenId = null,
  onOpenChange,
  onPromote,
  onCancel,
  title = 'Queue',
  name,
  className,
}: AgentQueueProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const jobEls = useRef(new Map<string, HTMLButtonElement>());
  const gradId = 'ui-agqc-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const measuredWidth = width || 812;

  const [clock, setClock] = useState(() => Date.now());
  const now = nowProp ?? clock;

  const activeLimit = rateLimits.find((l) => l.from <= now && now < l.until);
  const limited = !!activeLimit;

  const waiting = jobs.filter((j) => j.status === 'queued');
  const running = jobs.filter((j) => j.status === 'running');
  const needClock = nowProp === undefined && (waiting.length > 0 || running.length > 0 || limited);

  // --- render-time transition tracking (same as the original bundle) -------
  interface SeenJob {
    status: JobStatus;
    attempt: number;
    first: number;
    fresh: boolean;
    worker?: string;
  }
  const trackRef = useRef<{
    seen: Map<string, SeenJob>;
    gone: Map<string, number>;
    flash: Map<string, number>;
    limited: boolean;
    over: boolean;
    msg: string;
    msgAt: number;
    mounted: boolean;
  }>({
    seen: new Map(),
    gone: new Map(),
    flash: new Map(),
    limited: false,
    over: false,
    msg: '',
    msgAt: 0,
    mounted: false,
  });
  const perfNow = typeof performance !== 'undefined' ? performance.now() : 0;
  {
    const track = trackRef.current;
    const say = (msg: string) => {
      track.msg = msg;
      track.msgAt = perfNow;
    };
    for (const job of jobs) {
      const attempt = job.attempt ?? 1;
      const seen = track.seen.get(job.id);
      if (!seen) {
        track.seen.set(job.id, { status: job.status, attempt, first: perfNow, fresh: track.mounted, worker: job.worker });
        continue;
      }
      if (job.status === 'running' && job.worker) seen.worker = job.worker;
      if (seen.status === job.status && seen.attempt === attempt) continue;
      const wasActive = seen.status === 'running' || seen.status === 'queued';
      if ((job.status === 'done' || job.status === 'failed') && wasActive) track.gone.set(job.id, perfNow);
      if (job.status === 'failed' && wasActive) say(`${job.name} failed${job.error ? `: ${job.error}` : ''}`);
      if (job.status === 'queued' && seen.status === 'running') {
        track.flash.set(job.id, perfNow);
        if (attempt > seen.attempt) {
          say(`${job.name} failed – retrying, attempt ${attempt}${job.maxAttempts ? ` of ${job.maxAttempts}` : ''}`);
        }
      }
      seen.status = job.status;
      seen.attempt = attempt;
    }
    if (limited !== track.limited) {
      if (track.mounted) {
        say(
          limited
            ? `Rate limited – workers paused for ${Math.ceil(((activeLimit?.until ?? now) - now) / 1e3)} seconds`
            : 'Rate limit lifted – workers resumed'
        );
      }
      track.limited = limited;
    }
    const over = backpressure !== undefined && waiting.length > backpressure;
    if (over !== track.over) {
      if (over && track.mounted) say(`${fmtInt(waiting.length)} jobs waiting – above the backpressure line of ${backpressure}`);
      track.over = over;
    }
    for (const [id, at] of track.gone) if (perfNow - at > GONE_MS) track.gone.delete(id);
    for (const [id, at] of track.flash) if (perfNow - at > FLASH_MS) track.flash.delete(id);
    if (track.seen.size > jobs.length + 64) {
      const live = new Set(jobs.map((j) => j.id));
      for (const id of track.seen.keys()) if (!live.has(id)) track.seen.delete(id);
    }
  }

  const [liveMsg, setLiveMsg] = useState('');
  useEffect(() => {
    trackRef.current.mounted = true;
    if (trackRef.current.msg && trackRef.current.msg !== liveMsg) setLiveMsg(trackRef.current.msg);
  });

  // --- queue order and placement -------------------------------------------
  const flow = computeFlow(measuredWidth, workers.length);

  /** Sort key: priority first, but a fresh high-priority job ranks normal so it glides past. */
  const rankKey = (job: QueueJob): number => {
    const rank = PRIORITY_RANK[job.priority ?? 'normal'];
    const seen = trackRef.current.seen.get(job.id);
    return rank === 0 && seen?.fresh && perfNow - seen.first < GLIDE_MS ? 1 : rank;
  };

  const queue = [...waiting].sort(
    (a, b) => rankKey(a) - rankKey(b) || a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : 1)
  );

  const chipCount = flow.chips.length;
  const gridCells = flow.grid.cols * flow.grid.rows;
  const overflow = queue.length > chipCount + gridCells;
  const shownSquares = overflow ? gridCells - 3 : gridCells;
  const hiddenCount = Math.max(0, queue.length - chipCount - shownSquares);

  const workerIndex = new Map(workers.map((w, i) => [w.id, i]));

  const slotBox = (slot: Box): Box => ({ x: slot.x + flow.rail.x, y: slot.y + flow.rail.y, w: flow.rail.w, h: flow.rail.h });

  /** The worker slot a job recently occupied, if the hold window has not passed. */
  const recentSlot = (job: QueueJob, at: number | undefined, within: number): Box | undefined => {
    if (at === undefined || perfNow - at >= within) return undefined;
    const workerId = trackRef.current.seen.get(job.id)?.worker ?? job.worker;
    if (workerId === undefined) return undefined;
    const idx = workerIndex.get(workerId);
    if (idx === undefined) return undefined;
    return flow.slots[idx];
  };

  const placed: PlacedJob[] = [];
  {
    let squareCursor = 0;
    for (const job of queue) {
      const flashing = trackRef.current.flash.has(job.id);
      const retrySlot = recentSlot(job, trackRef.current.flash.get(job.id), RETRY_HOLD_MS);
      if (retrySlot) {
        placed.push({ job, shape: 'bar', box: slotBox(retrySlot), flash: true, p: 1 });
        continue;
      }
      const rank = squareCursor++;
      if (rank < chipCount) {
        placed.push({ job, shape: 'chip', box: flow.chips[rank], index: rank, flash: flashing });
      } else if (rank < chipCount + shownSquares) {
        const cell = rank - chipCount;
        placed.push({
          job,
          shape: 'square',
          box: {
            x: flow.grid.x + (cell % flow.grid.cols) * flow.grid.step,
            y: flow.grid.y + Math.floor(cell / flow.grid.cols) * ROW_H,
            w: SQUARE,
            h: SQUARE,
          },
          index: rank,
          flash: flashing,
        });
      }
    }
    for (const job of running) {
      const idx = job.worker === undefined ? undefined : workerIndex.get(job.worker);
      if (idx !== undefined) placed.push({ job, shape: 'bar', box: slotBox(flow.slots[idx]), flash: false });
    }
    for (const job of jobs) {
      if (!trackRef.current.gone.has(job.id) || (job.status !== 'done' && job.status !== 'failed')) continue;
      const holdSlot = recentSlot(job, trackRef.current.gone.get(job.id), job.status === 'done' ? DONE_HOLD_MS : FAILED_HOLD_MS);
      if (holdSlot) {
        placed.push({ job, shape: 'bar', box: slotBox(holdSlot), flash: false, p: 1 });
        continue;
      }
      const bin = job.status === 'done' ? flow.done : flow.failed;
      placed.push({
        job,
        shape: 'gone',
        box: { x: bin.x + 17, y: bin.y + (flow.narrow ? 15 : 17), w: 10, h: 10 },
        flash: false,
      });
    }
    placed.sort((a, b) => (a.job.id < b.job.id ? -1 : 1));
  }

  const doneTotal = totals?.done ?? jobs.filter((j) => j.status === 'done').length;
  const failedTotal = totals?.failed ?? jobs.filter((j) => j.status === 'failed').length;
  const throughput = jobs.filter(
    (j) => j.status === 'done' && j.endedAt !== undefined && j.endedAt > now - MINUTE_MS && j.endedAt <= now
  ).length;
  const waitP95 = quantile(
    [
      ...jobs
        .filter((j) => j.startedAt !== undefined && j.status !== 'queued' && j.startedAt > now - MINUTE_MS)
        .map((j) => (j.startedAt as number) - j.enqueuedAt),
      ...waiting.map((j) => now - j.enqueuedAt),
    ],
    0.95
  );
  const overLine = backpressure !== undefined && waiting.length > backpressure;
  const state = limited ? 'limited' : paused ? 'paused' : waiting.length || running.length ? 'live' : 'idle';

  // --- depth chart ----------------------------------------------------------
  const from = now - windowMs;
  const tickStep = windowMs / 96;
  const { starts, ends } = useMemo(() => {
    const s: number[] = [];
    const e: number[] = [];
    for (const job of jobs) {
      const end = job.status === 'queued' ? Infinity : (job.startedAt ?? job.endedAt ?? Infinity);
      s.push(job.enqueuedAt);
      e.push(Math.max(job.enqueuedAt, end));
    }
    s.sort((a, b) => a - b);
    e.sort((a, b) => a - b);
    return { starts: s, ends: e };
  }, [jobs]);

  let sCursor = 0;
  let eCursor = 0;
  const depthAt = (t: number): number => {
    while (sCursor < starts.length && starts[sCursor] <= t) sCursor++;
    while (eCursor < ends.length && ends[eCursor] <= t) eCursor++;
    return sCursor - eCursor;
  };
  const series: Array<[number, number]> = [[from, depthAt(from)]];
  for (let t = Math.ceil(from / tickStep) * tickStep; t < now - tickStep * 0.25; t += tickStep) {
    series.push([t, depthAt(t)]);
  }
  series.push([now, waiting.length]);

  const peak = Math.max(0, ...series.map((p) => p[1]));
  const rawMax = Math.max(peak * 1.15, (backpressure ?? 0) * 1.2, 4);
  const ymax = Y_TICKS.find((t) => t >= rawMax) ?? Math.ceil(rawMax / 500) * 500;
  const gutter = Math.max(GUTTER, 10 + fmtInt(ymax).length * 7);
  const plotW = Math.max(40, measuredWidth - 2 * flow.pad - gutter);
  const plotH = flow.narrow ? 88 : 112;
  const xOf = (t: number) => ((t - from) / windowMs) * plotW;
  const linePath = splinePath(series.map(([t, d]) => [xOf(t), d]));
  const areaPath = linePath ? `${linePath}L${round2(plotW)},0L0,0Z` : '';
  const avgDepth = series.reduce((sum, p) => sum + p[1], 0) / series.length;
  const bands = rateLimits
    .filter((l) => l.until > from && l.from < now)
    .map((l) => ({ limit: l, x1: xOf(Math.max(l.from, from)), x2: xOf(Math.min(l.until, now)) }));
  const windowMin = windowMs / MINUTE_MS;
  const windowLabel =
    windowMin >= 2880
      ? `${+(windowMin / 1440).toFixed(1)} days`
      : windowMin >= 120
        ? `${+(windowMin / 60).toFixed(1)} h`
        : windowMin >= 2
          ? `${+windowMin.toFixed(1)} min`
          : `${Math.round(windowMs / 1e3)}s`;
  const chartAria =
    `Queue depth over the last ${windowLabel}: ${waiting.length} waiting now, peak ${peak}, average ${avgDepth.toFixed(1)}` +
    `${backpressure === undefined ? '' : `, backpressure line at ${backpressure}`}` +
    `${bands.length ? `, rate limited ${bands.length === 1 ? 'once' : `${bands.length} times`}` : ''}` +
    `${failedTotal ? `, ${failedTotal} failed in all` : ''}.`;

  // --- animated numbers (one frame loop eases textContent directly) ---------
  const numsRef = useRef(new Map<string, { el: HTMLSpanElement | null; shown: number; target: number; fmt: (n: number) => string }>());
  const AnimatedNum = (key: string, value: number, fmt: (n: number) => string) => {
    let entry = numsRef.current.get(key);
    if (!entry) {
      entry = { el: null, shown: value, target: value, fmt };
      numsRef.current.set(key, entry);
    }
    entry.target = value;
    entry.fmt = fmt;
    const e = entry;
    return (
      <span
        className="ui-agqc__num"
        ref={(el) => {
          e.el = el;
          if (el && !el.textContent) el.textContent = e.fmt(e.shown);
        }}
      />
    );
  };

  // --- frame loop: eases the numbers and the chart scale, keeps the clock ---
  const loopCtx = useRef({ needClock, ymax });
  loopCtx.current = { needClock, ymax };
  const wakeRef = useRef(() => {});
  useEffect(() => {
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let clockAt = 0;
    let ymaxShown = loopCtx.current.ymax;
    rootRef.current?.style.setProperty('--ui-agqc-ymax', String(ymaxShown));

    const tick = (t: number) => {
      raf = 0;
      const dt = Math.min(64, t - last);
      last = t;
      const reduced = prefersReducedMotion();
      const ease = 1 - Math.exp(-dt / 110);
      let moving = false;
      for (const num of numsRef.current.values()) {
        if (num.shown === num.target) continue;
        const d = num.target - num.shown;
        num.shown = reduced || Math.abs(d) < 0.02 * Math.max(1, Math.abs(num.target)) * 0.05 + 0.004 ? num.target : num.shown + d * ease;
        if (num.el) num.el.textContent = num.fmt(num.shown);
        moving = true;
      }
      const targetMax = loopCtx.current.ymax;
      if (ymaxShown !== targetMax) {
        const d = targetMax - ymaxShown;
        ymaxShown = reduced || Math.abs(d) < 0.01 ? targetMax : ymaxShown + d * (1 - Math.exp(-dt / 160));
        rootRef.current?.style.setProperty('--ui-agqc-ymax', String(ymaxShown));
        moving = true;
      }
      if (loopCtx.current.needClock) {
        moving = true;
        if (t - clockAt > 33) {
          clockAt = t;
          setClock(Date.now());
        }
      }
      if (moving && visible && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!raf && visible && !document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    wakeRef.current = wake;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) wake();
    });
    if (rootRef.current) io.observe(rootRef.current);
    document.addEventListener('visibilitychange', wake);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  useEffect(() => wakeRef.current());
  useLayoutEffect(() => {
    rootRef.current?.style.setProperty('--ui-agqc-ymax', String(loopCtx.current.ymax));
  }, []);

  // Re-render while short-lived animations (gone / retry flash / vip glide) run.
  const [, bump] = useState(0);
  const animating =
    trackRef.current.gone.size > 0 ||
    trackRef.current.flash.size > 0 ||
    waiting.some((j) => j.priority === 'high' && perfNow - (trackRef.current.seen.get(j.id)?.first ?? 0) < GLIDE_MS);
  useEffect(() => {
    if (!animating) return;
    const id = window.setTimeout(() => bump((n) => n + 1), 120);
    return () => window.clearTimeout(id);
  });

  // --- pinned / hovered job card -------------------------------------------
  const [openInternal, setOpenInternal] = useState<string | null>(defaultOpenId);
  const openId = openIdProp === undefined ? openInternal : openIdProp;
  const selectOpen = (id: string | null) => {
    setOpenInternal(id);
    onOpenChange?.(id, id ? jobs.find((j) => j.id === id) : undefined);
  };

  const [hoverId, setHoverId] = useState<string | null>(null);
  const pinnable = placed.filter((p) => p.shape !== 'gone');
  const openPlaced = openId ? pinnable.find((p) => p.job.id === openId) : undefined;
  const hoverPlaced = !openPlaced && hoverId ? pinnable.find((p) => p.job.id === hoverId) : undefined;
  const shownPop = openPlaced ?? hoverPlaced;

  useEffect(() => {
    if (openId && !openPlaced) selectOpen(null);
  });
  useEffect(() => {
    if (!openPlaced) return;
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if ([...jobEls.current.values()].some((el) => el.contains(target))) return;
      selectOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  });

  const [popHeight, setPopHeight] = useState(120);
  useLayoutEffect(() => {
    const h = popRef.current?.offsetHeight;
    if (h && Math.abs(h - popHeight) > 1) setPopHeight(h);
  });

  // --- roving focus over the jobs -------------------------------------------
  const roveOrder = [
    ...running
      .filter((j) => j.worker !== undefined && workerIndex.has(j.worker))
      .sort((a, b) => (workerIndex.get(a.worker as string) as number) - (workerIndex.get(b.worker as string) as number)),
    ...queue.slice(0, chipCount + shownSquares),
  ];
  const [focusId, setFocusId] = useState<string | null>(null);
  const activeJobId = focusId && roveOrder.some((j) => j.id === focusId) ? focusId : roveOrder[0]?.id;

  const focusJob = (job?: QueueJob) => {
    if (job) {
      setFocusId(job.id);
      jobEls.current.get(job.id)?.focus();
    }
  };

  const onJobKeyDown = (e: KeyboardEvent<HTMLButtonElement>, job: QueueJob) => {
    const idx = roveOrder.findIndex((j) => j.id === job.id);
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusJob(roveOrder[idx + 1]),
      ArrowRight: () => focusJob(roveOrder[idx + 1]),
      ArrowUp: () => focusJob(roveOrder[idx - 1]),
      ArrowLeft: () => focusJob(roveOrder[idx - 1]),
      Home: () => focusJob(roveOrder[0]),
      End: () => focusJob(roveOrder[roveOrder.length - 1]),
      Escape: () => openId && selectOpen(null),
    };
    if (moves[e.key]) {
      e.preventDefault();
      moves[e.key]();
    }
  };

  const jobProgress = (job: QueueJob): number => {
    if (job.status === 'done' || job.status === 'failed') return 1;
    if (job.status === 'running') {
      return clamp(job.progress ?? (job.startedAt !== undefined && job.estimate ? (now - job.startedAt) / job.estimate : 0.5), 0.015, 1);
    }
    return 0;
  };

  const jobLabel = (p: PlacedJob): string => {
    const job = p.job;
    const parts = [job.name, KIND_LABEL[job.kind]];
    if (job.status === 'queued') {
      parts.push(`waiting ${fmtDuration(now - job.enqueuedAt)}`, `position ${fmtInt((p.index ?? 0) + 1)} of ${fmtInt(queue.length)}`);
    }
    if (job.status === 'running') {
      parts.push(limited ? 'paused by the rate limit' : `running ${fmtDuration(now - (job.startedAt ?? now))}, ${Math.round(jobProgress(job) * 100)}%`);
    }
    if (job.priority === 'high') parts.push('high priority');
    if (job.priority === 'low') parts.push('low priority');
    if ((job.attempt ?? 1) > 1) parts.push(`attempt ${job.attempt}${job.maxAttempts ? ` of ${job.maxAttempts}` : ''}`);
    return parts.join(', ');
  };

  const renderJob = (p: PlacedJob) => {
    const job = p.job;
    const gone = p.shape === 'gone';
    const attempt = job.attempt ?? 1;
    const halted = job.status === 'running' && limited;
    const meta =
      job.status === 'queued'
        ? fmtDuration(now - job.enqueuedAt)
        : job.status === 'running'
          ? halted
            ? 'Paused'
            : fmtDuration(now - (job.startedAt ?? now))
          : job.status === 'done'
            ? 'Done'
            : 'Failed';
    const seen = trackRef.current.seen.get(job.id);
    const delay = seen && !seen.fresh ? Math.min(420, (p.index ?? 0) * 22) : 0;
    return (
      <button
        key={job.id}
        ref={(el) => {
          if (el) jobEls.current.set(job.id, el);
          else jobEls.current.delete(job.id);
        }}
        type="button"
        className="ui-agqc__job"
        data-shape={p.shape}
        data-kind={job.kind}
        data-status={job.status}
        data-flash={p.flash ? '' : undefined}
        data-halted={halted ? '' : undefined}
        data-priority={job.priority && job.priority !== 'normal' ? job.priority : undefined}
        data-open={openId === job.id ? '' : undefined}
        tabIndex={!gone && activeJobId === job.id ? 0 : -1}
        aria-hidden={gone || undefined}
        aria-label={jobLabel(p)}
        aria-haspopup="dialog"
        aria-expanded={openId === job.id}
        style={
          {
            translate: `${p.box.x}px ${p.box.y}px`,
            width: p.box.w,
            height: p.box.h,
            '--p': p.p ?? jobProgress(job),
            animationDelay: `${delay}ms`,
          } as CSSProperties
        }
        onPointerEnter={() => {
          if (!gone) setHoverId(job.id);
        }}
        onPointerLeave={() => setHoverId((cur) => (cur === job.id ? null : cur))}
        onFocus={() => setFocusId(job.id)}
        onClick={() => {
          if (gone) return;
          setFocusId(job.id);
          selectOpen(openId === job.id ? null : job.id);
        }}
        onKeyDown={(e) => onJobKeyDown(e, job)}
      >
        <span className="ui-agqc__fill" aria-hidden="true" />
        <span className="ui-agqc__job-in" aria-hidden="true">
          <span className="ui-agqc__job-icon" data-logo={job.icon ? '' : undefined}>
            {job.icon ?? <KindIcon kind={job.kind} />}
          </span>
          <span className="ui-agqc__job-name" dir="auto">
            {job.name}
          </span>
          {job.priority === 'high' && (
            <span className="ui-agqc__badge" data-kind="high" title="High priority">
              <FrontIcon />
            </span>
          )}
          {attempt > 1 && (
            <span className="ui-agqc__badge" data-kind="retry" title={`Attempt ${attempt}`}>
              <RetryIcon />
              {attempt}
            </span>
          )}
          <span className="ui-agqc__job-meta">{meta}</span>
        </span>
      </button>
    );
  };

  const renderPop = (p: PlacedJob) => {
    const job = p.job;
    const pinned = !!openPlaced;
    const attempt = job.attempt ?? 1;
    const worker = job.worker ? workers.find((w) => w.id === job.worker) : undefined;
    const stats: Array<[string, string]> = [
      job.status === 'queued'
        ? ['Waiting', fmtDuration(now - job.enqueuedAt)]
        : ['Waited', fmtDuration((job.startedAt ?? now) - job.enqueuedAt)],
      ...(job.status === 'running' ? ([['Running', fmtDuration(now - (job.startedAt ?? now))]] as Array<[string, string]>) : []),
      ...(job.status === 'queued'
        ? ([[`Position`, `${fmtInt((p.index ?? 0) + 1)} of ${fmtInt(queue.length)}`]] as Array<[string, string]>)
        : []),
      ...(job.status === 'running' && worker ? ([[`Worker`, worker.name]] as Array<[string, string]>) : []),
      ['Priority', job.priority === 'high' ? 'High' : job.priority === 'low' ? 'Low' : 'Normal'],
      ['Attempt', `${attempt}${job.maxAttempts ? ` of ${job.maxAttempts}` : ''}`],
    ];
    const popW = Math.min(flow.narrow ? measuredWidth - 2 * flow.pad : 280, measuredWidth - 16);
    const below = p.box.y + p.box.h + 6;
    const popY = below + popHeight > flow.height + 120 && p.box.y - popHeight - 6 > 0 ? p.box.y - popHeight - 6 : below;
    const popX = clamp(p.box.x, 8, measuredWidth - popW - 8);
    const halted = job.status === 'running' && limited;
    const statusText = halted ? 'Paused' : STATUS_LABEL[job.status];
    return (
      <div
        key={job.id}
        ref={popRef}
        className="ui-agqc__pop"
        role={pinned ? 'dialog' : 'tooltip'}
        aria-label={`${job.name} details`}
        data-pinned={pinned ? '' : undefined}
        data-kind={job.kind}
        data-status={halted ? 'halted' : job.status}
        style={{ translate: `${popX}px ${popY}px`, width: popW }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            selectOpen(null);
            jobEls.current.get(job.id)?.focus();
          }
        }}
      >
        <div className="ui-agqc__pop-head">
          <span className="ui-agqc__pop-icon" data-logo={job.icon ? '' : undefined}>
            {job.icon ?? <KindIcon kind={job.kind} />}
          </span>
          <span className="ui-agqc__pop-who">
            <span className="ui-agqc__pop-name" dir="auto">
              {job.name}
            </span>
            <span className="ui-agqc__pop-kind" dir="auto">
              {KIND_LABEL[job.kind]}
              {job.detail ? ` · ${job.detail}` : ''}
            </span>
          </span>
          <span className="ui-agqc__pill" data-status={halted ? 'halted' : job.status}>
            {statusText}
          </span>
          {pinned && (
            <button
              type="button"
              className="ui-agqc__close"
              aria-label="Close details"
              onClick={() => {
                selectOpen(null);
                jobEls.current.get(job.id)?.focus();
              }}
            >
              <CloseIcon size={14} w={1.8} />
            </button>
          )}
        </div>
        <dl className="ui-agqc__pop-stats">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {job.error && (
          <p className="ui-agqc__pop-error">
            <AlertIcon />
            <span dir="auto">{job.error}</span>
          </p>
        )}
        {pinned && (onPromote || onCancel) && (job.status === 'queued' || job.status === 'running') && (
          <div className="ui-agqc__pop-actions">
            {onPromote && job.status === 'queued' && (p.index ?? 0) > 0 && (
              <button type="button" className="ui-agqc__btn" onClick={() => onPromote(job)}>
                <FrontIcon />
                Move to front
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                className="ui-agqc__btn"
                data-kind="danger"
                onClick={() => {
                  onCancel(job);
                  selectOpen(null);
                }}
              >
                <CloseIcon size={10} />
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const boxStyle = (b: Box): CSSProperties => ({ translate: `${b.x}px ${b.y}px`, width: b.w, height: b.h });

  const busyWorkers = running.filter((j) => j.worker !== undefined && workerIndex.has(j.worker)).length;
  const stats: Array<{ label: string; value: ReactNode; kind?: string }> = [
    { label: 'Waiting', value: AnimatedNum('waiting', waiting.length, fmtInt), kind: overLine ? 'warn' : undefined },
    {
      label: 'Running',
      value: (
        <>
          {AnimatedNum('running', busyWorkers, fmtInt)}
          <span className="ui-agqc__of">/{workers.length}</span>
        </>
      ),
    },
    {
      label: 'Throughput',
      value: (
        <>
          {AnimatedNum('rate', throughput, fmtInt)}
          <span className="ui-agqc__of">/min</span>
        </>
      ),
    },
    { label: 'Wait p95', value: AnimatedNum('p95', waitP95, fmtDuration) },
  ];

  const limitSeconds = activeLimit ? Math.max(0, Math.ceil((activeLimit.until - now) / 1e3)) : 0;
  const stateLabel = state === 'paused' ? 'Paused' : state === 'live' ? 'Live' : 'Idle';
  const canDec = workers.length > minConcurrency;
  const canInc = workers.length < maxConcurrency;

  const styleProps = {
    href: 'ui-agent-queue-clean',
    precedence: 'default',
    children: AGENT_QUEUE_CSS,
  } as unknown as HTMLAttributes<HTMLStyleElement>;

  return (
    <div ref={rootRef} className={['ui-agqc', className].filter(Boolean).join(' ')} data-state={state}>
      {/* Hoisted to <head> by React 19; rendered inline (still effective) on React 18. */}
      <style {...styleProps} />
      <header className="ui-agqc__head">
        <span className="ui-agqc__mark">
          <QueueMarkIcon />
        </span>
        <span className="ui-agqc__title" title={title}>
          {title}
        </span>
        {name && <span className="ui-agqc__name">{name}</span>}
        <span
          className="ui-agqc__pill"
          data-status={state}
          role={state === 'limited' ? 'status' : undefined}
          title={state === 'limited' ? activeLimit?.label : undefined}
        >
          {(state === 'live' || state === 'limited') && <span className="ui-agqc__pulse" aria-hidden="true" />}
          {state === 'limited' ? (
            <>
              Rate limited ·{' '}
              <span className="ui-agqc__num">{limitSeconds < 100 ? `${limitSeconds}s` : fmtDuration(limitSeconds * 1e3)}</span>
            </>
          ) : (
            stateLabel
          )}
        </span>
        <span className="ui-agqc__tools">
          {onPausedChange && (
            <button
              type="button"
              className="ui-agqc__btn"
              aria-pressed={paused}
              aria-label={paused ? 'Resume the queue' : 'Pause the queue'}
              onClick={() => onPausedChange(!paused)}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
              <span className="ui-agqc__btn-text">{paused ? 'Resume' : 'Pause'}</span>
            </button>
          )}
          {onConcurrencyChange && (
            <span className="ui-agqc__stepper" role="group" aria-label="Workers">
              <button type="button" aria-label="One worker less" disabled={!canDec} onClick={() => canDec && onConcurrencyChange(workers.length - 1)}>
                <MinusIcon />
              </button>
              <output className="ui-agqc__stepper-value" aria-live="polite" aria-label={`${workers.length} workers`}>
                {workers.length}
              </output>
              <button type="button" aria-label="One worker more" disabled={!canInc} onClick={() => canInc && onConcurrencyChange(workers.length + 1)}>
                <PlusIcon />
              </button>
            </span>
          )}
        </span>
      </header>
      <div ref={cardRef} className="ui-agqc__card">
        <dl className="ui-agqc__stats">
          {stats.map((s) => (
            <div className="ui-agqc__stat" data-kind={s.kind} key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
        <div className="ui-agqc__flow" style={{ height: flow.height }} data-narrow={flow.narrow ? '' : undefined}>
          <span className="ui-agqc__col-head" style={boxStyle(flow.heads.queue)}>
            <span>Queue</span>
            <b>{AnimatedNum('depth', waiting.length, fmtInt)}</b>
            {hiddenCount > 0 && flow.narrow && <span className="ui-agqc__col-more">+{fmtInt(hiddenCount)} more</span>}
          </span>
          <span className="ui-agqc__col-head" style={boxStyle(flow.heads.workers)}>
            <span>Workers</span>
            <b>
              {busyWorkers}/{workers.length}
            </b>
          </span>
          <span className="ui-agqc__well" aria-hidden="true" data-empty={waiting.length <= chipCount ? '' : undefined} style={boxStyle(flow.well)} />
          {queue.length === 0 && (
            <span
              className="ui-agqc__empty"
              style={boxStyle({
                x: flow.chips[0].x,
                y: flow.chips[0].y,
                w: flow.chips[0].w,
                h: flow.well.y + flow.well.h - flow.chips[0].y,
              })}
            >
              Nothing waiting
            </span>
          )}
          {overflow && (
            <span
              className="ui-agqc__more"
              aria-hidden="true"
              style={boxStyle({
                x: flow.grid.x + ((gridCells - 3) % flow.grid.cols) * flow.grid.step,
                y: flow.grid.y + Math.floor((gridCells - 3) / flow.grid.cols) * ROW_H,
                w: 2 * flow.grid.step + SQUARE,
                h: SQUARE,
              })}
            >
              +{fmtCount(hiddenCount)}
            </span>
          )}
          {workers.map((worker, i) => {
            const slot = flow.slots[i];
            const busy = running.some((j) => j.worker === worker.id);
            return (
              <div key={worker.id} className="ui-agqc__slot" data-busy={busy ? '' : undefined} data-limited={limited ? '' : undefined} style={boxStyle(slot)}>
                <span className="ui-agqc__who" style={{ width: flow.rail.x - 16 }}>
                  <span className="ui-agqc__logo" data-logo={worker.icon ? '' : undefined}>
                    {worker.icon ?? initials(worker.name)}
                  </span>
                  <span className="ui-agqc__who-text">
                    <span className="ui-agqc__who-name">{worker.name}</span>
                  </span>
                </span>
                <span
                  className="ui-agqc__rail"
                  style={{ left: flow.rail.x, top: flow.rail.y, width: flow.rail.w, height: flow.rail.h }}
                >
                  {!busy && <span>{limited || paused ? 'Paused' : 'Idle'}</span>}
                </span>
              </div>
            );
          })}
          {(['done', 'failed'] as const).map((kind) => {
            const count = kind === 'done' ? doneTotal : failedTotal;
            return (
              <div key={kind} className="ui-agqc__bin" data-kind={kind} style={boxStyle(kind === 'done' ? flow.done : flow.failed)}>
                <span className="ui-agqc__bin-icon">{kind === 'done' ? <CheckIcon /> : <CloseIcon />}</span>
                <span className="ui-agqc__bin-label">{kind === 'done' ? 'Done' : 'Failed'}</span>
                <span className="ui-agqc__bin-count" title={fmtInt(count)}>
                  {AnimatedNum(`bin-${kind}`, count, fmtCount)}
                </span>
                <span key={count} className="ui-agqc__bin-hit" aria-hidden="true" />
              </div>
            );
          })}
          <div className="ui-agqc__jobs" role="group" aria-label={`Jobs: ${busyWorkers} running, ${waiting.length} waiting`}>
            {placed.map(renderJob)}
          </div>
          {shownPop && renderPop(shownPop)}
        </div>
        <div className="ui-agqc__chart" style={{ '--ui-agqc-gutter': `${gutter}px` } as CSSProperties}>
          <div className="ui-agqc__chart-head">
            <span className="ui-agqc__chart-title">Queue depth</span>
          </div>
          <div className="ui-agqc__plot" role="img" aria-label={chartAria} style={{ height: plotH }}>
            {[0, ymax].map((v) => (
              <span
                key={v}
                className="ui-agqc__grid"
                data-zero={v === 0 ? '' : undefined}
                style={{ '--v': v } as CSSProperties}
                aria-hidden="true"
              >
                {(backpressure === undefined || Math.abs(v - backpressure) > ymax * 0.1) && <span>{fmtInt(v)}</span>}
              </span>
            ))}
            <svg className="ui-agqc__svg" width={plotW} height={plotH} viewBox={`0 0 ${plotW} ${plotH}`} aria-hidden="true">
              <defs>
                <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0" className="ui-agqc__stop" data-at="top" />
                  <stop offset="1" className="ui-agqc__stop" data-at="bottom" />
                </linearGradient>
              </defs>
              {bands.map(({ limit, x1, x2 }) => (
                <g key={limit.from} className="ui-agqc__band">
                  <rect x={x1} y={0} width={Math.max(1, x2 - x1)} height={plotH} />
                </g>
              ))}
              <g className="ui-agqc__scaled" style={{ '--h': plotH } as CSSProperties}>
                <path className="ui-agqc__area" d={areaPath} fill={`url(#${gradId})`} />
                <path className="ui-agqc__line" d={linePath} />
                {backpressure !== undefined && <line className="ui-agqc__bp" x1={0} x2={plotW} y1={backpressure} y2={backpressure} />}
              </g>
            </svg>
            {backpressure !== undefined && (
              <span className="ui-agqc__bp-label" style={{ '--v': backpressure } as CSSProperties} aria-hidden="true">
                {backpressure}
              </span>
            )}
            <span className="ui-agqc__dot" style={{ '--v': waiting.length } as CSSProperties} aria-hidden="true" />
          </div>
          <div className="ui-agqc__axis" aria-hidden="true">
            <span>{windowLabel} ago</span>
            <span>now</span>
          </div>
        </div>
      </div>
      <div className="ui-agqc__sr" aria-live="polite">
        {liveMsg}
      </div>
    </div>
  );
}

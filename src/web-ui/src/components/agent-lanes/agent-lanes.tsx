/**
 * AgentLanes — where every agent is right now, as a live timeline.
 *
 * A lane per agent, tasks growing into "now", hand-offs drawn between
 * lanes, waiting tasks asking you to decide. The window slides with the
 * clock; blocks and curves move together.
 *
 * Reconstructed in readable form from the affectUI "clean" style bundle
 * (https://www.affectui.com/components/agent-lanes). All layout, timing,
 * animation and a11y logic is preserved 1:1 from the original.
 *
 * Brand logos are NOT part of the component — pass them as `avatar`/`tools`.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { AGENT_LANES_CSS } from "./agent-lanes-css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ types */

export type LaneTaskStatus = "done" | "running" | "waiting" | "failed";

export interface LaneAgent {
  id: string;
  name: string;
  /** model name shown under the agent's name */
  model?: string;
  /** a logo; without one the initials show */
  avatar?: ReactNode;
}

export interface LaneTask {
  id: string;
  agentId: string;
  title: string;
  status: LaneTaskStatus;
  /** epoch ms or Date */
  start: number | Date;
  /** no end: the block reaches "now" */
  end?: number | Date;
  /** id of the next agent's task this one hands over to */
  handoffTo?: string;
  /** one sentence on what needs deciding (waiting tasks) */
  ask?: string;
  /** two or three short points on what got done — the dark tooltip */
  summary?: string[];
  /** up to three small logos of the apps a task works in */
  tools?: ReactNode[];
}

export interface AgentLanesProps {
  agents: LaneAgent[];
  tasks: LaneTask[];
  /** how much time the lanes show, in ms */
  span?: number;
  /** a clock you control; without it the lanes follow real time */
  now?: number;
  /** approve/reject on a waiting task; without handlers the lanes change the status themselves */
  onApprove?: (task: LaneTask) => void;
  onReject?: (task: LaneTask) => void;
  /** shows an Open link in the tooltip of a block that doesn't wait */
  onOpen?: (task: LaneTask) => void;
  title?: string;
  className?: string;
}

/* -------------------------------------------------------------- constants */

const MIN_MS = 60_000;
/** lane height in px — also drives the hand-off curve viewBox */
const ROW_PX = 48;

const STATUS_LABEL: Record<LaneTaskStatus, string> = {
  done: "Done",
  running: "Running",
  waiting: "Needs you",
  failed: "Failed",
};

/** candidate tick steps (minutes) — the first that gives ≤ 6 ticks wins */
const TICK_MINUTES = [1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

/* --------------------------------------------------------------- helpers */

const toTs = (v: number | Date): number =>
  typeof v === "number" ? v : v.getTime();

/** compact duration in minute units: "5m", "915m", "10080m" */
const fmtSpan = (ms: number): string =>
  `${Math.max(0, Math.round(ms / MIN_MS))}m`;

/** first letter of the first two words, uppercased */
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();

/* ------------------------------------------------------------- UI icons */

const SparkIcon = () =>
  jsxs("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 14 14",
    "aria-hidden": "true",
    children: [
      jsx("path", {
        d: "M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z",
        fill: "currentColor",
      }),
      jsx("circle", {
        cx: "11.6",
        cy: "11.4",
        r: "1.1",
        fill: "currentColor",
        opacity: "0.55",
      }),
    ],
  });

const FlagIcon = () =>
  jsx("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    "aria-hidden": "true",
    children: jsx("path", {
      d: "M6 1.8 10.8 10H1.2L6 1.8Z",
      fill: "currentColor",
    }),
  });

/* ------------------------------------------------------------- component */

export function AgentLanes({
  agents,
  tasks: tasksProp,
  span = 30 * MIN_MS,
  now,
  onApprove,
  onReject,
  onOpen,
  title = "Agents",
  className,
}: AgentLanesProps) {
  const uid = useId();
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [openId, setOpenId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<
    Record<string, Partial<LaneTask>>
  >({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  // the clock: without a `now` prop the lanes follow real time
  useEffect(() => {
    if (now !== undefined) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [now]);

  const nowMs = now ?? nowTick;
  const spanStart = nowMs - span;

  // local overrides apply when no approve/reject handlers are given
  const tasks = tasksProp.map((t) =>
    overrides[t.id] ? { ...t, ...overrides[t.id] } : t,
  );

  const decide = (task: LaneTask, approve: boolean) => {
    setOpenId(null);
    const handler = approve ? onApprove : onReject;
    if (handler) return handler(task);
    setOverrides((prev) => ({
      ...prev,
      [task.id]: approve
        ? { status: "running" }
        : { status: "failed", end: nowMs },
    }));
  };

  /** screen position of a timestamp inside the window (0–100%) */
  const pctOf = (ts: number) => Math.min(100, ((ts - spanStart) / span) * 100);

  // the layer spans [mount − span, mount + span] and slides with the clock
  const mountNow = useRef(nowMs).current;
  const layerPct = (ts: number) => ((ts - mountNow) / span) * 100 + 100;
  const shiftPct = ((nowMs - mountNow) / span) * 100;

  // tasks that touch the window
  const visible = tasks.filter(
    (t) => (t.end === undefined ? nowMs : toTs(t.end)) > spanStart,
  );

  // grid ticks: at most ~5, aligned to a friendly minute step
  const ticks = useMemo(() => {
    const step =
      (TICK_MINUTES.find((m) => span / (m * MIN_MS) <= 6) ??
        Math.ceil(span / (8640 * MIN_MS)) * 1440) * MIN_MS;
    const ago: number[] = [];
    for (let t = span - step; t > 0; t -= step) ago.push(t);
    return { step, ago };
  }, [span]);

  const laneIndex = (agentId: string) =>
    agents.findIndex((a) => a.id === agentId);

  // hand-off curves between lanes, in a 1000 × (rows × 48) viewBox
  const handoffCurves = visible.flatMap((task) => {
    const target = task.handoffTo
      ? tasks.find((t) => t.id === task.handoffTo)
      : undefined;
    if (!target) return [];
    const x1 = layerPct(task.end === undefined ? nowMs : toTs(task.end)) * 10;
    const x2 = layerPct(toTs(target.start)) * 10;
    const y1 = laneIndex(task.agentId) * ROW_PX + ROW_PX / 2;
    const y2 = laneIndex(target.agentId) * ROW_PX + ROW_PX / 2;
    if (y1 < 0 || y2 < 0) return [];
    const ctrl = Math.max(24, Math.abs(x2 - x1) / 2);
    return [
      {
        id: `${task.id}>${target.id}`,
        d: `M ${x1} ${y1} C ${x1 + ctrl} ${y1}, ${x2 - ctrl} ${y2}, ${x2} ${y2}`,
        live: target.status === "running",
      },
    ];
  });

  // close the popover on an outside pointerdown
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: PointerEvent) => {
      if (
        (e.target as Element).closest?.(
          `[data-task="${openId}"], .ui-alc__pop`,
        )
      )
        return;
      setOpenId(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openId]);

  const openTask = visible.find((t) => t.id === openId);

  // the little state tag next to a name (kept across renders in a ref)
  const agentStateRef = useRef<Record<string, string>>({});
  for (const agent of agents) {
    const active = tasks.find(
      (t) =>
        t.agentId === agent.id &&
        (t.status === "running" || t.status === "waiting"),
    );
    if (active?.status === "waiting") agentStateRef.current[agent.id] = "Needs you";
    else if (!active) agentStateRef.current[agent.id] = "Idle";
  }

  const waitingCount = tasks.filter((t) => t.status === "waiting").length;
  const runningCount = tasks.filter((t) => t.status === "running").length;

  return jsxs("div", {
    ref: rootRef,
    className: ["ui-alc", className].filter(Boolean).join(" "),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape" && openId) {
        e.stopPropagation();
        (
          rootRef.current?.querySelector(
            `[data-task="${openId}"]`,
          ) as HTMLElement | null
        )?.focus();        setOpenId(null);
      }
    },
    children: [
      // React 19 hoists this once per document; harmless on React 18
      jsx("style", {
        href: "ui-agent-lanes-clean",
        precedence: "default",
        children: AGENT_LANES_CSS,
      }),
      jsxs("div", {
        className: "ui-alc__card",
        children: [
          jsxs("header", {
            className: "ui-alc__bar",
            children: [
              jsx("span", {
                className: "ui-alc__spark",
                children: jsx(SparkIcon, {}),
              }),
              jsx("span", {
                className: "ui-alc__title",
                title,
                children: title,
              }),
              jsxs("span", {
                className: "ui-alc__summary",
                children: [
                  jsxs("span", {
                    "data-kind": "running",
                    children: [runningCount, ` running`],
                  }),
                  waitingCount > 0 &&
                    jsxs("span", {
                      "data-kind": "needs",
                      children: [
                        waitingCount,
                        ` `,
                        waitingCount === 1 ? "needs" : "need",
                        ` you`,
                      ],
                    }),
                ],
              }),
              jsxs("span", {
                className: "ui-alc__window",
                children: [`Last `, fmtSpan(span)],
              }),
            ],
          }),
          jsxs("div", {
            className: "ui-alc__body",
            style: { "--rows": agents.length },
            children: [
              jsx("ul", {
                className: "ui-alc__agents",
                children: agents.map((agent) => {
                  const active = tasks.find(
                    (t) =>
                      t.agentId === agent.id &&
                      (t.status === "running" || t.status === "waiting"),
                  );
                  return jsxs(
                    "li",
                    {
                      className: "ui-alc__agent",
                      children: [
                        jsx("span", {
                          className: "ui-alc__avatar",
                          "data-logo": agent.avatar ? "" : undefined,
                          children: agent.avatar ?? initials(agent.name),
                        }),
                        jsxs("span", {
                          className: "ui-alc__who",
                          "data-state": active?.status ?? "idle",
                          children: [
                            jsxs("span", {
                              className: "ui-alc__name-line",
                              children: [
                                jsx("span", {
                                  className: "ui-alc__name",
                                  dir: "auto",
                                  title: agent.name,
                                  children: agent.name,
                                }),
                                jsx("span", {
                                  className: "ui-alc__state",
                                  "data-show":
                                    active?.status === "running"
                                      ? undefined
                                      : "",
                                  "aria-hidden": active?.status === "running",
                                  children: jsx(Badge, {
                                    size: "sm",
                                    variant:
                                      active?.status === "waiting"
                                        ? "warning"
                                        : "secondary",
                                    children:
                                      active?.status === "waiting"
                                        ? "Needs you"
                                        : active
                                          ? (agentStateRef.current[agent.id] ??
                                            "Idle")
                                          : "Idle",
                                  }),
                                }),
                              ],
                            }),
                            jsx("span", {
                              className: "ui-alc__model",
                              children:
                                agent.model &&
                                jsx("span", {
                                  className: "ui-alc__model-name",
                                  title: agent.model,
                                  children: agent.model,
                                }),
                            }),
                          ],
                        }),
                      ],
                    },
                    agent.id,
                  );
                }),
              }),
              jsxs("div", {
                className: "ui-alc__track",
                children: [
                  jsx("div", {
                    className: "ui-alc__grid",
                    "aria-hidden": "true",
                    children: ticks.ago.map((ago) =>
                      jsx(
                        "span",
                        {
                          className: "ui-alc__tick",
                          style: { left: `${100 - (ago / span) * 100}%` },
                          children: jsxs("span", {
                            children: [`−`, fmtSpan(ago)],
                          }),
                        },
                        ago,
                      ),
                    ),
                  }),
                  jsx("div", {
                    className: "ui-alc__clip",
                    children: jsxs("div", {
                      className: "ui-alc__layer",
                      style: { transform: `translateX(${-shiftPct}%)` },
                      children: [
                        jsx("svg", {
                          className: "ui-alc__curves",
                          viewBox: `0 0 1000 ${agents.length * ROW_PX}`,
                          preserveAspectRatio: "none",
                          "aria-hidden": "true",
                          children: handoffCurves.map((curve) =>
                            jsx(
                              "path",
                              {
                                d: curve.d,
                                "data-live": curve.live ? "" : undefined,
                                vectorEffect: "non-scaling-stroke",
                              },
                              curve.id,
                            ),
                          ),
                        }),
                        agents.map((agent, lane) =>
                          jsx(
                            "ul",
                            {
                              className: "ui-alc__lane",
                              style: { top: lane * ROW_PX },
                              "aria-label": `${agent.name}'s tasks`,
                              children: visible
                                .filter((t) => t.agentId === agent.id)
                                .map((task) => {
                                  const end =
                                    task.end === undefined
                                      ? nowMs
                                      : toTs(task.end);
                                  const width =
                                    ((end - toTs(task.start)) / span) * 100;
                                  const durLabel = fmtSpan(
                                    end - toTs(task.start),
                                  );
                                  const isOpen = openId === task.id;
                                  // a still-running block whose start slid
                                  // out of the window keeps its text inside
                                  const padFrac =
                                    task.end === undefined &&
                                    toTs(task.start) < spanStart
                                      ? (spanStart - toTs(task.start)) /
                                        (end - toTs(task.start))
                                      : 0;
                                  return jsxs(
                                    "li",
                                    {
                                      className: "ui-alc__slot",
                                      "data-status": task.status,
                                      style: {
                                        left: `${layerPct(toTs(task.start))}%`,
                                        width: `${width}%`,
                                      },
                                      children: [
                                        jsxs("button", {
                                          type: "button",
                                          "data-task": task.id,
                                          className: "ui-alc__block",
                                          "data-status": task.status,
                                          title: task.title,
                                          style: padFrac
                                            ? {
                                                paddingLeft: `calc(${padFrac * 100}% + 40px)`,
                                              }
                                            : undefined,
                                          "data-open": isOpen ? "" : undefined,
                                          "aria-expanded": isOpen,
                                          "aria-controls": `${uid}-${task.id}`,
                                          "aria-label": `${agent.name}: ${task.title} – ${STATUS_LABEL[task.status]}${task.status === "done" ? `, took ${durLabel}` : `, ${durLabel}`}`,
                                          onClick: () =>
                                            setOpenId(
                                              isOpen ? null : task.id,
                                            ),
                                          children: [
                                            task.tools &&
                                              task.tools.length > 0 &&
                                              jsx("span", {
                                                className: "ui-alc__tools",
                                                "aria-hidden": "true",
                                                children: task.tools
                                                  .slice(0, 3)
                                                  .map((tool, i) =>
                                                    jsx(
                                                      "span",
                                                      {
                                                        className:
                                                          "ui-alc__tool",
                                                        children: tool,
                                                      },
                                                      i,
                                                    ),
                                                  ),
                                              }),
                                            jsx("span", {
                                              className: "ui-alc__label",
                                              dir: "auto",
                                              children: task.title,
                                            }),
                                          ],
                                        }),
                                        task.status === "waiting" &&
                                          jsxs("span", {
                                            className: "ui-alc__flag",
                                            "aria-hidden": "true",
                                            children: [
                                              jsx(FlagIcon, {}),
                                              `Needs you`,
                                            ],
                                          }),
                                      ],
                                    },
                                    task.id,
                                  );
                                }),
                            },
                            agent.id,
                          ),
                        ),
                      ],
                    }),
                  }),
                  openTask &&
                    (() => {
                      const lane = laneIndex(openTask.agentId);
                      const up = lane >= agents.length / 2;
                      const end =
                        openTask.end === undefined
                          ? nowMs
                          : toTs(openTask.end);
                      const agent = agents[lane];

                      // a waiting task asks for a decision
                      if (openTask.status === "waiting")
                        return jsxs("div", {
                          className: "ui-alc__pop ui-alc__ask",
                          id: `${uid}-${openTask.id}`,
                          role: "dialog",
                          "aria-label": `Decide: ${openTask.title}`,
                          "data-up": up ? "" : undefined,
                          style: {
                            top: up ? lane * ROW_PX + 6 : (lane + 1) * ROW_PX - 6,
                            right: `${100 - pctOf(end)}%`,
                          },
                          children: [
                            jsx("span", {
                              className: "ui-alc__ask-title",
                              dir: "auto",
                              children: openTask.title,
                            }),
                            openTask.ask &&
                              jsx("span", {
                                className: "ui-alc__ask-text",
                                dir: "auto",
                                children: openTask.ask,
                              }),
                            jsxs("span", {
                              className: "ui-alc__ask-actions",
                              children: [
                                jsx(Button, {
                                  size: "xs",
                                  type: "button",
                                  variant: "outline",
                                  onClick: () => decide(openTask, false),
                                  children: `Reject`,
                                }),
                                jsx(Button, {
                                  size: "xs",
                                  type: "button",
                                  autoFocus: true,
                                  onClick: () => decide(openTask, true),
                                  children: `Approve`,
                                }),
                              ],
                            }),
                          ],
                        });

                      // anything else gets a tooltip
                      const mid =
                        (Math.max(0, pctOf(toTs(openTask.start))) +
                          pctOf(end)) /
                        2;
                      return jsxs("div", {
                        className: "ui-alc__pop ui-alc__tip",
                        id: `${uid}-${openTask.id}`,
                        role: "tooltip",
                        "data-up": up ? "" : undefined,
                        style: {
                          top: up ? lane * ROW_PX + 6 : (lane + 1) * ROW_PX - 6,
                          left: `${Math.max(14, Math.min(86, mid))}%`,
                        },
                        children: [
                          jsxs("span", {
                            className: "ui-alc__tip-head",
                            children: [
                              jsx("span", {
                                className: "ui-alc__tip-name",
                                dir: "auto",
                                children: agent?.name,
                              }),
                              jsxs("span", {
                                children: [
                                  `· `,
                                  STATUS_LABEL[openTask.status],
                                  ` · `,
                                  fmtSpan(end - toTs(openTask.start)),
                                ],
                              }),
                            ],
                          }),
                          openTask.summary?.length
                            ? jsx("ul", {
                                className: "ui-alc__tip-list",
                                children: openTask.summary.map((line) =>
                                  jsx(
                                    "li",
                                    { dir: "auto", children: line },
                                    line,
                                  ),
                                ),
                              })
                            : jsx("span", {
                                className: "ui-alc__tip-title",
                                dir: "auto",
                                children: openTask.title,
                              }),
                          onOpen &&
                            jsx(Button, {
                              className: "justify-self-start text-white dark:text-black",
                              size: "xs",
                              type: "button",
                              variant: "link",
                              onClick: () => onOpen(openTask),
                              children: `Open`,
                            }),
                        ],
                      });
                    })(),
                  jsx("span", {
                    className: "ui-alc__now",
                    "aria-hidden": "true",
                    children: jsx("span", { children: `now` }),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      jsx("span", {
        className: "ui-alc__sr",
        "aria-live": "polite",
        children:
          waitingCount > 0
            ? `${waitingCount} task${waitingCount === 1 ? `` : `s`} need you`
            : `${runningCount} running`,
      }),
    ],
  });
}

export default AgentLanes;

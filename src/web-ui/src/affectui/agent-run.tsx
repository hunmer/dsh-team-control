import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppShell, Icon, Menu } from "./app-shell";
import { DELIVERABLES_ICON, PANEL_ICON, SEARCH_ICON } from "./icon-paths";
import type { IconDef } from "./icon-paths";
import {
  ANALYTICS_ICON,
  BOARD_CHART_ICON,
  CALENDAR_ICON,
  CHAT_ICON,
  CLOCK_ICON,
  COPY_ICON,
  DATABASE_ICON,
  DOCS_ICON,
  DOLLAR_ICON,
  HOME_ICON,
  MAIL_ICON,
  MORE_HORIZONTAL_ICON,
  PLAY_ICON,
  REPEAT_ICON,
  SHARE_ICON,
  STOP_ICON,
  WORKFLOW_ICON,
} from "./icons";
import { AGENT_RUN_CSS } from "./agent-run-css";
import { PlanSteps } from "./plan-steps";
import { ApprovalCard } from "./approval-card";
import { Button } from "@/components/ui/button";
import { RunLoader } from "./loader";
import { ToolCallGroup, ToolCall } from "./tool-calls";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunCallDef {
  name: string;
  summary: string;
  args: unknown;
  result?: unknown;
  duration: number;
  icon?: IconDef;
}

export interface AgentRunStepDef {
  id: string;
  title: string;
  detail: string;
  tool: string;
  calls: AgentRunCallDef[];
}

export interface AgentRunApprovalRequest {
  id: string;
  title: string;
  description: string;
  risk?: "low" | "medium" | "high";
  /** Small strip above the card, e.g. the requesting member. */
  label?: string;
  details?: { label: string; value: string }[];
  status?: "pending" | "approved" | "denied";
}

export interface AgentRunProps {
  title?: string;
  steps?: AgentRunStepDef[];
  /** Real approval requests (e.g. sidecar scope requests) shown in the side panel. */
  approvals?: AgentRunApprovalRequest[];
  agent?: string;
  autoRun?: boolean;
  onApproveRequest?: (id: string) => void;
  onDenyRequest?: (id: string) => void;
  onStop?: () => void;
  onDone?: () => void;
  user?: { name?: string };
  onNavigate?: (target: string) => void;
  children?: ReactNode;
}

interface NavItem {
  label: string;
  icon: IconDef;
  count?: number;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

type TimelineEventKind = "step" | "call" | "end" | "finish";
interface TimelineEvent {
  kind: TimelineEventKind;
  s: number; // step index
  c?: number; // call index
  delay: number;
}

type RunPhase = "running" | "waiting" | "done" | "stopped";
type StepStatus = "done" | "active" | "pending" | "failed";
type CallState = "running" | "success";

// ---------------------------------------------------------------------------
// Demo data (verbatim from the original bundle)
// ---------------------------------------------------------------------------

const NAV_ITEMS: NavItem[] = [
  { label: `Home`, icon: HOME_ICON },
  { label: `Chat`, icon: CHAT_ICON },
  { label: `Runs`, icon: PLAY_ICON, count: 3 },
  { label: `Analytics`, icon: ANALYTICS_ICON },
  { label: `Deliverables`, icon: DELIVERABLES_ICON },
];

const NAV_GROUPS: NavGroup[] = [
  {
    label: `Agents`,
    items: [
      { label: `Board prep`, icon: BOARD_CHART_ICON },
      { label: `Revenue ops`, icon: DOLLAR_ICON },
      { label: `Inbox triage`, icon: MAIL_ICON },
      { label: `Workflows`, icon: WORKFLOW_ICON },
    ],
  },
];

const STEPS: AgentRunStepDef[] = [
  {
    id: `revenue`,
    title: `Pull Q3 revenue and churn`,
    detail: `From Stripe, July to September`,
    tool: `stripe.query`,
    calls: [
      {
        name: `stripe.query`,
        summary: `Revenue by month, Q3`,
        args: { metric: `revenue`, from: `2026-07-01`, to: `2026-09-30`, group_by: `month` },
        result: { total: 431e4, months: [138e4, 142e4, 151e4], growth: 0.21 },
        duration: 700,
      },
      {
        name: `stripe.query`,
        summary: `Customer churn, Q3`,
        args: { metric: `churn_rate`, period: `quarter` },
        result: { churn_rate: 0.018, previous: 0.021 },
        duration: 500,
      },
    ],
  },
  {
    id: `memo`,
    title: `Read last quarter's board memo`,
    detail: `Keeps the structure the board knows`,
    tool: `search`,
    calls: [
      {
        name: `search`,
        summary: `Drive: “board memo Q2”`,
        args: { query: `board memo Q2`, source: `drive`, limit: 5 },
        result: [{ title: `Board memo – Q2 2026`, owner: `Maya Chen`, edited: `Jul 9` }],
        duration: 900,
      },
      {
        name: `docs.read`,
        summary: `Board memo – Q2 2026`,
        args: { doc: `Board memo – Q2 2026` },
        result: `6 sections · 1,240 words`,
        duration: 700,
      },
    ],
  },
  {
    id: `draft`,
    title: `Update the memo draft`,
    detail: `Revenue, churn and the Q4 outlook`,
    tool: `docs.write`,
    calls: [
      {
        name: `docs.write`,
        summary: `Rewrote the revenue paragraph`,
        args: { doc: `Board memo – Q3 2026`, section: `Revenue` },
        result: { changed_words: 21 },
        duration: 1100,
      },
      {
        name: `docs.write`,
        summary: `Added the churn chart`,
        args: { doc: `Board memo – Q3 2026`, insert: `chart`, data: `churn_rate` },
        result: { ok: true },
        duration: 600,
      },
    ],
  },
  {
    id: `send`,
    title: `Send the draft to Maya`,
    detail: `Emails the Q3 board memo for review`,
    tool: `gmail.send`,
    calls: [
      {
        name: `gmail.send`,
        summary: `Sent to maya@acme.com`,
        args: { to: `maya@acme.com`, subject: `Q3 board update – draft`, attach: `Board memo – Q3 2026` },
        result: { id: `msg_8f2c`, status: `sent` },
        duration: 600,
      },
    ],
  },
  {
    id: `review`,
    title: `Book a review with Maya`,
    detail: `30 minutes before the board meeting`,
    tool: `calendar.create`,
    calls: [
      {
        name: `calendar.create`,
        summary: `Thu, Oct 15 · 10:00`,
        args: { title: `Q3 board memo review`, with: [`maya@acme.com`], duration: 30 },
        result: { event: `evt_31a`, time: `2026-10-15T10:00` },
        duration: 700,
      },
    ],
  },
];

const toolIcon = (tool: string): IconDef => {
  if (tool.startsWith(`stripe`)) return DOLLAR_ICON;
  if (tool.startsWith(`search`)) return SEARCH_ICON;
  if (tool.startsWith(`docs`)) return DOCS_ICON;
  if (tool.startsWith(`gmail`) || tool.startsWith(`mail`)) return MAIL_ICON;
  if (tool.startsWith(`calendar`)) return CALENDAR_ICON;
  return WORKFLOW_ICON;
};

/** Build the playback timeline: one event per visual state change, each with its delay. */
function buildTimeline(steps: AgentRunStepDef[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  steps.forEach((step, s) => {
    events.push({ kind: `step`, s, delay: s === 0 ? 150 : 300 });
    step.calls.forEach((call, c) => {
      events.push({ kind: `call`, s, c, delay: 200 });
      events.push({ kind: `end`, s, c, delay: call.duration });
    });
    events.push({ kind: `finish`, s, delay: 250 });
  });
  return events;
}

const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1e3));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, `0`)}`;
};
const formatDuration = (ms: number): string => {
  const total = Math.max(1, Math.round(ms / 1e3));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, `0`)}s`;
};

const PHASE_LABEL: Record<RunPhase, string> = {
  running: `Running`,
  waiting: `Needs input`,
  done: `Done`,
  stopped: `Stopped`,
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function AgentRun({
  title = `Prepare the Q3 board update`,
  steps = STEPS,
  approvals = [],
  agent = `Board prep`,
  autoRun = true,
  onApproveRequest,
  onDenyRequest,
  onStop,
  onDone,
  ...rest
}: AgentRunProps) {
  const timeline = useMemo(() => buildTimeline(steps), [steps]);
  const [cursor, setCursor] = useState(0);
  const [runSeed, setRunSeed] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [stopReason, setStopReason] = useState<`user` | null>(null);
  const [feedOpen, setFeedOpen] = useState<Record<number, boolean>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if ((rootRef.current?.offsetWidth ?? Infinity) <= 1e3) setPanelOpen(false);
  }, []);

  const played = timeline.slice(0, cursor);
  const startedSteps = new Set(played.filter((e) => e.kind === `step`).map((e) => e.s));
  const finishedSteps = new Set(played.filter((e) => e.kind === `finish`).map((e) => e.s));

  const callState = (s: number, c: number): CallState | null =>
    played.some((e) => e.kind === `end` && e.s === s && e.c === c)
      ? `success`
      : played.some((e) => e.kind === `call` && e.s === s && e.c === c)
        ? `running`
        : null;

  const activeStep = steps.findIndex((_, s) => startedSteps.has(s) && !finishedSteps.has(s));
  const isDone = cursor >= timeline.length;
  const phase: RunPhase = isDone ? `done` : stopReason ? `stopped` : `running`;

  useEffect(() => {
    if (!autoRun || stopReason || cursor >= timeline.length) return;
    const timer = window.setTimeout(() => setCursor((c) => c + 1), timeline[cursor].delay);
    return () => window.clearTimeout(timer);
  }, [autoRun, cursor, stopReason, timeline, runSeed]);

  useEffect(() => {
    if (isDone && endedAt === null) {
      setEndedAt(Date.now());
      onDone?.();
    }
  }, [isDone]);

  useEffect(() => {
    if (phase === `done` || phase === `stopped`) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1e3);
    return () => window.clearInterval(timer);
  }, [phase]);

  const planSteps = steps.map((step, s) => {
    const failed = stopReason && s === activeStep;
    return {
      id: step.id,
      title: step.title,
      detail: step.detail,
      tool: step.tool,
      status: (finishedSteps.has(s)
        ? `done`
        : failed
          ? `failed`
          : startedSteps.has(s)
            ? `active`
            : `pending`) as StepStatus,
      error: failed ? `Stopped by you` : undefined,
    };
  });

  const runAgain = () => {
    setCursor(0);
    setStopReason(null);
    setFeedOpen({});
    setEndedAt(null);
    setStartedAt(Date.now());
    setRunSeed((s) => s + 1);
  };
  const stopRun = () => {
    setStopReason(`user`);
    setEndedAt(Date.now());
    onStop?.();
  };
  const retryStep = (stepId: string) => {
    const s = steps.findIndex((step) => step.id === stepId);
    const eventIndex = timeline.findIndex((e) => e.kind === `step` && e.s === s);
    if (eventIndex < 0) return;
    setStopReason(null);
    setEndedAt(null);
    setCursor(eventIndex);
  };

  const elapsed = (endedAt ?? Date.now()) - startedAt;
  const startedClock = new Date(startedAt).toLocaleTimeString(`en-US`, { hour: `numeric`, minute: `2-digit` });
  const isActive = phase === `running`;
  const totalCalls = steps.reduce((sum, step) => sum + step.calls.length, 0);

  return (
    <AppShell active={`Runs`} nav={NAV_ITEMS} groups={NAV_GROUPS} {...rest}>
      <style href={`ui-agent-run`} precedence={`default`}>
        {AGENT_RUN_CSS}
      </style>
      <div ref={rootRef} className={`ui-ar`} data-panel={panelOpen || undefined}>
        <section className={`ui-ar__main`}>
          <header className={`ui-ar__bar`}>
            <span className={`ui-ar__crumbs`}>
              <Icon icon={PLAY_ICON} size={15} />
              {`Runs `}
              <i>{`/`}</i>
              {` `}
              <b>{title}</b>
              <span className={`ui-ar__pill`} data-phase={phase}>
                <span aria-hidden={`true`} />
                {PHASE_LABEL[phase]}
              </span>
            </span>
            <span className={`ui-ar__tools`}>
              <span className={`ui-ar__time`}>
                <Icon icon={CLOCK_ICON} size={14} />
                {phase === `done` ? `Done in ${formatDuration(elapsed)}` : `Started ${startedClock} · ${formatClock(elapsed)}`}
              </span>
              {isActive ? (
                <Button
                  className="panel-coss"
                  size="sm"
                  variant="secondary"
                  onClick={stopRun}
                >
                  <Icon icon={STOP_ICON} size={14} />
                  {`Stop run`}
                </Button>
              ) : (
                <Button className="panel-coss" size="sm" onClick={runAgain}>
                  <Icon icon={REPEAT_ICON} size={14} />
                  {`Run again`}
                </Button>
              )}
              <Menu
                align={`end`}
                items={[
                  { label: `Copy run link`, icon: COPY_ICON },
                  { label: `Share`, icon: SHARE_ICON },
                  { label: `View in Chat`, icon: CHAT_ICON, onSelect: () => rest.onNavigate?.(`Chat`) },
                ]}
                trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
                  <Button
                    className="panel-coss"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Run options`}
                    aria-expanded={open}
                    onClick={toggle}
                  >
                    <Icon icon={MORE_HORIZONTAL_ICON} size={15} />
                  </Button>
                )}
              />
              <Button
                className="panel-coss"
                variant="ghost"
                size="icon-sm"
                aria-label={panelOpen ? `Hide side panel` : `Show side panel`}
                aria-pressed={panelOpen}
                onClick={() => setPanelOpen((open) => !open)}
              >
                <Icon icon={PANEL_ICON} size={16} />
              </Button>
            </span>
          </header>
          <div className={`ui-ar__scroll`}>
            <div className={`ui-ar__column`}>
              <PlanSteps key={runSeed} title={title} steps={planSteps} status={isDone ? `done` : `running`} onRetry={retryStep} />
              <div className={`ui-ar__feed`}>
                <span className={`ui-ar__label`}>{`Activity`}</span>
                {steps.map((step, s) => {
                  if (!startedSteps.has(s)) return null;
                  const visibleCalls = step.calls
                    .map((call, c) => ({ call, c, state: callState(s, c) }))
                    .filter((entry) => entry.state);
                  const isCurrent = s === activeStep;
                  return (
                    <div key={`${runSeed}-${step.id}`} className={`ui-ar__entry ui-as-rise`}>
                      <span className={`ui-ar__entry-head`}>
                        <span className={`ui-ar__num`} data-done={finishedSteps.has(s) || undefined}>
                          {s + 1}
                        </span>
                        {step.title}
                      </span>
                      {visibleCalls.length > 0 && (
                        <ToolCallGroup
                          open={feedOpen[s] ?? isCurrent}
                          onOpenChange={(open: boolean) => setFeedOpen((prev) => ({ ...prev, [s]: open }))}
                          runningLabel={`Using tools…`}
                        >
                          {visibleCalls.map(({ call, c, state }) => (
                            <ToolCall
                              key={c}
                              name={call.name}
                              summary={call.summary}
                              icon={<Icon icon={call.icon ?? toolIcon(call.name)} size={14} />}
                              status={state === `running` && stopReason ? `error` : (state ?? `success`)}
                              error={stopReason ? `Stopped before it finished` : undefined}
                              openOnError={false}
                              args={call.args}
                              result={state === `success` ? call.result : undefined}
                              duration={state === `success` ? call.duration : undefined}
                            />
                          ))}
                        </ToolCallGroup>
                      )}
                    </div>
                  );
                })}
                {phase !== `stopped` && (
                  <RunLoader
                    key={runSeed}
                    className={`ui-ar__loader`}
                    size={`sm`}
                    phases={steps.map((step) => step.title)}
                    phase={Math.max(0, activeStep)}
                    done={isDone}
                    doneLabel={`Done in ${formatDuration(elapsed)}`}
                  />
                )}
              </div>
            </div>
          </div>
        </section>
        {panelOpen && <div className={`ui-ar__scrim`} aria-hidden={`true`} onClick={() => setPanelOpen(false)} />}
        {panelOpen && (
          <aside className={`ui-ar__panel`} aria-label={`Run details`}>
            <header className={`ui-ar__bar`}>
              <span className={`ui-ar__crumbs`}>
                <b>{`Needs your input`}</b>
                {approvals.length > 0 && <span className={`ui-ar__count`}>{approvals.length}</span>}
              </span>
            </header>
            <div className={`ui-ar__panel-body`}>
              <section className={`ui-ar__section`}>
                {approvals.length ? (
                  approvals.map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      className={`ui-as-rise`}
                      title={approval.title}
                      description={approval.description}
                      risk={approval.risk}
                      icon={<Icon icon={WORKFLOW_ICON} size={15} />}
                      details={approval.details}
                      status={approval.status ?? `pending`}
                      allowAlways={false}
                      label={approval.label}
                      actions={`card`}
                      onApprove={() => onApproveRequest?.(approval.id)}
                      onDeny={() => onDenyRequest?.(approval.id)}
                    />
                  ))
                ) : (
                  <QuietState
                    icon={<Icon icon={BOARD_CHART_ICON} size={16} />}
                    title={`Nothing needs you yet`}
                  >
                    {`The agent asks here before it sends or books anything.`}
                  </QuietState>
                )}
              </section>
              <section className={`ui-ar__section`}>
                <span className={`ui-ar__label`}>{`Details`}</span>
                <dl className={`ui-ar__details`}>
                  {[
                    { label: `Agent`, value: agent, icon: BOARD_CHART_ICON },
                    { label: `Triggered by`, value: rest.user?.name ?? `Alex Morgan`, icon: WORKFLOW_ICON },
                    { label: `Tool calls`, value: String(totalCalls), icon: WORKFLOW_ICON },
                    { label: `Cost`, value: `$0.14`, icon: DATABASE_ICON },
                  ].map((row) => (
                    <div key={row.label}>
                      <dt>
                        <Icon icon={row.icon} size={14} />
                        {row.label}
                      </dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          </aside>
        )}
      </div>
    </AppShell>
  );
}

function QuietState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={`ui-ar__quiet`}>
      <span>{icon}</span>
      <b>{title}</b>
      <p>{children}</p>
    </div>
  );
}

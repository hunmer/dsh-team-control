/**
 * 成员看板 —— 用 Trace 瀑布代替原来的成员卡片网格。
 *
 * 数据来自 GET /api/trace：
 *   root(团队) → member(子 Agent) → step(Worker 计划步骤) / span(Host 工具调用)
 * SSE 的 span.append 帧会触发去抖刷新，因此工具调用一进一出都会实时出现在时间轴上。
 */
import { useState } from 'react';
import { usePanel } from '@/store';
import type { Member } from '@/types';
import { fmtClock } from '@/lib/format';
import { TraceWaterfall, type TraceSpan } from '@/components/trace-waterfall/trace-waterfall';
import { Button } from '@/components/ui/button';
import { EmptyState, MetaLine, SectionHead, StatusPill } from '@/components/Bits';

function durText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

function MemberPill({ member }: { member: Member }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs">
      <StatusPill status={member.status} />
      <span className="font-medium">{member.name || member.id}</span>
      {member.model ? <span className="text-muted-foreground">{member.model}</span> : null}
      {member.step ? <span className="text-muted-foreground">{member.step}</span> : null}
    </span>
  );
}

const WINDOWS: Array<[number, string]> = [
  [0, '全部历史'],
  [5, '近 5 分钟'],
  [30, '近 30 分钟'],
  [60, '近 1 小时'],
  [360, '近 6 小时'],
];

export function BoardView() {
  const { state, refreshTrace, setTraceWindow } = usePanel();
  const { teamId, members, trace, errors, traceWindow } = state;
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    if (!teamId || busy) return;
    setBusy(true);
    void refreshTrace().catch(() => undefined).finally(() => setBusy(false));
  };

  const metaParts: string[] = [];
  if (trace) {
    metaParts.push(`${trace.stats.members} 成员`, `${trace.stats.steps} 步骤`, `${trace.stats.spans} 工具调用`);
    metaParts.push(`用时 ${durText(trace.stats.durationMs)}`);
    if (trace.stats.running) metaParts.push(`运行中 ${trace.stats.running}`);
    if (trace.stats.failed) metaParts.push(`失败 ${trace.stats.failed}`);
    metaParts.push(trace.windowMs ? `窗口 ${WINDOWS.find(([v]) => v * 60000 === trace.windowMs)?.[1] ?? durText(trace.windowMs)}` : '全量历史');
    metaParts.push(`asOf ${fmtClock(trace.asOf)}`);
  }

  let body: React.ReactNode;
  if (!teamId) {
    body = <EmptyState title="未选择团队" detail="等待 /api/teams 返回团队列表后自动加载。" />;
  } else if (errors.trace && !trace) {
    body = <EmptyState title="Trace 加载失败" detail={errors.trace} />;
  } else if (!trace) {
    body = <EmptyState title="正在加载 Trace…" detail="首屏快照来自 GET /api/trace，随后由 SSE 实时增量刷新。" />;
  } else if (!members.length && !trace.stats.spans && !trace.stats.steps) {
    body = <EmptyState title="暂无运行数据" detail="团队创建后：Worker 步骤来自事件流，Agent 工具调用由 dsh-team 插件上报。" />;
  } else if (!trace.stats.steps && !trace.stats.spans) {
    body = (
      <EmptyState
        title="窗口内暂无运行数据"
        detail={trace.windowMs
          ? '当前时间窗内没有事件流或工具调用，可切换到「全部历史」查看旧记录。'
          : '等待下一次 Worker 步骤或 Agent 工具调用。'}
      />
    );
  } else {
    body = (
      <TraceWaterfall
        root={trace.root as TraceSpan}
        startedAt={trace.originMs}
        title="Trace 瀑布"
        markSlowest
      />
    );
  }

  return (
    <section className="space-y-3">
      <SectionHead
        title="成员看板 · Trace 瀑布"
        meta={<MetaLine>{metaParts.length ? metaParts.join(' · ') : '实时工具调用与步骤时间线'}</MetaLine>}
        controls={
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground"
              value={traceWindow}
              onChange={(event) => setTraceWindow(Number(event.target.value))}
              title="只统计该时间窗内的事件与工具调用"
              aria-label="Trace 时间窗"
            >
              {WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={!teamId || busy} onClick={refresh}>
              {busy ? '刷新中…' : '刷新 Trace'}
            </Button>
          </div>
        }
      />
      {members.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {members.map((member) => <MemberPill key={member.id} member={member} />)}
        </div>
      ) : null}
      {body}
      {trace && errors.trace ? (
        <MetaLine>上一次自动刷新失败：{errors.trace}（保留最后一次成功快照）</MetaLine>
      ) : null}
    </section>
  );
}

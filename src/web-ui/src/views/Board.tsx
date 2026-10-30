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
import { TraceWaterfall, type TraceSpan } from '@/components/trace-waterfall/trace-waterfall';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, MetaLine, SectionHead, StatusPill } from '@/components/Bits';
import { ModelAvatar } from '@/components/ModelAvatar';

function MemberPill({ member }: { member: Member }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs">
      <StatusPill status={member.status} />
      <ModelAvatar model={member.model} name={member.name} size={13} />
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

/** Base UI Select 需要 items 才能把 value 映射回显示文案，否则触发器直接显示原始值（0/5/30…） */
const WINDOW_ITEMS = WINDOWS.map(([value, label]) => ({ value: String(value), label }));

export function BoardView() {
  const { state, refreshTrace, setTraceWindow } = usePanel();
  const { teamId, members, trace, errors, traceWindow } = state;
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    if (!teamId || busy) return;
    setBusy(true);
    void refreshTrace().catch(() => undefined).finally(() => setBusy(false));
  };

  let body: React.ReactNode;
  if (!teamId) {
    body = <EmptyState title="未选择团队" />;
  } else if (errors.trace && !trace) {
    body = <EmptyState title="Trace 加载失败" detail={errors.trace} />;
  } else if (!trace) {
    body = <EmptyState title="正在加载 Trace…" />;
  } else if (!members.length && !trace.stats.spans && !trace.stats.steps) {
    body = <EmptyState title="暂无运行数据" detail="等待成员开始执行" />;
  } else if (!trace.stats.steps && !trace.stats.spans) {
    body = (
      <EmptyState
        title="窗口内暂无运行数据"
        detail={trace.windowMs
          ? '可切换到「全部历史」查看旧记录'
          : '等待下一次事件'}
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
        title="瀑布"
        controls={
          <div className="flex items-center gap-2">
            <Select
              items={WINDOW_ITEMS}
              value={String(traceWindow)}
              onValueChange={(value) => setTraceWindow(Number(value))}
            >
              <SelectTrigger
                size="sm"
                className="w-40"
                title="只统计该时间窗内的事件与工具调用"
                aria-label="Trace 时间窗"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map(([value, label]) => (
                  <SelectItem key={value} value={String(value)}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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

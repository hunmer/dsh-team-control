/**
 * 成员看板 —— 用 Trace 瀑布代替原来的成员卡片网格。
 *
 * 数据来自 GET /api/trace：
 *   root(团队) → member(子 Agent) → step(Worker 计划步骤) / span(Host 工具调用)
 * SSE 的 span.append 帧会触发去抖刷新，因此工具调用一进一出都会实时出现在时间轴上。
 */
import { useMemo, useState } from 'react';
import { usePanel } from '@/store';
import { TraceWaterfall, type TraceSpan } from '@/components/trace-waterfall/trace-waterfall';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import MemberGroupFilter from '@/components/member-filter';

/** trace 树里成员节点的 id 前缀（见 core.mjs：`member:${member.id}`）。 */
const MEMBER_PREFIX = 'member:';

/** 只保留选中成员的子树：未选中的成员节点整体剔除，非成员节点原样保留。 */
function filterMemberSpans<T extends { id: string; children?: T[] }>(root: T, memberIds: Set<string>): T {
  if (!memberIds.size) return root;
  return {
    ...root,
    children: (root.children ?? []).filter(
      (child) => !child.id.startsWith(MEMBER_PREFIX) || memberIds.has(child.id.slice(MEMBER_PREFIX.length)),
    ),
  };
}

const WINDOWS: Array<[number, string]> = [
  [5, '近 5 分钟'],
  [10, '近 10 分钟'],
  [30, '近 30 分钟'],
  [60, '近 1 小时'],
  [360, '近 6 小时'],
  [0, '全部历史'],
];

/** Base UI Select 需要 items 才能把 value 映射回显示文案，否则触发器直接显示原始值（0/5/30…） */
const WINDOW_ITEMS = WINDOWS.map(([value, label]) => ({ value: String(value), label }));

export function BoardView() {
  const { state, refreshTrace, setTraceWindow, loadOlderTrace } = usePanel();
  const { teamId, members, trace, errors, traceWindow, traceHasOlder, traceLoadingOlder } = state;
  const [busy, setBusy] = useState(false);
  /** null = 用户还没动过筛选器：默认勾选全部成员，并跟随成员列表（新成员自动勾上） */
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[] | null>(null);

  const memberOptions = useMemo(
    () => members.map((m) => ({ id: m.id, label: m.name || m.id })),
    [members],
  );
  /** 生效的选中集：未手动改动时即全部成员；只保留仍存在的成员，避免移除成员后选中态悬空 */
  const selectedOptions = useMemo(() => {
    const ids = selectedMemberIds ?? memberOptions.map((o) => o.id);
    return memberOptions.filter((o) => ids.includes(o.id));
  }, [memberOptions, selectedMemberIds]);
  const selectedIdSet = useMemo(() => new Set(selectedOptions.map((o) => o.id)), [selectedOptions]);

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
    const root = filterMemberSpans(trace.root as TraceSpan, selectedIdSet);
    body = root.children?.length ? (
      <TraceWaterfall
        root={root}
        startedAt={trace.originMs}
        title="Trace 瀑布"
        markSlowest
        hasOlder={traceHasOlder}
        loadingOlder={traceLoadingOlder}
        onLoadOlder={loadOlderTrace}
      />
    ) : (
      <EmptyState title="选中成员暂无运行数据" detail="在上方筛选器换一个成员，或点 × 清除筛选查看全部" />
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
        <MemberGroupFilter
          options={memberOptions}
          value={selectedOptions}
          onValueChange={(next) => setSelectedMemberIds(next.map((o) => o.id))}
        />
      ) : null}
      {body}
      {trace && errors.trace ? (
        <MetaLine>上一次自动刷新失败：{errors.trace}（保留最后一次成功快照）</MetaLine>
      ) : null}
    </section>
  );
}

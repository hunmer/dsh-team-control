/**
 * Activity 事件流卡片（抽离自 Home.tsx 的右列 Activity 区块）。
 *
 * 只读展示：事件按时间正序排成 ToolCall 行，自带「显示更早」分页（默认最近 20 条，
 * 每次多展示 40 条）与空态；entries 由调用方过滤、排好序后传入。
 */
import { useState } from 'react';
import { ListTree } from 'lucide-react';
import { fmtClockSec } from '@/lib/format';
import type { TimelineEntry } from '@/types';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ToolCall } from '@/components/tool-call';

/** 事件结果 → ToolCall 状态。落盘 result 是 OK / BLOCKED / FAIL 之类的短串。 */
export function eventStatus(entry: TimelineEntry): 'running' | 'success' | 'error' {
  const result = String(entry.result ?? '').toUpperCase();
  if (/FAIL|ERROR|DENIED|BLOCKED|TIMEOUT|ABORT/.test(result)) return 'error';
  if (!result && (entry.phase === 'wait' || entry.phase === 'step')) return 'running';
  return 'success';
}

export interface ActivityFeedProps {
  /** 已按时间正序、已按任务/团队过滤好的事件列表 */
  entries: TimelineEntry[];
  /** 成员 id → 展示名 */
  memberName: (id?: string | null) => string;
  /** 头部「在时间线视图查看」按钮回调；不传则隐藏按钮 */
  onOpenTimeline?: () => void;
  /** 事件计数文案前缀，默认「当前任务」 */
  countLabel?: string;
  /** 空态描述，默认「成员开始执行后实时出现」 */
  emptyHint?: string;
}

const DEFAULT_LIMIT = 20;
const PAGE_SIZE = 40;

export function ActivityFeed({
  entries,
  memberName,
  onOpenTimeline,
  countLabel = '当前任务',
  emptyHint = '成员开始执行后实时出现',
}: ActivityFeedProps) {
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const visible = entries.slice(-limit);

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-semibold">Activity</span>
        <span className="text-xs text-muted-foreground">
          {entries.length ? `${countLabel} ${entries.length} 条事件` : '暂无事件'}
        </span>
        {onOpenTimeline && (
          <Button className="ml-auto" onClick={onOpenTimeline} size="xs" type="button" variant="link">
            在时间线视图查看
          </Button>
        )}
      </header>
      <div className="min-h-0 max-h-[480px] flex-1 space-y-1 overflow-y-auto p-3 xl:max-h-none">
        {visible.length ? (
          visible.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2">
              {/* 高度对齐 ToolCall 头部（min-height 44px），展开时时间也不会被拉偏 */}
              <span className="flex h-11 w-14 shrink-0 items-center justify-end text-[11px] leading-none tabular-nums text-muted-foreground">
                {fmtClockSec(entry.ts)}
              </span>
              <div className="min-w-0 flex-1">
                <ToolCall
                  name={entry.action || entry.phase}
                  summary={
                    <span>
                      {entry.phase}
                      {entry.target ? ` · ${entry.target}` : ''}
                      {entry.memberId ? ` · ${memberName(entry.memberId)}` : ''}
                    </span>
                  }
                  status={eventStatus(entry)}
                  args={{ phase: entry.phase, action: entry.action, target: entry.target, next: entry.next }}
                  result={entry.result ? { result: entry.result } : undefined}
                />
              </div>
            </div>
          ))
        ) : (
          <Empty className="gap-4 px-4 py-8 md:py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="mb-3">
                <ListTree />
              </EmptyMedia>
              <EmptyTitle className="text-sm">暂无事件</EmptyTitle>
              <EmptyDescription>{emptyHint}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {entries.length > visible.length && (
          <Button
            className="mt-2 w-full"
            onClick={() => setLimit((value) => value + PAGE_SIZE)}
            size="sm"
            type="button"
            variant="outline"
          >
            显示更早的 {entries.length - visible.length} 条
          </Button>
        )}
      </div>
    </div>
  );
}

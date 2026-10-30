/**
 * 顶栏：按反馈去掉快照信息、刷新快照、导出报告；连接正常（live）时不再常驻「实时」胶囊，
 * 仅在连接中 / 重连 / 离线时提示。右侧：审批队列（通知按钮 + 弹层）、成员队列、主题切换
 * （团队运行操作已移入队列弹层头部）。
 *
 * 「审批队列」原来是一个侧栏路由，现在收进顶栏的通知按钮：有越界申请时按钮带数字角标，
 * 点开直接在弹层里批准/驳回，不再需要先跳页。
 */
import { useState } from 'react';
import { Bell, Moon, Sun } from 'lucide-react';
import { usePanel } from '@/store';
import { TeamSelect } from '@/components/TeamSelect';
import { AgentQueueDock } from '@/components/agent-queue/agent-queue-dock';
import { Button } from '@/components/ui/button';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { ApprovalsPanel } from '@/views/Approvals';
import { useTheme } from '@/theme';

const CONN_LABELS = { connecting: '连接中…', reconnecting: '重连中…', offline: '离线' } as const;
const CONN_CLASS = {
  connecting: 'border-border text-muted-foreground',
  reconnecting: 'border-amber-500/50 text-amber-600 dark:text-amber-400',
  offline: 'border-red-500/50 text-red-600 dark:text-red-400',
} as const;

/** 弹层每页条数：审批卡较高，一页 4 条即可读完，避免几十条时整屏滚动。 */
const PAGE_SIZE = 4;

/** 审批队列：通知按钮 + 弹层（Popover 必须 modal={false}，否则弹层里点不动页面）。 */
function ApprovalsDock() {
  const { state } = usePanel();
  const count = state.scopeRequests.length;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const items = state.scopeRequests.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="relative"
            aria-label="审批队列"
            title={count ? `审批队列（${count} 条待审批）` : '审批队列'}
          />
        }
      >
        <Bell />
        {count > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 font-medium text-[10px] text-white leading-4 tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[min(560px,calc(100vw-2.5rem))] [&_[data-slot=popover-viewport]]:p-0"
      >
        <div className="relative max-h-[min(72vh,640px)] overflow-y-auto p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-semibold text-sm">审批队列</span>
            <span className="text-muted-foreground text-xs">{count} 条待审批</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
              aria-label="收起审批队列"
              title="收起（Esc）"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <ApprovalsPanel dense requests={items} />
          {pages > 1 ? (
            <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
              <span className="text-muted-foreground text-xs tabular-nums">
                第 {current + 1} / {pages} 页 · 每页 {PAGE_SIZE} 条
              </span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  上一页
                </Button>
                <Button size="sm" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function TopBar() {
  const { state } = usePanel();
  const { conn } = state;
  const [theme, toggleTheme, followingHost] = useTheme();

  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {/* 团队切换从侧栏移到这里：只展示当前工作区下的团队 */}
      <TeamSelect className="w-52 max-w-[40%] shrink-0" />
      <div className="flex min-w-0 items-center justify-end gap-2">
      {conn !== 'live' ? (
        <div
          className={`flex flex-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${CONN_CLASS[conn]}`}
          role="status"
          title="SSE 连接状态"
        >
          {conn === 'connecting' || conn === 'reconnecting' ? <Spinner className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
          {CONN_LABELS[conn]}
        </div>
      ) : null}
      <ApprovalsDock />
      <AgentQueueDock />
      {/* 嵌在 DSH 里时外观跟随宿主设置，这里不再提供本地切换。 */}
      {followingHost ? null : (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      )}
      </div>
    </div>
  );
}

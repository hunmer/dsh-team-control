/**
 * 顶栏：按反馈去掉快照信息、刷新快照、导出报告；连接正常（live）时不再常驻「实时」胶囊，
 * 仅在连接中 / 重连 / 离线时提示。右侧：成员队列 + 主题切换（团队运行操作已移入队列弹层头部）。
 */
import { Moon, Sun } from 'lucide-react';
import { usePanel } from '@/store';
import { TeamSelect } from '@/components/TeamSelect';
import { AgentQueueDock } from '@/components/agent-queue/agent-queue-dock';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTheme } from '@/theme';

const CONN_LABELS = { connecting: '连接中…', reconnecting: '重连中…', offline: '离线' } as const;
const CONN_CLASS = {
  connecting: 'border-border text-muted-foreground',
  reconnecting: 'border-amber-500/50 text-amber-600 dark:text-amber-400',
  offline: 'border-red-500/50 text-red-600 dark:text-red-400',
} as const;

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

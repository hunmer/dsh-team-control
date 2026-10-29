/**
 * 顶栏（PRD FR-3.3）：保留连接状态、快照、刷新快照、导出报告与主题切换，
 * 适配 affectui AppShell 48px 顶栏；团队切换已移到左侧栏顶部（TeamSelect）。
 */
import { useMemo } from 'react';
import { Moon, Sun } from 'lucide-react';
import { usePanel } from '@/store';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTheme } from '@/theme';

const CONN_LABELS = { connecting: '连接中…', live: '实时', reconnecting: '重连中…', offline: '离线' } as const;
const CONN_CLASS = {
  connecting: 'border-border text-muted-foreground',
  live: 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
  reconnecting: 'border-amber-500/50 text-amber-600 dark:text-amber-400',
  offline: 'border-red-500/50 text-red-600 dark:text-red-400',
} as const;

export function TopBar() {
  const { state, refreshTeams, refreshAll, exportReport, toast } = usePanel();
  const { teamId, conn, snapshot } = state;
  const [theme, toggleTheme] = useTheme();

  const snapshotText = useMemo(
    () => (snapshot
      ? [snapshot.asOf ? '快照 ' + fmtDateTime(snapshot.asOf) : '', snapshot.version != null ? 'v' + snapshot.version : ''].filter(Boolean).join(' · ') || '—'
      : '—'),
    [snapshot],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className={`flex flex-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${CONN_CLASS[conn]}`} role="status" title="SSE 实时连接状态">
        {conn === 'connecting' || conn === 'reconnecting' ? <Spinner className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
        {CONN_LABELS[conn]}
      </div>
      <div className="hidden min-w-0 truncate text-xs text-muted-foreground xl:block" title={snapshot?.asOf ? 'asOf=' + snapshot.asOf : ''}>
        {snapshotText}
      </div>
      <div className="ms-auto flex flex-none items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => {
          if (!teamId) return;
          void refreshTeams().then(() => refreshAll()).then(() => { toast('快照已刷新', 'ok', 2000); }).catch((err) => toast('刷新失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
        }}>刷新快照</Button>
        <Button size="sm" disabled={!teamId} onClick={() => void exportReport()}>导出报告</Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </div>
    </div>
  );
}

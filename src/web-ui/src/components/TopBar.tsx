/**
 * 顶栏：按反馈去掉快照信息、刷新快照、导出报告；连接正常（live）时不再常驻「实时」胶囊，
 * 仅在连接中 / 重连 / 离线时提示。右侧：团队运行状态按钮（停止/删除/停止并删除）+ 主题切换。
 */
import { Archive, ChevronDown, Moon, Square, Sun, Trash2 } from 'lucide-react';
import { usePanel } from '@/store';
import { TeamSelect } from '@/components/TeamSelect';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/spinner';
import { useTheme } from '@/theme';
import type { TeamRunStatus } from '@/types';

const CONN_LABELS = { connecting: '连接中…', reconnecting: '重连中…', offline: '离线' } as const;
const CONN_CLASS = {
  connecting: 'border-border text-muted-foreground',
  reconnecting: 'border-amber-500/50 text-amber-600 dark:text-amber-400',
  offline: 'border-red-500/50 text-red-600 dark:text-red-400',
} as const;

const RUN_LABEL: Record<TeamRunStatus, string> = { running: '运行中', blocked: '阻塞', idle: '空闲', empty: '无成员' };
const RUN_DOT: Record<TeamRunStatus, string> = {
  running: 'bg-emerald-500',
  blocked: 'bg-amber-500',
  idle: 'bg-muted-foreground/50',
  empty: 'bg-muted-foreground/30',
};

export function TopBar() {
  const { state, stopTeam, archiveTeam, deleteTeam } = usePanel();
  const { conn, teamId, teams, members } = state;
  const [theme, toggleTheme] = useTheme();

  const team = teams.find((t) => t.id === teamId) ?? null;
  const active = members.filter((m) => m.status !== 'retired');
  const runningCount = active.filter((m) => m.status === 'running' || m.status === 'provisioning').length;
  const blockedCount = active.filter((m) => m.status === 'blocked').length;
  const status: TeamRunStatus = !team
    ? 'empty'
    : runningCount > 0
      ? 'running'
      : blockedCount > 0
        ? 'blocked'
        : active.length > 0
          ? 'idle'
          : 'empty';
  const canStop = status === 'running' || status === 'blocked';
  const name = team ? team.name || team.id : '';
  const extra = runningCount > 0 ? `\n该团队有 ${runningCount} 个成员正在运行，删除会中断它们。` : '';

  const confirmDelete = () => {
    if (!team) return;
    if (!window.confirm(`删除团队「${name}」？成员、任务、事件记录都会一并删除，无法恢复。${extra}`)) return;
    void deleteTeam();
  };
  const confirmArchive = () => {
    if (!team) return;
    if (!window.confirm(`封存团队「${name}」？${runningCount > 0 ? `运行中的 ${runningCount} 个成员会被停止；` : ''}封存后可在设置中恢复。`)) return;
    void archiveTeam();
  };
  const stopAndDelete = () => {
    if (!team) return;
    if (!window.confirm(`停止并删除团队「${name}」？运行中的成员会被中断，成员、任务、事件记录都会一并删除，无法恢复。`)) return;
    void (async () => {
      await stopTeam();
      await deleteTeam();
    })();
  };

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
      <Menu>
        <MenuTrigger
          render={<Button size="sm" variant="ghost" className="gap-1.5 px-2 text-xs" disabled={!team} title="团队运行操作" />}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 flex-none rounded-full ${RUN_DOT[status]} ${status === 'running' ? 'animate-pulse' : ''}`}
          />
          {team ? RUN_LABEL[status] : '无团队'}
          <ChevronDown className="size-3.5 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-40">
          <MenuItem onClick={() => void stopTeam()} disabled={!canStop}>
            <Square />
            停止
          </MenuItem>
          <MenuItem onClick={confirmArchive} disabled={!team}>
            <Archive />
            封存
          </MenuItem>
          <MenuItem variant="destructive" onClick={confirmDelete} disabled={!team}>
            <Trash2 />
            删除
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={stopAndDelete} disabled={!team}>
            <Square />
            <Trash2 />
            停止并删除
          </MenuItem>
        </MenuPopup>
      </Menu>
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

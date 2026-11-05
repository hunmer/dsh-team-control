/**
 * 独立任务看板页（workspace 维度）。
 *
 * 不渲染编排侧栏，也不依赖当前 team；入口由 dsh-plugin-ui 注册为独立页签，
 * 页面路由是 #/board[/<workspaceId>]。
 */
import { Moon, Sun } from 'lucide-react';
import { usePanel } from '@/store';
import { useTheme } from '@/theme';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TasksView } from './Tasks';
import './board-page.css';

export function BoardPage() {
  const { state, selectBoardWorkspace } = usePanel();
  const [theme, toggleTheme, followingHost] = useTheme();
  const workspaces = state.workspaces.filter((w) => w.id);
  const current = workspaces.find((w) => w.id === state.workspaceId) ?? null;
  const workspaceLabel = workspaces.length === 0
    ? '暂无工作区'
    : current ? current.title || current.path : '选择工作区';

  const onPickWorkspace = (value: string | null) => {
    if (value) selectBoardWorkspace(value);
  };

  return (
    <div className="board-page">
      <header className="board-page__bar">
        <div className="board-page__brand">
          <Select
            value={state.workspaceId ?? ''}
            onValueChange={onPickWorkspace}
            disabled={workspaces.length === 0}
          >
            <SelectTrigger size="sm" className="w-[min(220px,42vw)]" aria-label="切换工作区">
              <SelectValue>{workspaceLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-56">
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.title || workspace.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="board-page__spacer" />

        {followingHost ? null : (
          <button
            type="button"
            className="board-page__theme"
            aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        )}
      </header>

      <main className="board-page__body">
        <TasksView workspaceId={state.workspaceId} standalone />
      </main>
    </div>
  );
}

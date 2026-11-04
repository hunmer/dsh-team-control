/**
 * 独立任务看板页（workspace 维度）。
 *
 * 不渲染编排侧栏，也不依赖当前 team；入口由 dsh-plugin-ui 注册为独立页签，
 * 页面路由是 #/board[/<workspaceId>]。
 */
import { Moon, Sun } from 'lucide-react';
import { usePanel } from '@/store';
import { useTheme } from '@/theme';
import { TasksView } from './Tasks';
import './board-page.css';

export function BoardPage() {
  const { state, selectBoardWorkspace } = usePanel();
  const [theme, toggleTheme, followingHost] = useTheme();
  const workspaces = state.workspaces.filter((w) => w.id);

  return (
    <div className="board-page">
      <header className="board-page__bar">
        <div className="board-page__brand">
          <span className="board-page__mark" aria-hidden="true">DS</span>
          <div className="board-page__titles">
            <strong>任务看板</strong>
            <span>按工作区调度任务与 Agent Team</span>
          </div>
        </div>

        <label className="board-page__workspace">
          <span>工作区</span>
          <select
            value={state.workspaceId || ''}
            onChange={(event) => selectBoardWorkspace(event.target.value)}
            aria-label="切换工作区"
          >
            {workspaces.length === 0 && <option value="">暂无工作区</option>}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.title || workspace.path}</option>
            ))}
          </select>
        </label>

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

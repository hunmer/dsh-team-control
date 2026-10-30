/**
 * 团队切换：默认放在顶栏左侧（用户要求：从侧栏移到 TopBar），只展示「当前工作区」下的团队。
 *
 * 数据来自 store：teams（全部）+ workspaceId + selectTeam；团队 → 工作区的归属由
 * 团队自带的 workspace 路径与 /api/workspaces 的 path 匹配得出（见 teamsInWorkspace）。
 * 下拉列表：左侧运行状态 badge、右侧删除图标（删除前二次确认）。
 */
import { Trash2 } from 'lucide-react';
import { usePanel } from '@/store';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Team, TeamRunStatus } from '@/types';

const RUN_LABEL: Record<TeamRunStatus, string> = { running: '运行中', blocked: '阻塞', idle: '空闲', empty: '无成员' };
const RUN_VARIANT: Record<TeamRunStatus, 'success' | 'warning' | 'secondary' | 'outline'> = {
  running: 'success', blocked: 'warning', idle: 'secondary', empty: 'outline',
};

export function TeamSelect({ className = '' }: { className?: string } = {}) {
  const { state, selectTeam, deleteTeam, teamsInWorkspace, toast } = usePanel();
  const { teamId, workspaces, workspaceId } = state;
  const teams = teamsInWorkspace();

  const current = teams.find((team) => team.id === teamId);
  const label = current
    ? current.name || current.id
    : teams.length
      ? '选择团队'
      : workspaceId && workspaces.length
        ? '该工作区暂无团队'
        : state.noTeams
          ? '暂无团队'
          : '加载中…';

  const onDelete = (team: Team) => {
    const name = team.name || team.id;
    const extra = team.runningCount
      ? `\n该团队有 ${team.runningCount} 个成员正在运行，删除会中断它们。`
      : '';
    if (!window.confirm(`删除团队「${name}」？成员、任务、事件记录都会一并删除，无法恢复。${extra}`)) return;
    void deleteTeam(team.id);
  };

  return (
    <div className={'ui-side-team ' + className}>
      <Select
        value={teamId ?? ''}
        onValueChange={(value) => {
          if (value && value !== teamId) {
            void selectTeam(value).catch((err) =>
              toast('切换团队失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
          }
        }}
      >
        <SelectTrigger size="sm" className="w-full min-w-0" disabled={!teams.length} aria-label="切换团队">
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-56">
          {teams.map((team) => {
            const status: TeamRunStatus = team.status ?? 'empty';
            return (
              <SelectItem
                key={team.id}
                value={team.id}
                className="pe-1"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Badge size="sm" variant={RUN_VARIANT[status]} title={RUN_LABEL[status]}>
                    {RUN_LABEL[status]}
                  </Badge>
                  <span className="truncate">{(team.name || team.id) + ' · ' + team.id}</span>
                  <button
                    type="button"
                    className="ms-auto inline-flex size-5 flex-none items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={'删除团队 ' + (team.name || team.id)}
                    title="删除团队"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      // 阻止冒泡，避免点删除时顺带切换团队
                      e.stopPropagation();
                      e.preventDefault();
                      onDelete(team);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

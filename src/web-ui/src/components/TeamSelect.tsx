/**
 * 团队切换（用户要求：从顶栏移到左侧栏顶部）。
 *
 * 渲染在 AppShell 的 `sidebarTop` 插槽里，宽度跟随侧栏；
 * 数据与行为完全复用 store 的 teams / teamId / selectTeam。
 */
import { usePanel } from '@/store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function TeamSelect() {
  const { state, selectTeam, toast } = usePanel();
  const { teams, teamId } = state;

  const current = teams.find((team) => team.id === teamId);
  const label = current
    ? current.name || current.id
    : teams.length
      ? '选择团队'
      : state.noTeams
        ? '暂无团队'
        : '加载中…';

  return (
    <div className="ui-side-team">
      <Select
        value={teamId ?? ''}
        onValueChange={(value) => {
          if (value && value !== teamId) {
            void selectTeam(value).catch((err) =>
              toast('切换团队失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
          }
        }}
      >
        <SelectTrigger size="sm" className="w-full" disabled={!teams.length} aria-label="切换团队">
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-56">
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>{(team.name || team.id) + ' · ' + team.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

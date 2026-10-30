/**
 * 工作区切换：DSH 工作区注册表（Host 插件同步到 sidecar 的 /api/workspaces）。
 *
 * 渲染在 AppShell 的 `sidebarTop` 插槽（原来放团队选择的位置）。
 * 即使注册表还没同步过来也占位显示（「工作区同步中…」），避免左侧栏顶部整块消失；
 * 切换工作区会把当前团队换成该工作区下的第一个团队，并同步 URL 路由。
 */
import { Folder, FolderGit2 } from 'lucide-react';
import { OTHER_WORKSPACE_ID, usePanel } from '@/store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { workspaceMatches } from '@/lib/workspace';

export function WorkspaceSelect({ className = '' }: { className?: string } = {}) {
  const { state, selectWorkspace, toast } = usePanel();
  const { workspaces, workspaceId, teams, conn } = state;

  const loading = !workspaces.length;
  const unmatched = teams.filter((t) => !workspaces.some((w) => workspaceMatches(t.workspace, w.path))).length;
  const current = workspaces.find((w) => w.id === workspaceId) ?? null;
  const label = loading
    ? (conn === 'offline' ? '工作区不可用' : '工作区同步中…')
    : workspaceId === OTHER_WORKSPACE_ID
      ? '未归类团队'
      : current ? current.title || current.path || current.id : '选择工作区';

  const onPick = (value: string | null) => {
    if (!value || value === workspaceId) return;
    void selectWorkspace(value).catch((err) =>
      toast('切换工作区失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
  };

  return (
    <div className={'ui-side-team ' + className}>
      <Select value={loading ? '' : workspaceId ?? ''} onValueChange={onPick} disabled={loading}>
        <SelectTrigger size="sm" className="w-full min-w-0" aria-label="切换工作区">
          <span className="flex min-w-0 items-center gap-1.5">
            {workspaceId === OTHER_WORKSPACE_ID
              ? <Folder className="size-3.5 flex-none opacity-70" />
              : <FolderGit2 className="size-3.5 flex-none opacity-70" />}
            {loading
              ? <span className="truncate text-muted-foreground">{label}</span>
              : <SelectValue>{label}</SelectValue>}
          </span>
        </SelectTrigger>
        <SelectContent className="min-w-64">
          {workspaces.map((ws) => (
            <SelectItem key={ws.id} value={ws.id} className="pe-1">
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{ws.title || ws.path || ws.id}</span>
                {ws.path ? (
                  <span className="truncate text-xs text-muted-foreground" title={ws.path}>{ws.path}</span>
                ) : null}
              </span>
            </SelectItem>
          ))}
          {unmatched ? (
            <SelectItem value={OTHER_WORKSPACE_ID} className="pe-1">
              <span className="flex min-w-0 flex-col">
                <span className="truncate">未归类团队</span>
                <span className="truncate text-xs text-muted-foreground">工作区不在注册表里的 {unmatched} 个团队</span>
              </span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}

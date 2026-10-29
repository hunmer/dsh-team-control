import { useMemo } from 'react';
import { TAB_NAMES, usePanel, type TabName } from '@/store';
import { fmtDateTime } from '@/lib/format';
import { isUnacked } from '@/views/Messages';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Toaster } from '@/components/Toaster';
import { AuthOverlayDialog, BootErrorOverlay } from '@/components/Overlays';
import { BoardView } from '@/views/Board';
import { DagView } from '@/views/Dag';
import { TimelineView } from '@/views/Timeline';
import { PermissionsView } from '@/views/Permissions';
import { ApprovalsView } from '@/views/Approvals';
import { MessagesView } from '@/views/Messages';

const TAB_LABELS: Record<TabName, string> = {
  board: '成员看板', dag: '依赖 DAG', timeline: '时间线',
  permissions: '权限矩阵', approvals: '审批队列', messages: '消息',
};

const CONN_LABELS = { connecting: '连接中…', live: '实时', reconnecting: '重连中…', offline: '离线' } as const;
const CONN_CLASS = {
  connecting: 'border-border text-muted-foreground', live: 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
  reconnecting: 'border-amber-500/50 text-amber-600 dark:text-amber-400', offline: 'border-red-500/50 text-red-600 dark:text-red-400',
} as const;

function TopBar() {
  const { state, selectTeam, refreshTeams, refreshAll, exportReport, toast } = usePanel();
  const { teams, teamId, conn, snapshot } = state;
  const [busy] = [false as const];
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b bg-background/90 px-4 py-2.5 backdrop-blur">
      <div className="flex select-none items-center gap-1.5">
        <span className="rounded bg-primary px-1.5 py-0.5 font-mono text-xs font-bold text-primary-foreground">dsh</span>
        <span className="font-mono text-sm font-semibold tracking-tight">team</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">control plane</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">team</span>
        <Select
          value={teamId ?? ''}
          onValueChange={(value) => { if (value && value !== teamId) void selectTeam(value).catch((err) => toast('切换团队失败：' + (err instanceof Error ? err.message : String(err)), 'error')); }}        >
          <SelectTrigger size="sm" className="w-52" disabled={!teams.length}>
            <SelectValue>
              {(() => {
                const team = teams.find((t) => t.id === teamId);
                if (team) return (team.name || team.id) + ' · ' + team.id;
                return teams.length ? '选择团队' : state.noTeams ? '暂无团队' : '加载中…';
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {teams.map((team) => (
              <SelectItem key={team.id} value={team.id}>{(team.name || team.id) + ' · ' + team.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${CONN_CLASS[conn]}`} role="status" title="SSE 实时连接状态">
        {conn === 'connecting' || conn === 'reconnecting' ? <Spinner className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
        {CONN_LABELS[conn]}
      </div>
      <div className="hidden text-xs text-muted-foreground md:block" title={snapshot?.asOf ? 'asOf=' + snapshot.asOf : ''}>
        {snapshot ? [snapshot.asOf ? '快照 ' + fmtDateTime(snapshot.asOf) : '', snapshot.version != null ? 'v' + snapshot.version : ''].filter(Boolean).join(' · ') || '—' : '—'}
      </div>
      <div className="ms-auto flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => {
          if (!teamId) return;
          void refreshTeams().then(() => refreshAll()).then(() => { toast('快照已刷新', 'ok', 2000); }).catch((err) => toast('刷新失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
        }}>刷新快照</Button>
        <Button size="sm" disabled={!teamId} onClick={() => void exportReport()}>导出报告</Button>
      </div>
    </header>
  );
}

function Banner() {
  const { state, memberName } = usePanel();
  const { noTeams, degraded, staleMembers, errors, teamId } = state;
  const parts: string[] = [];
  if (noTeams) parts.push('尚未创建团队：请先用 CLI 或 REST（POST /api/teams）创建团队，然后点击"刷新快照"。');
  if (degraded) parts.push('degraded=true：状态投影与事件流不一致，部分成员数据可能陈旧（C2/FR-5.5 告警）。');
  if (staleMembers.size) parts.push('stale 成员：' + [...staleMembers].map((id) => memberName(id)).join('、') + '（seq 与事件流不一致）。');
  const failed = Object.keys(errors).filter((key) => errors[key as keyof typeof errors] && teamId);
  if (failed.length) parts.push('部分视图加载失败：' + failed.map((key) => `${key}（${errors[key as keyof typeof errors]}）`).join('；'));
  if (!parts.length) return null;
  return (
    <Alert variant="error" className="mx-4 mt-3">
      <AlertDescription>
        {parts.map((part) => <div key={part}>{part}</div>)}
      </AlertDescription>
    </Alert>
  );
}

export default function App() {
  const { state, setTab } = usePanel();
  const { tab, members, scopeRequests, messages } = state;

  const badges = useMemo<Partial<Record<TabName, number | null>>>(() => ({
    board: members.length || null,
    approvals: scopeRequests.length || null,
    messages: messages.filter(isUnacked).length || null,
  }), [members.length, scopeRequests.length, messages]);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <Banner />
      <BootErrorOverlay />
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabName)}
        className="flex flex-1 flex-col gap-0"
      >
        <div className="overflow-x-auto border-b px-4">
          <TabsList className="h-11 bg-transparent">
            {TAB_NAMES.map((name) => (
              <TabsTab key={name} value={name} className="gap-1.5">
                {TAB_LABELS[name]}
                {badges[name] ? <Badge variant={name === 'approvals' ? 'destructive' : 'secondary'} className="px-1 text-[10px]">{badges[name]}</Badge> : null}
              </TabsTab>
            ))}
          </TabsList>
        </div>
        <main className="flex-1 space-y-4 p-4">
          <TabsPanel value="board"><BoardView /></TabsPanel>
          <TabsPanel value="dag"><DagView /></TabsPanel>
          <TabsPanel value="timeline"><TimelineView /></TabsPanel>
          <TabsPanel value="permissions"><PermissionsView /></TabsPanel>
          <TabsPanel value="approvals"><ApprovalsView /></TabsPanel>
          <TabsPanel value="messages"><MessagesView /></TabsPanel>
        </main>
      </Tabs>
      <AuthOverlayDialog />
      <Toaster />
      <noscript><p className="p-4 text-sm">本面板需要启用 JavaScript 才能显示实时数据。</p></noscript>
    </div>
  );
}

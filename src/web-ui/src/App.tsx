import { useMemo } from 'react';
import { usePanel, type TabName } from '@/store';
import { isUnacked } from '@/views/Messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Toaster } from '@/components/Toaster';
import { AuthOverlayDialog, BootErrorOverlay } from '@/components/Overlays';
import { TopBar } from '@/components/TopBar';
import { TeamSelect } from '@/components/TeamSelect';
import { AppShell } from '@/affectui/app-shell';
import { buildNav, TAB_LABELS, tabFromLabel, type ShellChrome } from '@/shell';
import { HomeView } from '@/views/Home';
import { BoardView } from '@/views/Board';
import { DagView } from '@/views/Dag';
import { TimelineView } from '@/views/Timeline';
import { PermissionsView } from '@/views/Permissions';
import { ModelsView } from '@/views/Models';
import { ApprovalsView } from '@/views/Approvals';
import { MessagesView } from '@/views/Messages';

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

function ActiveView({ tab }: { tab: TabName }) {
  switch (tab) {
    case 'board': return <BoardView />;
    case 'dag': return <DagView />;
    case 'timeline': return <TimelineView />;
    case 'models': return <ModelsView />;
    case 'permissions': return <PermissionsView />;
    case 'approvals': return <ApprovalsView />;
    case 'messages': return <MessagesView />;
    case 'home': return <HomeView />;
  }
}

export default function App() {
  const { state, setTab } = usePanel();
  const { tab, members, scopeRequests, messages } = state;

  // FR-5：徽标数据源保持不变，只是渲染位置从横向 Tabs 换到左侧导航。
  const badges = useMemo<Partial<Record<TabName, number | null>>>(() => ({
    board: members.length || null,
    approvals: scopeRequests.length || null,
    messages: messages.filter(isUnacked).length || null,
  }), [members.length, scopeRequests.length, messages]);

  const chrome: ShellChrome = {
    nav: buildNav(badges),
    groups: [],
    active: TAB_LABELS[tab],
    onNavigate: (label) => {
      const next = tabFromLabel(label);
      if (next) setTab(next);
    },
    header: { title: TAB_LABELS[tab], actions: <TopBar /> },
    sidebarTop: <TeamSelect />,
  };

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50"><BootErrorOverlay /></div>
      <AppShell {...chrome}>
        <div className="panel-coss flex min-h-full flex-col">
          <Banner />
          <main className="flex-1 space-y-4 p-4">
            <ActiveView tab={tab} />
          </main>
        </div>
      </AppShell>
      <AuthOverlayDialog />
      <Toaster />
      <noscript><p className="p-4 text-sm">本面板需要启用 JavaScript 才能显示实时数据。</p></noscript>
    </>
  );
}

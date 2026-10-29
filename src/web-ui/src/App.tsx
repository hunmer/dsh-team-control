import { useMemo, type ComponentType } from 'react';
import { usePanel, type TabName } from '@/store';
import { isUnacked } from '@/views/Messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Toaster } from '@/components/Toaster';
import { AuthOverlayDialog, BootErrorOverlay } from '@/components/Overlays';
import { TopBar } from '@/components/TopBar';
import { TeamSelect } from '@/components/TeamSelect';
import { AgentRun, type AgentRunApprovalRequest, type AgentRunProps } from '@/affectui/agent-run';
import { AppShell } from '@/affectui/app-shell';
import { buildNav, TAB_LABELS, tabFromLabel, type ShellChrome } from '@/shell';
import { BoardView } from '@/views/Board';
import { DagView } from '@/views/Dag';
import { TimelineView } from '@/views/Timeline';
import { PermissionsView } from '@/views/Permissions';
import { ModelsView } from '@/views/Models';
import { ApprovalsView } from '@/views/Approvals';
import { MessagesView } from '@/views/Messages';

/**
 * AgentRun 内部 `<AppShell active={"Runs"} nav={NAV_ITEMS} groups={NAV_GROUPS} {...rest}>`，
 * 未解构的 props 会覆盖 demo 导航；但它的 TS 类型没有暴露 nav/groups/active/header。
 * 这里做一次显式类型收窄，把同一套外壳参数同时交给主页与业务视图。
 */
const AgentRunShell = AgentRun as unknown as ComponentType<AgentRunProps & ShellChrome>;

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
    case 'home': return <BoardView />;
  }
}

/** 越界请求风险 → AffectUI ApprovalCard 的风险等级。 */
function approvalRisk(risk?: string): AgentRunApprovalRequest['risk'] {
  const text = String(risk ?? '').toLowerCase();
  if (['high', 'critical', '3'].includes(text)) return 'high';
  if (['medium', '2'].includes(text)) return 'medium';
  return 'low';
}

export default function App() {
  const { state, setTab, decideScope, memberName, toast } = usePanel();
  const { tab, members, scopeRequests, messages } = state;

  // FR-5：徽标数据源保持不变，只是渲染位置从横向 Tabs 换到左侧导航。
  const badges = useMemo<Partial<Record<TabName, number | null>>>(() => ({
    board: members.length || null,
    approvals: scopeRequests.length || null,
    messages: messages.filter(isUnacked).length || null,
  }), [members.length, scopeRequests.length, messages]);

  // home 右栏审批卡：把 store 里真实的 pending scope requests 映射成 AffectUI 的卡片模型。
  const approvals = useMemo<AgentRunApprovalRequest[]>(() => scopeRequests.map((request) => ({
    id: request.id,
    title: `${request.domain || 'scope'} · ${request.target || '未指定目标'}`,
    description: request.reason || (request.fallback ? `若拒绝将走 fallback：${request.fallback}` : '成员请求越界操作，等待你的决策。'),
    risk: approvalRisk(request.risk),
    label: `成员 ${memberName(request.memberId)}`,
    details: [
      { label: 'member', value: request.memberId },
      { label: 'domain', value: request.domain || '—' },
      { label: 'target', value: request.target || '—' },
      ...(request.blockedStep ? [{ label: 'blockedStep', value: request.blockedStep }] : []),
      ...(request.fallback ? [{ label: 'fallback', value: request.fallback }] : []),
    ],
  })), [scopeRequests, memberName]);

  const decideRequest = (id: string, decision: 'approved' | 'denied') => {
    const request = scopeRequests.find((item) => item.id === id);
    if (!request) return;
    const verdict = decision === 'approved' ? '批准' : '驳回';
    if (!window.confirm(`确认${verdict} ${memberName(request.memberId)} 的 ${request.domain || '?'} 申请「${request.target || '?'}」？决策将事务落盘为 decision。`)) return;
    // 成功反馈由 store 的 SSE `decision` 事件统一 toast（其他面板决策时同样可见），这里只提示失败。
    void decideScope(id, decision)
      .catch((err) => toast(verdict + '失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
  };

  const chrome: AgentRunProps & ShellChrome = {
    nav: buildNav(badges),
    groups: [],
    active: TAB_LABELS[tab],
    onNavigate: (label) => {
      const next = tabFromLabel(label);
      if (next) setTab(next);
    },
    header: { title: TAB_LABELS[tab], actions: <TopBar /> },
    sidebarTop: <TeamSelect />,
    approvals,
    onApproveRequest: (id) => decideRequest(id, 'approved'),
    onDenyRequest: (id) => decideRequest(id, 'denied'),
  };

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50"><BootErrorOverlay /></div>
      {tab === 'home' ? (
        <AgentRunShell {...chrome} />
      ) : (
        <AppShell {...chrome}>
          <div className="panel-coss flex min-h-full flex-col">
            <Banner />
            <main className="flex-1 space-y-4 p-4">
              <ActiveView tab={tab} />
            </main>
          </div>
        </AppShell>
      )}
      <AuthOverlayDialog />
      <Toaster />
      <noscript><p className="p-4 text-sm">本面板需要启用 JavaScript 才能显示实时数据。</p></noscript>
    </>
  );
}

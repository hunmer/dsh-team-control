import { useState } from 'react';
import { usePanel } from '@/store';
import { api, enc } from '@/lib/api';
import { fmtAgo } from '@/lib/format';
import type { ScopeRequest } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

function riskBadge(risk?: string): 'destructive' | 'secondary' | 'outline' {
  const text = String(risk ?? '').toLowerCase();
  if (['high', 'critical', '3'].includes(text)) return 'destructive';
  if (['medium', '2'].includes(text)) return 'secondary';
  return 'outline';
}

function ApprovalCard({ request }: { request: ScopeRequest }) {
  const { memberName, refreshPermissions, refreshAll, toast } = usePanel();
  const [reason, setReason] = useState('');
  const [ttl, setTtl] = useState('300');
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'approved' | 'denied') => {
    const verdict = decision === 'approved' ? '批准' : '驳回';
    if (!window.confirm(`确认${verdict} ${memberName(request.memberId)} 的 ${request.domain || '?'} 申请「${request.target || '?'}」？决策将事务落盘为 decision。`)) return;
    const body: Record<string, unknown> = { decision, decidedBy: 'panel', singleUse: true };
    if (reason.trim()) body.reason = reason.trim();
    const ttlNumber = Number(ttl);
    if (decision === 'approved' && Number.isFinite(ttlNumber) && ttlNumber > 0) body.ttlSeconds = Math.floor(ttlNumber);
    setBusy(true);
    try {
      const response = await api<{ decision?: { id?: string }; id?: string; requestId?: string }>(
        '/api/scope-requests/' + enc(request.id) + '/decide', { method: 'POST', body });
      const decisionId = response.decision?.id || (response.id && response.requestId ? response.id : '已落盘');
      toast(`已${verdict} ${request.domain || ''}:${request.target || ''}（decision ${decisionId}）`, decision === 'approved' ? 'ok' : 'warn');
      await Promise.all([refreshAll(), refreshPermissions()]);
    } catch (err) {
      toast(verdict + '失败：' + (err instanceof Error ? err.message : String(err)), 'error');
      setBusy(false);
    }
  };

  const rows: Array<[string, unknown]> = [
    ['member', request.memberId], ['reason', request.reason],
    ['diffSize', request.diffSize], ['fallback', request.fallback], ['requestId', request.id],
  ];

  return (
    <Card className="py-4">
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="font-mono">{request.domain || '?'}</Badge>
          <span className="max-w-56 truncate font-mono" title={request.target || ''}>{request.target || '—'}</span>
          <Badge variant="outline">{memberName(request.memberId)}</Badge>
          <Badge variant={riskBadge(request.risk)}>risk {request.risk || '?'}</Badge>
          <span className="text-muted-foreground">
            {(request.blockedStep ? `blocked@${request.blockedStep} · ` : '') + fmtAgo(request.createdAt)}
          </span>
        </div>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="col-span-2 grid grid-cols-[5.5rem_1fr] items-baseline gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate text-foreground/90" title={value === null || value === undefined ? '' : String(value)}>
                {value === null || value === undefined || value === '' ? '—' : String(value)}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid flex-1 gap-1">
            <Label className="text-xs">decision reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="决策理由（可选，落盘 decision）" />
          </div>
          <div className="grid w-28 gap-1">
            <Label className="text-xs">grant TTL (s)</Label>
            <Input type="number" min={0} value={ttl} onChange={(e) => setTtl(e.target.value)} title="scope_grant TTL（秒）" />
          </div>
          <div className="flex gap-2">
            <Button variant="destructive" disabled={busy} onClick={() => void decide('denied')}>驳回</Button>
            <Button disabled={busy} onClick={() => void decide('approved')}>批准</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 审批队列主体：全页与顶栏通知弹层共用（dense = 弹层里单列紧凑排版，无 SectionHead）。
 * requests 有值时只渲染这一页（顶栏弹层分页用；空态仍按全量判断）。
 */
export function ApprovalsPanel({ dense = false, requests }: { dense?: boolean; requests?: ScopeRequest[] }) {
  const { state } = usePanel();
  const { scopeRequests, errors } = state;
  if (errors.approvals && !scopeRequests.length) {
    return <EmptyState title="审批队列加载失败" detail={errors.approvals} />;
  }
  if (!scopeRequests.length) {
    return <EmptyState title="审批队列为空" detail="没有待审批的越界申请" />;
  }
  const items = requests ?? scopeRequests;
  return (
    <div className={dense ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 gap-3 xl:grid-cols-2'}>
      {items.map((request) => <ApprovalCard key={request.id} request={request} />)}
    </div>
  );
}

export function ApprovalsView() {
  const { state } = usePanel();
  const { scopeRequests, errors } = state;
  return (
    <section className="space-y-3">
      <SectionHead
        title="审批队列"
        meta={<MetaLine>
          {scopeRequests.length + ' 条待审批' + (errors.approvals ? ' · 加载失败：' + errors.approvals : '')}
        </MetaLine>}
      />
      <ApprovalsPanel />
    </section>
  );
}

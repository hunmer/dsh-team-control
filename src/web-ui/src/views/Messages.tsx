import { useMemo } from 'react';
import { usePanel } from '@/store';
import { fmtClock, safeToken } from '@/lib/format';
import type { TeamMessage } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import type { TabName } from '@/store';

export function isUnacked(message: TeamMessage): boolean {
  return !message.ackedAt && message.status !== 'acked' && message.status !== 'expired';
}

const STATUS_TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  acked: 'secondary', delivered: 'outline', read: 'outline', queued: 'outline', expired: 'destructive',
};

function MessageRow({ message, pairLabel }: { message: TeamMessage; pairLabel: string }) {
  return (
    <div className={`grid grid-cols-[3rem_1fr_5rem_6rem_1fr] items-center gap-2 rounded px-2 py-1 text-xs ${isUnacked(message) ? 'bg-amber-500/5' : ''}`}>
      <span className="text-muted-foreground">{pairLabel}</span>
      <span className="truncate font-mono" title={`${message.from || '?'} → ${message.to || '?'}`}>
        <span className="text-foreground/90">{message.from || '?'}</span>
        <span className="mx-1 text-muted-foreground">→</span>
        <span className="text-foreground/90">{message.to || '?'}</span>
      </span>
      <span className="truncate text-muted-foreground">{message.kind || '—'}</span>
      <Badge variant={STATUS_TONE[safeToken(message.status || 'queued')] ?? 'outline'} className="justify-self-start text-[10px]">{message.status || 'queued'}</Badge>
      <span className="truncate text-right font-mono text-[10px] text-muted-foreground">
        sent {fmtClock(message.sentAt)}
        {message.ackedAt ? ` · acked ${fmtClock(message.ackedAt)}`
          : message.readAt ? ` · read ${fmtClock(message.readAt)}`
            : message.deliveredAt ? ` · delivered ${fmtClock(message.deliveredAt)}` : ''}
      </span>
    </div>
  );
}

export function MessagesView() {
  const { state, refreshMessages, toast } = usePanel();
  const { messages, errors } = state;
  const unackedCount = messages.filter(isUnacked).length;

  const groups = useMemo(() => {
    const map = new Map<string, TeamMessage[]>();
    for (const message of messages) {
      const key = message.correlationId ? 'corr:' + message.correlationId : 'solo:' + message.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(message);
    }
    const entries = [...map.entries()];
    entries.sort((a, b) => {
      const aSolo = a[0].startsWith('solo:') ? 1 : 0;
      const bSolo = b[0].startsWith('solo:') ? 1 : 0;
      if (aSolo !== bSolo) return aSolo - bSolo;
      return String(a[1][0]?.sentAt || '').localeCompare(String(b[1][0]?.sentAt || ''));
    });
    return entries;
  }, [messages]);

  return (
    <section className="space-y-3" data-view="messages">
      <SectionHead
        title="消息与回执"
        meta={<MetaLine>
          {`${messages.length} 条消息 · 未 ack ${unackedCount}` + (errors.messages ? ` · 加载失败：${errors.messages}` : '')}
        </MetaLine>}
        controls={
          <Button size="sm" variant="outline" onClick={() => {
            void refreshMessages().catch((err) => toast('消息刷新失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
          }}>刷新</Button>
        }
      />
      {errors.messages && !messages.length
        ? <EmptyState title="消息加载失败" detail={errors.messages} />
        : !messages.length
          ? <EmptyState title="暂无消息" detail="请求与响应按 correlationId 配对" />
          : (
            <div className="space-y-2">
              {groups.map(([key, list]) => {
                const isCorrelation = key.startsWith('corr:');
                const rows = list.slice().sort((a, b) => String(a.sentAt || '').localeCompare(String(b.sentAt || '')));
                return (
                  <Card key={key} className="py-3">
                    {isCorrelation ? (
                      <div className="flex items-center gap-3 border-b px-3 pb-2 text-xs text-muted-foreground">
                        <span className="font-mono">correlation {key.slice(5)}</span>
                        <span>{rows.length} 条（请求-响应配对）</span>
                        <span>{rows.some(isUnacked) ? '⚠ 存在未 ack' : '✓ 全部已确认'}</span>
                      </div>
                    ) : null}
                    <CardContent className="px-1 py-1">
                      {rows.map((message, index) => (
                        <MessageRow key={message.id} message={message} pairLabel={isCorrelation ? (index === 0 ? 'req' : index === 1 ? 'resp' : 'msg') : 'msg'} />
                      ))}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
    </section>
  );
}

export type { TabName };

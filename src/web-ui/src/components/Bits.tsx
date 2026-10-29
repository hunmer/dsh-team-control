import { Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import type { MemberStatus } from '@/types';
import { safeToken } from '@/lib/format';

const STATUS_TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default', idle: 'secondary', queued: 'outline', spawning: 'outline',
  blocked: 'outline', interrupted: 'outline', inactive: 'outline',
  failed: 'destructive', done: 'secondary',
};

export function StatusPill({ status }: { status: MemberStatus }) {
  return <Badge variant={STATUS_TONE[safeToken(status)] ?? 'outline'}>{status || '?'}</Badge>;
}

/** 空态统一用 coss Empty：图标 + 一句标题，必要时补一行说明。 */
export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <Empty className="gap-4 px-4 py-8 md:py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="mb-3">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {detail ? <EmptyDescription className="max-w-md text-xs">{detail}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

export function MetaLine({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground">{children}</div>;
}

export function SectionHead({ title, meta, controls }: { title: string; meta?: React.ReactNode; controls?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {meta ? <MetaLine>{meta}</MetaLine> : null}
      </div>
      {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
    </div>
  );
}

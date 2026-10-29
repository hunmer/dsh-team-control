import { Badge } from '@/components/ui/badge';
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

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
      <strong className="font-medium text-foreground">{title}</strong>
      {detail ? <div>{detail}</div> : null}
    </div>
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

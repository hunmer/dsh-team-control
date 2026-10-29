/**
 * 单条工具调用 / 事件（coss ui 版，取代 affectui/tool-calls）。
 */
import { useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, LoaderCircle, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type ToolCallStatus = 'running' | 'success' | 'error';

export interface ToolCallProps {
  name: string;
  summary?: ReactNode;
  status: ToolCallStatus;
  args?: unknown;
  result?: unknown;
  defaultOpen?: boolean;
  className?: string;
}

const STATUS_META = {
  running: { label: '运行中', variant: 'info' as const, Icon: LoaderCircle },
  success: { label: '成功', variant: 'success' as const, Icon: CircleCheck },
  error: { label: '失败', variant: 'error' as const, Icon: CircleAlert },
};

function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCall({ name, summary, status, args, result, defaultOpen = false, className }: ToolCallProps) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[status] ?? STATUS_META.success;
  const { Icon } = meta;
  const argsText = pretty(args);
  const resultText = pretty(result);

  return (
    <Collapsible className={cn('w-full', className)} onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-xs">{name}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{summary}</span>}
        <Badge size="sm" variant={meta.variant}>
          <Icon className={cn('size-3', status === 'running' && 'animate-spin')} />
          {meta.label}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-6 space-y-2 border-l pl-3 pb-1">
          {argsText && (
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground uppercase tracking-wide">参数</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed">{argsText}</pre>
            </div>
          )}
          {resultText && (
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground uppercase tracking-wide">结果</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed">{resultText}</pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

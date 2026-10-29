/**
 * 单条工具调用 / 事件（coss ui 版，取代 affectui/tool-calls）。
 */
import { useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, LoaderCircle, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { JsonViewer, type JsonValue } from '@/components/JsonViewer';
import { parseLooseJson } from '@/lib/json';
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

/** 纯文本结果仍用 <pre>；对象或 JSON 字符串交给 JsonViewer 折叠展示。 */
function asJson(value: unknown): JsonValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'string') return value as JsonValue;
  return parseLooseJson(value)?.value ?? null;
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const json = asJson(value);
  const text = json ? '' : pretty(value);
  if (!json && !text) return null;
  return (
    <div>
      <div className="mb-0.5 text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      {json ? (
        <div className="max-h-64 overflow-auto rounded-md border bg-muted/30">
          <JsonViewer data={json} defaultExpanded={1} mini />
        </div>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed">{text}</pre>
      )}
    </div>
  );
}

export function ToolCall({ name, summary, status, args, result, defaultOpen = false, className }: ToolCallProps) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[status] ?? STATUS_META.success;
  const { Icon } = meta;

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
          <Payload label="参数" value={args} />
          <Payload label="结果" value={result} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

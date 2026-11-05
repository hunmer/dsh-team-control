/**
 * 任务看板表单基础控件：字段容器、模型路由下拉、执行方式切换。
 * 拆分自 Tasks.tsx，行为不变。
 */
import type { ReactNode } from 'react';
import type { BoardMode } from '@/lib/board';
import { cn } from '@/lib/utils';
import type { ModelOption } from './shared';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="ui-tb__label">{label}</span>
      {children}
    </label>
  );
}

export function RouteSelect({
  value,
  options,
  onChange,
  placeholder = '跟随工作区默认',
}: {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <select className="ui-tb__field" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((m) => (
        <option key={m.key} value={m.key}>
          {m.group} / {m.name || m.model}
        </option>
      ))}
    </select>
  );
}

export function ModePicker({ value, onChange }: { value: BoardMode; onChange: (mode: BoardMode) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {([
        ['same', '同一会话'],
        ['new', '新会话'],
      ] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={cn(
            'rounded-md px-2 py-1.5 text-xs transition',
            value === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

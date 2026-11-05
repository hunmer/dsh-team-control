/**
 * 任务看板表单基础控件：字段容器、模型路由下拉、执行方式切换。
 * 模型下拉用 coss Select：按 provider 分组（分隔线 + 组标题），选项与触发器都带模型头像。
 */
import { useMemo, type ReactNode } from 'react';
import type { BoardMode } from '@/lib/board';
import { ModelAvatar } from '@/components/ModelAvatar';
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { ModelOption } from './shared';

/** Base UI 的 Select 用 null 表示空值，这里用哨兵字符串表示「跟随默认」这一项。 */
const DEFAULT_KEY = '\u0000__default__';

function optionLabel(option: ModelOption): string {
  return option.name || option.model;
}

function fallbackLabel(value: string): string {
  const parts = value.split('\u0000');
  return parts[parts.length - 1] || value;
}

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
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const option of options) {
      const list = map.get(option.group);
      if (list) list.push(option);
      else map.set(option.group, [option]);
    }
    return [...map.entries()];
  }, [options]);

  return (
    <Select
      value={value || DEFAULT_KEY}
      onValueChange={(next) => {
        const key = typeof next === 'string' ? next : '';
        onChange(key === DEFAULT_KEY ? '' : key);
      }}
    >
      <SelectTrigger className="w-full" aria-label="模型路由">
        <SelectValue>
          {(current) => {
            const key = typeof current === 'string' ? current : '';
            if (!key || key === DEFAULT_KEY) {
              return <span className="truncate text-muted-foreground">{placeholder}</span>;
            }
            const option = options.find((m) => m.key === key);
            if (!option) return <span className="truncate">{fallbackLabel(key)}</span>;
            return (
              <span className="flex min-w-0 items-center gap-2">
                <ModelAvatar model={option.model} name={option.name} provider={option.provider} size={16} />
                <span className="truncate">{optionLabel(option)}</span>
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={DEFAULT_KEY}>
          <span className="text-muted-foreground">{placeholder}</span>
        </SelectItem>
        {groups.map(([group, items], index) => (
          <SelectGroup key={group}>
            {index > 0 && <SelectSeparator />}
            <SelectGroupLabel>{group}</SelectGroupLabel>
            {items.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                <span className="flex min-w-0 items-center gap-2">
                  <ModelAvatar model={option.model} name={option.name} provider={option.provider} size={16} />
                  <span className="truncate">{optionLabel(option)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
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

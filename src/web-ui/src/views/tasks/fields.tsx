/**
 * 任务看板表单基础控件：字段容器、模型路由 Combobox、思考强度下拉、执行方式切换。
 * 模型下拉用 coss Combobox：单选、按 provider 分组，选项带模型头像，选中后可单独指定 effort。
 */
import { useMemo, type ReactNode } from 'react';
import type { BoardMode } from '@/lib/board';
import { ModelAvatar } from '@/components/ModelAvatar';
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from '@/components/ui/combobox';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { ModelEffort, ModelOption } from './shared';

/** Select 用哨兵值表示「跟随默认」。 */
const EFFORT_DEFAULT = '\u0000__default__';

interface ModelGroup {
  group: string;
  items: ModelOption[];
}

function optionLabel(option: ModelOption): string {
  return option.name || option.model;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="ui-tb__label">{label}</span>
      {children}
    </label>
  );
}

/** 已选模型的思考强度单选；value 为 null 表示跟随该模型默认。 */
export function EffortSelect({
  value,
  efforts,
  onChange,
  ariaLabel,
  className,
}: {
  value: string | null;
  efforts: ModelEffort[];
  onChange: (value: string | null) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <Select
      value={value ?? EFFORT_DEFAULT}
      onValueChange={(next) => {
        const id = typeof next === 'string' ? next : '';
        onChange(id === EFFORT_DEFAULT ? null : id);
      }}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn('h-7 min-h-0 w-auto min-w-0 shrink-0 gap-1 px-2 text-xs', className)}
        size="sm"
      >
        <SelectValue>
          {(current) => {
            const id = typeof current === 'string' ? current : '';
            const effort = efforts.find((e) => e.id === id);
            if (!effort) return <span className="truncate text-muted-foreground">默认</span>;
            return <span className="truncate">{effort.name || effort.id}</span>;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={EFFORT_DEFAULT}>跟随默认</SelectItem>
        {efforts.map((effort) => (
          <SelectItem key={effort.id} value={effort.id}>
            {effort.name || effort.id}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * 模型路由单选：下拉可搜索、按 provider 分组、选项带头像；选中模型后若支持 effort，
 * 右侧出现强度单选（不传 `onEffortChange` 时不显示，供看板设置等只选模型的场景使用）。
 */
export function RouteSelect({
  value,
  options,
  onChange,
  placeholder = '跟随工作区默认',
  effort,
  onEffortChange,
  ariaLabel = '模型路由',
}: {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  effort?: string | null;
  onEffortChange?: (effort: string | null) => void;
  ariaLabel?: string;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const option of options) {
      const list = map.get(option.group);
      if (list) list.push(option);
      else map.set(option.group, [option]);
    }
    return [...map.entries()].map(([group, items]) => ({ group, items }));
  }, [options]);

  const selected = useMemo(() => options.find((option) => option.key === value) ?? null, [options, value]);
  const efforts = selected?.efforts ?? [];

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Combobox<ModelOption, false, ModelGroup>
          autoHighlight
          isItemEqualToValue={(item, current) => Boolean(current) && item.key === current?.key}
          itemToStringLabel={(option) => (option ? `${optionLabel(option)} · ${option.group}` : '')}
          itemToStringValue={(option) => (option ? option.key : '')}
          items={groups}
          onValueChange={(next) => onChange(next ? next.key : '')}
          value={selected}
        >
          <ComboboxInput
            aria-label={ariaLabel}
            placeholder={placeholder}
            showClear
            startAddon={
              selected ? (
                <ModelAvatar model={selected.model} name={selected.name} provider={selected.provider} size={16} />
              ) : undefined
            }
          />
          <ComboboxPopup>
            <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
            <ComboboxList>
              {(group: ModelGroup) => (
                <ComboboxGroup key={group.group} items={group.items}>
                  <ComboboxGroupLabel>{group.group}</ComboboxGroupLabel>
                  <ComboboxCollection>
                    {(option: ModelOption) => (
                      <ComboboxItem key={option.key} value={option}>
                        <span className="flex min-w-0 items-center gap-2">
                          <ModelAvatar model={option.model} name={option.name} provider={option.provider} size={16} />
                          <span className="truncate">{optionLabel(option)}</span>
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </div>
      {onEffortChange && efforts.length > 0 ? (
        <EffortSelect
          ariaLabel={`${selected ? optionLabel(selected) : '模型'} 的思考强度`}
          efforts={efforts}
          onChange={onEffortChange}
          value={effort ?? null}
        />
      ) : null}
    </div>
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

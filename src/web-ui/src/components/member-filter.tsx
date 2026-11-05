"use client";

/**
 * p-group-23 —— 成员过滤器（coss ui registry block 的本地受控版）。
 * 来源：https://coss.com/ui/r/p-group-23.json（copy-paste 理念，import 已按本仓库别名重写）。
 * 原版是内置假数据的 demo；这里改成受控组件：options/value/onValueChange。
 */
import {
  ChevronsUpDownIcon,
  FunnelIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Group, GroupSeparator, GroupText } from "@/components/ui/group";

export type FilterOption = {
  id: string;
  label: string;
  avatar?: string;
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0]?.charAt(0).toUpperCase() ?? "";
  }
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts[parts.length - 1]?.charAt(0) ?? "";
  return (first + last).toUpperCase();
}

function MemberAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl?: string;
  className?: string;
}) {
  return (
    <Avatar className={cn("[--avatar-size:--spacing(5)]", className)}>
      {avatarUrl ? <AvatarImage alt={name} src={avatarUrl} /> : null}
      <AvatarFallback>{getInitials(name)}</AvatarFallback>
    </Avatar>
  );
}

export interface MemberGroupFilterProps {
  /** 可选成员清单 */
  options: FilterOption[];
  /** 已选中的成员（多选）；空数组表示不过滤 */
  value: FilterOption[];
  onValueChange: (value: FilterOption[]) => void;
  /** 左侧筛选标签文案 */
  label?: string;
}

export default function MemberGroupFilter({
  options,
  value,
  onValueChange,
  label = "成员",
}: MemberGroupFilterProps) {
  const renderTriggerContent = () => {
    if (value.length === 0) return `全部${label}`;
    const first = value[0];
    const remainingCount = value.length - 1;

    return (
      <div className="flex items-center gap-2">
        <MemberAvatar
          avatarUrl={first?.avatar}
          name={first?.label ?? ""}
        />
        <span className="truncate">{first?.label}</span>
        {remainingCount > 0 && (
          <Badge className="tabular-nums" variant="secondary">
            +{remainingCount}
          </Badge>
        )}
      </div>
    );
  };

  return (
    <Group>
      <GroupText
        className={cn(
          buttonVariants({
            size: "sm",
            variant: "outline",
          }),
          "pointer-events-none",
        )}
      >
        <FunnelIcon />
        {label}
      </GroupText>
      <GroupSeparator />
      <Combobox
        autoHighlight
        items={options}
        multiple
        onValueChange={(next) => {
          if (Array.isArray(next)) {
            onValueChange(next);
          }
        }}
        value={value}
      >
        <ComboboxTrigger
          render={
            <Button
              className={value.length === 0 ? "justify-between" : undefined}
              size="sm"
              variant="outline"
            />
          }
        >
          {renderTriggerContent()}
          {value.length === 0 && (
            <ChevronsUpDownIcon className="-me-1!" />
          )}
        </ComboboxTrigger>
        <ComboboxPopup aria-label={`选择${label}`}>
          <div className="border-b p-2">
            <ComboboxInput
              className="rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
              placeholder={`搜索${label}…`}
              showTrigger={false}
              startAddon={<SearchIcon />}
            />
          </div>
          <ComboboxEmpty>没有匹配的{label}。</ComboboxEmpty>
          <ComboboxList>
            {(option: FilterOption) => (
              <ComboboxItem key={option.id} value={option}>
                <div className="flex items-center gap-2">
                  <MemberAvatar avatarUrl={option.avatar} name={option.label} />
                  <span>{option.label}</span>
                </div>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      <GroupSeparator />
      <Button
        aria-label="清除筛选"
        disabled={value.length === 0}
        onClick={() => onValueChange([])}
        size="icon-sm"
        variant="outline"
      >
        <XIcon />
      </Button>
    </Group>
  );
}

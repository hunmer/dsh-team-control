/**
 * 审阅页（只读）：各子成员 write/edit 的 unified diff。
 *
 * 数据来自 sidecar 的 /api/changes（插件在 members 的工具调用前后读盘算 diff 上报），
 * 面板只做展示，没有任何写操作 —— 审批与落盘仍走「审批队列」。
 */
import { useEffect, useMemo, useState } from 'react';
import { FileDiff, RefreshCw } from 'lucide-react';
import { usePanel } from '@/store';
import type { Member, MemberChange } from '@/types';
import { ModelAvatar } from '@/components/ModelAvatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import { fmtClock } from '@/lib/format';

/** diff 单行：kind 决定前缀、配色与行号推进方式。 */
interface DiffRow {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** 把 unified diff 展开成可渲染的行，并给出 old/new 两侧行号。 */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (!line) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : oldNo;
      newNo = m ? Number(m[2]) : newNo;
      const tail = line.replace(/^@@[^@]*@@\s?/, '');
      rows.push({ kind: 'hunk', text: tail || line });
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('-')) { rows.push({ kind: 'del', text: line.slice(1), oldNo }); oldNo += 1; }
    else if (line.startsWith('+')) { rows.push({ kind: 'add', text: line.slice(1), newNo }); newNo += 1; }
    else { rows.push({ kind: 'ctx', text: line.slice(1), oldNo, newNo }); oldNo += 1; newNo += 1; }
  }
  return rows;
}

/** 改动量档位：给列表一个粗粒度的“多大”提示，配色沿用仓库既有语义色。 */
function sizeTone(added: number, deleted: number): { label: string; cls: string } {
  const total = added + deleted;
  if (total >= 300) return { label: '大改', cls: 'border-destructive/40 text-destructive' };
  if (total >= 60) return { label: '中等', cls: 'border-warning/50 text-warning' };
  return { label: '小改', cls: 'border-border text-muted-foreground' };
}

/** 成员首字（中文取首个汉字，英文取首字母大写），作为没有厂商图标时的兜底。 */
function initialsOf(name?: string | null): string {
  const text = (name ?? '').trim();
  if (!text) return '?';
  const first = Array.from(text)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** 成员标记：能识别模型厂商时用品牌图标，否则退回首字母方块。 */
function MemberAvatar({ member, name, size = 14 }: { member?: Member; name?: string | null; size?: number }) {
  const label = member?.name ?? name ?? '';
  const brand = member ? <ModelAvatar model={member.model} name={member.name} size={size} /> : null;
  if (brand) return brand;
  return (
    <span
      aria-hidden
      className="grid shrink-0 select-none place-items-center rounded bg-muted font-medium leading-none text-muted-foreground"
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.58)) }}
    >
      {initialsOf(label)}
    </span>
  );
}

const ROW_CLS: Record<DiffRow['kind'], string> = {
  meta: 'text-muted-foreground',
  hunk: 'bg-muted/50 text-muted-foreground',
  add: 'bg-emerald-500/10',
  del: 'bg-destructive/10',
  ctx: '',
};

const SIGN: Record<DiffRow['kind'], string> = { meta: ' ', hunk: '', add: '+', del: '−', ctx: ' ' };

/** 单条改动的 diff 面板：超过 400 行默认折叠，避免一次渲染整份大文件。 */
function DiffPane({ change }: { change: MemberChange }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => parseDiff(change.diff), [change.diff]);
  const shown = expanded ? rows : rows.slice(0, 400);
  const hidden = rows.length - shown.length;

  if (!change.diff.trim()) {
    return (
      <div className="grid h-full place-items-center p-6">
        <p className="text-xs text-muted-foreground">没有可展示的 diff（写入内容与原文一致，或该文件不是文本）。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <pre className="w-max min-w-full font-mono text-[11.5px] leading-[1.55]">
          {shown.map((row, index) => (
            <div key={index} className={`flex ${ROW_CLS[row.kind]}`}>
              <span className="w-10 shrink-0 select-none border-r border-border/60 px-1 text-right text-[10px] text-muted-foreground/70">
                {row.oldNo ?? ''}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border/60 px-1 text-right text-[10px] text-muted-foreground/70">
                {row.newNo ?? ''}
              </span>
              <span className="w-4 shrink-0 select-none text-center text-muted-foreground/70">{SIGN[row.kind]}</span>
              <span className="whitespace-pre px-2">{row.text}</span>
            </div>
          ))}
        </pre>
      </ScrollArea>
      {hidden > 0 ? (
        <div className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          还有 {hidden} 行未显示
          <Button size="xs" variant="ghost" className="ml-2" onClick={() => setExpanded(true)}>显示全部</Button>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewView() {
  const { state, memberName, refreshChanges, toast } = usePanel();
  const { changes, members, errors, teamId } = state;
  const [query, setQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const membersById = useMemo(() => {
    const map = new Map<string, Member>();
    for (const member of members) map.set(member.id, member);
    return map;
  }, [members]);

  // 进页 / 刷新后默认选中第一条，右栏不留空
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return changes.filter((change) => {
      if (memberFilter && change.memberId !== memberFilter) return false;
      if (q && !change.path.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [changes, memberFilter, query]);

  const selected = useMemo(
    () => filtered.find((change) => change.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  useEffect(() => {
    if (!teamId) return;
    if (!changes.length) void refreshChanges().catch(() => { /* 错误显示在横幅里 */ });
  }, [teamId, changes.length, refreshChanges]);

  const totals = useMemo(() => {
    const files = new Set(changes.map((change) => change.path));
    const contributors = new Set(changes.map((change) => change.memberId).filter(Boolean));
    const added = changes.reduce((sum, change) => sum + (change.added ?? 0), 0);
    const deleted = changes.reduce((sum, change) => sum + (change.deleted ?? 0), 0);
    return { files: files.size, contributors: contributors.size, added, deleted };
  }, [changes]);

  const memberOptions = useMemo(() => {
    const ids = new Set(changes.map((change) => change.memberId).filter((id): id is string => !!id));
    return members.filter((member) => ids.has(member.id));
  }, [changes, members]);

  if (!teamId) return <EmptyState title="还没有选择团队" detail="先在左上角选择一个团队" />;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3" data-view="review">
      <SectionHead
        title="审阅"
        meta={<MetaLine>
          {changes.length
            ? `${changes.length} 处改动 · ${totals.files} 个文件 · ${totals.contributors} 位成员 · +${totals.added} / −${totals.deleted}`
            : '成员 write/edit 文件的统一 diff'}
          {errors.changes ? ` · 加载失败：${errors.changes}` : ''}
        </MetaLine>}
        controls={<Button size="sm" variant="outline" onClick={() => {
          void refreshChanges().catch((err) => toast('审阅刷新失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
        }}><RefreshCw className="size-3.5" />刷新</Button>}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按文件路径过滤…"
          className="h-8 w-64 text-xs max-lg:w-full"
        />
        <div className="flex flex-wrap items-center gap-1">
          <Button size="xs" variant={memberFilter ? 'ghost' : 'secondary'} onClick={() => setMemberFilter('')}>
            全部成员
          </Button>
          {memberOptions.map((member) => (
            <Button
              key={member.id}
              size="xs"
              variant={memberFilter === member.id ? 'secondary' : 'ghost'}
              onClick={() => setMemberFilter(memberFilter === member.id ? '' : member.id)}
            >
              <span className="flex items-center gap-1">
                <MemberAvatar member={member} size={12} />
                <span>{member.name}</span>
              </span>
            </Button>
          ))}
        </div>
      </div>

      {errors.changes && !changes.length
        ? <EmptyState title="改动加载失败" detail={errors.changes} />
        : !filtered.length
          ? <EmptyState
              title={changes.length ? '没有符合过滤条件的改动' : '暂无改动'}
              detail={changes.length ? '换个关键词或成员看看' : '子成员用 write / edit 改文件后，这里会出现只读的统一 diff'}
            />
          : (
            <div className="flex min-h-0 flex-1 gap-3 max-lg:flex-col">
              <div className="w-72 shrink-0 overflow-y-auto rounded-lg border border-border/60 [scrollbar-width:thin] max-lg:w-full max-lg:overflow-x-auto max-lg:overflow-y-hidden">
                <ul className="flex flex-col max-lg:flex-row">
                  {filtered.map((change) => {
                    const tone = sizeTone(change.added ?? 0, change.deleted ?? 0);
                    const active = selected?.id === change.id;
                    return (
                      <li key={change.id} className="max-lg:shrink-0">
                        <button
                          type="button"
                          onClick={() => setSelectedId(change.id)}
                          className={`flex w-full flex-col gap-1 border-b border-border/40 px-3 py-2 text-left transition-colors last:border-b-0 max-lg:w-60 max-lg:border-r max-lg:border-b-0 max-lg:last:border-r-0 ${active ? 'bg-accent/60' : 'hover:bg-accent/30'}`}
                        >
                          <span className="flex items-center gap-1.5 text-xs font-medium">
                            <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate" title={change.path}>{change.path}</span>
                          </span>
                          <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className={tone.cls}>{change.kind === 'add' ? '新增' : '修改'} · {tone.label}</Badge>
                            <span className="text-emerald-600 dark:text-emerald-400">+{change.added ?? 0}</span>
                            <span className="text-destructive">−{change.deleted ?? 0}</span>
                            <span className="flex min-w-0 items-center gap-1">
                              <MemberAvatar
                                member={change.memberId ? membersById.get(change.memberId) : undefined}
                                name={memberName(change.memberId)}
                                size={12}
                              />
                              <span className="truncate">{memberName(change.memberId)}</span>
                            </span>
                            <span className="ml-auto shrink-0">{fmtClock(change.createdAt)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60">
                {selected ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
                      <span className="font-mono text-xs font-medium">{selected.path}</span>
                      <Badge variant="outline">{selected.kind === 'add' ? '新增文件' : '修改'}</Badge>
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <MemberAvatar
                          member={selected.memberId ? membersById.get(selected.memberId) : undefined}
                          name={memberName(selected.memberId)}
                          size={13}
                        />
                        <span>{memberName(selected.memberId)}</span>
                        {selected.taskId ? ` · ${selected.taskId}` : ''}
                        {' · '}{fmtClock(selected.createdAt)}
                      </span>
                      <span className="ml-auto text-[11px]">
                        <span className="text-emerald-600 dark:text-emerald-400">+{selected.added ?? 0}</span>
                        {' '}
                        <span className="text-destructive">−{selected.deleted ?? 0}</span>
                      </span>
                    </div>
                    <DiffPane key={selected.id} change={selected} />
                  </>
                ) : <EmptyState title="选择一条改动" detail="该文件的统一 diff 会显示在这里" />}
              </div>
            </div>
          )}
    </section>
  );
}

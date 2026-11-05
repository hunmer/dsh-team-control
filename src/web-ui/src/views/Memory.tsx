/**
 * 记忆 —— 团队成员空间 + 共享空间的显式上下文（文件持久化，一条记忆一个 JSON）。
 *
 * 数据来自 GET /api/memory（只回元数据 + 摘要）；选中后 GET /api/memory/:id 取完整 value。
 * 这里只做 Lead/面板侧的查看、改可见性、删除；成员写入由 team_memory_write 工具完成。
 */
import { useEffect, useMemo, useState } from 'react';
import { Copy, RefreshCw, Trash2 } from 'lucide-react';
import { usePanel } from '@/store';
import type { MemoryEntry } from '@/types';
import { api, enc } from '@/lib/api';
import { JsonViewer, type JsonValue } from '@/components/JsonViewer';
import { Button } from '@/components/ui/button';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

const SCOPES = [
  { value: 'all', label: '全部' },
  { value: 'team', label: '团队空间' },
  { value: 'member', label: '成员空间' },
] as const;

const KINDS = [
  { value: '', label: '全部类型' },
  { value: 'handoff', label: '交接' },
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决策' },
  { value: 'open-question', label: '未决问题' },
] as const;

const VISIBILITY_LABEL: Record<string, string> = { private: '私有', team: '本队', shared: '跨队共享' };

const KIND_LABEL: Record<string, string> = {
  handoff: '交接', fact: '事实', decision: '决策', 'open-question': '未决问题',
};

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString('zh-CN', { hour12: false });
};

/** value 可能是普通字符串，也可能是成员写入的 JSON 字符串：能解析就交给 JsonViewer。 */
function parseValue(value?: string): JsonValue {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return '';
  if (/^[[{]/.test(text)) {
    try { return JSON.parse(text); } catch { /* 当文本展示 */ }
  }
  return value;
}

export function MemoryView() {
  const { state, refreshMemories, memberName } = usePanel();
  const { teamId, memories, errors } = state;
  const [scope, setScope] = useState<'all' | 'team' | 'member'>('all');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    void refreshMemories().catch(() => undefined);
  }, [teamId, refreshMemories]);

  const filtered = useMemo(() => {
    const text = q.trim().toLowerCase();
    return memories.filter((m) => {
      if (scope !== 'all' && m.scope !== scope) return false;
      if (kind && m.kind !== kind) return false;
      if (!text) return true;
      return [m.slot, m.title, m.summary, (m.tags || []).join(' ')].join('\n').toLowerCase().includes(text);
    });
  }, [memories, scope, kind, q]);

  // 列表刷新后保持选中；选中的记忆被删掉则清空详情。
  useEffect(() => {
    if (selectedId && !memories.some((m) => m.id === selectedId)) {
      setSelectedId(null);
      setDetail(null);
    }
  }, [memories, selectedId]);

  const open = async (id: string) => {
    setSelectedId(id);
    setConfirmDelete(false);
    setNotice(null);
    try {
      const resp = await api<{ memory: MemoryEntry }>('/api/memory/' + enc(id) + '?team=' + enc(teamId || ''), {});
      setDetail(resp.memory);
    } catch (err) {
      setDetail(null);
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const refresh = () => {
    if (!teamId || busy) return;
    setBusy(true);
    void refreshMemories().catch(() => undefined).finally(() => setBusy(false));
  };

  const setVisibility = async (visibility: string) => {
    if (!detail) return;
    setBusy(true);
    try {
      const resp = await api<{ memory: MemoryEntry }>('/api/memory/' + enc(detail.id), {
        method: 'PATCH',
        body: { visibility },
      });
      setDetail(resp.memory);
      setNotice('可见性已更新');
      await refreshMemories();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api('/api/memory/' + enc(detail.id) + '?team=' + enc(teamId || ''), { method: 'DELETE' });
      setSelectedId(null);
      setDetail(null);
      setConfirmDelete(false);
      setNotice('已删除该记忆文件');
      await refreshMemories();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const copyId = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.id);
      setNotice('已复制 memoryId：可以把 id 交给其他团队的成员读取（visibility=shared 时）。');
    } catch { setNotice(detail.id); }
  };

  let body: React.ReactNode;
  if (!teamId) body = <EmptyState title="未选择团队" />;
  else if (errors.memories && !memories.length) body = <EmptyState title="记忆加载失败" detail={errors.memories} />;
  else if (!memories.length) {
    body = <EmptyState title="还没有记忆" detail="成员收工时可用 team_memory_write 保存 handoff；Lead 可要求成员上传到团队空间" />;
  } else if (!filtered.length) {
    body = <EmptyState title="没有匹配的记忆" detail="换个 scope / 类型 / 关键词试试" />;
  } else {
    body = (
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-h-0 overflow-y-auto rounded-xl border bg-card">
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => void open(m.id)}
              className={
                'flex w-full flex-col gap-1.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-accent/40 '
                + (m.id === selectedId ? 'bg-accent/60' : '')
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{m.title || m.slot}</span>
                <span className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {KIND_LABEL[m.kind] || m.kind}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <code className="truncate font-mono">{m.slot}</code>
                <span>·</span>
                <span className="shrink-0">{m.scope === 'team' ? '团队' : memberName(m.ownerMemberId)}</span>
                <span>·</span>
                <span className="shrink-0">{VISIBILITY_LABEL[m.visibility] || m.visibility}</span>
                <span className="ml-auto shrink-0">{fmtTime(m.updatedAt)}</span>
              </div>
              {m.summary ? <div className="line-clamp-2 text-xs text-muted-foreground">{m.summary}</div> : null}
            </button>
          ))}
        </div>

        <div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-4">
          {!detail ? (
            <EmptyState title="选择左侧一条记忆" detail="value 正文只在这里按需读取，列表接口不返回正文" />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold">{detail.title || detail.slot}</h3>
                <MetaLine>v{detail.version} · {fmtTime(detail.updatedAt)}</MetaLine>
              </div>
              <MetaLine>
                <code className="font-mono">{detail.id}</code> · scope={detail.scope}
                {detail.ownerMemberId ? ` · owner=${memberName(detail.ownerMemberId)}` : ''}
                {detail.source?.taskId ? ` · task=${detail.source.taskId}` : ''}
              </MetaLine>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">可见性</span>
                <Button size="sm" variant={detail.visibility === 'private' ? 'default' : 'outline'} disabled={busy || detail.scope === 'team'} onClick={() => void setVisibility('private')}>私有</Button>
                <Button size="sm" variant={detail.visibility === 'team' ? 'default' : 'outline'} disabled={busy} onClick={() => void setVisibility('team')}>本队</Button>
                <Button size="sm" variant={detail.visibility === 'shared' ? 'default' : 'outline'} disabled={busy} onClick={() => void setVisibility('shared')}>跨队共享</Button>
                <Button size="sm" variant="outline" disabled={!detail} onClick={() => void copyId()}><Copy className="size-3.5" />复制 id</Button>
                {confirmDelete ? (
                  <>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>确认删除</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</Button>
                  </>
                ) : (
                  <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="size-3.5" />删除
                  </Button>
                )}
              </div>
              {notice ? <MetaLine>{notice}</MetaLine> : null}
              <div className="rounded-lg border bg-muted/30 p-2">
                <JsonViewer data={parseValue(detail.value)} defaultExpanded={2} mini />
              </div>
              {detail.tags?.length ? <MetaLine>标签：{detail.tags.join('、')}</MetaLine> : null}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <SectionHead
        title="记忆"
        meta={`${memories.length} 条 · 文件持久化，不落库`}
        controls={(
          <>
            <SegmentedControl size="sm" aria-label="记忆空间">
              {SCOPES.map((item) => (
                <SegmentedControlItem
                  key={item.value}
                  aria-current={scope === item.value ? 'page' : undefined}
                  onClick={() => setScope(item.value)}
                >
                  {item.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <select
              className="h-7.5 rounded-md border bg-background px-2 text-xs"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <input
              className="h-7.5 w-48 rounded-md border bg-background px-2 text-xs"
              placeholder="搜索槽位 / 标题 / 摘要"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!teamId || busy} onClick={refresh}>
              <RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新
            </Button>
          </>
        )}
      />
      {body}
    </div>
  );
}

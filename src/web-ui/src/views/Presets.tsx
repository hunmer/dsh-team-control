import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { usePanel } from '@/store';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

/**
 * agentPreset 目录：Host 插件把宿主内置 + 团队自建的组合预设同步到 sidecar。
 * 面板只读浏览；团队自建的可以点删除（排队给 Host 插件执行，几秒内生效）。
 */
export function PresetsView() {
  const { state, refreshPresets, deletePreset, toast } = usePanel();
  const { presets, errors } = state;
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, unknown>>({});
  const teamCount = presets.filter((p) => p.source === 'team').length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((p) => [p.id, p.name, p.description].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [presets, query]);

  const toggleDoc = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (docs[id] !== undefined) return;
    try {
      const detail = await api<{ preset: unknown; doc: unknown }>('/api/presets/' + encodeURIComponent(id));
      setDocs((prev) => ({ ...prev, [id]: detail.doc ?? { preset: detail.preset, hint: '内置预设的文档在 DSH bundle 里，面板没有镜像。' } }));
    } catch (err) {
      setDocs((prev) => ({ ...prev, [id]: { error: err instanceof Error ? err.message : String(err) } }));
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await deletePreset(id);
      toast(`已请求删除「${id}」，Host 插件执行后自动刷新`);
    } catch (err) {
      toast('删除失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally { setBusy(null); }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3" data-view="presets">
      <SectionHead
        title="组合预设（agentPreset）"
        meta={<MetaLine>
          {`${presets.length} 个 · 团队自建 ${teamCount}` + (errors.presets ? ` · 加载失败：${errors.presets}` : '')}
        </MetaLine>}
        controls={
          <div className="flex items-center gap-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 id / 名称 / 说明" className="h-8 w-52" />
            <Button size="sm" variant="outline" onClick={() => {
            void refreshPresets().catch((err) => toast('预设刷新失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
            }}>刷新</Button>
          </div>
        }
      />
      {shown.length === 0 ? (
        <EmptyState title="还没有预设目录" detail="Host 插件启动后会同步；也可以让 Lead 用 team_preset 新建一个。" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">id</th>
                <th className="px-3 py-2 font-medium">名称 / 说明</th>
                <th className="px-3 py-2 font-medium">来源</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((preset) => (
                <tr key={preset.id} className="border-t align-top">
                  <td className="px-3 py-2 font-mono">{preset.id}</td>
                  <td className="px-3 py-2">
                    <div>{preset.name || '—'}</div>
                    {preset.description ? <div className="text-muted-foreground">{preset.description}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={preset.source === 'team' ? 'secondary' : 'outline'}>
                      {preset.source === 'team' ? '团队自建' : '宿主内置'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {preset.broken
                      ? <span className="text-destructive" title={preset.broken}>不可用</span>
                      : <span className="text-muted-foreground">可用</span>}
                    {preset.file ? <div className="truncate font-mono text-[10px] text-muted-foreground" title={preset.file}>{preset.file}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => { void toggleDoc(preset.id); }}>
                      {open === preset.id ? '收起' : '查看'}
                    </Button>
                    {preset.source === 'team' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === preset.id}
                        onClick={() => { void remove(preset.id); }}
                      >删除</Button>
                    ) : (
                      <span className="text-muted-foreground">只读</span>
                    )}
                  </td>
                </tr>
              ))}
              {open && shown.some((p) => p.id === open) ? (
                <tr key={`doc-${open}`} className="border-t bg-muted/30">
                  <td colSpan={5} className="px-3 py-2">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                      {docs[open] === undefined ? '加载中…' : JSON.stringify(docs[open], null, 2)}
                    </pre>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        新建/修改用 Lead 的 <code className="font-mono">team_preset</code>；内置预设来自 DSH bundle，不能覆盖。
      </p>
    </section>
  );
}

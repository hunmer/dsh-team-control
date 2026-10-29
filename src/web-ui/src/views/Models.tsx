import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { usePanel } from '@/store';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState, SectionHead } from '@/components/Bits';
import { ModelAvatar, ProviderAvatar } from '@/components/ModelAvatar';

/**
 * 模型路由页：目录来自 Host 的 DSH ctx.llm（Host 同步给 sidecar），
 * 面板只负责勾选启用与写备注 —— 本页不调用任何模型服务。
 */
interface LlmModel {
  provider: string;
  model: string;
  name: string;
  description?: string | null;
  modalities?: string[] | null;
  source?: string;
  enabled: boolean;
  note?: string | null;
}

interface LlmProvider {
  id: string;
  name: string;
  source?: string;
  error?: string | null;
  models: LlmModel[];
}

interface Catalog {
  asOf: string;
  source: string;
  providers: LlmProvider[];
  totals: { providers: number; models: number; enabled: number };
}

const keyOf = (m: { provider: string; model: string }) => m.provider + '\u0000' + m.model;

export function ModelsView() {
  const { toast } = usePanel();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const apply = (next: Catalog) => {
    setCatalog(next);
    setNotes(Object.fromEntries(next.providers.flatMap((p) => p.models.map((m) => [keyOf(m), m.note || '']))));
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      apply(await api<Catalog>('/api/llm/catalog'));
    } catch (err) {
      setError('读取模型目录失败：' + (err instanceof Error ? err.message : String(err)));
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const mutate = async (model: LlmModel, patch: { enabled?: boolean; note?: string }) => {
    const key = keyOf(model);
    setBusy((prev) => new Set(prev).add(key));
    try {
      await api('/api/llm/routes', {
        method: 'PATCH',
        body: { provider: model.provider, model: model.model, ...patch },
      });
      setCatalog((prev) => prev && {
        ...prev,
        providers: prev.providers.map((p) => ({
          ...p,
          models: p.models.map((m) => (keyOf(m) === key ? { ...m, ...patch } : m)),
        })),
        totals: {
          ...prev.totals,
          enabled: prev.providers.flatMap((p) => p.models).filter((m) => (keyOf(m) === key ? (patch.enabled ?? m.enabled) : m.enabled)).length,
        },
      });
      if (patch.enabled !== undefined) toast(patch.enabled ? '已启用 ' + model.model : '已停用 ' + model.model, 'ok', 1800);
    } catch (err) {
      toast('保存失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  const saveNote = (model: LlmModel) => {
    const key = keyOf(model);
    const value = notes[key] ?? '';
    if (value === (model.note ?? '')) return;
    void mutate(model, { note: value });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!catalog) return [];
    return catalog.providers
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => !q || [p.id, p.name, m.model, m.name, m.description || '', m.note || ''].some((v) => v.toLowerCase().includes(q))),
      }))
      // 没有模型的 provider 不展示（Host 也不会再上报，这里兜住旧数据）
      .filter((p) => p.models.length > 0);
  }, [catalog, query]);

  const providerCount = useMemo(
    () => (catalog ? catalog.providers.filter((p) => p.models.length > 0).length : 0),
    [catalog],
  );

  return (
    <div className="space-y-3">
      <SectionHead
        title="模型路由"
        meta={catalog ? `${catalog.totals.enabled}/${catalog.totals.models} 条已启用 · ${providerCount} 个提供商 · 同步于 ${catalog.asOf}` : '目录由 Host 从 DSH 模型服务同步'}
        controls={(
          <>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 provider / model / 备注" className="h-8 w-60" />
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>刷新</Button>
          </>
        )}
      />

      <div className="text-xs text-muted-foreground">
        只有勾选启用的 provider/model 才会出现在 <code className="rounded bg-muted px-1">team_models</code> 里，也才能传给 <code className="rounded bg-muted px-1">team_spawn</code> 的 agentProvider/model。
        目录本身来自宿主 DSH，本面板不代理任何模型请求；Host 侧模型配置变化后，下一次团队工具调用会刷新它。
      </div>

      {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading && !catalog ? <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Spinner className="size-4" />加载中…</div> : null}
      {!loading && catalog && !catalog.totals.models ? (
        <EmptyState
          title="还没有模型目录"
          detail="配置模型提供商后自动同步"
        />
      ) : null}

      {groups.map((p) => (
        <Card key={p.id}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <ProviderAvatar provider={p.id} size={16} />
              <CardTitle className="text-sm">{p.name}</CardTitle>
              <code className="text-[11px] text-muted-foreground">{p.id}</code>
            </div>
            <span className="text-xs text-muted-foreground">{p.models.length} 个模型</span>
          </CardHeader>
          <CardContent className="p-0">
            {p.models.map((m) => {
              const key = keyOf(m);
              const disabled = busy.has(key);
              return (
                <div key={key} className="flex flex-wrap items-start gap-3 border-t px-3 py-2 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ModelAvatar model={m.model} name={m.name} provider={m.provider} size={14} />
                      <span className="text-sm font-medium">{m.name || m.model}</span>
                      <code className="text-[11px] text-muted-foreground">{m.model}</code>
                      {m.modalities?.includes('image') ? <Badge variant="outline" size="sm">vision</Badge> : null}
                      {!m.enabled ? <Badge variant="secondary" size="sm">已停用</Badge> : null}
                    </div>
                    {m.description ? <div className="text-xs text-muted-foreground">{m.description}</div> : null}
                  </div>
                  <Input
                    value={notes[key] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [key]: e.target.value }))}
                    onBlur={() => saveNote(m)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder="备注，例如：日常改代码 / 复杂推理"
                    className="h-8 w-56"
                    disabled={disabled}
                  />
                  <Button
                    size="sm"
                    variant={m.enabled ? 'outline' : 'default'}
                    disabled={disabled}
                    onClick={() => void mutate(m, { enabled: !m.enabled })}
                  >
                    {m.enabled ? '停用' : '启用'}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

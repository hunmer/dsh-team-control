import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { usePanel } from '@/store';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { EmptyState, SectionHead } from '@/components/Bits';
import { ModelAvatar, ProviderAvatar } from '@/components/ModelAvatar';
import { brandOfProvider } from '@/lib/model-brand';

/** 供应商图标：能认出品牌用官方 logo；聚合商（aicode / comfly 等）没有自家 logo 时退回首字母方块 */
function ProviderIcon({ id, name }: { id: string; name?: string | null }) {
  if (brandOfProvider(id)) return <ProviderAvatar provider={id} size={16} />;
  return (
    <span
      aria-hidden="true"
      title={name || id}
      className="grid size-4 shrink-0 place-items-center rounded-[4px] border bg-muted text-[9px] font-semibold uppercase leading-none text-muted-foreground"
    >
      {(name || id).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 1)}
    </span>
  );
}

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
  /** 适配器声明的可选思考强度（按弱→强排序）；null/缺省 = 未知或不支持 */
  efforts?: Array<{ id: string; name?: string; description?: string | null }> | null;
  defaultEffort?: string | null;
  /** 用户允许派发给该 route 的 effort 子集；null/缺省 = 全部允许 */
  allowedEfforts?: string[] | null;
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

  // 模型目录由 Host 插件启动时同步；这里在「目录为空」期间自动重试，免得用户手动切页刷新
  useEffect(() => {
    if (loading || (catalog && catalog.providers.length)) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [loading, catalog]);

  const mutate = async (model: LlmModel, patch: { enabled?: boolean; note?: string; allowedEfforts?: string[] | null }) => {
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

  /** 整组启用/停用：只 PATCH 状态需要变化的模型，成功后本地重算 totals。 */
  const mutateGroup = async (provider: LlmProvider, enabled: boolean) => {
    const targets = provider.models.filter((m) => m.enabled !== enabled);
    if (!targets.length) return;
    const keys = targets.map(keyOf);
    setBusy((prev) => new Set([...prev, ...keys]));
    try {
      await Promise.all(targets.map((m) => api('/api/llm/routes', {
        method: 'PATCH',
        body: { provider: m.provider, model: m.model, enabled },
      })));
      setCatalog((prev) => {
        if (!prev) return prev;
        const providers = prev.providers.map((p) => (p.id === provider.id
          ? { ...p, models: p.models.map((m) => ({ ...m, enabled })) }
          : p));
        return {
          ...prev,
          providers,
          totals: {
            ...prev.totals,
            enabled: providers.flatMap((p) => p.models).filter((m) => m.enabled).length,
          },
        };
      });
      toast(enabled ? `已启用 ${provider.name} 全部模型` : `已停用 ${provider.name} 全部模型`, 'ok', 1800);
    } catch (err) {
      setError('批量更新失败：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
    }
  };

  const saveNote = (model: LlmModel) => {
    const key = keyOf(model);
    const value = notes[key] ?? '';
    if (value === (model.note ?? '')) return;
    void mutate(model, { note: value });
  };

  /** 切换某个思考强度是否允许派发给该 route；全选时折回 null（不限）。 */
  const toggleEffort = (model: LlmModel, id: string) => {
    const ids = (model.efforts || []).map((e) => e.id);
    const current = model.allowedEfforts ?? ids;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    void mutate(model, { allowedEfforts: next.length === ids.length ? null : next });
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
        模型行里的 effort 开关决定该 route 允许派发的 <code className="rounded bg-muted px-1">reasoningEffort</code>（含继承自 Lead 的强度）：关掉的强度会从 team_models 里隐藏，主 Agent 指定时直接被拒绝。
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

      {groups.map((p) => {
        // 搜索会过滤掉不匹配的模型，但整组开关要作用于该 provider 的全部模型
        const full = catalog?.providers.find((x) => x.id === p.id) ?? p;
        const groupEnabled = full.models.every((m) => m.enabled);
        return (
        <Card key={p.id}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <ProviderIcon id={p.id} name={p.name} />
              <CardTitle className="text-sm">{p.name}</CardTitle>
              <code className="text-[11px] text-muted-foreground">{p.id}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {full.models.filter((m) => m.enabled).length}/{full.models.length} 个模型
              </span>
              <Switch
                aria-label={groupEnabled ? `停用 ${p.name} 全部模型` : `启用 ${p.name} 全部模型`}
                checked={groupEnabled}
                disabled={full.models.some((m) => busy.has(keyOf(m)))}
                onCheckedChange={(checked) => void mutateGroup(full, checked)}
              />
            </div>
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
                    </div>
                    {m.description ? <div className="text-xs text-muted-foreground">{m.description}</div> : null}
                  </div>
                  {m.efforts?.length ? (
                    <span className="flex h-8 flex-wrap items-center gap-1" title="允许主 Agent 派发给该模型的思考强度：关闭后 team_spawn 指定它会被拒绝">
                      {m.efforts.map((e) => {
                        const on = !m.allowedEfforts || m.allowedEfforts.includes(e.id);
                        const isDefault = m.defaultEffort === e.id;
                        return (
                          <button
                            key={e.id}
                            type="button"
                            disabled={disabled}
                            aria-pressed={on}
                            title={`${e.description || e.name || e.id}${isDefault ? '（模型默认）' : ''}${on ? '' : ' — 已禁止派发'}`}
                            onClick={() => toggleEffort(m, e.id)}
                            className={
                              'rounded-full border px-1.5 py-0.5 text-[10px] leading-none transition '
                              + (on
                                ? 'border-primary/50 bg-primary/10 text-foreground'
                                : 'border-dashed text-muted-foreground line-through opacity-60 hover:opacity-100')
                            }
                          >
                            {e.name || e.id}
                            {isDefault ? ' ·默认' : ''}
                          </button>
                        );
                      })}
                    </span>
                  ) : null}
                  <Input
                    value={notes[key] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [key]: e.target.value }))}
                    onBlur={() => saveNote(m)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder="备注，例如：日常改代码 / 复杂推理"
                    className="h-8 w-56"
                    disabled={disabled}
                  />
                  <span className="flex h-8 items-center">
                    <Switch
                      aria-label={`${m.enabled ? '停用' : '启用'} ${m.model}`}
                      checked={m.enabled}
                      disabled={disabled}
                      onCheckedChange={(checked) => void mutate(m, { enabled: checked })}
                    />
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
        );
      })}
    </div>
  );
}

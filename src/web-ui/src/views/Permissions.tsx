import { useMemo, useState } from 'react';
import { usePanel } from '@/store';
import { api, enc } from '@/lib/api';
import { describeSummary, fmtDateTime } from '@/lib/format';
import type { Policy } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

const DOMAIN_LIST = ['fs', 'exec', 'net', 'env'] as const;

function PolicyForm() {
  const { state, refreshPermissions, toast } = usePanel();
  const [form, setForm] = useState({
    subjectType: 'member', subjectId: '', domain: 'fs', matcher: '', ops: '', mode: 'allow',
    constraints: '', expiresAt: '',
  });
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string | null) => setForm((prev) => ({ ...prev, [key]: value ?? '' }));

  const submit = async () => {
    setError('');
    if (!state.teamId) { setError('请先选择团队。'); return; }
    const ops = form.ops.split(',').map((item) => item.trim()).filter(Boolean);
    if (!form.subjectId.trim()) { setError('subject id 不能为空。'); return; }
    if (!form.matcher.trim()) { setError('matcher 不能为空。'); return; }
    if (!ops.length) { setError('ops 至少填一个（逗号分隔）。'); return; }
    const body: Record<string, unknown> = {
      teamId: state.teamId,
      subjectType: form.subjectType, subjectId: form.subjectId.trim(), domain: form.domain,
      matcher: form.matcher.trim(), ops, mode: form.mode,
    };
    if (form.constraints.trim()) {
      try { body.constraints = JSON.parse(form.constraints); } catch { setError('constraints 不是合法 JSON。'); return; }
    }
    if (form.expiresAt) {
      const expires = new Date(form.expiresAt);
      if (Number.isNaN(expires.getTime())) { setError('expiresAt 不是合法时间。'); return; }
      body.expiresAt = expires.toISOString();
    }
    setBusy(true);
    try {
      await api('/api/policies', { method: 'POST', body });
      setConfirming(false);
      setForm((prev) => ({ ...prev, subjectId: '', matcher: '', ops: '', constraints: '', expiresAt: '' }));
      toast('规则已新增，正在刷新权限矩阵…', 'ok');
      await refreshPermissions();
    } catch (err) {
      setError('新增失败：' + (err instanceof Error ? err.message : String(err)));
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">新增规则 <span className="text-xs font-normal text-muted-foreground">默认拒绝 · deny 优先 · 多规则取最严</span></CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>subject type</Label>
            <Select value={form.subjectType} onValueChange={set('subjectType')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem><SelectItem value="role">role</SelectItem><SelectItem value="task">task</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>subject id</Label>
            <Input value={form.subjectId} onChange={(e) => set('subjectId')(e.target.value)} placeholder="lab-alpha / builder / task_3" list="member-ids" />
            <datalist id="member-ids">
              {state.members.map((m) => <option key={m.id} value={m.name || m.id} />)}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>domain</Label>
            <Select value={form.domain} onValueChange={set('domain')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DOMAIN_LIST.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>mode</Label>
            <Select value={form.mode} onValueChange={set('mode')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">allow</SelectItem><SelectItem value="deny">deny</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>matcher</Label>
            <Input value={form.matcher} onChange={(e) => set('matcher')(e.target.value)} placeholder="path glob / argv 前缀 / host:port / env glob" />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>ops（逗号分隔）</Label>
            <Input value={form.ops} onChange={(e) => set('ops')(e.target.value)} placeholder="fs: read,write / exec: spawn / net: connect / env: read" />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>constraints（JSON，可选）</Label>
            <Textarea rows={2} value={form.constraints} onChange={(e) => set('constraints')(e.target.value)} placeholder={'{"maxRuntimeMs":5000,"readOnly":true}'} />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>expiresAt（本地时间，可选）</Label>
            <Input type="datetime-local" value={form.expiresAt} onChange={(e) => set('expiresAt')(e.target.value)} />
          </div>
        </div>
        {confirming ? (
          <div className="rounded-md border bg-card/60 p-3 text-xs space-y-2">
            <div>确认新增规则？（确认后立即 POST /api/policies 并刷新矩阵）</div>
            <div className="font-mono text-[11px] text-muted-foreground break-all">
              {form.mode} {form.subjectType}:{form.subjectId} · domain={form.domain} · matcher={form.matcher} · ops={form.ops}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>取消</Button>
              <Button size="sm" loading={busy} onClick={submit}>确认新增</Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => { setError(''); setConfirming(true); }}>新增规则</Button>
          </div>
        )}
        {error ? <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-600 dark:text-red-400" role="alert">{error}</div> : null}
      </CardContent>
    </Card>
  );
}

async function deletePolicy(policy: Policy, refresh: () => Promise<void>, toast: (m: string, k?: 'ok' | 'warn' | 'error' | 'info') => void) {
  const label = `${policy.mode || '?'} ${policy.domain || '?'} ${policy.matcher || '*'}（${policy.subjectType || '?'}:${policy.subjectId || '*'}）`;
  if (!window.confirm('确认删除策略 ' + label + ' ？删除后立即生效（AC-11 热更新）。')) return;
  try {
    await api('/api/policies/' + enc(policy.id), { method: 'DELETE' });
    toast('策略已删除，正在刷新权限矩阵…', 'ok');
    await refresh();
  } catch (err) {
    toast('删除策略失败：' + (err instanceof Error ? err.message : String(err)), 'error');
  }
}

export function PermissionsView() {
  const { state, refreshPermissions, toast } = usePanel();
  const { matrix, policies, errors, snapshot } = state;
  const errorMessage = errors.permissions || errors.policies || '';
  const unackedCount = 0;
  void unackedCount;

  const policyTable = useMemo(() => {
    if (errors.policies && !policies.length) {
      return <div className="p-4 text-sm text-muted-foreground">策略加载失败：{errors.policies}</div>;
    }
    if (!policies.length) {
      return <div className="p-4 text-sm text-muted-foreground">暂无策略。默认拒绝：没有 allow 规则的域的写 / 执行 / 连接 / 读密钥都会被拒绝。</div>;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>mode</TableHead><TableHead>subject</TableHead><TableHead>domain</TableHead>
            <TableHead>matcher</TableHead><TableHead>ops</TableHead><TableHead>到期</TableHead><TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {policies.map((policy) => (
            <TableRow key={policy.id}>
              <TableCell><Badge variant={policy.mode === 'deny' ? 'destructive' : 'default'}>{policy.mode || '?'}</Badge></TableCell>
              <TableCell className="font-mono text-xs">{(policy.subjectType || '?') + ':' + (policy.subjectId || '*')}</TableCell>
              <TableCell className="font-mono text-xs">{policy.domain || '—'}</TableCell>
              <TableCell className="max-w-40 truncate font-mono text-xs" title={policy.matcher || ''}>{policy.matcher || '*'}</TableCell>
              <TableCell className="text-xs">{Array.isArray(policy.ops) ? policy.ops.join(',') : (policy.ops || '—')}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{policy.expiresAt ? fmtDateTime(policy.expiresAt) : '不过期'}</TableCell>
              <TableCell>
                <Button size="xs" variant="destructive" onClick={() => void deletePolicy(policy, refreshPermissions, toast)}>删除</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }, [policies, errors.policies, refreshPermissions, toast]);

  return (
    <section className="space-y-3">
      <SectionHead
        title="权限矩阵"
        meta={<MetaLine>{matrix.length} 成员 · {policies.length} 策略{snapshot?.version != null ? ` · v${snapshot.version}` : ''}</MetaLine>}
      />
      {errorMessage ? <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-600 dark:text-red-400">加载失败：{errorMessage}</div> : null}
      {errors.permissions && !matrix.length
        ? <EmptyState title="权限矩阵加载失败" detail={errors.permissions} />
        : !matrix.length
          ? <EmptyState title="暂无权限数据" detail="默认拒绝，未授权即空" />
          : (
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>成员</TableHead><TableHead>role</TableHead>
                    {DOMAIN_LIST.map((d) => <TableHead key={d}>{d}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matrix.map((item) => (
                    <TableRow key={item.memberId}>
                      <TableCell>
                        <div className="font-medium">{item.name || item.memberId || '?'}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{item.memberId}</div>
                      </TableCell>
                      <TableCell className="text-xs">{item.role || '—'}</TableCell>
                      {DOMAIN_LIST.map((domain) => {
                        const value = item[domain];
                        const summary = describeSummary(value);
                        return (
                          <TableCell
                            key={domain}
                            title={summary}
                            className={`max-w-48 truncate text-xs ${typeof value === 'boolean' ? (value ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400') : 'text-muted-foreground'}`}
                          >
                            {summary}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <PolicyForm />
        <Card>
          <CardHeader><CardTitle className="text-base">策略列表</CardTitle></CardHeader>
          <CardContent className="p-0">{policyTable}</CardContent>
        </Card>
      </div>
    </section>
  );
}

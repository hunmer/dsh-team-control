/**
 * 设置弹窗：左右布局（左侧垂直项目 / 右侧内容）。
 *
 * 目前只有「已封存的团队」一项：顶部自动封存开关 + 天数，下面列出已封存团队（恢复 / 删除）。
 * 数据来自 GET /api/settings 与 GET /api/teams?archived=1，打开弹窗时加载。
 */
import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import { api, enc, pickItems } from '@/lib/api';
import { usePanel } from '@/store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { PanelSettings, Team } from '@/types';

const SECTIONS = [{ id: 'archived', label: '已封存的团队', icon: Archive }] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function formatDay(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('zh-CN') : '—';
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { refreshTeams, toast } = usePanel();
  const [section, setSection] = useState<SectionId>('archived');
  const [settings, setSettings] = useState<PanelSettings | null>(null);
  const [archived, setArchived] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);
  const [daysDraft, setDaysDraft] = useState('7');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [nextSettings, list] = await Promise.all([
        api<PanelSettings>('/api/settings'),
        api<{ items?: Team[] } | Team[]>('/api/teams?archived=1'),
      ]);
      setSettings(nextSettings);
      setDaysDraft(String(nextSettings.autoArchive.days));
      setArchived(pickItems<Team>(list));
    } catch (err) {
      toast('读取设置失败：' + errText(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 只改自动封存配置：先乐观更新，失败回滚重读 */
  const saveAutoArchive = async (patch: Partial<PanelSettings['autoArchive']>) => {
    if (!settings) return;
    const snapshot = settings;
    const next: PanelSettings = { ...settings, autoArchive: { ...settings.autoArchive, ...patch } };
    setSettings(next);
    if (patch.days !== undefined) setDaysDraft(String(patch.days));
    try {
      const saved = await api<PanelSettings>('/api/settings', { method: 'PATCH', body: { autoArchive: patch } });
      setSettings(saved);
      setDaysDraft(String(saved.autoArchive.days));
    } catch (err) {
      setSettings(snapshot);
      toast('保存设置失败：' + errText(err), 'error');
    }
  };

  const commitDays = () => {
    if (!settings) return;
    const days = Math.round(Number(daysDraft));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      setDaysDraft(String(settings.autoArchive.days));
      toast('自动封存天数需在 1–365 之间', 'warn');
      return;
    }
    if (days !== settings.autoArchive.days) void saveAutoArchive({ days });
  };

  const restore = async (team: Team) => {
    setBusyId(team.id);
    try {
      await api('/api/teams/' + enc(team.id) + '/restore', { method: 'POST', body: {} });
      await refreshTeams();
      await load();
      toast('团队已恢复：' + (team.name || team.id), 'ok');
    } catch (err) {
      toast('恢复团队失败：' + errText(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (team: Team) => {
    const name = team.name || team.id;
    if (!window.confirm(`永久删除已封存的团队「${name}」？成员、任务、事件记录都会一并删除，无法恢复。`)) return;
    setBusyId(team.id);
    try {
      await api('/api/teams/' + enc(team.id) + '?confirm=1', { method: 'DELETE' });
      await load();
      toast('团队已删除', 'ok');
    } catch (err) {
      toast('删除团队失败：' + errText(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const auto = settings?.autoArchive;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b p-5 pe-12">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>管理已封存的团队与自动封存规则。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[24rem]">
          <nav aria-label="设置项目" className="flex w-44 shrink-0 flex-col gap-1 border-r bg-muted/32 p-2">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  section === id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
                onClick={() => setSection(id)}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-auto p-5">
            {section === 'archived' ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-sm">自动封存</div>
                    <p className="mt-0.5 text-muted-foreground text-xs">团队超过设定天数没有任何活动时自动封存；封存只隐藏团队，不会删除数据。</p>
                  </div>
                  <Switch
                    aria-label="自动封存"
                    checked={!!auto?.enabled}
                    disabled={!auto}
                    onCheckedChange={(checked) => void saveAutoArchive({ enabled: checked })}
                  />
                </div>
                {auto?.enabled ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">无活动超过</span>
                    <Input
                      aria-label="自动封存天数"
                      className="w-20"
                      max={365}
                      min={1}
                      onBlur={commitDays}
                      onChange={(event) => setDaysDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
                      size="sm"
                      type="number"
                      value={daysDraft}
                    />
                    <span className="text-sm">天自动封存</span>
                  </div>
                ) : null}

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="font-medium text-sm">已封存的团队</div>
                  <span className="text-muted-foreground text-xs">{archived.length} 个</span>
                </div>
                {loading && !archived.length ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="size-3.5 animate-spin" />
                    加载中…
                  </div>
                ) : null}
                {!loading && !archived.length ? (
                  <p className="text-muted-foreground text-xs">暂无已封存的团队。可在顶栏团队菜单里选择「封存」。</p>
                ) : null}
                <ul className="space-y-2">
                  {archived.map((team) => (
                    <li key={team.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">{team.name || team.id}</div>
                        <div className="truncate text-muted-foreground text-xs">
                          {team.id} · 封存于 {formatDay(team.archivedAt)}
                        </div>
                      </div>
                      <Button size="sm" variant="outline" disabled={busyId === team.id} onClick={() => void restore(team)}>
                        <ArchiveRestore />
                        恢复
                      </Button>
                      <Button size="sm" variant="destructive-outline" disabled={busyId === team.id} onClick={() => void remove(team)}>
                        <Trash2 />
                        删除
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

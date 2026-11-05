/**
 * 看板对话框：新建任务、看板设置。
 * 拆分自 Tasks.tsx，行为不变。
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { boardApi, type BoardMode, type BoardSettings, type BoardTask } from '@/lib/board';
import { usePanel } from '@/store';
import { Field, ModePicker, RouteSelect } from './fields';
import { errText, routeFromKey, type ModelOption } from './shared';

export function CreateTaskDialog({
  open,
  onOpenChange,
  workspaceId,
  workspacePath,
  models,
  defaultSettings,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspacePath: string;
  models: ModelOption[];
  defaultSettings: BoardSettings | null;
  onCreated: (task: BoardTask) => void | Promise<void>;
}) {
  const { toast } = usePanel();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [auto, setAuto] = useState(false);
  const [mode, setMode] = useState<BoardMode>('same');
  const [planKey, setPlanKey] = useState('');
  const [leadKey, setLeadKey] = useState('');
  const [limitTeams, setLimitTeams] = useState(false);
  const [teamModels, setTeamModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setAuto(false);
    setMode('same');
    setPlanKey('');
    setLeadKey('');
    setLimitTeams(false);
    setTeamModels([]);
  }, [open]);

  const submit = async () => {
    if (!title.trim()) { toast('请填写任务标题', 'warn'); return; }
    if (limitTeams && teamModels.length === 0) { toast('开启团队模型限制后至少选择一项', 'warn'); return; }
    setSaving(true);
    try {
      const task = await boardApi.create({
        workspaceId,
        workspacePath,
        title: title.trim(),
        description: description.trim(),
        auto,
        executionMode: mode,
        planRoute: routeFromKey(planKey),
        leadRoute: routeFromKey(leadKey),
        teamModels: limitTeams ? teamModels.map((key) => routeFromKey(key)!).filter(Boolean) : null,
      });
      await onCreated(task);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>任务会进入当前工作区的 Waiting 列；开启 auto 后调度器自动接手。</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Field label="标题">
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：给登录页加验证码" />
          </Field>
          <Field label="描述">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="目标、范围、验收标准…" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="执行方式">
              <ModePicker value={mode} onChange={setMode} />
            </Field>
            <Field label="自动入队">
              <div className="flex h-9 items-center gap-2">
                <Switch checked={auto} onCheckedChange={setAuto} />
                <span className="text-xs text-muted-foreground">{auto ? '创建后自动规划' : '手动点开始执行'}</span>
              </div>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="规划模型">
              <RouteSelect value={planKey} options={models} onChange={setPlanKey} placeholder={defaultSettings?.planModel ? `默认：${defaultSettings.planModel}` : '跟随默认'} />
            </Field>
            <Field label="执行模型">
              <RouteSelect value={leadKey} options={models} onChange={setLeadKey} placeholder={defaultSettings?.leadModel ? `默认：${defaultSettings.leadModel}` : '跟随默认'} />
            </Field>
          </div>
          <label className="ui-tb__check">
            <Switch checked={limitTeams} onCheckedChange={setLimitTeams} />
            <span>限制团队模型（不开启 = 不限制）</span>
          </label>
          {limitTeams && (
            <div className="ui-tb__checks">
              {models.length === 0 ? (
                <p className="text-xs text-muted-foreground">模型目录尚未加载。</p>
              ) : models.map((m) => (
                <label key={m.key} className="ui-tb__check">
                  <input
                    type="checkbox"
                    checked={teamModels.includes(m.key)}
                    onChange={(e) => {
                      setTeamModels((prev) => e.target.checked ? [...prev, m.key] : prev.filter((key) => key !== m.key));
                    }}
                  />
                  <span>{m.group} / {m.name}</span>
                </label>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" size={14} />}
            创建任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  workspaceId,
  settings,
  models,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  settings: BoardSettings | null;
  models: ModelOption[];
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = usePanel();
  const [draft, setDraft] = useState<BoardSettings | null>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings?.updatedAt]);

  if (!draft) return null;

  const save = async () => {
    setSaving(true);
    try {
      await boardApi.saveSettings({
        workspaceId,
        planningConcurrency: Number(draft.planningConcurrency) || 1,
        inprogressConcurrency: Number(draft.inprogressConcurrency) || 1,
        planProvider: draft.planProvider,
        planModel: draft.planModel,
        planReasoningEffort: draft.planReasoningEffort,
        leadProvider: draft.leadProvider,
        leadModel: draft.leadModel,
        leadReasoningEffort: draft.leadReasoningEffort,
      });
      await onSaved();
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>看板设置</DialogTitle>
          <DialogDescription>并发按工作区计算；模型留空时跟随 DSH 默认。</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="规划并发">
              <Input
                type="number"
                min={1}
                max={10}
                value={draft.planningConcurrency}
                onChange={(e) => setDraft({ ...draft, planningConcurrency: Number(e.target.value) })}
              />
            </Field>
            <Field label="执行并发">
              <Input
                type="number"
                min={1}
                max={10}
                value={draft.inprogressConcurrency}
                onChange={(e) => setDraft({ ...draft, inprogressConcurrency: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="默认规划模型">
            <RouteSelect
              value={draft.planProvider && draft.planModel ? `${draft.planProvider}\u0000${draft.planModel}` : ''}
              options={models}
              onChange={(key) => {
                const route = routeFromKey(key);
                setDraft({ ...draft, planProvider: route?.provider || null, planModel: route?.model || null });
              }}
            />
          </Field>
          <Field label="默认执行模型">
            <RouteSelect
              value={draft.leadProvider && draft.leadModel ? `${draft.leadProvider}\u0000${draft.leadModel}` : ''}
              options={models}
              onChange={(key) => {
                const route = routeFromKey(key);
                setDraft({ ...draft, leadProvider: route?.provider || null, leadModel: route?.model || null });
              }}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            权限预设：规划 {draft.planPermissionPreset}，执行 {draft.leadPermissionPreset}。无人值守规划会自动拒绝需要审批的操作。
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" size={14} />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

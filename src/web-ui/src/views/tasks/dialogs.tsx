/**
 * 看板对话框：新建任务、看板设置。
 * 团队模型限制用 coss 多选 Combobox：候选项按 provider 分组，已选列表逐项可移除，
 * 每个模型行右侧可单独指定思考强度（单选，默认跟随该模型）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, SearchIcon, XIcon } from 'lucide-react';
import { ModelAvatar } from '@/components/ModelAvatar';
import { Button } from '@/components/ui/button';
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { boardApi, type BoardMode, type BoardSettings, type BoardTask } from '@/lib/board';
import { usePanel } from '@/store';
import { Field, ModePicker, RouteSelect } from './fields';
import { errText, routeFromKey, type ModelEffort, type ModelOption } from './shared';

/** 已选团队模型 + 该项单独指定的思考强度（null = 跟随该模型默认）。 */
type TeamModelChoice = { key: string; reasoningEffort: string | null };

/** Combobox 分组渲染用的形状：基座把所有组的 items 拍平后过滤。 */
type ModelGroup = { group: string; items: ModelOption[] };

/** Select 用哨兵值表示「跟随默认」。 */
const EFFORT_DEFAULT = '\u0000__default__';

/** 新建任务表单需要跨会话记住的选项（标题/描述除外）。 */
type CreateDraft = {
  auto: boolean;
  mode: BoardMode;
  planKey: string;
  leadKey: string;
  limitTeams: boolean;
  teamModels: TeamModelChoice[];
};

const CREATE_DRAFT_KEY = 'dsh-panel:board-create-draft';

/** 兼容旧草稿里的 string[]（只存 key）与新结构。 */
function parseTeamChoices(value: unknown): TeamModelChoice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TeamModelChoice[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item) out.push({ key: item, reasoningEffort: null });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const entry = item as { key?: unknown; reasoningEffort?: unknown };
    if (typeof entry.key !== 'string' || !entry.key) continue;
    out.push({
      key: entry.key,
      reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : null,
    });
  }
  return out;
}

function loadCreateDraft(): Partial<CreateDraft> {
  try {
    const raw = localStorage.getItem(CREATE_DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<CreateDraft> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      auto: typeof parsed.auto === 'boolean' ? parsed.auto : undefined,
      mode: parsed.mode === 'same' || parsed.mode === 'new' ? parsed.mode : undefined,
      planKey: typeof parsed.planKey === 'string' ? parsed.planKey : undefined,
      leadKey: typeof parsed.leadKey === 'string' ? parsed.leadKey : undefined,
      limitTeams: typeof parsed.limitTeams === 'boolean' ? parsed.limitTeams : undefined,
      teamModels: parseTeamChoices(parsed.teamModels),
    };
  } catch {
    return {};
  }
}

function saveCreateDraft(draft: CreateDraft) {
  try {
    localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* 存储不可用时静默降级为不记忆 */
  }
}

/** 已选模型行右侧的思考强度单选；value 为 null 表示跟随该模型默认。 */
function EffortSelect({
  value,
  efforts,
  onChange,
  ariaLabel,
}: {
  value: string | null;
  efforts: ModelEffort[];
  onChange: (value: string | null) => void;
  ariaLabel: string;
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
        className="h-7 min-h-0 w-auto min-w-0 shrink-0 gap-1 px-2 text-xs"
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
  const [lastDraft] = useState(loadCreateDraft);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [auto, setAuto] = useState(lastDraft.auto ?? false);
  const [mode, setMode] = useState<BoardMode>(lastDraft.mode ?? 'same');
  const [planKey, setPlanKey] = useState(lastDraft.planKey ?? '');
  const [leadKey, setLeadKey] = useState(lastDraft.leadKey ?? '');
  const [limitTeams, setLimitTeams] = useState(lastDraft.limitTeams ?? false);
  const [teamModels, setTeamModels] = useState<TeamModelChoice[]>(lastDraft.teamModels ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setAuto(lastDraft.auto ?? false);
    setMode(lastDraft.mode ?? 'same');
    setPlanKey(lastDraft.planKey ?? '');
    setLeadKey(lastDraft.leadKey ?? '');
    setLimitTeams(lastDraft.limitTeams ?? false);
    setTeamModels(lastDraft.teamModels ?? []);
  }, [open, lastDraft]);

  const teamRows = teamModels.flatMap((choice) => {
    const option = models.find((m) => m.key === choice.key);
    return option ? [{ choice, option }] : [];
  });
  const teamModelOptions = teamRows.map((row) => row.option);

  const modelGroups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const option of models) {
      const list = map.get(option.group);
      if (list) list.push(option);
      else map.set(option.group, [option]);
    }
    return [...map.entries()].map(([group, items]) => ({ group, items }));
  }, [models]);

  const setEffort = (key: string, reasoningEffort: string | null) => {
    setTeamModels((prev) => prev.map((item) => (item.key === key ? { ...item, reasoningEffort } : item)));
  };

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
        teamModels: limitTeams
          ? teamModels.flatMap(({ key, reasoningEffort }) => {
              const route = routeFromKey(key);
              if (!route) return [];
              const option = models.find((m) => m.key === key);
              // 目录里已不再声明的强度不发出去，避免后端拒绝
              const effort =
                reasoningEffort && option?.efforts?.some((e) => e.id === reasoningEffort)
                  ? reasoningEffort
                  : null;
              return [{ ...route, reasoningEffort: effort }];
            })
          : null,
      });
      saveCreateDraft({ auto, mode, planKey, leadKey, limitTeams, teamModels });
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
            <div className="space-y-2">
              <Combobox<ModelOption, true, ModelGroup>
                autoHighlight
                isItemEqualToValue={(item, value) => item.key === value.key}
                itemToStringLabel={(m) => `${m.name || m.model} ${m.group}`}
                items={modelGroups}
                multiple
                onValueChange={(next) =>
                  setTeamModels((prev) => {
                    const efforts = new Map(prev.map((item) => [item.key, item.reasoningEffort]));
                    return next.map((option) => ({
                      key: option.key,
                      reasoningEffort: efforts.get(option.key) ?? null,
                    }));
                  })
                }
                value={teamModelOptions}
              >
                <ComboboxInput
                  aria-label="选择团队可用模型"
                  placeholder="搜索并添加模型…"
                  startAddon={<SearchIcon />}
                />
                <ComboboxPopup>
                  <ComboboxEmpty>{models.length === 0 ? '模型目录尚未加载。' : '没有匹配的模型。'}</ComboboxEmpty>
                  <ComboboxList>
                    {(group: ModelGroup) => (
                      <ComboboxGroup key={group.group} items={group.items}>
                        <ComboboxGroupLabel>{group.group}</ComboboxGroupLabel>
                        <ComboboxCollection>
                          {(option: ModelOption) => (
                            <ComboboxItem key={option.key} value={option}>
                              <span className="flex min-w-0 items-center gap-2">
                                <ModelAvatar model={option.model} name={option.name} provider={option.provider} size={16} />
                                <span className="truncate">{option.name || option.model}</span>
                                {option.efforts?.length ? (
                                  <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                                    {option.efforts.map((e) => e.name || e.id).join(' / ')}
                                  </span>
                                ) : null}
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxCollection>
                      </ComboboxGroup>
                    )}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
              {teamRows.length > 0 && (
                <ul className="divide-y rounded-lg border">
                  {teamRows.map(({ choice, option }) => {
                    const efforts = option.efforts ?? [];
                    return (
                      <li className="flex items-center gap-2 p-1 ps-2 sm:text-sm" key={option.key}>
                        <ModelAvatar model={option.model} name={option.name} provider={option.provider} size={16} />
                        <div className="min-w-0 flex-1 leading-tight">
                          <div className="truncate font-medium">{option.name || option.model}</div>
                          <div className="truncate text-[10px] text-muted-foreground">{option.group}</div>
                        </div>
                        {efforts.length > 0 && (
                          <EffortSelect
                            ariaLabel={`${option.name || option.model} 的思考强度`}
                            efforts={efforts}
                            onChange={(effort) => setEffort(option.key, effort)}
                            value={choice.reasoningEffort}
                          />
                        )}
                        <Button
                          aria-label={`移除 ${option.name || option.model}`}
                          onClick={() => setTeamModels((prev) => prev.filter((item) => item.key !== option.key))}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        >
                          <XIcon />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
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
        showTaskSessions: draft.showTaskSessions !== false,
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
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm">在工作区会话里显示任务会话</div>
              <p className="text-xs leading-5 text-muted-foreground">
                开启后，看板为任务创建的规划/执行会话会出现在 DSH 的工作区会话列表里；关闭则只在看板里可见。
              </p>
            </div>
            <Switch
              checked={draft.showTaskSessions !== false}
              onCheckedChange={(checked) => setDraft({ ...draft, showTaskSessions: checked })}
            />
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

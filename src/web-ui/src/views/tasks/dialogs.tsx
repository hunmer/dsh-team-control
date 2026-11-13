/**
 * 看板对话框：新建任务、编辑任务、看板设置。
 * 模型选择统一用 Combobox：候选按 provider 分组、带头像、单选，选定后可在右侧单独指定思考强度；
 * 团队模型白名单用多选 Combobox，已选列表逐项可移除并单独指定强度；不选 = 不限制。
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { BOARD_STATUS_LABEL, boardApi, type BoardMode, type BoardSettings, type BoardTask } from '@/lib/board';
import { usePanel } from '@/store';
import { EffortSelect, Field, ModePicker, RouteSelect } from './fields';
import { PromptEnhancerForm } from './PromptForm';
import { errText, routeFromKey, routeKey, type ModelOption } from './shared';

/** 已选团队模型 + 该项单独指定的思考强度（null = 跟随该模型默认）。 */
type TeamModelChoice = { key: string; reasoningEffort: string | null };

/** Combobox 分组渲染用的形状：基座把所有组的 items 拍平后过滤。 */
type ModelGroup = { group: string; items: ModelOption[] };

/** 新建任务表单需要跨会话记住的选项（标题/描述除外）。 */
type CreateDraft = {
  auto: boolean;
  needPlan: boolean;
  useTeam: boolean;
  prewalk: boolean;
  mode: BoardMode;
  /** 是否在任务开始前切到独立 git 分支（隔离改动，便于 review/回滚） */
  gitBranchOn: boolean;
  /** 分支名；留空 = 自动生成 task/<任务短号> */
  gitBranch: string;
  planKey: string;
  leadKey: string;
  planEffort: string | null;
  leadEffort: string | null;
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

/** 把任务上保存的团队模型（新结构 BoardRoute 或旧字符串）转成编辑表单的选项。 */
function taskTeamChoices(task: BoardTask): TeamModelChoice[] {
  const out: TeamModelChoice[] = [];
  for (const entry of task.teamModels ?? []) {
    if (typeof entry === 'string') {
      const choice = legacyChoice(entry);
      if (choice) out.push(choice);
      continue;
    }
    const key = routeKey(entry);
    if (key) out.push({ key, reasoningEffort: entry.reasoningEffort ?? null });
  }
  return out;
}

/** 旧数据可能存成 provider\u0000model、provider/model 或裸 model。 */
function legacyChoice(raw: string): TeamModelChoice | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('\u0000')) {
    return value.split('\u0000')[1] ? { key: value, reasoningEffort: null } : null;
  }
  const slash = value.indexOf('/');
  if (slash > 0) return { key: `${value.slice(0, slash)}\u0000${value.slice(slash + 1)}`, reasoningEffort: null };
  return { key: `\u0000${value}`, reasoningEffort: null };
}

/** 提交时把表单里的团队模型转成后端路由数组，丢掉目录里已不存在的强度。 */
function teamChoicesToRoutes(choices: TeamModelChoice[], models: ModelOption[]) {
  return choices.flatMap(({ key, reasoningEffort }) => {
    const route = routeFromKey(key);
    if (!route) return [];
    const option = models.find((m) => m.key === key);
    const effort = reasoningEffort && option?.efforts?.some((e) => e.id === reasoningEffort) ? reasoningEffort : null;
    return [{ ...route, reasoningEffort: effort }];
  });
}

/** 单个模型 + 强度：强度不在目录（或该模型不支持）时退化为跟随默认。 */
function routeWithEffort(key: string, effort: string | null, models: ModelOption[]) {
  const route = routeFromKey(key);
  if (!route) return null;
  const option = models.find((m) => m.key === key);
  const value = effort && option?.efforts?.some((e) => e.id === effort) ? effort : null;
  return { ...route, reasoningEffort: value };
}

function loadCreateDraft(): Partial<CreateDraft> {
  try {
    const raw = localStorage.getItem(CREATE_DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<CreateDraft> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      auto: typeof parsed.auto === 'boolean' ? parsed.auto : undefined,
      needPlan: typeof parsed.needPlan === 'boolean' ? parsed.needPlan : undefined,
      useTeam: typeof parsed.useTeam === 'boolean' ? parsed.useTeam : undefined,
      prewalk: typeof parsed.prewalk === 'boolean' ? parsed.prewalk : undefined,
      mode: parsed.mode === 'same' || parsed.mode === 'new' ? parsed.mode : undefined,
      gitBranchOn: typeof parsed.gitBranchOn === 'boolean' ? parsed.gitBranchOn : undefined,
      gitBranch: typeof parsed.gitBranch === 'string' ? parsed.gitBranch : undefined,
      planKey: typeof parsed.planKey === 'string' ? parsed.planKey : undefined,
      leadKey: typeof parsed.leadKey === 'string' ? parsed.leadKey : undefined,
      planEffort: typeof parsed.planEffort === 'string' ? parsed.planEffort : parsed.planEffort === null ? null : undefined,
      leadEffort: typeof parsed.leadEffort === 'string' ? parsed.leadEffort : parsed.leadEffort === null ? null : undefined,
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

/** 团队模型白名单：按分组搜索添加、已选行可单独选思考强度或移除；空 = 不限制。 */
function TeamModelPicker({
  models,
  choices,
  onChange,
}: {
  models: ModelOption[];
  choices: TeamModelChoice[];
  onChange: (next: TeamModelChoice[]) => void;
}) {
  const rows = choices.flatMap((choice) => {
    const option = models.find((m) => m.key === choice.key);
    return option ? [{ choice, option }] : [];
  });
  const selected = rows.map((row) => row.option);

  const modelGroups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const option of models) {
      const list = map.get(option.group);
      if (list) list.push(option);
      else map.set(option.group, [option]);
    }
    return [...map.entries()].map(([group, items]) => ({ group, items }));
  }, [models]);

  return (
    <div className="space-y-2">
      <Combobox<ModelOption, true, ModelGroup>
        autoHighlight
        isItemEqualToValue={(item, value) => item.key === value.key}
        itemToStringLabel={(m) => `${m.name || m.model} ${m.group}`}
        items={modelGroups}
        multiple
        onValueChange={(next) => {
          const efforts = new Map(choices.map((item) => [item.key, item.reasoningEffort]));
          onChange(next.map((option) => ({ key: option.key, reasoningEffort: efforts.get(option.key) ?? null })));
        }}
        value={selected}
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
      {rows.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {rows.map(({ choice, option }) => {
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
                    onChange={(reasoningEffort) =>
                      onChange(choices.map((item) => (item.key === option.key ? { ...item, reasoningEffort } : item)))
                    }
                    value={choice.reasoningEffort}
                  />
                )}
                <Button
                  aria-label={`移除 ${option.name || option.model}`}
                  onClick={() => onChange(choices.filter((item) => item.key !== option.key))}
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
  const [needPlan, setNeedPlan] = useState(lastDraft.needPlan ?? false);
  const [useTeam, setUseTeam] = useState(lastDraft.useTeam ?? true);
  const [prewalk, setPrewalk] = useState(lastDraft.prewalk ?? false);
  const [mode, setMode] = useState<BoardMode>(lastDraft.mode ?? 'same');
  const [gitBranchOn, setGitBranchOn] = useState(lastDraft.gitBranchOn ?? false);
  const [gitBranch, setGitBranch] = useState(lastDraft.gitBranch ?? '');
  const [planKey, setPlanKey] = useState(lastDraft.planKey ?? '');
  const [leadKey, setLeadKey] = useState(lastDraft.leadKey ?? '');
  const [planEffort, setPlanEffort] = useState<string | null>(lastDraft.planEffort ?? null);
  const [leadEffort, setLeadEffort] = useState<string | null>(lastDraft.leadEffort ?? null);
  const [teamModels, setTeamModels] = useState<TeamModelChoice[]>(lastDraft.teamModels ?? []);
  const [tab, setTab] = useState<'basic' | 'prompt'>('basic');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setAuto(lastDraft.auto ?? false);
    setNeedPlan(lastDraft.needPlan ?? false);
    setUseTeam(lastDraft.useTeam ?? true);
    setPrewalk(lastDraft.prewalk ?? false);
    setMode(lastDraft.mode ?? 'same');
    setGitBranchOn(lastDraft.gitBranchOn ?? false);
    setGitBranch(lastDraft.gitBranch ?? '');
    setPlanKey(lastDraft.planKey ?? '');
    setLeadKey(lastDraft.leadKey ?? '');
    setPlanEffort(lastDraft.planEffort ?? null);
    setLeadEffort(lastDraft.leadEffort ?? null);
    setTeamModels(lastDraft.teamModels ?? []);
    setTab('basic');
  }, [open, lastDraft]);

  const submit = async () => {
    if (!title.trim()) { toast('请填写任务标题', 'warn'); return; }
    setSaving(true);
    try {
      const task = await boardApi.create({
        workspaceId,
        workspacePath,
        title: title.trim(),
        description: description.trim(),
        auto,
        needPlan,
        useTeam,
        prewalk: needPlan && mode === 'same' ? prewalk : false,
        executionMode: mode,
        // 开关关掉 → null 不切分支；开着但留空 → '' 让后端自动生成 task/<任务短号>
        gitBranch: gitBranchOn ? gitBranch.trim() : null,
        planRoute: needPlan ? routeWithEffort(planKey, planEffort, models) : null,
        leadRoute: routeWithEffort(leadKey, leadEffort, models),
        teamModels: useTeam && teamModels.length ? teamChoicesToRoutes(teamModels, models) : null,
      });
      saveCreateDraft({ auto, needPlan, useTeam, prewalk, mode, gitBranchOn, gitBranch, planKey, leadKey, planEffort, leadEffort, teamModels });
      await onCreated(task);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Tabs
            className="gap-3"
            onValueChange={(next) => setTab(next === 'prompt' ? 'prompt' : 'basic')}
            value={tab}
          >
            <TabsList className="w-full">
              <TabsTab className="flex-1" value="basic">
                基础表单
              </TabsTab>
              <TabsTab className="flex-1" value="prompt">
                提示词增强
              </TabsTab>
            </TabsList>
            <TabsPanel className="space-y-3" value="basic">
              <Field label="标题">
                <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：给登录页加验证码" />
              </Field>
              <Field label="描述">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="目标、范围、验收标准…" />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">规划</span>
                <label className="ui-tb__check">
                  <Switch checked={needPlan} onCheckedChange={setNeedPlan} />
                  <span>需要规划</span>
                </label>
              </div>
              {needPlan && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="执行方式">
                    <ModePicker value={mode} onChange={setMode} />
                  </Field>
                  <Field label="规划模型">
                    <RouteSelect
                      value={planKey}
                      options={models}
                      effort={planEffort}
                      onEffortChange={setPlanEffort}
                      onChange={(key) => {
                        setPlanKey(key);
                        setPlanEffort(null);
                      }}
                      ariaLabel="规划模型"
                      placeholder={defaultSettings?.planModel ? `默认：${defaultSettings.planModel}` : '跟随默认'}
                    />
                  </Field>
                </div>
              )}
              {needPlan && mode === 'same' && (
                <label className="ui-tb__check">
                  <Switch checked={prewalk} onCheckedChange={setPrewalk} />
                  <span>Prewalk（实验性）：规划模型完成首次改动后，在同一会话切到执行模型继续</span>
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="自动入队">
                  <div className="flex h-9 items-center gap-2">
                    <Switch checked={auto} onCheckedChange={setAuto} />
                    <span className="text-xs text-muted-foreground">
                      {auto ? (needPlan ? '创建后自动规划' : '创建后自动执行') : '手动点开始执行'}
                    </span>
                  </div>
                </Field>
                <Field label="执行模型">
                  <RouteSelect
                    value={leadKey}
                    options={models}
                    effort={leadEffort}
                    onEffortChange={setLeadEffort}
                    onChange={(key) => {
                      setLeadKey(key);
                      setLeadEffort(null);
                    }}
                    ariaLabel="执行模型"
                    placeholder={defaultSettings?.leadModel ? `默认：${defaultSettings.leadModel}` : '跟随默认'}
                  />
                </Field>
              </div>
              <div className="space-y-2 rounded-md border px-3 py-2">
                <label className="ui-tb__check">
                  <Switch checked={gitBranchOn} onCheckedChange={setGitBranchOn} />
                  <span>开始前切到独立 git 分支（改动隔离，便于 review / 回滚）</span>
                </label>
                {gitBranchOn && (
                  <Field label="分支名">
                    <Input
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                      placeholder="留空自动生成 task/<任务短号>"
                      aria-label="git 分支名"
                      className="h-9"
                    />
                  </Field>
                )}
              </div>
              <label className="ui-tb__check">
                <Switch checked={useTeam} onCheckedChange={setUseTeam} />
                <span>开启团队（关闭 = 单个 Agent 独立完成）</span>
              </label>
              {useTeam && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">团队模型（不选 = 不限制）</p>
                  <TeamModelPicker models={models} choices={teamModels} onChange={setTeamModels} />
                </div>
              )}
            </TabsPanel>
            <TabsPanel className="pt-1" value="prompt">
              <PromptEnhancerForm value={description} onChange={setDescription} />
            </TabsPanel>
          </Tabs>
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

/** 编辑任务：只允许「待办」状态（已开始/已封存的任务字段冻结）。 */
export function EditTaskDialog({
  open,
  onOpenChange,
  task,
  models,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: BoardTask;
  models: ModelOption[];
  onSaved: () => void;
}) {
  const { toast } = usePanel();
  const editable = task.status === 'todo' && !task.archivedAt;
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [auto, setAuto] = useState(task.auto);
  const [needPlan, setNeedPlan] = useState(task.needPlan !== false);
  const [useTeam, setUseTeam] = useState(task.useTeam !== false);
  const [prewalk, setPrewalk] = useState(!!task.prewalk);
  const [mode, setMode] = useState<BoardMode>(task.executionMode);
  const [gitBranchOn, setGitBranchOn] = useState(!!task.gitBranch);
  const [gitBranch, setGitBranch] = useState(task.gitBranch ?? '');
  const [planKey, setPlanKey] = useState(routeKey(task.planRoute));
  const [leadKey, setLeadKey] = useState(routeKey(task.leadRoute));
  const [planEffort, setPlanEffort] = useState<string | null>(task.planRoute?.reasoningEffort ?? null);
  const [leadEffort, setLeadEffort] = useState<string | null>(task.leadRoute?.reasoningEffort ?? null);
  const [teamModels, setTeamModels] = useState<TeamModelChoice[]>(() => taskTeamChoices(task));
  const [tab, setTab] = useState<'basic' | 'prompt'>('basic');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setDescription(task.description || '');
    setAuto(task.auto);
    setNeedPlan(task.needPlan !== false);
    setUseTeam(task.useTeam !== false);
    setPrewalk(!!task.prewalk);
    setMode(task.executionMode);
    setGitBranchOn(!!task.gitBranch);
    setGitBranch(task.gitBranch ?? '');
    setPlanKey(routeKey(task.planRoute));
    setLeadKey(routeKey(task.leadRoute));
    setPlanEffort(task.planRoute?.reasoningEffort ?? null);
    setLeadEffort(task.leadRoute?.reasoningEffort ?? null);
    setTeamModels(taskTeamChoices(task));
    setTab('basic');
  }, [open, task.id]);

  const submit = async () => {
    if (!editable) { toast('任务已开始执行或已封存，不能修改', 'warn'); return; }
    if (!title.trim()) { toast('请填写任务标题', 'warn'); return; }
    setSaving(true);
    try {
      await boardApi.update(task.id, {
        title: title.trim(),
        description: description.trim(),
        auto,
        needPlan,
        useTeam,
        prewalk: needPlan && mode === 'same' ? prewalk : false,
        executionMode: mode,
        gitBranch: gitBranchOn ? gitBranch.trim() : null,
        planRoute: needPlan ? routeWithEffort(planKey, planEffort, models) : null,
        leadRoute: routeWithEffort(leadKey, leadEffort, models),
        teamModels: useTeam && teamModels.length ? teamChoicesToRoutes(teamModels, models) : null,
      });
      toast('任务已更新', 'ok');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑任务</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {!editable && (
            <p className="text-xs text-destructive">
              该任务当前为「{BOARD_STATUS_LABEL[task.status]}」{task.archivedAt ? '（已封存）' : ''}，字段已锁定，不能修改。
            </p>
          )}
          <Tabs
            className="gap-3"
            onValueChange={(next) => setTab(next === 'prompt' ? 'prompt' : 'basic')}
            value={tab}
          >
            <TabsList className="w-full">
              <TabsTab className="flex-1" value="basic">
                基础表单
              </TabsTab>
              <TabsTab className="flex-1" value="prompt">
                提示词增强
              </TabsTab>
            </TabsList>
            <TabsPanel className="space-y-3" value="basic">
              <Field label="标题">
                <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} />
              </Field>
              <Field label="描述">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} disabled={!editable} />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">规划</span>
                <label className="ui-tb__check">
                  <Switch checked={needPlan} onCheckedChange={setNeedPlan} disabled={!editable} />
                  <span>需要规划</span>
                </label>
              </div>
              {needPlan && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="执行方式">
                    <ModePicker value={mode} onChange={setMode} />
                  </Field>
                  <Field label="规划模型">
                    <RouteSelect
                      value={planKey}
                      options={models}
                      effort={planEffort}
                      onEffortChange={setPlanEffort}
                      onChange={(key) => {
                        setPlanKey(key);
                        setPlanEffort(null);
                      }}
                      ariaLabel="规划模型"
                    />
                  </Field>
                </div>
              )}
              {needPlan && mode === 'same' && (
                <label className="ui-tb__check">
                  <Switch checked={prewalk} onCheckedChange={setPrewalk} disabled={!editable} />
                  <span>Prewalk（实验性）：规划模型完成首次改动后，在同一会话切到执行模型继续</span>
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="自动入队">
                  <div className="flex h-9 items-center gap-2">
                    <Switch checked={auto} onCheckedChange={setAuto} disabled={!editable} />
                    <span className="text-xs text-muted-foreground">
                      {auto ? (needPlan ? '创建后自动规划' : '创建后自动执行') : '手动点开始执行'}
                    </span>
                  </div>
                </Field>
                <Field label="执行模型">
                  <RouteSelect
                    value={leadKey}
                    options={models}
                    effort={leadEffort}
                    onEffortChange={setLeadEffort}
                    onChange={(key) => {
                      setLeadKey(key);
                      setLeadEffort(null);
                    }}
                    ariaLabel="执行模型"
                  />
                </Field>
              </div>
              <div className="space-y-2 rounded-md border px-3 py-2">
                <label className="ui-tb__check">
                  <Switch checked={gitBranchOn} onCheckedChange={setGitBranchOn} disabled={!editable} />
                  <span>开始前切到独立 git 分支（改动隔离，便于 review / 回滚）</span>
                </label>
                {gitBranchOn && (
                  <Field label="分支名">
                    <Input
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                      placeholder="留空自动生成 task/<任务短号>"
                      aria-label="git 分支名"
                      disabled={!editable}
                      className="h-9"
                    />
                  </Field>
                )}
              </div>
              <label className="ui-tb__check">
                <Switch checked={useTeam} onCheckedChange={setUseTeam} disabled={!editable} />
                <span>开启团队（关闭 = 单个 Agent 独立完成）</span>
              </label>
              {useTeam && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">团队模型（不选 = 不限制）</p>
                  <TeamModelPicker models={models} choices={teamModels} onChange={setTeamModels} />
                </div>
              )}
            </TabsPanel>
            <TabsPanel className="pt-1" value="prompt">
              <PromptEnhancerForm disabled={!editable} value={description} onChange={setDescription} />
            </TabsPanel>
          </Tabs>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={() => void submit()} disabled={saving || !editable}>
            {saving && <Loader2 className="animate-spin" size={14} />}
            保存修改
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

  // 规划与执行共用同一个「并行上限」；历史数据两者不一致时取较大值，避免静默降低容量。
  const parallelLimit = Math.max(
    Number(draft.planningConcurrency) || 1,
    Number(draft.inprogressConcurrency) || 1,
  );

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
            <Field label="并行上限">
              <Input
                type="number"
                min={1}
                max={10}
                value={parallelLimit}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setDraft({ ...draft, planningConcurrency: next, inprogressConcurrency: next });
                }}
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

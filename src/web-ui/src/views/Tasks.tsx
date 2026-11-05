/**
 * 工作区任务看板（M3）。
 *
 * 视觉沿用 affectUI TaskBoard，数据来自 sidecar `/api/board`。
 * 三列：Waiting = todo/planned/failed，Progress = planning/inprogress，Done = done。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleAlert,
  CircleStop,
  ExternalLink,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import {
  BOARD_STATUS_LABEL,
  boardApi,
  type BoardData,
  type BoardMode,
  type BoardRoute,
  type BoardSettings,
  type BoardStatus,
  type BoardTask,
} from '@/lib/board';
import { OTHER_WORKSPACE_ID, usePanel } from '@/store';
import { cn } from '@/lib/utils';
import { TASK_BOARD_CSS } from './board-css';
import { StatusIcon, type BoardStatusKind } from './board-status-icon';
import './board-extra.css';

interface ModelOption {
  key: string;
  provider: string;
  model: string;
  name: string;
  group: string;
}

interface ModelsResponse {
  providers: Array<{
    id: string;
    name: string;
    models: Array<{ provider: string; model: string; name: string; enabled?: boolean }>;
  }>;
}

const STATUS_ICON: Record<BoardStatus, BoardStatusKind> = {
  todo: 'todo',
  planning: 'progress',
  planned: 'review',
  inprogress: 'progress',
  done: 'done',
  failed: 'canceled',
};

const COLUMNS: Array<{ id: string; label: string; statuses: BoardStatus[]; icon: BoardStatusKind }> = [
  { id: 'waiting', label: 'Waiting', statuses: ['todo', 'planned', 'failed'], icon: 'backlog' },
  { id: 'progress', label: 'Progress', statuses: ['planning', 'inprogress'], icon: 'progress' },
  { id: 'done', label: 'Done', statuses: ['done'], icon: 'done' },
];

const STATUS_ORDER: Record<string, number> = { todo: 0, planned: 1, failed: 2, planning: 0, inprogress: 1, done: 0 };

function routeKey(route?: BoardRoute | null): string {
  if (!route?.model) return '';
  return `${route.provider || ''}\u0000${route.model}`;
}

function routeFromKey(key: string): BoardRoute | null {
  if (!key) return null;
  const [provider, model] = key.split('\u0000');
  return { provider: provider || null, model: model || null, reasoningEffort: null };
}

function routeLabel(route?: BoardRoute | null): string {
  if (!route?.model) return '跟随默认';
  return `${route.provider ? `${route.provider}/` : ''}${route.model}`;
}

function shortModel(route?: BoardRoute | null): string {
  return route?.model || '默认';
}

function fmtTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function taskKey(task: BoardTask): string {
  return `BT-${task.id.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase()}`;
}

type OpenTeamResult = 'sidebar' | 'window';

/**
 * 打开某团队的编排界面：嵌在 DSH 里交给宿主切侧栏；独立页面（非 DSH 环境）没有宿主，
 * 直接在同一个面板地址上用新窗口打开该团队。
 */
function openTeamPanel(teamId: string): OpenTeamResult | null {
  if (typeof window === 'undefined') return null;
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'dsh-team:open-team', teamId }, window.location.origin);
    return 'sidebar';
  }
  const url = new URL(window.location.href);
  // ?team= 的优先级高于 hash，必须去掉，否则新窗口会被旧参数锁回上一个团队
  url.searchParams.delete('team');
  url.hash = `#/t/${encodeURIComponent(teamId)}`;
  return window.open(url.toString(), '_blank') ? 'window' : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="ui-tb__label">{label}</span>
      {children}
    </label>
  );
}

function RouteSelect({
  value,
  options,
  onChange,
  placeholder = '跟随工作区默认',
}: {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <select className="ui-tb__field" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((m) => (
        <option key={m.key} value={m.key}>
          {m.group} / {m.name || m.model}
        </option>
      ))}
    </select>
  );
}

function ModePicker({ value, onChange }: { value: BoardMode; onChange: (mode: BoardMode) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {([
        ['same', '同一会话'],
        ['new', '新会话'],
      ] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={cn(
            'rounded-md px-2 py-1.5 text-xs transition',
            value === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function TasksView({ workspaceId: workspaceIdProp, standalone = false }: {
  workspaceId?: string | null;
  standalone?: boolean;
} = {}) {
  const { state, toast } = usePanel();
  const workspaceId = workspaceIdProp === undefined ? state.workspaceId : workspaceIdProp;
  const usable = !!workspaceId && workspaceId !== OTHER_WORKSPACE_ID;

  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [compact, setCompact] = useState(false);
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [dragTask, setDragTask] = useState<BoardTask | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!usable || !workspaceId) {
      setData(null);
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const next = await boardApi.list(workspaceId, archived);
      setData(next);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [usable, workspaceId, archived]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!usable) return;
    const timer = setInterval(() => { void load(true); }, 2500);
    return () => clearInterval(timer);
  }, [usable, load]);

  useEffect(() => {
    if (!usable) return;
    let alive = true;
    void api<ModelsResponse>('/api/llm/catalog')
      .then((res) => {
        if (!alive) return;
        const flat: ModelOption[] = [];
        for (const group of res.providers || []) {
          for (const m of group.models || []) {
            if (m.enabled === false) continue;
            flat.push({
              key: `${m.provider}\u0000${m.model}`,
              provider: m.provider,
              model: m.model,
              name: m.name || m.model,
              group: group.name || group.id,
            });
          }
        }
        setModels(flat);
      })
      .catch(() => { /* 模型目录不可用时只显示“跟随默认” */ });
    return () => { alive = false; };
  }, [usable]);

  const selected = useMemo(
    () => data?.tasks.find((task) => task.id === selectedId) || null,
    [data, selectedId],
  );

  useEffect(() => {
    if (selectedId && !selected && !loading) setSelectedId(null);
  }, [selected, selectedId, loading]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.tasks || []).filter((task) => {
      if (!q) return true;
      return `${task.title} ${task.description} ${task.id} ${task.status}`.toLowerCase().includes(q);
    });
    return [...list].sort((a, b) => {
      const byStatus = (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0);
      if (byStatus) return byStatus;
      return (a.priority || 0) - (b.priority || 0);
    });
  }, [data, query]);

  const columns = archived
    ? [{ id: 'archived', label: '已封存', statuses: [] as BoardStatus[], icon: 'backlog' as BoardStatusKind }]
    : COLUMNS;

  const run = useCallback(async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      await fn();
      toast(ok, 'ok');
      await load(true);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy('');
    }
  }, [load, toast]);

  const start = (task: BoardTask, mode: BoardMode) => {
    void run(`${task.id}:start`, () => boardApi.start(task.id, mode), mode === 'same' ? '已进入调度队列' : '已加入队列（新会话执行）');
  };

  const stop = (task: BoardTask) => {
    void run(`${task.id}:stop`, () => boardApi.stop(task.id), '已请求停止');
  };

  const retry = (task: BoardTask) => {
    void run(`${task.id}:retry`, () => boardApi.retry(task.id), '已重试');
  };

  const archive = (task: BoardTask) => {
    void run(`${task.id}:archive`, () => boardApi.archive(task.id), '已封存');
  };

  const restore = (task: BoardTask) => {
    void run(`${task.id}:restore`, () => boardApi.restore(task.id), '已恢复');
  };

  const toggleAuto = (task: BoardTask) => {
    void run(`${task.id}:auto`, () => boardApi.update(task.id, { auto: !task.auto }), task.auto ? '已关闭自动入队' : '已开启自动入队');
  };

  const onDropColumn = (columnId: string) => {
    const task = dragTask;
    setDragTask(null);
    if (!task || archived || loading) return;
    if (columnId === 'progress') {
      if (task.status === 'todo' || task.status === 'planned') start(task, 'same');
      else if (task.status === 'failed') retry(task);
      return;
    }
    if (columnId === 'done' && (task.status === 'planned' || task.status === 'inprogress')) {
      void run(`${task.id}:done`, () => boardApi.status(task.id, 'done', '由看板手动标记完成'), '已标记完成');
    }
    if (columnId === 'waiting' && (task.status === 'planning' || task.status === 'inprogress')) stop(task);
  };

  if (!usable) {
    return (
      <section className={cn('ui-tb', standalone && 'ui-tb--standalone')}>
        <style href="ui-task-board" precedence="default">{TASK_BOARD_CSS}</style>
        <div className="ui-tb__empty-card">请选择一个工作区后查看任务看板。</div>
      </section>
    );
  }

  return (
    <section className={cn('ui-tb', standalone && 'ui-tb--standalone')}>
      <style href="ui-task-board" precedence="default">{TASK_BOARD_CSS}</style>

      <header className="ui-tb__top">
        <nav className="ui-tb__crumbs" aria-label="面包屑">
          <span className="ui-tb__logo" aria-hidden="true">DS</span>
          <span className="ui-tb__crumb">{data?.workspace.title || '工作区'}</span>
          <ChevronRight className="ui-tb__crumb-sep" size={13} strokeWidth={1.6} />
          <span className="ui-tb__crumb">{archived ? '封存箱' : '任务看板'}</span>
        </nav>
        <div className="ui-tb__top-actions">
          <Tooltip>
            <TooltipTrigger
              type="button"
              className="ui-tb__ghost-btn"
              aria-label={archived ? '返回任务看板' : '查看封存任务'}
              onClick={() => { setArchived((v) => !v); setSelectedId(null); }}
            >
              {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </TooltipTrigger>
            <TooltipPopup>{archived ? '返回任务看板' : '查看封存任务'}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              type="button"
              className="ui-tb__ghost-btn"
              aria-label="看板设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={14} />
            </TooltipTrigger>
            <TooltipPopup>看板设置</TooltipPopup>
          </Tooltip>
          {!archived && (
            <Tooltip>
              <TooltipTrigger
                type="button"
                className="ui-tb__new-btn"
                aria-label="新建任务"
                onClick={() => setCreating(true)}
              >
                <Plus size={14} />
              </TooltipTrigger>
              <TooltipPopup>新建任务</TooltipPopup>
            </Tooltip>
          )}
        </div>
      </header>

      <div className="ui-tb__bar">
        <span className="ui-tb__count">
          {archived ? `${filtered.length} 个封存任务` : `${filtered.length} 个任务`}
          <span className="ui-tb__slots">
            {data ? ` · Planning ${data.slots.planning.used}/${data.slots.planning.limit} · Progress ${data.slots.inprogress.used}/${data.slots.inprogress.limit}` : ''}
          </span>
        </span>
        <div className="ui-tb__tools">
          <label className="ui-tb__search">
            <Search size={13} strokeWidth={1.7} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务…" />
          </label>
          <button
            type="button"
            className="ui-tb__menu"
            data-on={compact ? 'true' : 'false'}
            onClick={() => setCompact((v) => !v)}
            title="紧凑模式"
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      {error && <p className="ui-tb__error" style={{ padding: '0 18px' }}>{error}</p>}

      {loading && !data ? (
        <div className="ui-tb__empty-card"><Loader2 className="animate-spin" size={18} /> 正在加载看板…</div>
      ) : (
        <div className={cn('ui-tb__columns', compact && 'is-compact')}>
          {columns.map((column) => {
            const items = archived
              ? filtered
              : filtered.filter((task) => column.statuses.includes(task.status));
            return (
              <div
                key={column.id}
                className="ui-tb__column"
                data-column={column.id}
                onDragOver={(e) => { if (!archived) e.preventDefault(); }}
                onDrop={() => onDropColumn(column.id)}
              >
                <div className="ui-tb__col-head">
                  <span className="ui-tb__status"><StatusIcon kind={column.icon} /></span>
                  <span className={cn('ui-tb__col-title', compact && 'is-compact')}>{column.label}</span>
                  <span className="ui-tb__col-count">{items.length}</span>
                  {column.id === 'waiting' && !archived && (
                    <span className="ui-tb__col-hint">待办 / 已规划 / 失败</span>
                  )}
                  {column.id === 'progress' && !archived && (
                    <span className="ui-tb__col-hint">规划中 / 执行中</span>
                  )}
                </div>
                <div className="ui-tb__cards">
                  {items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      compact={compact}
                      archived={archived}
                      busy={busy}
                      onOpen={() => setSelectedId(task.id)}
                      onStart={(mode) => start(task, mode)}
                      onStop={() => stop(task)}
                      onRetry={() => retry(task)}
                      onRestore={() => restore(task)}
                      onToggleAuto={() => toggleAuto(task)}
                      onDragStart={() => setDragTask(task)}
                      onDragEnd={() => setDragTask(null)}
                    />
                  ))}
                  {items.length === 0 && (
                    <div className="ui-tb__empty">
                      {archived ? '没有封存任务' : column.id === 'waiting' ? '没有待办任务' : '暂无任务'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <TaskPanel
          task={selected}
          models={models}
          busy={busy}
          onClose={() => setSelectedId(null)}
          onStart={start}
          onStop={stop}
          onRetry={retry}
          onArchive={archive}
          onRestore={restore}
          onToggleAuto={() => toggleAuto(selected)}
          onSaved={() => void load(true)}
          onError={(message) => toast(message, 'error')}
          onOk={(message) => toast(message, 'ok')}
        />
      )}

      <CreateTaskDialog
        open={creating}
        onOpenChange={setCreating}
        workspaceId={workspaceId!}
        workspacePath={data?.workspace.path || ''}
        models={models}
        defaultSettings={data?.settings || null}
        onCreated={async (task) => {
          setCreating(false);
          await load(true);
          setSelectedId(task.id);
          toast('任务已创建', 'ok');
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        workspaceId={workspaceId!}
        settings={data?.settings || null}
        models={models}
        onSaved={async () => { setSettingsOpen(false); await load(true); toast('看板设置已保存', 'ok'); }}
      />

    </section>
  );
}

function TaskCard({
  task,
  compact,
  archived,
  busy,
  onOpen,
  onStart,
  onStop,
  onRetry,
  onRestore,
  onToggleAuto,
  onDragStart,
  onDragEnd,
}: {
  task: BoardTask;
  compact: boolean;
  archived: boolean;
  busy: string;
  onOpen: () => void;
  onStart: (mode: BoardMode) => void;
  onStop: () => void;
  onRetry: () => void;
  onRestore: () => void;
  onToggleAuto: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const active = task.status === 'planning' || task.status === 'inprogress';
  const startable = task.status === 'todo' || task.status === 'planned';
  const isBusy = busy.startsWith(`${task.id}:`);

  return (
    <article
      className={cn('ui-tb__card', compact && 'is-compact')}
      draggable={!archived}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
    >
      <div className="ui-tb__card-top">
        <div className="ui-tb__card-top-left">
          <span className="ui-tb__status-dot" data-status={task.status} title={BOARD_STATUS_LABEL[task.status]} />
          <span className="ui-tb__key">{taskKey(task)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="ui-tb__auto"
            onClick={(e) => { e.stopPropagation(); onToggleAuto(); }}
            title={task.auto ? '关闭自动入队' : '开启自动入队'}
          >
            {task.auto ? 'auto 开' : 'auto 关'}
          </button>
          {!!task.teams?.length && (
            <span className="ui-tb__count-badge" title={`${task.teams.length} 个团队`}>
              <Users size={11} /> {task.teams.length}
            </span>
          )}
        </div>
      </div>

      <div className="ui-tb__card-main">
        <p className="ui-tb__card-title">
          <StatusIcon kind={STATUS_ICON[task.status]} />
          <span className="ui-tb__title-text">{task.title}</span>
        </p>

        {!compact && task.description && (
          <p className="line-clamp-2 text-[11.5px] leading-4 text-muted-foreground">{task.description}</p>
        )}

        <div className="ui-tb__props">
          <span className="ui-tb__prop" title="执行模型">
            <span className="ui-tb__prop-text">{shortModel(task.leadRoute)}</span>
          </span>
          {task.planSummary && <span className="ui-tb__prop ui-tb__prop--wide" title={task.planSummary}><span className="ui-tb__prop-text">{task.planSummary}</span></span>}
        </div>

        {task.lastError && (
          <Alert variant="error" className="mt-2 rounded-lg px-2.5 py-2 text-[11.5px] [&>svg]:size-3.5">
            <CircleAlert />
            <AlertDescription className="line-clamp-2 leading-4">{task.lastError}</AlertDescription>
          </Alert>
        )}
      </div>

      {!compact && (
      <div className="ui-tb__card-foot">
        <div className="ui-tb__actions" onClick={(e) => e.stopPropagation()}>
          {archived ? (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" aria-label="恢复" disabled={isBusy} onClick={onRestore}>
                <ArchiveRestore size={12} />
              </TooltipTrigger>
              <TooltipPopup>恢复</TooltipPopup>
            </Tooltip>
          ) : startable ? (
            <>
              <Tooltip>
                <TooltipTrigger type="button" className="ui-tb__act" data-primary aria-label="开始执行" disabled={isBusy} onClick={() => onStart('same')}>
                  <Play size={12} />
                </TooltipTrigger>
                <TooltipPopup>开始执行</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger type="button" className="ui-tb__act" aria-label="新会话执行" disabled={isBusy} onClick={() => onStart('new')}>
                  <ExternalLink size={12} />
                </TooltipTrigger>
                <TooltipPopup>新会话执行</TooltipPopup>
              </Tooltip>
            </>
          ) : active ? (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" aria-label="停止" disabled={isBusy} onClick={onStop}>
                <CircleStop size={12} />
              </TooltipTrigger>
              <TooltipPopup>停止</TooltipPopup>
            </Tooltip>
          ) : task.status === 'failed' ? (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" data-primary aria-label="重试" disabled={isBusy} onClick={onRetry}>
                <RotateCcw size={12} />
              </TooltipTrigger>
              <TooltipPopup>重试</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <p className="ui-tb__meta">更新于 {fmtTime(task.updatedAt)}</p>
      </div>
      )}
    </article>
  );
}

function TaskPanel({
  task,
  models,
  busy,
  onClose,
  onStart,
  onStop,
  onRetry,
  onArchive,
  onRestore,
  onToggleAuto,
  onSaved,
  onError,
  onOk,
}: {
  task: BoardTask;
  models: ModelOption[];
  busy: string;
  onClose: () => void;
  onStart: (task: BoardTask, mode: BoardMode) => void;
  onStop: (task: BoardTask) => void;
  onRetry: (task: BoardTask) => void;
  onArchive: (task: BoardTask) => void;
  onRestore: (task: BoardTask) => void;
  onToggleAuto: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
  onOk: (message: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description || '');
  }, [task.id]);

  const save = async (patch: { title?: string; description?: string }) => {
    setSaving(true);
    try {
      await boardApi.update(task.id, patch);
      onSaved();
    } catch (err) {
      onError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const commitTitle = () => {
    const value = title.trim();
    if (!value || value === task.title) { setTitle(task.title); return; }
    void save({ title: value }).then(() => onOk('标题已更新'));
  };

  const commitDescription = () => {
    if (description === (task.description || '')) return;
    void save({ description }).then(() => onOk('描述已更新'));
  };

  const startable = task.status === 'todo' || task.status === 'planned';
  const active = task.status === 'planning' || task.status === 'inprogress';
  const terminal = task.status === 'done' || task.status === 'failed';
  const isBusy = busy.startsWith(`${task.id}:`);

  return (
    <>
      <div className="ui-tb__scrim" data-open="true" onClick={onClose} />
      <aside className="ui-tb__panel" data-open="true" aria-label="任务详情">
        <div className="ui-tb__panel-head">
          <span className="ui-tb__key">{taskKey(task)}</span>
          <button type="button" className="ui-tb__panel-close" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <input
          className="ui-tb__title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="ui-tb__state ui-tb__prop" data-status={task.status}>
            <StatusIcon kind={STATUS_ICON[task.status]} />
            {BOARD_STATUS_LABEL[task.status]}
          </span>
          <span className="ui-tb__meta">更新 {fmtTime(task.updatedAt)}</span>
          {saving && <Loader2 className="animate-spin text-muted-foreground" size={13} />}
        </div>

        {task.lastError && <p className="ui-tb__error">{task.lastError}</p>}

        <div className="ui-tb__panel-actions">
          {startable && (
            <>
              <Tooltip>
                <TooltipTrigger type="button" className="ui-tb__act" data-primary aria-label="开始执行" disabled={isBusy} onClick={() => onStart(task, 'same')}>
                  <Play size={12} />
                </TooltipTrigger>
                <TooltipPopup>开始执行</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger type="button" className="ui-tb__act" aria-label="新的会话执行" disabled={isBusy} onClick={() => onStart(task, 'new')}>
                  <ExternalLink size={12} />
                </TooltipTrigger>
                <TooltipPopup>新的会话执行</TooltipPopup>
              </Tooltip>
            </>
          )}
          {active && (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" aria-label="停止" disabled={isBusy} onClick={() => onStop(task)}>
                <CircleStop size={12} />
              </TooltipTrigger>
              <TooltipPopup>停止</TooltipPopup>
            </Tooltip>
          )}
          {task.status === 'failed' && (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" data-primary aria-label="重试" disabled={isBusy} onClick={() => onRetry(task)}>
                <RotateCcw size={12} />
              </TooltipTrigger>
              <TooltipPopup>重试</TooltipPopup>
            </Tooltip>
          )}
          {task.archivedAt ? (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" aria-label="恢复" disabled={isBusy} onClick={() => onRestore(task)}>
                <ArchiveRestore size={12} />
              </TooltipTrigger>
              <TooltipPopup>恢复</TooltipPopup>
            </Tooltip>
          ) : terminal ? (
            <Tooltip>
              <TooltipTrigger type="button" className="ui-tb__act" aria-label="封存" disabled={isBusy} onClick={() => onArchive(task)}>
                <Archive size={12} />
              </TooltipTrigger>
              <TooltipPopup>封存</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>

        <div className="ui-tb__fields">
          <div className="ui-tb__field-row">
            <span className="ui-tb__label">执行方式</span>
            <ModePicker
              value={task.executionMode}
              onChange={(mode) => {
                void boardApi.update(task.id, { executionMode: mode })
                  .then(() => { onSaved(); onOk('执行方式已更新'); })
                  .catch((err) => onError(errText(err)));
              }}
            />
          </div>

          <label className="ui-tb__check">
            <Switch checked={task.auto} onCheckedChange={onToggleAuto} />
            <span>自动入队（auto）</span>
          </label>

          <Field label="规划模型">
            <RouteSelect
              value={routeKey(task.planRoute)}
              options={models}
              onChange={(key) => {
                void boardApi.update(task.id, { planRoute: routeFromKey(key) })
                  .then(() => { onSaved(); onOk('规划模型已更新'); })
                  .catch((err) => onError(errText(err)));
              }}
            />
          </Field>

          <Field label="执行模型">
            <RouteSelect
              value={routeKey(task.leadRoute)}
              options={models}
              onChange={(key) => {
                void boardApi.update(task.id, { leadRoute: routeFromKey(key) })
                  .then(() => { onSaved(); onOk('执行模型已更新'); })
                  .catch((err) => onError(errText(err)));
              }}
            />
          </Field>

          <div>
            <span className="ui-tb__label">团队模型</span>
            <p className="text-xs text-muted-foreground">
              {task.teamModels?.length
                ? task.teamModels.map((m) => (typeof m === 'string' ? m : `${m.provider ? `${m.provider}/` : ''}${m.model}`)).join('、')
                : '不限制'}
            </p>
          </div>

          <div>
            <span className="ui-tb__label">关联团队</span>
            {task.teams?.length ? (
              <div className="ui-tb__teams">
                {task.teams.map((teamId) => (
                  <button
                    key={teamId}
                    type="button"
                    className="ui-tb__team-link"
                    title="打开该团队的编排界面"
                    onClick={() => {
                      const opened = openTeamPanel(teamId);
                      if (!opened) {
                        onError('打开编排失败，请检查浏览器是否拦截了弹窗');
                        return;
                      }
                      onOk(opened === 'sidebar' ? '已在侧栏打开编排' : '已在新窗口打开编排');
                    }}
                  >
                    <Users size={12} />
                    <span>{teamId}</span>
                    <span className="ui-tb__team-link-hint">打开编排</span>
                    <ExternalLink size={11} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                尚未关联团队；执行阶段调用 team_create 后会自动绑定。
              </p>
            )}
          </div>

          <Field label="任务描述">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              className="ui-tb__field ui-tb__field--area ui-tb__field--desc"
              rows={5}
            />
          </Field>

          {task.planSummary && (
            <div>
              <span className="ui-tb__label">计划摘要</span>
              <p className="text-xs leading-5">{task.planSummary}</p>
            </div>
          )}

          {task.planMd && (
            <>
              <div className="ui-tb__plan-head">
                <span>规划内容</span>
                <span>{task.planMd.length} 字</span>
              </div>
              <div className="ui-tb__plan">
                <Markdown text={task.planMd} />
              </div>
            </>
          )}

          <div className="ui-tb__meta space-y-1 pt-2">
            <div>创建：{fmtTime(task.createdAt)}</div>
            <div>完成：{fmtTime(task.doneAt)}</div>
            <div>规划会话：{task.planningSessionId || '—'}</div>
            <div>执行会话：{task.leadSessionId || '—'}</div>
          </div>
        </div>

        <div className="ui-tb__panel-foot">
          <div className="ui-tb__panel-actions">
            {(task.status === 'planned' || task.status === 'inprogress') && (
              <button
                type="button"
                className="ui-tb__act"
                disabled={isBusy}
                onClick={() => {
                  void boardApi.status(task.id, 'done', '由看板手动标记完成')
                    .then(() => { onSaved(); onOk('已标记完成'); })
                    .catch((err) => onError(errText(err)));
                }}
              >
                标记完成
              </button>
            )}
            {(task.status === 'planning' || task.status === 'planned' || task.status === 'inprogress') && (
              <button
                type="button"
                className="ui-tb__act ui-tb__danger"
                disabled={isBusy}
                onClick={() => {
                  void boardApi.status(task.id, 'failed', '由看板手动标记失败')
                    .then(() => { onSaved(); onOk('已标记失败'); })
                    .catch((err) => onError(errText(err)));
                }}
              >
                标记失败
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function CreateTaskDialog({
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

function SettingsDialog({
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


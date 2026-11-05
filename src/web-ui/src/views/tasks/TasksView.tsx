/**
 * 工作区任务看板主视图（M3）：数据加载、三列/封存渲染、拖拽调度、子组件编排。
 *
 * 视觉沿用 affectUI TaskBoard，数据来自 sidecar `/api/board`。
 * 三列：Waiting = todo/planned/failed，Progress = planning/inprogress，Done = done。
 * 拆分自 Tasks.tsx，行为不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Archive, ArchiveRestore, ClipboardList, Loader2, Plus, Search, Settings2, SlidersHorizontal } from 'lucide-react';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import {
  boardApi,
  type BoardData,
  type BoardMode,
  type BoardStatus,
  type BoardTask,
} from '@/lib/board';
import { OTHER_WORKSPACE_ID, usePanel } from '@/store';
import { cn } from '@/lib/utils';
import { TASK_BOARD_CSS } from '../board-css';
import { StatusIcon, type BoardStatusKind } from '../board-status-icon';
import '../board-extra.css';
import { CreateTaskDialog, SettingsDialog } from './dialogs';
import { TaskCard } from './TaskCard';
import { TaskPanel } from './TaskPanel';
import { TaskProgress } from './TaskProgress';
import { COLUMNS, STATUS_ORDER, errText, type ModelOption, type ModelsResponse } from './shared';

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
  const rootRef = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const scrollToDetail = useRef(false);
  /** 容器宽度不够时改成上下排（与 board-page.css 的 1300px 断点保持一致） */
  const [stacked, setStacked] = useState(false);

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
            const allowed = m.allowedEfforts ?? null;
            const efforts = (m.efforts ?? [])
              .filter((e) => allowed === null || allowed.includes(e.id))
              .map((e) => ({ id: e.id, name: e.name ?? null }));
            flat.push({
              key: `${m.provider}\u0000${m.model}`,
              provider: m.provider,
              model: m.model,
              name: m.name || m.model,
              group: group.name || group.id,
              efforts: efforts.length ? efforts : null,
              defaultEffort: m.defaultEffort ?? null,
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

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setStacked(width < 1300);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [usable]);

  const revealDetail = useCallback(() => {
    const el = detailRef.current;
    if (!el) return;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);

  /** 选中任务；窄屏（上下排）时把详情容器滚进视野。 */
  const selectTask = useCallback((id: string) => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (id === selectedId) {
      if (stacked) revealDetail();
      return;
    }
    scrollToDetail.current = stacked;
    setSelectedId(id);
  }, [selectedId, stacked, revealDetail]);

  useEffect(() => {
    if (!scrollToDetail.current || !selectedId) return;
    scrollToDetail.current = false;
    revealDetail();
  }, [selectedId, revealDetail]);

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

  const remove = (task: BoardTask) => {
    if (selectedId === task.id) setSelectedId(null);
    void run(`${task.id}:delete`, () => boardApi.remove(task.id), '任务已删除');
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
    <section ref={rootRef} className={cn('ui-tb', standalone && 'ui-tb--standalone')}>
      <style href="ui-task-board" precedence="default">{TASK_BOARD_CSS}</style>

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
      </div>

      {error && <p className="ui-tb__error" style={{ padding: '0 18px' }}>{error}</p>}

      <div className="ui-tb__body">
        <div className="ui-tb__board">
      {loading && !data ? (
        <div className="ui-tb__empty-card"><Loader2 className="animate-spin" size={18} /> 正在加载看板…</div>
      ) : (
        archived ? (
          <div className="ui-tb__archived">
            {filtered.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                compact={compact}
                archived
                busy={busy}
                onOpen={() => selectTask(task.id)}
                onStart={(mode) => start(task, mode)}
                onStop={() => stop(task)}
                onRetry={() => retry(task)}
                onRestore={() => restore(task)}
                onToggleAuto={() => toggleAuto(task)}
                onDelete={() => remove(task)}
                onDragStart={() => setDragTask(task)}
                onDragEnd={() => setDragTask(null)}
              />
            ))}
            {filtered.length === 0 && <div className="ui-tb__empty">没有封存任务</div>}
          </div>
        ) : (
          <div className={cn('ui-tb__columns', compact && 'is-compact')}>
            {columns.map((column) => {
              const items = filtered.filter((task) => column.statuses.includes(task.status));
              return (
                <div
                  key={column.id}
                  className="ui-tb__column"
                  data-column={column.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDropColumn(column.id)}
                >
                  <div className="ui-tb__col-head">
                    <span className="ui-tb__status"><StatusIcon kind={column.icon} /></span>
                    <span className={cn('ui-tb__col-title', compact && 'is-compact')}>{column.label}</span>
                    <span className="ui-tb__col-count">{items.length}</span>
                    {column.id === 'waiting' && (
                      <span className="ui-tb__col-hint">待办 / 已规划 / 失败</span>
                    )}
                    {column.id === 'progress' && (
                      <span className="ui-tb__col-hint">规划中 / 执行中</span>
                    )}
                  </div>
                  <div className="ui-tb__cards">
                    {items.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        compact={compact}
                        archived={false}
                        busy={busy}
                        onOpen={() => selectTask(task.id)}
                        onStart={(mode) => start(task, mode)}
                        onStop={() => stop(task)}
                        onRetry={() => retry(task)}
                        onRestore={() => restore(task)}
                        onToggleAuto={() => toggleAuto(task)}
                        onDelete={() => remove(task)}
                        onDragStart={() => setDragTask(task)}
                        onDragEnd={() => setDragTask(null)}
                      />
                    ))}
                    {items.length === 0 && (
                      <div className="ui-tb__empty">
                        {column.id === 'waiting' ? '没有待办任务' : '暂无任务'}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

        </div>

        <div className="ui-tb__detail" ref={detailRef}>
          {selected ? (
            <Tabs
              key={selected.id}
              defaultValue={selected.teams?.length ? 'progress' : 'task'}
              className="min-h-0 flex-1"
            >
              <TabsList>
                {selected.teams?.length ? (
                  <TabsTab value="progress">
                    <Activity aria-hidden="true" />
                    执行进度
                  </TabsTab>
                ) : null}
                <TabsTab value="task">
                  <ClipboardList aria-hidden="true" />
                  任务详情
                </TabsTab>
              </TabsList>
              {selected.teams?.length ? (
                <TabsPanel value="progress" className="min-h-0 overflow-y-auto">
                  <TaskProgress teamId={selected.teams[selected.teams.length - 1]} />
                </TabsPanel>
              ) : null}
              <TabsPanel value="task" className="min-h-0 overflow-y-auto">
                <TaskPanel
                  task={selected}
                  models={models}
                  dshWebUrl={data?.settings?.dshWebUrl || null}
                  busy={busy}
                  onClose={() => setSelectedId(null)}
                  onStart={start}
                  onStop={stop}
                  onRetry={retry}
                  onArchive={archive}
                  onRestore={restore}
                  onDelete={remove}
                  onToggleAuto={() => toggleAuto(selected)}
                  onSaved={() => void load(true)}
                  onError={(message) => toast(message, 'error')}
                  onOk={(message) => toast(message, 'ok')}
                />
              </TabsPanel>
            </Tabs>
          ) : (
            <div className="ui-tb__detail-empty">
              <p className="ui-tb__detail-empty-title">选择一个任务</p>
              <p>这里会显示任务详情，以及关联团队成员的待办执行进度。</p>
            </div>
          )}
        </div>
      </div>

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
          selectTask(task.id);
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

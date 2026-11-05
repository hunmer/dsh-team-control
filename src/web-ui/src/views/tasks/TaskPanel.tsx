/**
 * 任务详情卡片：放在看板右侧（窄屏时下方）的详情容器里，字段只读展示；
 * 仅在「待办」状态时可通过右上角编辑按钮打开编辑对话框。拆分自 Tasks.tsx。
 */
import { Fragment, useState } from 'react';
import { Archive, ArchiveRestore, CircleStop, ExternalLink, MessageSquare, Pencil, Play, RotateCcw, Users, X } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { ModelAvatar } from '@/components/ModelAvatar';
import { Button } from '@/components/ui/button';
import { Group, GroupSeparator } from '@/components/ui/group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { brandOfModel } from '@/lib/model-brand';
import { BOARD_STATUS_LABEL, boardApi, type BoardMode, type BoardRoute, type BoardTask } from '@/lib/board';
import { StatusIcon } from '../board-status-icon';
import { EditTaskDialog } from './dialogs';
import { TaskActionsMenu } from './TaskActionsMenu';
import { STATUS_ICON, errText, fmtTime, openDshSession, openTeamPanel, routeLabel, taskKey, type ModelOption } from './shared';

/** 只读展示一条模型路由：有品牌图标时带图标，否则只显示文字。 */
function RouteValue({ route }: { route?: BoardRoute | null }) {
  if (!route?.model) return <p className="text-xs text-muted-foreground">跟随工作区默认</p>;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <ModelAvatar model={route.model} provider={route.provider} size={14} />
      <span className="truncate">{routeLabel(route)}</span>
    </p>
  );
}

/** 团队模型既可能是 BoardRoute，也可能是历史遗留字符串（`provider\0model` 或 `provider/model`）。 */
function teamModelRoutes(task: BoardTask): BoardRoute[] {
  return (task.teamModels ?? []).flatMap((entry) => {
    if (typeof entry !== 'string') return entry.model ? [entry] : [];
    if (!entry) return [];
    const separator = entry.includes('\u0000') ? '\u0000' : entry.includes('/') ? '/' : '';
    if (!separator) return [{ provider: null, model: entry, reasoningEffort: null }];
    const index = entry.indexOf(separator);
    return [{ provider: entry.slice(0, index) || null, model: entry.slice(index + 1), reasoningEffort: null }];
  });
}

/** 团队模型头像列表：厂商图标 + 展示名（目录里没有时回退 provider/model）+ 已指定的思考强度。 */
function TeamModelList({ task, models }: { task: BoardTask; models: ModelOption[] }) {
  const routes = teamModelRoutes(task).filter((route) => route.model);
  if (!routes.length) return <p className="text-xs text-muted-foreground">不限制</p>;
  return (
    <ul className="mt-1 flex flex-col gap-1.5">
      {routes.map((route) => {
        const option = models.find((m) => m.provider === (route.provider ?? '') && m.model === route.model);
        const brand = brandOfModel(route.model, option?.name, route.provider);
        const effort = option?.efforts?.find((e) => e.id === route.reasoningEffort);
        return (
          <li key={`${route.provider ?? ''}/${route.model}`} className="flex items-center gap-2 text-xs text-muted-foreground">
            {brand ? (
              <ModelAvatar model={route.model} name={option?.name} provider={route.provider} size={16} />
            ) : (
              <span className="grid size-4 shrink-0 place-items-center rounded-sm bg-muted text-[9px] font-semibold uppercase">
                {(route.model || '?').slice(0, 2)}
              </span>
            )}
            <span className="truncate">{option?.name || routeLabel(route)}</span>
            {effort && (
              <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] leading-4">
                {effort.name || effort.id}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TaskPanel({
  task,
  models,
  dshWebUrl,
  busy,
  onClose,
  onStart,
  onStop,
  onRetry,
  onArchive,
  onRestore,
  onDelete,
  onSaved,
  onError,
  onOk,
}: {
  task: BoardTask;
  models: ModelOption[];
  /** Host 上报的 DSH Web 地址：独立页面用它 window.open 深链打开会话 */
  dshWebUrl?: string | null;
  busy: string;
  onClose: () => void;
  onStart: (task: BoardTask, mode: BoardMode) => void;
  onStop: (task: BoardTask) => void;
  onRetry: (task: BoardTask) => void;
  onArchive: (task: BoardTask) => void;
  onRestore: (task: BoardTask) => void;
  onDelete: (task: BoardTask) => void;
  onToggleAuto: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
  onOk: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  const startable = task.status === 'todo' || task.status === 'planned';
  const active = task.status === 'planning' || task.status === 'inprogress';
  const terminal = task.status === 'done' || task.status === 'failed';
  const isBusy = busy.startsWith(`${task.id}:`);
  // 只有待办（且未封存）的任务可以编辑字段
  const editable = task.status === 'todo' && !task.archivedAt;

  return (
    <>
      <section className="ui-tb__panel ui-tb__panel--card" aria-label="任务详情">
        <div className="ui-tb__panel-head">
          <span className="ui-tb__key">{taskKey(task)}</span>
          <div className="flex items-center gap-1">
            {task.archivedAt ? (
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  className="ui-tb__panel-close"
                  aria-label="恢复任务"
                  disabled={isBusy}
                  onClick={() => onRestore(task)}
                >
                  <ArchiveRestore size={13} />
                </TooltipTrigger>
                <TooltipPopup>恢复</TooltipPopup>
              </Tooltip>
            ) : terminal ? (
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  className="ui-tb__panel-close"
                  aria-label="封存任务"
                  disabled={isBusy}
                  onClick={() => onArchive(task)}
                >
                  <Archive size={13} />
                </TooltipTrigger>
                <TooltipPopup>封存</TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                type="button"
                className="ui-tb__panel-close"
                aria-label="编辑任务"
                disabled={!editable}
                onClick={() => setEditing(true)}
              >
                <Pencil size={13} />
              </TooltipTrigger>
              <TooltipPopup>{editable ? '编辑任务' : '仅待办状态的任务可以编辑'}</TooltipPopup>
            </Tooltip>
            <TaskActionsMenu
              task={task}
              busy={busy}
              onStop={() => onStop(task)}
              onDelete={() => onDelete(task)}
              triggerClassName="ui-tb__panel-close"
            />
            <button type="button" className="ui-tb__panel-close" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
        </div>

        <h2 className="ui-tb__title">{task.title}</h2>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="ui-tb__state ui-tb__prop" data-status={task.status}>
            <StatusIcon kind={STATUS_ICON[task.status]} />
            {BOARD_STATUS_LABEL[task.status]}
          </span>
          <span className="text-[11px] text-muted-foreground">更新 {fmtTime(task.updatedAt)}</span>
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
        </div>

        <div className="ui-tb__fields">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="ui-tb__label">执行方式</span>
              <span className="text-xs text-muted-foreground">
                {task.executionMode === 'new' ? '新会话' : '同一会话'}
              </span>
            </div>
            <div>
              <span className="ui-tb__label">自动入队</span>
              <span className="text-xs text-muted-foreground">{task.auto ? '已开启' : '已关闭'}</span>
            </div>
          </div>

          <div>
            <span className="ui-tb__label">规划模型</span>
            <RouteValue route={task.planRoute} />
          </div>

          <div>
            <span className="ui-tb__label">执行模型</span>
            <RouteValue route={task.leadRoute} />
          </div>

          <div>
            <span className="ui-tb__label">团队模型</span>
            <TeamModelList task={task} models={models} />
          </div>

          <div>
            <span className="ui-tb__label">关联团队</span>
            {task.teams?.length || task.leadSessionId ? (
              <Group aria-label="关联团队与执行会话" orientation="vertical" className="mt-1.5 w-full">
                {task.teams?.map((teamId, index) => (
                  <Fragment key={teamId}>
                    {index > 0 && <GroupSeparator orientation="horizontal" />}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-start"
                      title={`打开团队 ${teamId} 的编排界面`}
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
                      <span className="min-w-0 flex-1 truncate text-left">{teamId}</span>
                      <ExternalLink className="ml-auto shrink-0" size={11} />
                    </Button>
                  </Fragment>
                ))}
                {task.leadSessionId && (
                  <>
                    {task.teams?.length ? <GroupSeparator orientation="horizontal" /> : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-start"
                      title="打开该任务的 Lead（执行）DSH 会话"
                      onClick={() => {
                        const opened = openDshSession(task.leadSessionId!, dshWebUrl);
                        if (!opened) {
                          onError('新窗口被浏览器拦截：请允许本站弹窗后重试');
                          return;
                        }
                        onOk(opened === 'window' ? '已在新窗口打开 DSH 执行会话' : '已在 DSH 中打开执行会话');
                      }}
                    >
                      <MessageSquare size={12} />
                      <span className="min-w-0 flex-1 truncate text-left">在DSH查看执行会话</span>
                      <ExternalLink className="ml-auto shrink-0" size={11} />
                    </Button>
                  </>
                )}
              </Group>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                尚未关联团队；执行阶段调用 team_create 后会自动绑定。
              </p>
            )}
          </div>

          <div>
            <span className="ui-tb__label">任务描述</span>
            {task.description ? (
              <p className="whitespace-pre-wrap text-xs leading-5">{task.description}</p>
            ) : (
              <p className="text-xs text-muted-foreground">没有描述</p>
            )}
          </div>

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
          </div>
        </div>
      </section>
      <EditTaskDialog
        open={editing}
        onOpenChange={setEditing}
        task={task}
        models={models}
        onSaved={onSaved}
      />
    </>
  );
}

/**
 * 任务详情侧滑面板：编辑标题/描述、执行方式、模型路由、关联团队、计划内容。
 * 拆分自 Tasks.tsx，行为不变。
 */
import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, CircleStop, ExternalLink, Loader2, Play, RotateCcw, Users, X } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { BOARD_STATUS_LABEL, boardApi, type BoardMode, type BoardTask } from '@/lib/board';
import { StatusIcon } from '../board-status-icon';
import { Field, ModePicker, RouteSelect } from './fields';
import { STATUS_ICON, errText, fmtTime, openTeamPanel, routeFromKey, routeKey, taskKey, type ModelOption } from './shared';

export function TaskPanel({
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

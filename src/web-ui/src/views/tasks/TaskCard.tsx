/**
 * 看板任务卡片（列内单卡 + 封存视图复用）。
 * 拆分自 Tasks.tsx，行为不变。
 */
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { ArchiveRestore, CircleAlert, CircleStop, ExternalLink, Play, RotateCcw, Users } from 'lucide-react';
import { BOARD_STATUS_LABEL, type BoardMode, type BoardTask } from '@/lib/board';
import { cn } from '@/lib/utils';
import { StatusIcon } from '../board-status-icon';
import { STATUS_ICON, fmtTime, shortModel, taskKey } from './shared';

export function TaskCard({
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
          <Switch
            checked={task.auto}
            onCheckedChange={() => onToggleAuto()}
            onClick={(e) => e.stopPropagation()}
            title={task.auto ? '关闭自动入队' : '开启自动入队'}
            aria-label={task.auto ? '关闭自动入队' : '开启自动入队'}
          />
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
              <TooltipTrigger type="button" className="ui-tb__act" aria-label="重试" disabled={isBusy} onClick={onRetry}>
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

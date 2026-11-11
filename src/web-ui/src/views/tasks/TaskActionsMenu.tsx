/**
 * 任务操作菜单（任务卡片与详情卡片复用）：编辑 / 停止 / 重置 / 封存或恢复 / 删除。
 * 编辑仅对待办任务可用；停止对非进行中的任务禁用；重置仅对已结束（完成/失败）的任务可用；
 * 删除会二次确认，进行中的任务需先停止。
 */
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import type { BoardTask } from '@/lib/board';
import { cn } from '@/lib/utils';

export function TaskActionsMenu({
  task,
  busy,
  onEdit,
  onStop,
  onReset,
  onArchive,
  onRestore,
  onDelete,
  triggerClassName,
  align = 'end',
}: {
  task: BoardTask;
  busy: string;
  onEdit?: () => void;
  onStop: () => void;
  onReset?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete: () => void;
  triggerClassName?: string;
  align?: 'start' | 'center' | 'end';
}) {
  const isBusy = busy.startsWith(`${task.id}:`);
  const active = task.status === 'planning' || task.status === 'inprogress';
  const terminal = task.status === 'done' || task.status === 'failed';

  const confirmDelete = () => {
    if (!window.confirm(`删除任务「${task.title}」？删除后无法恢复。`)) return;
    onDelete();
  };

  const confirmReset = () => {
    if (!window.confirm(`重置任务「${task.title}」为待办？将清空计划、执行记录与失败信息。`)) return;
    onReset?.();
  };

  return (
    <span
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className={cn(triggerClassName)}
              aria-label="任务操作"
              title="任务操作"
              disabled={isBusy}
            />
          }
        >
          <MoreHorizontal size={13} />
        </MenuTrigger>
        <MenuPopup align={align} className="w-36">
          {onEdit && task.status === 'todo' && !task.archivedAt && (
            <MenuItem onClick={onEdit} disabled={isBusy}>
              <Pencil />
              编辑
            </MenuItem>
          )}
          <MenuItem onClick={onStop} disabled={!active || isBusy}>
            <Square />
            停止
          </MenuItem>
          {onReset && !task.archivedAt && (
            <MenuItem
              onClick={confirmReset}
              disabled={!terminal || isBusy}
              title={terminal ? '清空计划与执行记录，回到待办' : '仅已完成或失败的任务可以重置'}
            >
              <RotateCcw />
              重置
            </MenuItem>
          )}
          {onRestore && task.archivedAt && (
            <MenuItem onClick={onRestore} disabled={isBusy}>
              <ArchiveRestore />
              恢复
            </MenuItem>
          )}
          {onArchive && !task.archivedAt && (
            <MenuItem
              onClick={onArchive}
              disabled={!terminal || isBusy}
              title={terminal ? undefined : '仅已完成或失败的任务可以封存'}
            >
              <Archive />
              封存
            </MenuItem>
          )}
          <MenuItem
            variant="destructive"
            onClick={confirmDelete}
            disabled={active || isBusy}
            title={active ? '请先停止任务' : undefined}
          >
            <Trash2 />
            删除
          </MenuItem>
        </MenuPopup>
      </Menu>
    </span>
  );
}

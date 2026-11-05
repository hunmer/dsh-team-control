/**
 * 任务操作菜单（任务卡片与详情卡片复用）：停止 / 删除。
 * 停止对非进行中的任务禁用；删除会二次确认，进行中的任务需先停止。
 */
import { MoreHorizontal, Square, Trash2 } from 'lucide-react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import type { BoardTask } from '@/lib/board';
import { cn } from '@/lib/utils';

export function TaskActionsMenu({
  task,
  busy,
  onStop,
  onDelete,
  triggerClassName,
  align = 'end',
}: {
  task: BoardTask;
  busy: string;
  onStop: () => void;
  onDelete: () => void;
  triggerClassName?: string;
  align?: 'start' | 'center' | 'end';
}) {
  const isBusy = busy.startsWith(`${task.id}:`);
  const active = task.status === 'planning' || task.status === 'inprogress';

  const confirmDelete = () => {
    if (!window.confirm(`删除任务「${task.title}」？删除后无法恢复。`)) return;
    onDelete();
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
          <MenuItem onClick={onStop} disabled={!active || isBusy}>
            <Square />
            停止
          </MenuItem>
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

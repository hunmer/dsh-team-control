/** 团队待办（todo）数据与耗时计算：看板执行进度用。 */
import { api } from './api';
import type { Member } from '@/types';

export type TodoStatus = 'open' | 'active' | 'done' | 'blocked' | 'skipped';

export interface TodoItem {
  id: string;
  teamId: string;
  taskId: string | null;
  memberId: string | null;
  title: string;
  status: TodoStatus;
  orderNo: number;
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
  /** 第一次进入执行（active/blocked/done）的时间；由 sidecar 记录 */
  startedAt: string | null;
  /** 完成时间；同一次 todo_write 勾掉的多个 todo 共享同一个值（= 一个进度批次） */
  doneAt: string | null;
}

export interface TodosResponse {
  asOf: string;
  version: number | string;
  items: TodoItem[];
}

export interface TeamsResponse {
  items: Array<{ id: string; name: string }>;
}

export const todosApi = {
  list: (teamId: string) => api<TodosResponse>(`/api/todos?team=${encodeURIComponent(teamId)}`),
  members: (teamId: string) =>
    api<{ asOf: string; members: Member[]; staleMembers?: string[] }>(`/api/status?team=${encodeURIComponent(teamId)}`),
  teams: () => api<TeamsResponse>('/api/teams'),
};

export type TodoBatchStatus = 'done' | 'running' | 'failed';

/** 一个进度批次：同一成员、同一次提交里一起完成的 todo 合成一块。 */
export interface TodoBatch {
  id: string;
  memberId: string | null;
  status: TodoBatchStatus;
  start: number;
  end: number;
  todos: TodoItem[];
}

export const parseTs = (value: string | null | undefined): number => {
  const ts = value ? Date.parse(value) : NaN;
  return Number.isFinite(ts) ? ts : 0;
};

/** 开始计时：优先 started_at，缺失时退回创建时间（旧数据 / 未经过 active 直接 done）。 */
export const todoStartMs = (todo: TodoItem): number => parseTs(todo.startedAt || todo.createdAt);

/** 结束计时：完成用 done_at，执行中/阻塞到当前时刻，未开始返回 null。 */
export const todoEndMs = (todo: TodoItem, now: number): number | null => {
  if (todo.status === 'done') return parseTs(todo.doneAt || todo.updatedAt);
  if (todo.status === 'active') return now;
  if (todo.status === 'blocked') return parseTs(todo.updatedAt);
  return null;
};

export function todoDuration(todo: TodoItem, now: number): number | null {
  const end = todoEndMs(todo, now);
  if (end == null) return null;
  return Math.max(0, end - todoStartMs(todo));
}

/** 紧凑时长：40s / 12m / 1h 20m / 2d 3h */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * 把 todo 折成进度批次：
 * - done：按 done_at 分组（todo_write 一次勾多个 → 同一个 done_at → 同一块）；
 * - active / blocked：按 started_at 分组（一次提交里同时启动多个 → 同一块），结束到 now / updated_at。
 * open 不占时间轴，只在明细列表里展示。
 */
export function buildTodoBatches(todos: TodoItem[], now: number): TodoBatch[] {
  const groups = new Map<string, TodoBatch>();
  for (const todo of todos) {
    if (todo.status === 'done') {
      const finished = parseTs(todo.doneAt || todo.updatedAt);
      const key = `done:${todo.memberId || '-'}:${todo.doneAt || todo.updatedAt}`;
      let batch = groups.get(key);
      if (!batch) {
        batch = { id: key, memberId: todo.memberId, status: 'done', start: todoStartMs(todo), end: finished, todos: [] };
        groups.set(key, batch);
      }
      batch.start = Math.min(batch.start, todoStartMs(todo));
      batch.end = Math.max(batch.end, finished);
      batch.todos.push(todo);
      continue;
    }
    if (todo.status === 'active' || todo.status === 'blocked') {
      const start = todoStartMs(todo);
      // 同一次 todo_write 里多个 todo 一起进入 active/blocked 时共享 started_at → 同一块
      const key = `run:${todo.memberId || '-'}:${todo.startedAt || start}`;
      const end = Math.max(start, todoEndMs(todo, now) ?? now);
      const batch = groups.get(key);
      if (batch) {
        batch.end = Math.max(batch.end, end);
        if (todo.status === 'blocked') batch.status = 'failed';
        batch.todos.push(todo);
      } else {
        groups.set(key, {
          id: key,
          memberId: todo.memberId,
          status: todo.status === 'blocked' ? 'failed' : 'running',
          start,
          end,
          todos: [todo],
        });
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.start - b.start);
}

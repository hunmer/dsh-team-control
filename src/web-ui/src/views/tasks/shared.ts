/**
 * 任务看板共享类型、常量与纯工具函数。
 * 拆分自 Tasks.tsx，行为不变。
 */
import type { BoardMode, BoardRoute, BoardStatus, BoardTask } from '@/lib/board';
import type { BoardStatusKind } from '../board-status-icon';

export interface ModelOption {
  key: string;
  provider: string;
  model: string;
  name: string;
  group: string;
}

export interface ModelsResponse {
  providers: Array<{
    id: string;
    name: string;
    models: Array<{ provider: string; model: string; name: string; enabled?: boolean }>;
  }>;
}

export const STATUS_ICON: Record<BoardStatus, BoardStatusKind> = {
  todo: 'todo',
  planning: 'progress',
  planned: 'review',
  inprogress: 'progress',
  done: 'done',
  failed: 'canceled',
};

export const COLUMNS: Array<{ id: string; label: string; statuses: BoardStatus[]; icon: BoardStatusKind }> = [
  { id: 'waiting', label: 'Waiting', statuses: ['todo', 'planned', 'failed'], icon: 'backlog' },
  { id: 'progress', label: 'Progress', statuses: ['planning', 'inprogress'], icon: 'progress' },
  { id: 'done', label: 'Done', statuses: ['done'], icon: 'done' },
];

export const STATUS_ORDER: Record<string, number> = { todo: 0, planned: 1, failed: 2, planning: 0, inprogress: 1, done: 0 };

export function routeKey(route?: BoardRoute | null): string {
  if (!route?.model) return '';
  return `${route.provider || ''}\u0000${route.model}`;
}

export function routeFromKey(key: string): BoardRoute | null {
  if (!key) return null;
  const [provider, model] = key.split('\u0000');
  return { provider: provider || null, model: model || null, reasoningEffort: null };
}

export function routeLabel(route?: BoardRoute | null): string {
  if (!route?.model) return '跟随默认';
  return `${route.provider ? `${route.provider}/` : ''}${route.model}`;
}

export function shortModel(route?: BoardRoute | null): string {
  return route?.model || '默认';
}

export function fmtTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function taskKey(task: BoardTask): string {
  return `BT-${task.id.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase()}`;
}

export type OpenTeamResult = 'sidebar' | 'window';

/**
 * 打开某团队的编排界面：嵌在 DSH 里交给宿主切侧栏；独立页面（非 DSH 环境）没有宿主，
 * 直接在同一个面板地址上用新窗口打开该团队。
 */
export function openTeamPanel(teamId: string): OpenTeamResult | null {
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

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { BoardMode };

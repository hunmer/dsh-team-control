/** 工作区任务看板 API（sidecar /api/board）。 */
import { api, enc } from './api';

export type BoardStatus = 'todo' | 'planning' | 'planned' | 'inprogress' | 'done' | 'failed';
export type BoardMode = 'same' | 'new';

export interface BoardRoute {
  provider: string | null;
  model: string | null;
  reasoningEffort?: string | null;
}

export interface BoardTask {
  id: string;
  workspaceId: string;
  workspacePath: string;
  title: string;
  description: string;
  status: BoardStatus;
  auto: boolean;
  executionMode: BoardMode;
  priority: number;
  position: number;
  planRoute: BoardRoute;
  leadRoute: BoardRoute;
  teamModels: Array<string | BoardRoute> | null;
  planMd: string | null;
  planSummary: string | null;
  planningSessionId: string | null;
  leadSessionId: string | null;
  claimedAt: string | null;
  stopRequested: boolean;
  resumed: boolean;
  lastError: string | null;
  archivedAt: string | null;
  teams: string[];
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export interface BoardSettings {
  workspaceId: string;
  workspacePath: string;
  planningConcurrency: number;
  inprogressConcurrency: number;
  /** 看板创建的规划/执行会话是否挂进 DSH 工作区会话列表（默认 true） */
  showTaskSessions: boolean;
  planProvider: string | null;
  planModel: string | null;
  planReasoningEffort: string | null;
  leadProvider: string | null;
  leadModel: string | null;
  leadReasoningEffort: string | null;
  planPermissionPreset: string;
  leadPermissionPreset: string;
  planAgentPreset: string | null;
  leadAgentPreset: string | null;
  /** Host 上报的 DSH Web 地址（独立面板用它深链打开会话；Host 未上报时为 null） */
  dshWebUrl?: string | null;
  updatedAt: string | null;
}

export interface BoardData {
  workspace: { id: string; title: string; path: string };
  settings: BoardSettings;
  counts: Record<BoardStatus, number>;
  slots: {
    planning: { used: number; limit: number };
    inprogress: { used: number; limit: number };
  };
  tasks: BoardTask[];
}

export interface CreateBoardTask {
  workspaceId: string;
  workspacePath?: string;
  title: string;
  description?: string;
  auto?: boolean;
  executionMode?: BoardMode;
  planRoute?: BoardRoute | null;
  leadRoute?: BoardRoute | null;
  teamModels?: BoardRoute[] | null;
}

export const boardApi = {
  list: (workspaceId: string, archived = false) =>
    api<BoardData>(`/api/board?workspaceId=${enc(workspaceId)}${archived ? '&archived=1' : ''}`),
  create: (body: CreateBoardTask) => api<BoardTask>('/api/board/tasks', { method: 'POST', body }),
  update: (id: string, body: Partial<CreateBoardTask> & { auto?: boolean }) =>
    api<BoardTask>(`/api/board/tasks/${enc(id)}`, { method: 'PATCH', body }),
  start: (id: string, executionMode: BoardMode) =>
    api<BoardTask>(`/api/board/tasks/${enc(id)}/start`, { method: 'POST', body: { executionMode } }),
  stop: (id: string) => api<BoardTask>(`/api/board/tasks/${enc(id)}/stop`, { method: 'POST', body: {} }),
  retry: (id: string) => api<BoardTask>(`/api/board/tasks/${enc(id)}/retry`, { method: 'POST', body: {} }),
  archive: (id: string) => api<BoardTask>(`/api/board/tasks/${enc(id)}/archive`, { method: 'POST', body: {} }),
  restore: (id: string) => api<BoardTask>(`/api/board/tasks/${enc(id)}/restore`, { method: 'POST', body: {} }),
  status: (id: string, status: 'done' | 'failed' | 'inprogress', summary?: string) =>
    api<BoardTask>(`/api/board/tasks/${enc(id)}/status`, { method: 'POST', body: { status, summary } }),
  settings: (workspaceId: string) => api<{ settings: BoardSettings }>(`/api/board/settings?workspaceId=${enc(workspaceId)}`),
  saveSettings: (body: Partial<BoardSettings> & { workspaceId: string }) =>
    api<{ settings: BoardSettings }>('/api/board/settings', { method: 'PUT', body }),
};

export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  todo: '待办',
  planning: '规划中',
  planned: '已规划',
  inprogress: '执行中',
  done: '完成',
  failed: '失败',
};

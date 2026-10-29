/**
 * 网络层 —— 与原 vanilla 面板相同的原则：
 * - 同源嵌入（?api=/dsh-team-api&embed=1）时 token 由 Host 注入，本页不接触 token；
 * - 独立打开时 token 只存内存（URL hash 用完即抹），不写任何浏览器存储。
 */

const PANEL_PARAMS = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
export const API_BASE = String(PANEL_PARAMS.get('api') || '').replace(/\/+$/, '');
export const EMBEDDED = PANEL_PARAMS.get('embed') === '1' || API_BASE !== '';

export class ApiError extends Error {
  code: string;
  path: string;
  constructor(code: string, message: string, path: string) {
    super(message || code || 'request failed');
    this.name = 'ApiError';
    this.code = code || 'E_UNKNOWN';
    this.path = path;
  }
}

export const apiUrl = (path: string) => (path.startsWith('http') ? path : API_BASE + path);

/** 内存 token（模块级，绝不落盘）。 */
let memoryToken = '';

export function initUrlToken(): string {
  try {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = hash.get('token') || query.get('token') || '';
    if (token) memoryToken = token;
    if (hash.has('token') || query.has('token')) {
      hash.delete('token');
      query.delete('token');
      const search = query.toString();
      const hashText = hash.toString();
      history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + (hashText ? '#' + hashText : ''));
    }
  } catch {
    /* file:// 等场景忽略 */
  }
  return memoryToken;
}

export const getToken = () => memoryToken;
export const setToken = (token: string) => { memoryToken = token; };

export interface ApiOptions {
  method?: string;
  body?: unknown;
  raw?: boolean;
  text?: boolean;
  onUnauthorized?: () => void;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (memoryToken) headers.Authorization = 'Bearer ' + memoryToken;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method: options.method || 'GET', headers, body });
  } catch (err) {
    throw new ApiError('E_NETWORK', '网络请求失败（' + path + '）：' + (err instanceof Error ? err.message : String(err)), path);
  }
  if (response.status === 401) {
    options.onUnauthorized?.();
    throw new ApiError('E_UNAUTHORIZED', '未授权（401）：token 无效或已轮换', path);
  }
  if (!response.ok) {
    let detail: { code?: string; message?: string } | null = null;
    try { detail = await response.json(); } catch { /* 非 JSON */ }
    throw new ApiError(detail?.code || 'HTTP_' + response.status, detail?.message || 'HTTP ' + response.status + ' ' + response.statusText, path);
  }
  if (options.raw) return response as unknown as T;
  if (options.text) return (await response.text()) as unknown as T;
  try { return (await response.json()) as T; } catch { return {} as T; }
}

export const pickItems = <T,>(response: unknown): T[] =>
  Array.isArray(response) ? (response as T[]) : (Array.isArray((response as { items?: T[] })?.items) ? (response as { items: T[] }).items : []);

export const enc = (value: unknown) => encodeURIComponent(String(value));

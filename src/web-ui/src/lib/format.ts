const pad2 = (n: number) => String(n).padStart(2, '0');

/** token 数：≥1M 用 M（一位小数），≥100k 取整 k，≥1k 保留一位小数，其余原样。 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  // 1e6 以上再走 k 就会显示成 1000k：先切成 M
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 花费一般都很小，给到 4 位小数才不至于全显示成 $0.00。 */
export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtClock(ts?: string | null): string {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 只到秒的时间：Activity 行左侧用，避免毫秒把一列挤满。 */
export function fmtClockSec(ts?: string | null): string {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtDateTime(ts?: string | null): string {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtAgo(ts?: string | null): string {
  const t = ts ? new Date(ts).getTime() : NaN;
  if (Number.isNaN(t)) return '—';
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 2) return '刚刚';
  if (secs < 60) return `${secs}s 前`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m 前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h 前`;
  return `${Math.floor(secs / 86400)}d 前`;
}

export const truncate = (text: unknown, max: number): string => {
  const str = text === null || text === undefined ? '' : String(text);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
};

export const safeToken = (value: unknown): string =>
  String(value || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'unknown';

export function compactObject(object: Record<string, unknown>, separator: string): string {
  const parts: string[] = [];
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value === null || value === undefined || value === '') continue;
    let text: string;
    if (Array.isArray(value)) text = value.map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : String(item))).join('|');
    else if (value && typeof value === 'object') text = compactObject(value as Record<string, unknown>, ' ');
    else text = String(value);
    parts.push(`${key}=${text}`);
  }
  return parts.length ? parts.join(separator) : '—';
}

export function describeSummary(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '允许' : '拒绝';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => (item && typeof item === 'object' ? compactObject(item as Record<string, unknown>, ' ') : String(item))).join(', ') : '—';
  if (typeof value === 'object') return compactObject(value as Record<string, unknown>, ' · ');
  return String(value);
}

export const safeFileName = (name: unknown) =>
  String(name || 'team').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'team';

/** sessionStorage（隐私模式静默失败）。 */
export const storeGet = (key: string): string | null => {
  try { return sessionStorage.getItem(key); } catch { return null; }
};
export const storeSet = (key: string, value: string): void => {
  try { sessionStorage.setItem(key, value); } catch { /* 隐私模式忽略 */ }
};

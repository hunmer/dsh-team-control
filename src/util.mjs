// util.mjs — 无依赖工具：ID/时间/哈希/glob/脱敏/错误/统计
import { createHash } from 'node:crypto';
import path from 'node:path';

// ---------- 错误 ----------
export class ApiError extends Error {
  constructor(code, message, { status = 400, detail } = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
  toJSON() { return { error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) } }; }
}
export const ERR = {
  denied: (m = 'permission denied', d) => new ApiError('E_DENIED', m, { status: 403, detail: d }),
  unauthorized: () => new ApiError('E_UNAUTHORIZED', 'unauthorized', { status: 401 }),
  notFound: (what = 'resource') => new ApiError('E_NOT_FOUND', `${what} not found`, { status: 404 }),
  conflict: (m = 'conflict', d) => new ApiError('E_CONFLICT', m, { status: 409, detail: d }),
  version: (m = 'version conflict', d) => new ApiError('E_VERSION', m, { status: 409, detail: d }),
  timeout: (m = 'timeout') => new ApiError('E_TIMEOUT', m, { status: 408 }),
  bad: (m = 'bad request', d) => new ApiError('E_BAD_REQUEST', m, { status: 400, detail: d }),
  quota: (m = 'quota exceeded') => new ApiError('E_QUOTA', m, { status: 429 }),
  interrupted: (m = 'interrupted') => new ApiError('E_INTERRUPTED', m, { status: 409 }),
  cycle: (m = 'cycle detected') => new ApiError('E_CYCLE', m, { status: 400 }),
  invalidState: (m = 'invalid state') => new ApiError('E_INVALID_STATE', m, { status: 409 }),
};

// ---------- 时间/ID ----------
export const now = () => Date.now();
export const nowIso = (t = Date.now()) => new Date(t).toISOString();
let __idCounter = 0;
export function newId(prefix = 'id') {
  __idCounter = (__idCounter + 1) % 0x10000;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0x100000).toString(36).padStart(4, '0');
  return `${prefix}_${t}${__idCounter.toString(36)}${r}`;
}
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const p95 = (arr) => percentile(arr, 0.95);
export function percentile(arr, p) {
  const a = arr.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1);
  return a[Math.max(0, idx)];
}
export const backoffMs = (attempt, base = 50) => Math.min(2000, base * 2 ** Math.max(0, attempt - 1));

// ---------- 哈希 ----------
export function sha256(data) {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return h.digest('hex');
}

// ---------- 路径 / glob ----------
export function toPosix(p) { return String(p).replace(/\\/g, '/'); }

/** 归一化为相对 workspace 的 posix 路径；越界抛错 */
export function resolveInWorkspace(workspace, p) {
  if (typeof p !== 'string' || !p.length) throw ERR.bad('path required');
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
  const ws = path.resolve(workspace);
  const rel = path.relative(ws, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw ERR.denied(`path escapes workspace: ${p}`);
  }
  return { abs, rel: toPosix(rel) || '.', inside: true };
}

const globCache = new Map();
/** glob → RegExp。`**` 跨目录，`*` 不跨目录，`?` 单字符，`{a,b}` 简写不支持（用多条规则） */
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  const g = toPosix(glob).replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+?.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  const rx = new RegExp('^' + re + '$');
  globCache.set(glob, rx);
  return rx;
}
export function matchGlob(glob, relPath) {
  const p = toPosix(relPath).replace(/^\.\//, '');
  if (glob === '**' || glob === '**/*' || glob === '*') return true;
  if (globToRegExp(glob).test(p)) return true;
  // 目录前缀语义：`config` 也匹配 `config/x.json`（matcher 写目录时）
  if (!g_hasWildcard(glob) && p.startsWith(toPosix(glob).replace(/\/$/, '') + '/')) return true;
  return false;
}
const g_hasWildcard = (g) => /[*?]/.test(g);

// ---------- 脱敏（FR-3.8 / AC-13）----------
const SENSITIVE_NAME = /SECRET|TOKEN|KEY|PASS(?:WD|WORD)?|CREDENTIAL|PRIVATE/i;
export const isSensitiveName = (n) => SENSITIVE_NAME.test(String(n || ''));
export const REDACTED = '<redacted>';

export function createRedactor() {
  const secrets = new Set();
  const addSecret = (v) => { if (typeof v === 'string' && v.length >= 3) secrets.add(v); };
  const scrubString = (s) => {
    if (!s) return s;
    let out = s;
    for (const sec of secrets) if (out.includes(sec)) out = out.split(sec).join(REDACTED);
    return out;
  };
  const obj = (o) => {
    if (o == null || typeof o !== 'object') return typeof o === 'string' ? scrubString(o) : o;
    if (Array.isArray(o)) return o.map(obj);
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (isSensitiveName(k) && typeof v === 'string' && v && v !== REDACTED) { out[k] = REDACTED; continue; }
      out[k] = obj(v);
    }
    return out;
  };
  return { addSecret, str: scrubString, obj, get size() { return secrets.size; }, secrets };
}

/** 进程级默认脱敏器（sidecar 单进程共享） */
export const redactor = createRedactor();

// ---------- 杂项 ----------
export const arr = (x) => (Array.isArray(x) ? x : []);
export const int = (x, d = 0) => (Number.isFinite(Number(x)) ? Math.trunc(Number(x)) : d);
export const bool = (x) => x === true || x === 'true' || x === 1 || x === '1';
export function parseJson(s, d = null) { try { return s == null ? d : JSON.parse(s); } catch { return d; } }
export const json = (v) => JSON.stringify(v ?? null);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function truncate(s, n = 65536) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n) + `\n…[truncated ${str.length - n}B]`;
}
/** 简单优先级队列（priority 小者先，FIFO 同优先级） */
export class PrioQueue {
  constructor() { this.items = []; this.seq = 0; }
  push(item, priority = 0) { this.items.push({ item, priority, seq: this.seq++ }); this.items.sort((a, b) => a.priority - b.priority || a.seq - b.seq); }
  shift() { return this.items.shift()?.item ?? null; }
  get size() { return this.items.length; }
  remove(pred) { const i = this.items.findIndex((x) => pred(x.item)); if (i >= 0) return this.items.splice(i, 1)[0].item; return null; }
  toArray() { return this.items.map((x) => x.item); }
}

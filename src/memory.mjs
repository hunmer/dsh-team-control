// memory.mjs — 显式记忆：一条记忆一个 JSON 文件，文件只存事实（不落库）
//
// 目录：<home>/memory/objects/<memoryId>.json
// 文件字段：id/key/kind/title/value/tags/visibility/createdAt/updatedAt/version。
// 文件里不写 teamId、memberId、scope、source —— 归属在 team 数据（SQLite memory_link）里，
// 这样一条记忆拷到别的团队仍然只靠 id 就能读。
// 索引：进程内 Map(id → record)；key 的唯一性按「空间」算，空间由 core 传进来（不落文件）。
// 并发：写入走 tmp + rename 原子替换；expectedVersion 做 CAS，冲突返回 409。
import fs from 'node:fs';
import path from 'node:path';
import { ERR, nowIso, newId, truncate } from './util.mjs';

const KINDS = new Set(['handoff', 'fact', 'decision', 'open-question']);
const VISIBILITIES = new Set(['private', 'team', 'shared']);
const MAX_VALUE = 64 * 1024;
const MAX_ITEMS = 5000;
const MAX_KEY = 128;

const s = (v) => (v == null ? '' : String(v));
const firstLine = (v) => s(v).split('\n')[0].trim();

export class MemoryStore {
  constructor({ home, log = () => {}, onUpdate = null } = {}) {
    this.home = home;
    this.log = log;
    this.onUpdate = onUpdate;
    this.dir = path.join(home, 'memory', 'objects');
    /** @type {Map<string, object>} memoryId → 规范化记录（只含事实字段） */
    this.records = new Map();
    /** @type {Map<string, string>} `${space}\u0000${key}` → memoryId；空间由 bind() 从 team 数据灌入 */
    this.keyIndex = new Map();
    /** @type {Map<string, string>} memoryId → space（仅运行时，不进文件） */
    this.spaceOf = new Map();
    this.reindex();
  }

  fileOf(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** 扫目录重建记录表。key 索引要等 core 用 memory_link 调 bind() 后才能恢复。 */
  reindex() {
    fs.mkdirSync(this.dir, { recursive: true });
    const records = new Map();
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { files = []; }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      let rec;
      try {
        rec = this.normalize(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')));
      } catch (e) {
        this.log({ level: 'warn', msg: 'memory file skipped', file: name, err: String(e?.message || e) });
        continue;
      }
      const prev = records.get(rec.id);
      if (prev && Date.parse(prev.updatedAt) > Date.parse(rec.updatedAt)) continue;
      records.set(rec.id, rec);
    }
    this.records = records;
    this.keyIndex = new Map();
    this.spaceOf = new Map();
    return { items: records.size, dir: this.dir, ids: [...records.keys()] };
  }

  /** core 从 memory_link 恢复「这条记忆属于哪个空间」，只影响同 key upsert 的归并。 */
  bind(id, space) {
    const r = this.records.get(s(id));
    if (!r || !space) return false;
    this.spaceOf.set(r.id, s(space));
    const k = `${s(space)}\u0000${r.key}`;
    const oldId = this.keyIndex.get(k);
    if (oldId && oldId !== r.id) {
      const old = this.records.get(oldId);
      if (old && Date.parse(old.updatedAt) > Date.parse(r.updatedAt)) return true;
    }
    this.keyIndex.set(k, r.id);
    return true;
  }

  unbind(id) {
    for (const [k, v] of this.keyIndex) {
      if (v === s(id)) this.keyIndex.delete(k);
    }
    this.spaceOf.delete(s(id));
  }

  /** 文件字段做最小规范化；缺 id/key 的记录视为损坏。旧版本文件里的归属字段直接忽略。 */
  normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    const id = s(raw.id);
    const key = s(raw.key);
    if (!id || !key) throw new Error('missing id/key');
    const kind = KINDS.has(raw.kind) ? raw.kind : 'fact';
    const visibility = VISIBILITIES.has(raw.visibility) ? raw.visibility : 'private';
    return {
      id,
      schema: 1,
      key,
      kind,
      title: s(raw.title).slice(0, 200),
      value: typeof raw.value === 'string' ? raw.value : JSON.stringify(raw.value ?? ''),
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => s(t).trim()).filter(Boolean).slice(0, 20) : [],
      visibility,
      createdAt: s(raw.createdAt) || nowIso(),
      updatedAt: s(raw.updatedAt) || s(raw.createdAt) || nowIso(),
      version: Number.isFinite(Number(raw.version)) ? Math.max(1, Math.trunc(Number(raw.version))) : 1,
    };
  }

  /** 对外视图：字段 `key` 改成 `slot`，避免被全局脱敏规则（名字含 KEY）打成 <redacted>。 */
  view(r, { withValue = true } = {}) {
    return {
      id: r.id,
      slot: r.key,
      kind: r.kind,
      title: r.title,
      ...(withValue ? { value: r.value } : {}),
      summary: truncate(firstLine(r.value), 180),
      size: Buffer.byteLength(r.value, 'utf8'),
      tags: r.tags,
      visibility: r.visibility,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      version: r.version,
    };
  }

  get(id) {
    const r = this.records.get(s(id));
    if (!r) throw ERR.notFound('memory');
    return r;
  }

  /** core 已经按 team 数据筛好 id 集合；这里只做字段过滤与排序。 */
  list(filter = {}) {
    const q = s(filter.q).trim().toLowerCase();
    const tag = s(filter.tag).trim();
    const ids = filter.ids instanceof Set ? filter.ids : null;
    const out = [];
    for (const r of this.records.values()) {
      if (ids && !ids.has(r.id)) continue;
      if (filter.slot && r.key !== s(filter.slot)) continue;
      if (filter.kind && r.kind !== s(filter.kind)) continue;
      if (tag && !r.tags.includes(tag)) continue;
      if (q) {
        const hay = [r.key, r.title, r.value, r.tags.join(' ')].join('\n').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(r);
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const limit = Math.max(1, Math.min(1000, Number(filter.limit) || 200));
    return { total: out.length, items: out.slice(0, limit).map((r) => this.view(r, { withValue: false })) };
  }

  /** upsert：同一 (space, key) 写回同一条记忆，version+1。 */
  write(input = {}) {
    const space = s(input.space);
    if (!space) throw ERR.bad('space required');
    const key = s(input.key).trim();
    if (!key) throw ERR.bad('key required');
    if (key.length > MAX_KEY) throw ERR.bad(`key too long (max ${MAX_KEY})`);
    if (/[\u0000-\u001f]/.test(key)) throw ERR.bad('key must not contain control characters');
    const kind = input.kind == null || input.kind === '' ? 'fact' : s(input.kind);
    if (!KINDS.has(kind)) throw ERR.bad(`invalid kind: ${kind}`);
    const visibility = input.visibility == null || input.visibility === '' ? 'private' : s(input.visibility);
    if (!VISIBILITIES.has(visibility)) throw ERR.bad(`invalid visibility: ${visibility}`);
    let value = input.value;
    if (value == null) throw ERR.bad('value required');
    if (typeof value !== 'string') value = JSON.stringify(value);
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE) throw ERR.bad(`value too large (max ${MAX_VALUE}B)`);
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((t) => s(t).trim()).filter(Boolean))].slice(0, 20)
      : [];

    const idx = `${space}\u0000${key}`;
    const existingId = this.keyIndex.get(idx);
    const existing = existingId ? this.records.get(existingId) : null;
    if (existing && input.expectedVersion != null && Number(input.expectedVersion) !== existing.version) {
      throw ERR.version(`expectedVersion ${input.expectedVersion} != current ${existing.version}`, { current: existing.version });
    }
    if (!existing && input.expectedVersion != null && Number(input.expectedVersion) !== 0) {
      throw ERR.version(`memory does not exist (expectedVersion ${input.expectedVersion})`);
    }
    if (!existing && this.records.size >= MAX_ITEMS) {
      throw ERR.quota(`memory store is full (max ${MAX_ITEMS} items)`);
    }

    const t = nowIso();
    const rec = {
      id: existing?.id || newId('mem'),
      schema: 1,
      key,
      kind,
      title: s(input.title).slice(0, 200) || firstLine(value).slice(0, 120),
      value,
      tags,
      visibility,
      createdAt: existing?.createdAt || t,
      updatedAt: t,
      version: existing ? existing.version + 1 : 1,
    };
    this.persist(rec);
    this.records.set(rec.id, rec);
    this.keyIndex.set(idx, rec.id);
    this.spaceOf.set(rec.id, space);
    try { this.onUpdate?.(rec, existing ? 'update' : 'create'); } catch { /* 广播失败不影响写入 */ }
    return { memory: this.view(rec), created: !existing };
  }

  /** 按 id 局部更新：value/title/kind/tags/visibility；key 不可改（避免空间键漂移）。 */
  update(id, patch = {}) {
    const r = this.get(id);
    const next = { ...r, tags: [...r.tags] };
    if (patch.value !== undefined) {
      let v = patch.value;
      if (v == null) throw ERR.bad('value required');
      if (typeof v !== 'string') v = JSON.stringify(v);
      if (Buffer.byteLength(v, 'utf8') > MAX_VALUE) throw ERR.bad(`value too large (max ${MAX_VALUE}B)`);
      next.value = v;
    }
    if (patch.title !== undefined) next.title = s(patch.title).slice(0, 200);
    if (patch.kind !== undefined) {
      if (!KINDS.has(s(patch.kind))) throw ERR.bad(`invalid kind: ${patch.kind}`);
      next.kind = s(patch.kind);
    }
    if (patch.tags !== undefined) {
      if (!Array.isArray(patch.tags)) throw ERR.bad('tags must be an array');
      next.tags = [...new Set(patch.tags.map((t) => s(t).trim()).filter(Boolean))].slice(0, 20);
    }
    if (patch.visibility !== undefined) {
      const v = s(patch.visibility);
      if (!VISIBILITIES.has(v)) throw ERR.bad(`invalid visibility: ${v}`);
      next.visibility = v;
    }
    if (patch.expectedVersion != null && Number(patch.expectedVersion) !== r.version) {
      throw ERR.version(`expectedVersion ${patch.expectedVersion} != current ${r.version}`, { current: r.version });
    }
    next.updatedAt = nowIso();
    next.version = r.version + 1;
    this.persist(next);
    this.records.set(next.id, next);
    const space = this.spaceOf.get(next.id);
    if (space) this.keyIndex.set(`${space}\u0000${next.key}`, next.id);
    try { this.onUpdate?.(next, 'update'); } catch { /* ignore */ }
    return this.view(next);
  }

  share(id, visibility) {
    const r = this.get(id);
    const v = s(visibility);
    if (!VISIBILITIES.has(v)) throw ERR.bad(`invalid visibility: ${v}`);
    const next = { ...r, visibility: v, updatedAt: nowIso(), version: r.version + 1 };
    this.persist(next);
    this.records.set(next.id, next);
    try { this.onUpdate?.(next, 'share'); } catch { /* ignore */ }
    return this.view(next);
  }

  remove(id) {
    const r = this.get(id);
    try { fs.rmSync(this.fileOf(r.id), { force: true }); } catch (e) {
      throw ERR.bad(`failed to delete memory file: ${e?.message || e}`);
    }
    this.records.delete(r.id);
    this.unbind(r.id);
    try { this.onUpdate?.(r, 'delete'); } catch { /* ignore */ }
    return { id: r.id, removed: true };
  }

  /** tmp + rename：进程崩溃时最多留下 .tmp 文件，不会写出半截 JSON。 */
  persist(rec) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileOf(rec.id);
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  stats() {
    return { items: this.records.size, dir: this.dir };
  }
}

// llm.mjs — DSH 模型路由目录（sidecar 侧只存「映射 + 开关 + 注释」，不接任何 LLM 服务）
//
// 数据从 Host 插件同步进来（Host 的 ctx.llm.listProviders()/listModels()），sidecar 不猜
// provider/model 是否存在；它只负责把用户勾选的子集和备注持久化，供面板展示与
// team_models/team_spawn 使用。
import { ERR, nowIso } from './util.mjs';

const clip = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** 适配器声明的 effort 列表 → 去重后的 [{id,name,description?}]（顺序即适配器的强弱顺序）。 */
const normalizeEfforts = (list) => {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') continue;
    const id = clip(e.id, 64);
    // 「off」是关思考而非可派发强度：插件已过滤，这里再兜一层防止旧数据/其他来源写进来。
    if (!id || id === 'off' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: clip(e.name, 120) || id, ...(e.description ? { description: clip(e.description, 300) } : {}) });
  }
  return out;
};
const parseEfforts = (json) => {
  if (!json) return null;
  try { const v = JSON.parse(json); return Array.isArray(v) ? normalizeEfforts(v) : null; } catch { return null; }
};
const parseAllowed = (json) => {
  if (!json) return null;
  try { const v = JSON.parse(json); return Array.isArray(v) ? [...new Set(v.map(String))].filter((id) => id !== 'off') : null; } catch { return null; }
};

export class LlmCatalog {
  constructor(db, get) {
    this.db = db;
    this.get = get;
  }

  /**
   * 用 Host 上报的快照整体替换目录：同 route 保留用户的 enabled/note，
   * 消失的 route 删除；空快照直接拒绝（避免 llm 服务暂不可用时把勾选清空）。
   */
  sync(input = {}) {
    const providers = Array.isArray(input.providers) ? input.providers : [];
    const models = Array.isArray(input.models) ? input.models : [];
    // Host 有 provider 读取失败时标记 partial：只 upsert、不删旧行，避免一次网络抖动清掉用户勾选
    const partial = input.partial === true;
    const live = providers.filter((p) => p && p.id);
    if (!live.length) throw ERR.bad('providers required（Host 未提供 ctx.llm 目录时不要同步）');
    const t = nowIso();
    const keepP = new Set();
    const keepM = new Set();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of live) {
        const id = String(p.id);
        keepP.add(id);
        this.get(
          `INSERT INTO llm_provider (provider, name, source, error, synced_at) VALUES (?,?,?,?,?)
           ON CONFLICT(provider) DO UPDATE SET name=excluded.name, source=excluded.source,
             error=excluded.error, synced_at=excluded.synced_at`
        ).run(id, clip(p.name, 200) || id, p.source === 'dormant' ? 'dormant' : 'live', clip(p.error, 500), t);
      }
      for (const m of models) {
        if (!m || !m.provider || !m.model || !keepP.has(String(m.provider))) continue;
        const provider = String(m.provider);
        const model = String(m.model);
        keepM.add(provider + '\u0000' + model);
        // 适配器声明的 effort：数组 = 本次已知（可为空数组），undefined = 本次没取到 → 保留旧值。
        const efforts = Array.isArray(m.efforts) ? normalizeEfforts(m.efforts) : null;
        const prev = this.get('SELECT efforts_json, default_effort, allowed_efforts_json FROM llm_route WHERE provider=? AND model=?').get(provider, model);
        const knownEfforts = efforts === null ? parseEfforts(prev?.efforts_json) : efforts;
        const defaultEffort = m.defaultEffort ? String(m.defaultEffort) : (efforts === null ? (prev?.default_effort || null) : null);
        // 用户允许的子集随 effort 列表收缩；列表全允许时折回 NULL，减少无意义差异。
        let allowed = parseAllowed(prev?.allowed_efforts_json);
        if (allowed !== null && knownEfforts) {
          const ids = new Set(knownEfforts.map((e) => e.id));
          allowed = allowed.filter((id) => ids.has(id));
          if (allowed.length === knownEfforts.length) allowed = null;
        }
        this.get(
          `INSERT INTO llm_route (provider, model, name, description, modalities_json, context_window, source, efforts_json, default_effort, allowed_efforts_json, enabled, note, synced_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)
           ON CONFLICT(provider, model) DO UPDATE SET name=excluded.name, description=excluded.description,
             modalities_json=excluded.modalities_json, context_window=excluded.context_window,
             source=excluded.source, efforts_json=excluded.efforts_json, default_effort=excluded.default_effort,
             allowed_efforts_json=excluded.allowed_efforts_json,
             synced_at=excluded.synced_at, updated_at=excluded.updated_at`
        ).run(
          provider, model, clip(m.name, 200) || model, clip(m.description, 1000),
          m.modalities ? JSON.stringify(m.modalities) : null,
          Number.isFinite(Number(m.contextWindow)) ? Number(m.contextWindow) : null,
          m.source === 'dormant' ? 'dormant' : 'live',
          efforts === null ? (prev?.efforts_json ?? null) : JSON.stringify(efforts),
          defaultEffort,
          allowed === null ? null : JSON.stringify(allowed),
          t, t,
        );
      }
      for (const row of this.get('SELECT provider, model FROM llm_route').all()) {
        if (!partial && !keepM.has(row.provider + '\u0000' + row.model)) {
          this.get('DELETE FROM llm_route WHERE provider=? AND model=?').run(row.provider, row.model);
        }
      }
      for (const row of this.get('SELECT provider FROM llm_provider').all()) {
        if (!partial && !keepP.has(row.provider)) this.get('DELETE FROM llm_provider WHERE provider=?').run(row.provider);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    const totals = this.totals();
    return { ok: true, asOf: t, ...totals };
  }

  totals() {
    const models = Number(this.get('SELECT COUNT(*) AS c FROM llm_route').get().c);
    const enabled = Number(this.get('SELECT COUNT(*) AS c FROM llm_route WHERE enabled=1').get().c);
    const providers = Number(this.get('SELECT COUNT(*) AS c FROM llm_provider').get().c);
    return { providers, models, enabled };
  }

  rowToModel(r) {
    let modalities = null;
    try { modalities = r.modalities_json ? JSON.parse(r.modalities_json) : null; } catch { /* ignore */ }
    return {
      provider: r.provider,
      model: r.model,
      name: r.name || r.model,
      description: r.description || null,
      modalities,
      contextWindow: r.context_window == null ? null : Number(r.context_window),
      source: r.source,
      enabled: Number(r.enabled) === 1,
      note: r.note || null,
      // 适配器声明的思考强度（null = 未知/不支持）；allowedEfforts = null 表示全部允许
      efforts: parseEfforts(r.efforts_json),
      defaultEffort: r.default_effort || null,
      allowedEfforts: parseAllowed(r.allowed_efforts_json),
    };
  }

  /** 面板/工具读的完整目录：provider 分组，含未开启项。 */
  catalog() {
    const providers = this.get('SELECT * FROM llm_provider ORDER BY name ASC, provider ASC').all()
      .map((p) => ({ id: p.provider, name: p.name || p.provider, source: p.source, error: p.error || null, models: [] }));
    const byId = new Map(providers.map((p) => [p.id, p]));
    for (const r of this.get('SELECT * FROM llm_route ORDER BY name ASC, model ASC').all()) {
      const model = this.rowToModel(r);
      const group = byId.get(r.provider);
      if (group) group.models.push(model);
      else {
        const orphan = { id: r.provider, name: r.provider, source: r.source, error: null, models: [model] };
        byId.set(r.provider, orphan); providers.push(orphan);
      }
    }
    return { asOf: nowIso(), source: 'dsh-llm', providers, totals: this.totals() };
  }

  /** team_models 用：只返回用户勾选启用的 route。 */
  enabledModels() {
    return this.get('SELECT * FROM llm_route WHERE enabled=1 ORDER BY provider ASC, name ASC, model ASC').all()
      .map((r) => this.rowToModel(r));
  }

  getRoute(provider, model) {
    const r = this.get('SELECT * FROM llm_route WHERE provider=? AND model=?').get(String(provider), String(model));
    return r ? this.rowToModel(r) : null;
  }

  /**
   * 勾选启用 / 写注释 / 限定可派发的 effort 子集（面板调用）；未知 route 404，避免静默写丢。
   * allowedEfforts：字符串数组，null = 全部允许；只接受该 route 已声明的 effort id。
   */
  setRoute(provider, model, { enabled, note, allowedEfforts } = {}) {
    const row = this.getRoute(provider, model);
    if (!row) throw ERR.notFound('llm route');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw ERR.bad('enabled must be boolean');
    if (note !== undefined && note !== null && typeof note !== 'string') throw ERR.bad('note must be string');
    if (allowedEfforts !== undefined && allowedEfforts !== null && !Array.isArray(allowedEfforts)) {
      throw ERR.bad('allowedEfforts must be an array of effort ids or null');
    }
    if (enabled !== undefined) {
      this.get('UPDATE llm_route SET enabled=?, updated_at=? WHERE provider=? AND model=?')
        .run(enabled ? 1 : 0, nowIso(), row.provider, row.model);
    }
    if (note !== undefined) {
      this.get('UPDATE llm_route SET note=?, updated_at=? WHERE provider=? AND model=?')
        .run(clip(note, 240), nowIso(), row.provider, row.model);
    }
    if (allowedEfforts !== undefined) {
      const declared = (row.efforts || []).map((e) => e.id);
      if (!declared.length) throw ERR.bad('该 route 未声明 reasoning effort，无法设置 effort 开关');
      let next = allowedEfforts === null ? null : [...new Set(allowedEfforts.map(String))];
      if (next) {
        for (const id of next) if (!declared.includes(id)) throw ERR.bad(`未知 effort: ${id}（可用：${declared.join(', ')}）`);
        if (next.length === declared.length) next = null; // 全选等价于不限
      }
      this.get('UPDATE llm_route SET allowed_efforts_json=?, updated_at=? WHERE provider=? AND model=?')
        .run(next === null ? null : JSON.stringify(next), nowIso(), row.provider, row.model);
    }
    return this.getRoute(row.provider, row.model);
  }
}

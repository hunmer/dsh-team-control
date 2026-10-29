// dsh-plugin/pricing.js — 模型单价表与「token 用量 → 金额」折算（零第三方依赖）。
//
// 为什么金额要在这里算：DSH 内核的 LLM 层只上报 token 用量（TokenUsage：未命中缓存输入 /
// 缓存读 / 缓存写 / 输出），没有任何货币计价。真实金额只能由调用方按单价表折算。
//
// 原则：查不到 provider 或模型时返回 null —— 只显示 token，不显示金额，绝不按模型名猜价。
// 单价单位：每 100 万 tokens；货币见各表的 currency。

/** 中国法定节假日（闭区间，北京时间的日历日；只影响「工作日里的放假那天算低谷」）。 */
export const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午
  ['2026-09-25', '2026-09-27'], // 中秋
  ['2026-10-01', '2026-10-07'], // 国庆
];

/** 把闭区间展开成 yyyy-mm-dd 集合（非法日期直接跳过，避免 Date.parse 滚动到别的日子）。 */
export function expandHolidayRanges(ranges) {
  const set = new Set();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [from, to] of ranges) {
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (new Date(start).toISOString().slice(0, 10) !== from) continue;
    if (new Date(end).toISOString().slice(0, 10) !== to) continue;
    for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
}

const HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

/** 固定偏移时区下的钟点/星期/日期键。 */
function scheduleParts(ms, offsetMinutes) {
  const local = new Date(ms + offsetMinutes * 60000);
  return { hour: local.getUTCHours(), dow: local.getUTCDay(), dateKey: local.toISOString().slice(0, 10) };
}

/** 某时刻是否落在「贵」的一侧（高峰窗口内，且不是周末/节假日豁免）。 */
export function isPeakTime(atMs, schedule) {
  if (!schedule || !Array.isArray(schedule.peakWindows)) return false;
  const offset = Number.isFinite(schedule.offsetMinutes) ? schedule.offsetMinutes : 480;
  const { hour, dow, dateKey } = scheduleParts(atMs, offset);
  const weekday = dow !== 0 && dow !== 6;
  if (schedule.holidays === true && HOLIDAY_DAYS.has(dateKey)) return false;
  if ((schedule.peakDays ?? 'everyday') === 'weekdays' && !weekday) return false;
  return schedule.peakWindows.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 默认单价表。键是 provider id；`aliases` 用于把 provider 别名并到同一张表，
 * `models[id].standard / offPeak` 是「高峰 / 低谷」两档，没有 offPeak 表示全价。
 */
export const DEFAULT_PRICE_TABLES = {
  'deepseek-official': {
    label: 'DeepSeek',
    currency: 'CNY',
    asOf: '2026-09-10',
    // 北京时间工作日 09:00-12:00 / 14:00-18:00 为高峰，其余（含周末与法定节假日）为低谷
    schedule: { offsetMinutes: 480, peakWindows: [[9, 12], [14, 18]], peakDays: 'weekdays', holidays: true },
    aliases: {
      'deepseek-account': 'deepseek-official',
      deepseek: 'deepseek-official',
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    },
    models: {
      'deepseek-flash': {
        standard: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
        offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
      },
      'deepseek-v4-pro': {
        standard: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
        offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
      },
      'deepseek-chat': { standard: { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 } },
      'deepseek-reasoner': { standard: { input: 4, cacheRead: 1, cacheWrite: 0, output: 16 } },
    },
  },
};

/** 合并调用方给的额外单价表（同 provider 深合并，方便只覆盖某几个模型）。 */
function withTables(extra) {
  if (!extra || typeof extra !== 'object') return DEFAULT_PRICE_TABLES;
  const out = { ...DEFAULT_PRICE_TABLES };
  for (const [key, table] of Object.entries(extra)) {
    if (!table || typeof table !== 'object') continue;
    const base = out[key] || {};
    out[key] = {
      ...base, ...table,
      models: { ...(base.models || {}), ...(table.models || {}) },
      aliases: { ...(base.aliases || {}), ...(table.aliases || {}) },
    };
  }
  return out;
}

/** provider → 单价表（跟随 aliases 一跳）。 */
export function resolveTable(provider, tables) {
  const all = withTables(tables);
  const key = String(provider || '').trim();
  if (!key) return null;
  const direct = all[key];
  if (direct) return { key, table: direct };
  // 别名可能指向另一个 provider（如 deepseek-account → deepseek-official）
  const alias = Object.values(all).find((t) => t?.aliases?.[key]);
  if (alias) return { key: Object.keys(all).find((k) => all[k] === alias) || key, table: alias };
  return null;
}

/** 模型 → 单价档位（standard / offPeak），带别名与 `vendor/` 前缀兜底。 */
export function resolveRate(table, model, atMs) {
  if (!table || !model) return null;
  const models = table.models || {};
  const aliases = table.aliases || {};
  const raw = String(model).trim();
  const candidates = [raw, aliases[raw], raw.includes('/') ? raw.split('/').pop() : null]
    .filter(Boolean)
    .map((m) => aliases[m] || m);
  const id = candidates.find((m) => models[m]);
  if (!id) return null;
  const spec = models[id];
  const peak = isPeakTime(atMs, table.schedule);
  const rate = (!peak && spec.offPeak) ? spec.offPeak : spec.standard;
  if (!rate) return null;
  return { model: id, peak, rate };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 一次调用的金额。usage 形如 { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }，
 * 其中 inputTokens 只含未命中缓存的输入，所以计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens。
 * 返回 null 表示「不知道价」——调用方应只展示 token。
 */
export function priceUsage({ provider, model, usage, atMs = Date.now(), tables = null } = {}) {
  if (!usage) return null;
  const found = resolveTable(provider, tables);
  if (!found) return null;
  const priced = resolveRate(found.table, model, atMs);
  if (!priced) return null;
  const { rate, peak } = priced;
  const { input, cacheRead, cacheWrite, output } = rate;
  // 没单独标缓存写单价时按普通输入价计
  const writePrice = Number.isFinite(cacheWrite) ? cacheWrite : (Number.isFinite(input) ? input : 0);
  const perToken = (price) => num(price) / 1e6;
  const value = num(usage.inputTokens) * perToken(input)
    + num(usage.cacheReadTokens) * perToken(cacheRead)
    + num(usage.cacheWriteTokens) * perToken(writePrice)
    + num(usage.outputTokens) * perToken(output);
  return {
    currency: found.table.currency || 'USD',
    provider: found.key,
    model: priced.model,
    peak,
    rate,
    cost: Math.round(value * 1e8) / 1e8,
  };
}

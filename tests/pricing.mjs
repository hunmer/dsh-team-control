// tests/pricing.mjs — LLM 金额折算：单价表 / 峰谷 / 节假日 / 别名 / 未知模型
// 纯函数测试，不启 sidecar。金额单位：元（CNY），每百万 tokens 单价。
import assert from 'node:assert/strict';
import { priceUsage, isPeakTime, DEFAULT_PRICE_TABLES } from '../dsh-plugin/pricing.js';

const DS = DEFAULT_PRICE_TABLES['deepseek-official'];
const toks = (inputTokens, outputTokens = 0, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });

// 2026-10-27 是周二：北京 10:00（UTC 02:00）高峰，北京 20:00（UTC 12:00）低谷
const PEAK_AT = Date.parse('2026-10-27T02:00:00Z');
const OFF_AT = Date.parse('2026-10-27T12:00:00Z');

assert.equal(isPeakTime(PEAK_AT, DS.schedule), true, '工作日 10:00 属高峰');
assert.equal(isPeakTime(OFF_AT, DS.schedule), false, '工作日 20:00 属低谷');
assert.equal(isPeakTime(Date.parse('2026-10-31T02:00:00Z'), DS.schedule), false, '周六全天低谷');
assert.equal(isPeakTime(Date.parse('2026-10-01T02:00:00Z'), DS.schedule), false, '国庆假期全天低谷');

// 高峰 1M 输入 = 2 元；低谷 = 1 元
const peak = priceUsage({ provider: 'deepseek-official', model: 'deepseek-flash', usage: toks(1e6), atMs: PEAK_AT });
const off = priceUsage({ provider: 'deepseek-official', model: 'deepseek-flash', usage: toks(1e6), atMs: OFF_AT });
assert.equal(peak.cost, 2, '高峰：1M 输入 × ¥2');
assert.equal(off.cost, 1, '低谷：1M 输入 × ¥1');
assert.equal(peak.currency, 'CNY');
assert.equal(peak.peak, true);
assert.equal(off.peak, false);

// 缓存读按缓存单价（低谷 ¥0.02/M、高峰 ¥0.04/M），不计入普通输入
const cached = priceUsage({ provider: 'deepseek-official', model: 'deepseek-flash', usage: toks(0, 0, 1e6), atMs: OFF_AT });
assert.equal(cached.cost, 0.02, '缓存命中 1M = ¥0.02（低谷）');
assert.equal(
  priceUsage({ provider: 'deepseek-official', model: 'deepseek-flash', usage: toks(0, 0, 1e6), atMs: PEAK_AT }).cost,
  0.04, '缓存命中 1M = ¥0.04（高峰）',
);
// 输出 1M = ¥4（低谷）
assert.equal(priceUsage({ provider: 'deepseek-official', model: 'deepseek-flash', usage: toks(0, 1e6), atMs: OFF_AT }).cost, 4);

// provider 别名 + 模型别名
const alias = priceUsage({ provider: 'deepseek-account', model: 'deepseek-v4-flash', usage: toks(1e6), atMs: OFF_AT });
assert.equal(alias.cost, 1, 'deepseek-account / deepseek-v4-flash 归一到 flash 低谷价');
assert.equal(alias.model, 'deepseek-flash');

// 未知 provider / 模型 / 无 usage → null（只显示 token，不猜价）
assert.equal(priceUsage({ provider: 'unknown-provider', model: 'deepseek-flash', usage: toks(1e6), atMs: OFF_AT }), null);
assert.equal(priceUsage({ provider: 'deepseek-official', model: 'gpt-6-astra', usage: toks(1e6), atMs: OFF_AT }), null);
assert.equal(priceUsage({ provider: 'deepseek-official', model: 'deepseek-flash', usage: null, atMs: OFF_AT }), null);

// 调用方可覆盖单价（同 provider 深合并）
const custom = priceUsage({
  provider: 'deepseek-official', model: 'deepseek-flash', usage: toks(1e6), atMs: OFF_AT,
  tables: { 'deepseek-official': { models: { 'deepseek-flash': { standard: { input: 100, cacheRead: 0, output: 0 } } } } },
});
assert.equal(custom.cost, 100, '自定义单价表覆盖生效');

console.log('PASS pricing — 峰谷/节假日/别名/缓存/未知模型/自定义单价 全部通过');

// tests/llm-provider-note.mjs — 厂商级备注：PATCH /api/llm/providers 持久化，Host 重新同步目录不会覆盖
import assert from 'node:assert/strict';
import { mkTmp, startSidecar } from './lib/harness.mjs';

const tmp = mkTmp('dsh-llm-provider-note');
const sidecar = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
try {
  const api = sidecar.api;
  await api.post('/api/llm/catalog', {
    providers: [{ id: 'openai', name: 'OpenAI' }],
    routes: [{ provider: 'openai', model: 'gpt-x', name: 'GPT X' }],
    partial: false,
  });
  const before = await api.get('/api/llm/catalog');
  assert.equal(before.providers[0].note, null, '初始厂商备注为空');

  const saved = await api.patch('/api/llm/providers', { provider: 'openai', note: '擅长逻辑推理' });
  assert.equal(saved.note, '擅长逻辑推理', 'PATCH 返回新备注');
  const after = await api.get('/api/llm/catalog');
  assert.equal(after.providers[0].note, '擅长逻辑推理', 'catalog 带出厂商备注');

  // Host 重新上报目录只 upsert name/source/error/synced_at，不能覆盖用户备注
  await api.post('/api/llm/catalog', {
    providers: [{ id: 'openai', name: 'OpenAI 新名' }],
    routes: [{ provider: 'openai', model: 'gpt-x', name: 'GPT X' }],
    partial: false,
  });
  const again = await api.get('/api/llm/catalog');
  assert.equal(again.providers[0].name, 'OpenAI 新名', '目录名仍跟随 Host');
  assert.equal(again.providers[0].note, '擅长逻辑推理', '重新同步保留厂商备注');

  // 空串清空备注（clip 后回 null）
  const cleared = await api.patch('/api/llm/providers', { provider: 'openai', note: '  ' });
  assert.equal(cleared.note, null, '空白备注归一为 null');

  let err = null;
  try { await api.patch('/api/llm/providers', { provider: 'nope', note: 'x' }); } catch (e) { err = e; }
  assert.equal(err?.status, 404, '未知 provider 404');
  console.log('llm-provider-note: ok');
} finally {
  await sidecar.close();
  tmp.cleanup();
}

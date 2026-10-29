// tests/llm-catalog.mjs — 模型路由目录：Host 快照同步、启用/停用、备注、清理语义
import { mkTmp, startSidecar, assert, assertEqual } from './lib/harness.mjs';

const tmp = mkTmp('llm-catalog');
let s;
const rejects = async (p, body, status, label) => {
  let err = null;
  try { await s.api.post(p, body); } catch (e) { err = e; }
  assert(err && err.status === status, `${label}: expected ${status}, got ${err ? err.status : 'no error'}`);
};

try {
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });

  const empty = await s.api.get('/api/llm/catalog');
  assertEqual(empty.totals.models, 0, '空目录');
  assertEqual((await s.api.get('/api/llm/models')).total, 0, '空目录可用列表');

  const sync = await s.api.post('/api/llm/catalog', {
    providers: [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' },
      { id: 'dormant-x', name: 'Dormant X', source: 'dormant', error: 'not configured' },
    ],
    models: [
      { provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat', description: 'fast', modalities: ['text', 'image'] },
      { provider: 'deepseek', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      { provider: 'openai', model: 'gpt-5', name: 'GPT-5' },
    ],
  });
  assertEqual(sync.models, 3, '同步模型数');
  assertEqual(sync.enabled, 3, '默认全部启用');
  assertEqual(sync.providers, 3, '同步 provider 数');

  let cat = await s.api.get('/api/llm/catalog');
  const dormant = cat.providers.find((p) => p.id === 'dormant-x');
  assertEqual(dormant.source, 'dormant', 'dormant provider 保留');
  assertEqual(dormant.error, 'not configured');

  let list = await s.api.get('/api/llm/models');
  assertEqual(list.total, 3, '默认可用列表 = 全部');

  const patched = await s.api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-chat', enabled: false, note: '日常改代码' });
  assertEqual(patched.enabled, false, '停用');
  assertEqual(patched.note, '日常改代码', '备注');

  list = await s.api.get('/api/llm/models');
  assertEqual(list.total, 2, '停用项不出现在可用列表');
  assert(!list.items.some((m) => m.model === 'deepseek-chat'), '停用项必须隐藏');
  const all = await s.api.get('/api/llm/models?all=1');
  assertEqual(all.total, 3, 'all=1 返回全部');

  // 再次同步：保留 enabled/note，更新元数据，删除快照里消失的 route
  await s.api.post('/api/llm/catalog', {
    providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    models: [{ provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat v2' }],
  });
  cat = await s.api.get('/api/llm/catalog');
  const chat = cat.providers.flatMap((p) => p.models).find((m) => m.model === 'deepseek-chat');
  assertEqual(chat.enabled, false, '重复同步保留停用');
  assertEqual(chat.note, '日常改代码', '重复同步保留备注');
  assertEqual(chat.name, 'DeepSeek Chat v2', '名称更新');
  assertEqual(cat.totals.models, 1, '消失的 route 被删除');
  assertEqual(cat.providers.length, 1, '消失的 provider 被删除');

  // partial：只 upsert，不删旧行
  await s.api.post('/api/llm/catalog', {
    providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI', error: 'timeout' }],
    models: [{ provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat' }],
    partial: true,
  });
  cat = await s.api.get('/api/llm/catalog');
  assertEqual(cat.totals.models, 1, 'partial 不删除已有 route');

  await rejects('/api/llm/catalog', { providers: [] }, 400, '空 providers');
  let err = null;
  try { await s.api.patch('/api/llm/routes', { provider: 'nope', model: 'nope', enabled: true }); } catch (e) { err = e; }
  assert(err && err.status === 404, '未知 route 404');
  err = null;
  try { await s.api.patch('/api/llm/routes', { provider: 'deepseek', model: 'deepseek-chat', enabled: 'yes' }); } catch (e) { err = e; }
  assert(err && err.status === 400, 'enabled 非 boolean 400');

  console.log('PASS llm-catalog');
} finally {
  if (s) await s.close();
  tmp.cleanup();
}

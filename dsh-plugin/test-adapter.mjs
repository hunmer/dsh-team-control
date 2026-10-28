// 适配层端到端自测：临时 sidecar 上走完「建队 → 加成员 → 建阻塞任务 → 审批 → 报告」。
// 不依赖演示实例的状态；用真实进程 + 真实 HTTP。
// 用法：node dsh-plugin/test-adapter.mjs
import path from 'node:path';
import { mkTmp, startSidecar } from '../tests/lib/harness.mjs';
import { apply } from './index.js';

let failed = 0;
const check = (name, fn) => {
  try { const d = fn(); console.log(`PASS ${name}${d ? ' — ' + d : ''}`); }
  catch (e) { failed++; console.error(`FAIL ${name} — ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = { signal: new AbortController().signal };

function mountPlugin(config) {
  const registered = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(tool) {
        if (!tool || typeof tool.name !== 'string') throw new Error('tool must have a name');
        if (registered.some((t) => t.name === tool.name)) throw new Error(`duplicate tool ${tool.name}`);
        registered.push(tool);
        return () => { const i = registered.indexOf(tool); if (i >= 0) registered.splice(i, 1); };
      },
    },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); },
  };
  apply(ctx, config);
  return { registered, disposers, tool: (n) => registered.find((t) => t.name === n) };
}

const tmp = mkTmp('dsh-plugin-adapter');
let s;
let plugin;
try {
  s = await startSidecar({ dataDir: tmp.dataDir, ws: tmp.ws });
  plugin = mountPlugin({ baseUrl: s.url, home: s.dataDir, autoStart: false });
  const { registered, tool } = plugin;

  // ---------- 静态契约 ----------
  check('注册 8 个工具', () => {
    const names = registered.map((t) => t.name).join(',');
    assert(registered.length === 8, `expected 8, got ${registered.length}: ${names}`);
    return names;
  });
  check('参数是合法 JSON Schema 且带 output.render', () => {
    for (const t of registered) {
      assert(typeof t.description === 'string' && t.description.length > 40, `${t.name} description`);
      assert(t.parameters?.type === 'object', `${t.name} parameters.type`);
      for (const r of t.parameters.required || []) assert(t.parameters.properties?.[r], `${t.name} required ${r} missing in properties`);
      assert(typeof t.output?.render === 'function', `${t.name} output.render`);
      assert(typeof t.execute === 'function', `${t.name} execute`);
    }
    return `${registered.length} 个`;
  });

  // ---------- 真实链路 ----------
  const team = await tool('team_create').execute({ name: 'adapter-team', workspace: tmp.ws, maxMembers: 4, maxConcurrency: 2 }, exec);
  check('team_create 建队', () => {
    assert(team.team?.id && team.team.name === 'adapter-team', 'team');
    assert(team.panel.endsWith('/panel'), 'panel url');
    return `${team.team.id} panel=${team.panel}`;
  });

  const alpha = await tool('team_spawn').execute({ teamId: team.team.id, name: 'adapter-alpha', role: 'writer' }, exec);
  const beta = await tool('team_spawn').execute({ teamId: team.team.id, name: 'adapter-beta', role: 'blocked-writer' }, exec);
  check('team_spawn 加成员', () => {
    assert(alpha.member?.id && beta.member?.id, 'members');
    assert(alpha.member.status === 'idle', `alpha status ${alpha.member?.status}`);
    return `${alpha.member.name}/${beta.member.name}`;
  });

  // 默认策略允许工作区读、拒绝写 → 这个任务必然阻塞在审批上
  const task = await tool('team_task').execute({
    teamId: team.team.id,
    subject: 'adapter blocked write',
    assignee: beta.member.id,
    plan: [
      {
        step: 'S1', phase: 'write', action: 'write', target: 'config/x.json',
        op: { kind: 'fs.write', args: { path: 'config/x.json', content: '{"ok":true}' } },
        onDenied: 'scope', scopeReason: 'adapter test', scopeTimeoutMs: 60000,
      },
    ],
  }, exec);
  check('team_task 建任务', () => { assert(task.task?.id, 'task id'); return task.task.id; });

  let st = null;
  for (let i = 0; i < 100; i++) {
    st = await tool('team_status').execute({ teamId: team.team.id }, exec);
    if (st.members.find((m) => m.name === 'adapter-beta')?.status === 'blocked') break;
    await sleep(100);
  }
  check('team_status 反映真实阻塞与 blocker', () => {
    const b = st.members.find((m) => m.name === 'adapter-beta');
    assert(b && b.status === 'blocked', `status=${b?.status}`);
    assert(Array.isArray(b.blockers) && b.blockers.some((x) => x.kind === 'scope_request'), 'scope_request blocker');
    assert(typeof st.asOf === 'string' && st.asOf.includes('T'), 'asOf');
    return `${b.status} step=${b.step} blockers=${b.blockers.map((x) => x.kind).join(',')}`;
  });

  const pend = await tool('team_scope').execute({ action: 'list', teamId: team.team.id, status: 'pending' }, exec);
  check('team_scope(list) 拿到待审批', () => {
    assert(Array.isArray(pend.items) && pend.items.length === 1, `items=${pend.items?.length}`);
    const r = pend.items[0];
    assert(r.domain === 'fs' && r.target === 'config/x.json', `${r.domain} ${r.target}`);
    return r.id;
  });

  const decided = await tool('team_scope').execute({
    action: 'decide', requestId: pend.items[0].id, decision: 'approved', decidedBy: 'adapter-test', reason: 'approved in test', ttlSeconds: 30, singleUse: true,
  }, exec);
  check('team_scope(decide) 落盘 decision + 单次 grant', () => {
    assert(decided.decision?.id && decided.grant?.id, 'decision/grant');
    assert(decided.grant.singleUse === 1, 'singleUse');
    return `decision=${decided.decision.id} grant=${decided.grant.id}`;
  });

  const done = await (async () => {
    for (let i = 0; i < 100; i++) {
      const d = await tool('team_status').execute({ teamId: team.team.id, detail: 'dag' }, exec);
      const node = d.nodes.find((n) => n.taskId === task.task.id);
      if (node?.status === 'done') return d;
      await sleep(100);
    }
    return null;
  })();
  check('批准后任务自动完成（单次 grant 生效）', () => {
    assert(done, 'task 未在 10s 内完成');
    assert(tmp.exists('config/x.json'), '目标文件未生成');
    assert(tmp.read('config/x.json') === '{"ok":true}', `内容不符：${tmp.exists('config/x.json') ? tmp.read('config/x.json') : 'missing'}`);
    const dag = done;
    assert(Array.isArray(dag.criticalPath), 'criticalPath');
    return `criticalPath=${dag.criticalPath.join('→')}`;
  });

  const report = await tool('team_report').execute({ teamId: team.team.id }, exec);
  check('team_report 含审计 hash 与 actor', () => {
    const md = report.markdown;
    assert(typeof md === 'string' && md.includes('before_hash') && md.includes('after_hash'), 'hash columns');
    assert(md.includes('adapter-test'), 'decision actor');
    assert(/[0-9a-f]{64}/.test(md), 'full sha256');
    return `${md.length} chars`;
  });

  // ---------- 错误路径 ----------
  const deadPlugin = mountPlugin({ baseUrl: 'http://127.0.0.1:43999', home: tmp.dataDir, autoStart: false });
  let deadMsg = '';
  try {
    await deadPlugin.tool('team_status').execute({ teamId: 'x' }, exec);
    throw new Error('应当抛错');
  } catch (e) { deadMsg = e.message; }
  check('autoStart=false 且不可达时报可执行错误', () => {
    assert(/不可达/.test(deadMsg) && /dsh-team/.test(deadMsg), deadMsg);
    return deadMsg.slice(0, 70) + '…';
  });

  // ---------- 卸载 ----------
  for (const d of plugin.disposers.reverse()) { try { d(); } catch { /* ignore */ } }
  check('卸载后工具全部注销', () => { assert(plugin.registered.length === 0, `still ${plugin.registered.length}`); return '0'; });
} catch (e) {
  console.error('ADAPTER TEST ERROR:', e?.stack || e);
  failed++;
} finally {
  try { if (s) await s.close(); } catch { /* ignore */ }
  tmp.cleanup();
}
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
process.exit(failed ? 1 : 0);

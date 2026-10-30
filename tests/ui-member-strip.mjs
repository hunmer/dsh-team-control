// tests/ui-member-strip.mjs — AC-16：会话右上角「团队卡片」入口（affectui AgentFindings 移植）
// 用 stub React 跑真实 dsh-plugin-ui/client.js：验证
//  - 只认本会话的子会话（= 团队成员），非团队会话不渲染
//  - pill 上显示团队名 / 运行中 n/m / 严重·警告计数
//  - 有运行中成员时卡片自动展开，卡片渲染在 shell.overlay
//  - 点发现条目用 dsh-resource://subagentchat/... 在右侧栏打开该成员对话
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CLIENT = path.join(here, '..', 'dsh-plugin-ui', 'client.js');
const source = fs.readFileSync(CLIENT, 'utf8');

// --- stub React：hooks 立即求值，createElement 生成可遍历的普通对象 ---
// 惰性初始值（读 store / Date.now）每次渲染都重算，等价于「无状态」；
// 普通初始值（如选中的成员 id）按调用点（client.js 行号）持有槽位，set 后下次渲染能读到新值。
const hookSlots = new Map();
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useMemo: (fn) => fn(),
  useState: (initial) => {
    const site = (new Error().stack || '').split(String.fromCharCode(10))[2] || '';
    if (typeof initial === 'function') return [initial(), () => {}];
    if (!hookSlots.has(site)) hookSlots.set(site, initial);
    return [
      hookSlots.get(site),
      (next) => {
        hookSlots.set(site, typeof next === 'function' ? next(hookSlots.get(site)) : next);
      },
    ];
  },
  useEffect: (fn) => {
    fn();
  },
};

// --- 假 sidecar 数据 ---
const TEAM = { id: 'team_t1', name: '小说团队' };
const STATUS = {
  members: [
    {
      id: 'm1', teamId: 'team_t1', name: 'plot-designer', model: 'glm', agentSessionId: 'c1',
      status: 'running', currentTaskId: 'task_1', step: 'S1', pct: 0.5,
      blockers: [{ kind: 'scope_request', id: 'r1', detail: '需要批准 npm publish' }],
    },
    {
      id: 'm2', teamId: 'team_t1', name: 'writer-ch1', model: null, agentSessionId: 'c2',
      status: 'idle', currentTaskId: null, step: null, pct: null, blockers: [],
    },
    {
      id: 'm4', teamId: 'team_t1', name: 'future-member', model: null, agentSessionId: 'c4',
      status: 'weird_state', currentTaskId: null, step: null, pct: null, blockers: [],
    },
    {
      // 复现「运行中灰显」：agent/status 的维护期 idle 已经把成员写成 idle，
      // 但它手上的任务依然是 running —— 卡片必须按任务画成运行中。
      id: 'm5', teamId: 'team_t1', name: 'reviewer', model: null, agentSessionId: 'c5',
      status: 'idle', currentTaskId: 'task_3', step: null, pct: null, blockers: [],
    },
    {
      id: 'm3', teamId: 'team_other', name: '别人家的成员', agentSessionId: 'c-other',
      status: 'running', blockers: [],
    },
  ],
};
const TASKS = {
  items: [
    { id: 'task_1', teamId: 'team_t1', subject: '写大纲', assignee: 'm1', status: 'running', plan: [1, 2, 3, 4] },
    { id: 'task_2', teamId: 'team_t1', subject: '写第一章', assignee: 'm2', status: 'done', plan: [] },
    { id: 'task_3', teamId: 'team_t1', subject: '审稿', assignee: 'm5', status: 'running', plan: [] },
  ],
};
const EVENTS = {
  items: [
    { id: 1, seq: 1, ts: '2026-10-29T07:00:00.000Z', phase: 'exec', action: 'file.write', target: 'chapters/01.md', result: 'OK', memberId: 'm1' },
    { id: 2, seq: 2, ts: '2026-10-29T07:01:00.000Z', phase: 'verify', action: 'npm publish', target: 'pkg', result: 'FAIL:EPERM', memberId: 'm1' },
    { id: 3, seq: 3, ts: '2026-10-29T07:02:00.000Z', phase: 'exec', action: 'file.read', target: 'outline.md', result: 'OK', memberId: 'm2' },
  ],
};

// m5 的步骤清单：内置 todo → plan 同步后的样子
const TODOS = {
  items: [
    { id: 'td1', teamId: 'team_t1', taskId: 'task_3', memberId: 'm5', title: '读大纲', status: 'done', orderNo: 0 },
    { id: 'td2', teamId: 'team_t1', taskId: 'task_3', memberId: 'm5', title: '写评语', status: 'active', orderNo: 1 },
    { id: 'td3', teamId: 'team_t1', taskId: 'task_3', memberId: 'm5', title: '改错字', status: 'open', orderNo: 2 },
  ],
};
let definition;
const requested = [];
let serveStatus = true;
// 假 document：ensureStyles() 应把「全局唯一一份」样式挂到 head（不在组件树里）
const headChildren = [];
const sandbox = {
  window: {
    __ModuleLoader__: { load: (def) => { definition = def; } },
    innerWidth: 1280,
    innerHeight: 800,
  },
  document: {
    head: { appendChild: (node) => { headChildren.push(node); } },
    getElementById: (id) => headChildren.find((node) => node.id === id) || null,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
    // 胶囊按钮：卡片要贴着它正下方弹出
    querySelector: (selector) => (String(selector).includes('data-dsh-team-pill')
      ? { getBoundingClientRect: () => ({ width: 120, right: 1200, bottom: 40 }) }
      : null),
  },
  console,
  fetch: async (url) => {
    requested.push(url);
    if (url.endsWith('/status') && !serveStatus) return { ok: false, status: 503, json: async () => ({}) };
    const body = url.endsWith('/status')
      ? STATUS
      : url.endsWith('/teams')
        ? { items: [TEAM] }
        : url.includes('/tasks?team=')
          ? TASKS
          : url.includes('/todos?team=')
            ? TODOS
            : url.includes('/events/history')
              ? EVENTS
              : null;
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  },
  URLSearchParams,
  Promise,
  setTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  Date,
  Object,
  Array,
  String,
  JSON,
  Map,
  Set,
  Math,
};
vm.runInNewContext(source, sandbox, { filename: CLIENT });
assert.ok(definition && typeof definition.factory === 'function', 'client.js 应通过 __ModuleLoader__ 导出 factory');

const plugin = definition.factory((name) => {
  assert.equal(name, 'react');
  return React;
});

// --- 假 ctx：捕获 slot 注册，服务可注入 ---
const registrations = [];
const services = { sessions: { subagentAddress: () => undefined } };
const ctx = {
  get: (name) => services[name],
  getService: (name) => services[name],
  effect: (fn) => { fn(); return () => {}; },
  on: () => () => {},
  slots: {
    inject: (slot, cb) => { cb(); return () => {}; },
    register: (desc, component) => { registrations.push({ desc, component }); return () => {}; },
  },
  // t() 桩：带变量的 key 渲染成 key[值1,值2]，其余原样返回 key，便于断言
  locale: {
    register: () => {},
    bind: () => (key, vars) => (vars ? key + '[' + Object.keys(vars).map((k) => vars[k]).join(',') + ']' : key),
  },
};

plugin.apply(ctx);

// 样式必须在 head 里只有一份：亮/暗主题走 --dsw-alias-* token，卡片里不应再塞 <style>
assert.equal(headChildren.length, 1, '插件样式只注入一次到 <head>');
assert.equal(headChildren[0].id, 'dsh-team-ui-styles', '样式节点 id');
assert.match(headChildren[0].textContent, /\.dsht-afc-dock\s*\{/, '样式含浮层样式');
assert.match(headChildren[0].textContent, /\.ui-afc__card\s*\{/, '样式含 affectui 卡片样式');
assert.match(headChildren[0].textContent, /--dsw-alias-bg-overlay/, '卡片配色绑定宿主主题 token');
assert.ok(headChildren[0].textContent.includes('backdrop-filter:blur(24px)'), '卡片用磨砂玻璃背景（backdrop-filter）');
assert.ok(
  headChildren[0].textContent.includes('--ui-afc-card: color-mix(in srgb, var(--dsw-alias-bg-overlay) 72%, transparent)'),
  '卡片底色半透明，才能透出磨砂',
);
assert.ok(headChildren[0].textContent.includes('@supports not ((backdrop-filter'), '不支持 backdrop-filter 时有不透明兜底');

const strip = registrations.find((r) => r.desc && r.desc.name === 'conversation.session.header.utilities');
assert.ok(strip, '应注册 conversation.session.header.utilities');
assert.equal(strip.desc.id, 'dsh-team:members', 'slot 条目 id');

const dock = registrations.find((r) => r.desc && r.desc.name === 'shell.overlay');
assert.ok(dock, '应把卡片注册到 shell.overlay（frame-wide 浮层）');
assert.equal(dock.desc.id, 'dsh-team:findings', '浮层条目 id');

// --- 会话状态源：s1 有 2 个团队成员子会话，s9 有一个非团队子会话 ---
const byId = {
  c1: { id: 'c1', parentId: 's1', origin: 'subagent', running: true },
  c2: { id: 'c2', parentId: 's1', origin: 'subagent', running: false },
  c5: { id: 'c5', parentId: 's1', origin: 'subagent', running: false },
  c9: { id: 'c9', parentId: 's9', origin: 'subagent', running: true },
  s1: { id: 's1', parentId: null, origin: 'user', running: true },
};
const useSessions = (selector) => selector({ byId });

// --- 工具：遍历 stub 树 ---
const flatten = (node) => {
  if (node == null || node === false) return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (typeof node === 'object' && node.type) {
    if (typeof node.type === 'function') return flatten(node.type(node.props));
    return [node, ...node.children.flatMap(flatten)];
  }
  return [];
};
const textOf = (node) => {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props));
    return node.children ? node.children.map(textOf).join('') : '';
  }
  return String(node);
};
const byClass = (node, cls) => flatten(node).filter((el) => typeof el.props.className === 'string' && el.props.className.split(/\s+/).includes(cls));

// --- 第一帧：还没拿到 sidecar 快照，先什么都不渲染（避免非团队会话闪一下空入口）---
assert.equal(strip.component({ sessionId: 's1', useSessions }), null, '快照未到时不渲染');

// --- 等轮询首次返回，再渲染：团队名 / 运行中 n/m / 计数 ---
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(requested.some((u) => u === '/dsh-team-api/api/status'), '通过 Host 代理读 /status');

const pill = strip.component({ sessionId: 's1', useSessions });
assert.equal(pill.props['data-dsh-team-pill'], TEAM.id, 'pill 绑定团队 id');
assert.equal(pill.props['aria-expanded'], 'true', '有运行中成员时卡片自动展开');
assert.equal(textOf(byClass(pill, 'dsht-afc-pill-name')[0]), '小说团队', 'pill 显示团队名');
assert.equal(textOf(byClass(pill, 'dsht-afc-pill-run')[0]), 'running_of[2,4]', '运行中 2 / 成员 4（不含他会话成员；idle 但有 running 任务的也算运行中）');

const sevs = byClass(pill, 'dsht-afc-pill-sev');
assert.equal(sevs.length, 2, '严重/警告两个计数');
assert.equal(sevs[0].props['data-severity'], 'critical');
assert.equal(textOf(sevs[0]), '1', 'blocker 之外的失败事件计 1 条严重');
assert.equal(sevs[1].props['data-severity'], 'warning');
assert.equal(textOf(sevs[1]), '1', 'scope_request 计 1 条警告');

// --- 浮层卡片：成员进度 + 最新发现 ---
const card = dock.component({});
assert.ok(card, '卡片展开时浮层渲染');
// 卡片必须贴着胶囊按钮（bottom 40 / right 1200，视口 1280）下方弹出，而不是钉在窗口右上角
assert.equal(card.props.style.top, '48px', '浮层贴在按钮下方（bottom 40 + 8）');
assert.equal(card.props.style.right, '80px', '浮层右边与按钮右边对齐（视口 1280 - 1200）');
assert.equal(card.props.style['--dsht-dock-max'], '736px', '卡片高度上限按剩余视口算');
assert.equal(card.props['data-dsh-team-card'], TEAM.id);
const afc = byClass(card, 'ui-afc')[0];
assert.ok(afc, '卡片本体是 affectui AgentFindings');
assert.equal(afc.props['data-dsh-team-findings'], 4, '四个团队成员行');

const agentRows = byClass(card, 'ui-afc__agent');
assert.equal(agentRows.length, 4);
assert.equal(textOf(byClass(agentRows[0], 'ui-afc__name')[0]), 'plot-designer');
assert.equal(textOf(byClass(agentRows[0], 'ui-afc__count')[0]), '2/4', '当前任务 plan 进度 2/4');
assert.ok(textOf(agentRows[2]).includes('未知状态'), '未知状态兜底成本地文案，不露 status_* 原始 key');
assert.ok(!textOf(agentRows[2]).includes('status_'), '卡片里不出现原始 i18n key');
assert.equal(byClass(agentRows[0], 'ui-afc__fill')[0].props.style.width, '50%');
assert.equal(textOf(byClass(agentRows[1], 'ui-afc__count')[0]), '1/1', '已完成任务的成员进度 1/1');

// --- 运行中判定：sidecar 把成员写成 idle，但任务还在 running ⇒ 仍画成运行中（不再灰成「已完成」）---
const m5Row = agentRows.find((row) => textOf(byClass(row, 'ui-afc__name')[0]) === 'reviewer');
assert.ok(m5Row, 'reviewer 成员行');
assert.equal(m5Row.props['data-status'], 'running', 'idle 成员 + running 任务 ⇒ 画成运行中');
assert.equal(textOf(byClass(m5Row, 'ui-afc__count')[0]), '1/3', '进度按步骤清单算（1 done / 3 步）');
assert.equal(textOf(byClass(m5Row, 'ui-afc__step')[0]), '写评语', '行内显示当前步骤');
assert.match(byClass(m5Row, 'ui-afc__fill')[0].props.style.width, /^33\.33+%$/, '进度条按 1/3 填充');

// --- 点成员行展开它的步骤清单（计划来自 sidecar 的 todo 表）---
m5Row.props.onClick();
const expanded = dock.component({});
const steps = byClass(expanded, 'ui-afc__plan-step');
assert.equal(steps.length, 3, '展开后显示三步计划');
assert.equal(textOf(byClass(steps[0], 'ui-afc__plan-title')[0]), '读大纲');
assert.equal(steps[0].props['data-status'], 'done');
assert.ok(byClass(steps[0], 'ui-afc__plan-icon').length === 1, '完成的步骤用图标标记');
assert.equal(steps[1].props['data-status'], 'active', '第二步进行中');
assert.ok(byClass(steps[1], 'ui-afc__plan-icon').length === 1, '进行中的步骤用图标标记');
assert.equal(textOf(byClass(expanded, 'ui-afc__plan-count')[0]), '1/3', '计划头部显示完成比');
assert.equal(steps[2].props['data-status'], 'open');
const chipped = byClass(expanded, 'ui-afc__chip')[0];
chipped.props.onClick(); // 用顶部 chip 取消筛选，后续断言不受影响
assert.equal(byClass(dock.component({}), 'ui-afc__plan-step').length, 0, '取消选中后计划清单收起');
assert.ok(headChildren[0].textContent.includes('.ui-afc__plan-step'), '样式里含计划清单规则');

const findings = byClass(card, 'ui-afc__finding');
assert.equal(findings.length, 4, '1 条 blocker + 3 条事件 = 4 条发现');
assert.match(textOf(byClass(card, 'ui-afc__ftitle')[0]), /npm publish/, '最新的失败事件排在最前');
const firstBody = byClass(findings[0], 'ui-afc__body')[0];
assert.ok(firstBody, '发现行有标题/元信息两行容器');
assert.equal(byClass(firstBody, 'ui-afc__ftitle').length, 1, '标题在容器内');
assert.equal(byClass(firstBody, 'ui-afc__meta').length, 1, '元信息与标题同容器、分行渲染（不再同一行叠字）');

// --- 点发现：用 subagentchat 资源在右侧栏打开该成员的对话 ---
const calls = [];
services.sidebarRight = { openResource: (url, opts) => calls.push({ url, opts }) };
findings[0].props.onClick();
assert.equal(calls.length, 1, '点发现应打开成员对话');
assert.equal(calls[0].url, 'dsh-resource://subagentchat/session/c1?parent=s1&mode=continuable', '用内置 subagentchat 页');
assert.equal(calls[0].opts.kind, 'subagentchat');

// --- 收起后再渲染：pill 变窄，浮层不渲染 ---
pill.props.onClick();
assert.equal(strip.component({ sessionId: 's1', useSessions }).props['aria-expanded'], 'false', '再点收起');
assert.equal(dock.component({}), null, '收起后浮层不渲染');

// --- 用户收起过就不会被下一轮轮询重新弹开（pinned 优先于「有人在跑自动展开」）---
assert.equal(strip.component({ sessionId: 's1', useSessions }).props['aria-expanded'], 'false', '轮询不覆盖用户选择');

// --- 轮询偶发失败：入口与浮层都保留上一份数据（只降权，不清屏）---
pill.props.onClick();
assert.ok(dock.component({}), '再次展开');
serveStatus = false;
strip.component({ sessionId: 's1', useSessions });
await new Promise((resolve) => setTimeout(resolve, 20));
const stale = strip.component({ sessionId: 's1', useSessions });
assert.ok(stale, '一次取不到快照不应让入口消失');
assert.equal(stale.props['data-dsh-team-stale'], '', '失败时 pill 标记为 stale');
assert.ok(dock.component({}), '浮层继续展示上一份数据');
serveStatus = true;

// --- 不是团队的子会话：pill 不渲染 ---
const nonTeam = strip.component({ sessionId: 's9', useSessions });
assert.equal(nonTeam, null, '子会话不属于任何团队时不渲染');

// --- 没有子会话 / 没有状态源：安全降级 ---
assert.equal(strip.component({ sessionId: 's-nobody', useSessions }), null, '无子会话返回 null');
assert.equal(strip.component({ sessionId: 's1' }), null, '缺 useSessions 时安全降级');

console.log('PASS ui-member-strip — 右上角团队卡片：pill 显示团队/运行中/严重·警告计数，浮层渲染 AgentFindings，点发现打开成员对话');
process.exit(0); // 渲染用的轮询/计时器会留在事件循环里，断言全过就显式退出


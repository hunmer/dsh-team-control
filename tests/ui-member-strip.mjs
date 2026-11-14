// tests/ui-member-strip.mjs — AC-16：聊天框上方的团队进度条 + 成员详情浮层
// 用 stub React 跑真实 dsh-plugin-ui/client.js：验证
//  - 只认本会话的子会话（= 团队成员），非团队会话不渲染
//  - 进度条注册在 conversation.input.dock（聊天框上方的全宽容器）
//  - 团队成员横向铺开：状态红点 / 名字 / Todo 进度；右侧是打开面板 / 停止
//  - 点成员 chip 才在 shell.overlay 弹出该成员的详情（单成员 AgentFindings），再点收起
//  - 解析到团队时自动推开一次右侧栏「编排」页（每会话一次，之后不再打扰）
//  - 成员计划清单常驻展开（不再折叠、不再有「最新发现」列表）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'dsh-plugin-ui', 'client.js');
const source = fs.readFileSync(CLIENT, 'utf8');

// --- stub React：hooks 立即求值，createElement 生成可遍历的普通对象 ---
// 惰性初始值（读 store / Date.now）每次渲染都重算，等价于「无状态」；
// 普通初始值（如停止弹窗状态）按调用点（client.js 行号）持有槽位，set 后下次渲染能读到新值。
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
  useRef: (initial) => ({ current: initial }),
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
      // 但它手上的任务依然是 running —— 进度条必须按任务画成运行中。
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
const calls = [];
let serveStatus = true;
// 假 document：ensureStyles() 应把「全局唯一一份」样式挂到 head（不在组件树里）
const headChildren = [];
const storage = new Map();
const sandbox = {
  window: {
    __ModuleLoader__: { load: (def) => { definition = def; } },
    innerWidth: 1280,
    innerHeight: 800,
    // AUTO_OPEN_KEY 依赖：记住「本会话已自动开过一次编排页」
    sessionStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
    },
  },
  document: {
    head: { appendChild: (node) => { headChildren.push(node); } },
    getElementById: (id) => headChildren.find((node) => node.id === id) || null,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
    // 成员 chip：浮层要贴着被点开的 chip 弹出
    querySelector: (selector) => (String(selector).includes('data-dsh-team-chip')
      ? { getBoundingClientRect: () => ({ width: 120, right: 1200, bottom: 40 }) }
      : null),
  },
  console,
  fetch: async (url, opts) => {
    requested.push(url);
    if (String(url).includes('/stop')) {
      calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
      return { ok: true, status: 200, json: async () => ({ item: { id: TEAM.id } }) };
    }
    if (url.endsWith('/status') && !serveStatus) return { ok: false, status: 503, json: async () => ({}) };
    const body = url.endsWith('/status')
      ? STATUS
      : url.includes('/teams/by-lead/')
        ? { item: TEAM }
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
const opened = [];
const panels = [];
const services = {
  sessions: { subagentAddress: () => undefined },
  sidebarRight: {
    openResource: (url, opts) => { opened.push({ url, opts }); },
    openTab: (kind) => { panels.push(kind); },
  },
};
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
assert.match(headChildren[0].textContent, /\.dsht-afc-dock\s*\{/, '样式含成员详情浮层');
assert.ok(headChildren[0].textContent.includes('.dsht-afc-bar {'), '样式含聊天框上方的进度条');
assert.ok(headChildren[0].textContent.includes('.dsht-afc-member-icon'), '样式含成员模型图标');
assert.ok(!headChildren[0].textContent.includes('.dsht-afc-member-track'), '不再渲染成员迷你进度条');
assert.ok(!headChildren[0].textContent.includes('.dsht-afc-bar-close'), '不再有收起按钮样式');
assert.ok(!headChildren[0].textContent.includes('dsht-afc-pill'), '旧胶囊样式已移除');
assert.match(headChildren[0].textContent, /\.ui-afc__card\s*\{/, '样式含 affectui 卡片样式');
assert.match(headChildren[0].textContent, /--dsw-alias-bg-overlay/, '卡片配色绑定宿主主题 token');
assert.ok(headChildren[0].textContent.includes('backdrop-filter:blur(24px)'), '卡片用磨砂玻璃背景（backdrop-filter）');
assert.ok(
  headChildren[0].textContent.includes('--ui-afc-card: color-mix(in srgb, var(--dsw-alias-bg-overlay) 72%, transparent)'),
  '卡片底色半透明，才能透出磨砂',
);
assert.ok(headChildren[0].textContent.includes('@supports not ((backdrop-filter'), '不支持 backdrop-filter 时有不透明兜底');

const barReg = registrations.find((r) => r.desc && r.desc.name === 'conversation.input.dock');
assert.ok(barReg, '应注册 conversation.input.dock（聊天框上方的全宽容器）');
assert.equal(barReg.desc.id, 'dsh-team:members', 'slot 条目 id');

const dock = registrations.find((r) => r.desc && r.desc.name === 'shell.overlay');
assert.ok(dock, '应把成员详情注册到 shell.overlay（frame-wide 浮层）');
assert.equal(dock.desc.id, 'dsh-team:findings', '浮层条目 id');

// --- 会话状态源：s1 有 3 个团队成员子会话，s9 有一个非团队子会话 ---
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
const byData = (node, attr, value) => flatten(node).filter((el) => el.props[attr] === value);

// --- 第一帧：还没拿到 sidecar 快照，先什么都不渲染（避免非团队会话闪一下空入口）---
assert.equal(barReg.component({ sessionId: 's1', useSessions }), null, '快照未到时不渲染');

// --- 等轮询首次返回，再渲染：团队名 / 状态点+数量 / 计数 ---
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(requested.some((u) => u === '/dsh-team-api/api/status'), '通过 Host 代理读 /status');

// 解析到团队（by-lead 500ms 后首次查询）自动把「编排」页推到右侧栏，但每会话只推一次
await new Promise((resolve) => setTimeout(resolve, 600));
assert.ok(requested.some((u) => u.includes('/api/teams/by-lead/s1')), '解析本会话团队');
assert.deepEqual(panels, ['dsh-team:panel'], '团队创建时自动打开一次右侧栏编排页');
assert.equal(storage.get('dsh-team.autoopen.v1.s1'), '1', '记住已自动打开，之后不再打扰');

const bar = barReg.component({ sessionId: 's1', useSessions });
assert.ok(bar, '解析到团队后渲染进度条');
assert.equal(bar.props.className, 'dsht-afc-bar');
assert.equal(bar.props['data-dsh-team-bar'], TEAM.id, '进度条绑定团队 id');
assert.equal(bar.props['data-dsh-team-stale'], undefined, '成功快照不标记 stale');
assert.equal(textOf(byClass(bar, 'dsht-afc-bar-name')[0]), '小说团队', '左侧展示团队名');
const live = byClass(bar, 'dsht-afc-bar-live')[0];
assert.ok(live, '标题旁是状态点 + 运行中数量');
assert.equal(live.props['data-status'], 'running', '有运行中成员时状态点为运行中');
assert.equal(textOf(live), '2', '只显示数量，不再显示「运行中 2/4」');
assert.equal(byClass(live, 'dsht-afc-bar-dot').length, 1, '数量前有一个状态点');
assert.equal(live.props.title, 'running_of[2,4]', '完整 n/m 仍放在 tooltip 里');

const sevs = byClass(bar, 'dsht-afc-bar-sev');
assert.equal(sevs.length, 1, '只保留严重计数，警告标记已移除');
assert.equal(sevs[0].props['data-severity'], 'critical');
assert.equal(textOf(sevs[0]), '1', 'blocker 之外的失败事件计 1 条严重');

// --- 成员横向铺开：每人一个 chip（状态红点 + 名字 + Todo 进度）---
const chips = byClass(bar, 'dsht-afc-member');
assert.equal(chips.length, 4, '四个团队成员横向铺开');
assert.deepEqual(chips.map((c) => c.props['data-dsh-team-chip']),
  ['team_t1:m1', 'team_t1:m2', 'team_t1:m4', 'team_t1:m5'], 'chip 带团队+成员 id，顺序稳定');
assert.ok(chips.every((c) => c.props['aria-pressed'] === 'false'), '未点开时全部收起');
assert.equal(textOf(byClass(chips[0], 'dsht-afc-member-name')[0]), 'plot-designer');
assert.equal(textOf(byClass(chips[0], 'dsht-afc-member-count')[0]), '2/4', 'm1 的 plan 进度 2/4');
const m1Icon = byClass(chips[0], 'dsht-afc-member-icon')[0];
assert.ok(m1Icon, '每位成员在名字前有模型图标');
assert.equal(flatten(m1Icon).filter((el) => el.type === 'img').length, 1, 'GLM 模型显示品牌图标');
assert.equal(m1Icon.props['data-logo'], '', '有品牌图标时打上 data-logo');
assert.equal(byClass(m1Icon, 'dsht-afc-member-dot').length, 1, '状态红点挂在模型图标容器里（右下角）');
assert.ok(headChildren[0].textContent.includes('.dsht-afc-member-icon { position:relative'), '图标容器是红点的定位基准');
assert.ok(/\.dsht-afc-member-dot \{[^}]*right:-2px;[^}]*bottom:-2px/.test(headChildren[0].textContent), '红点定位到图标右下角');
assert.equal(byClass(chips[0], 'dsht-afc-member-dot').length, 1, '每人恰好一个状态红点');
assert.equal(byClass(chips[0], 'dsht-afc-member-track').length, 0, 'chip 不再有迷你进度条，只保留 current/max');

const m5Chip = chips.find((c) => c.props['data-dsh-team-chip'] === 'team_t1:m5');
assert.ok(m5Chip, 'reviewer 的 chip');
assert.equal(m5Chip.props['data-status'], 'running', 'idle 成员 + running 任务 ⇒ 画成运行中');
assert.equal(textOf(byClass(m5Chip, 'dsht-afc-member-count')[0]), '1/3', '进度按步骤清单算（1 done / 3 步）');
const m5Icon = byClass(m5Chip, 'dsht-afc-member-icon')[0];
assert.equal(textOf(byClass(m5Icon, 'dsht-afc-member-initials')[0]), 'R', '没有模型信息时回退首字母');
assert.equal(m5Icon.props['data-logo'], undefined, '回退首字母时不打 data-logo');
assert.equal(byClass(m5Icon, 'dsht-afc-member-dot').length, 1, '回退首字母时红点仍在图标右下角');

const m4Chip = chips.find((c) => c.props['data-dsh-team-chip'] === 'team_t1:m4');
assert.equal(m4Chip.props['data-status'], 'idle', '未知状态不炸，归一到 idle 兜底');
assert.equal(textOf(byClass(m4Chip, 'dsht-afc-member-count')[0]), '0/1', '没有任务也没有 pct 时按「未完成/1」兜底');

// --- 手动发消息唤醒已停止成员：会话实时在跑，但快照里还是 done/idle → 用 useSessionStatus 补成运行中 ---
const liveMap = new Map([['c2', { running: true }]]);
const liveBar = barReg.component({ sessionId: 's1', useSessions, useSessionStatus: (selector) => selector(liveMap) });
const liveChip = byClass(liveBar, 'dsht-afc-member').find((c) => c.props['data-dsh-team-chip'] === 'team_t1:m2');
assert.equal(liveChip.props['data-status'], 'running', '会话正在跑时，快照里的已完成成员也画成运行中');
assert.equal(textOf(byClass(liveBar, 'dsht-afc-bar-live')[0]), '3', '标题旁数量跟着实时状态走');

// 没有 useSessionStatus 时退回会话行自带的 running 标记
byId.c2.running = true;
const rowBar = barReg.component({ sessionId: 's1', useSessions });
const rowChip = byClass(rowBar, 'dsht-afc-member').find((c) => c.props['data-dsh-team-chip'] === 'team_t1:m2');
assert.equal(rowChip.props['data-status'], 'running', '会话行的 running 也能把灰点补成运行中');
byId.c2.running = false;

// --- 右侧：打开面板 / 停止团队 两个动作（不再有收起按钮）---
const actions = byClass(bar, 'dsht-afc-bar-actions')[0];
assert.ok(actions, '右侧操作区');
assert.deepEqual(actions.children.map((c) => c.props.className), ['dsht-afc-bar-open', 'dsht-afc-bar-stop'],
  '打开面板 / 停止并排，关闭靠再点成员 chip 或 Esc');
const openLink = actions.children[0];
assert.ok(String(openLink.props.href).includes('team_t1'), '打开面板链接带当前团队');
assert.equal(openLink.props.target, '_blank');

// --- 点成员 chip 才弹成员详情；再点同一个收起 ---
assert.equal(dock.component({}), null, '默认收起时浮层不渲染');
chips[0].props.onClick();
let card = dock.component({});
assert.ok(card, '点成员后浮层渲染');
// 浮层必须贴着被点开的 chip（bottom 40 / right 1200，视口 1280）下方弹出，而不是钉在窗口右上角
assert.equal(card.props.style.top, '48px', '浮层贴在 chip 下方（bottom 40 + 8）');
assert.equal(card.props.style.right, '80px', '浮层右边与 chip 右边对齐（视口 1280 - 1200）');
assert.equal(card.props.style['--dsht-dock-max'], '640px', '浮层高度上限 = 80% 视口');
assert.equal(card.props['data-dsh-team-card'], TEAM.id);
assert.equal(card.props['data-dsh-team-focus'], 'm1', '浮层聚焦被点开的成员');
const afc = byClass(card, 'ui-afc')[0];
assert.ok(afc, '详情本体是 affectui AgentFindings');
assert.equal(afc.props['data-dsh-team-findings'], 1, '只画被点开的这一个成员');
assert.equal(byClass(card, 'ui-afc__agent').length, 1, '单成员详情');
assert.equal(barReg.component({ sessionId: 's1', useSessions }).props['data-dsh-team-stale'], undefined);
assert.equal(byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-member')[0].props['aria-pressed'], 'true',
  '被点开的 chip 高亮');

// --- 切到另一个成员：浮层换成该成员，计划清单常驻展开 ---
const m5Chip2 = byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-member')
  .find((c) => c.props['data-dsh-team-chip'] === 'team_t1:m5');
m5Chip2.props.onClick();
assert.equal(dock.component({}).props['data-dsh-team-focus'], 'm5', '点第二个成员切过去');
card = dock.component({});
const m5Row = byClass(card, 'ui-afc__agent')[0];
assert.equal(textOf(byClass(m5Row, 'ui-afc__name')[0]), 'reviewer');
assert.equal(m5Row.props['data-status'], 'running', 'idle 成员 + running 任务 ⇒ 画成运行中');
assert.equal(textOf(byClass(m5Row, 'ui-afc__count')[0]), '1/3', '进度按步骤清单算（1 done / 3 步）');
assert.equal(textOf(byClass(m5Row, 'ui-afc__step')[0]), '写评语', '行内显示当前步骤');

// 两行布局：第一行 状态圆点 + 图标 + 名称 + 消息图标；第二行 当前任务（单行截断）+ 进度 + 完成比
assert.equal(byClass(m5Row, 'ui-afc__dot').length, 1, '成员行有状态圆点');
const taskLine = byClass(m5Row, 'ui-afc__task')[0];
assert.ok(taskLine, '任务信息落在第二行容器');
for (const cls of ['ui-afc__step', 'ui-afc__track', 'ui-afc__count']) {
  assert.equal(byClass(taskLine, cls).length, 1, '第二行包含 ' + cls);
}
assert.deepEqual(m5Row.children.map((c) => (c && c.props && c.props.className) || ''),
  ['ui-afc__dot', 'ui-afc__avatar', 'ui-afc__who', 'ui-afc__chat', 'ui-afc__task'],
  '第一行圆点/图标/名称/消息图标，第二行任务');
assert.ok(headChildren[0].textContent.includes('.ui-afc__dot'), '样式里含状态圆点规则');
assert.ok(headChildren[0].textContent.includes('grid-template-areas:"dot avatar who chat"'), '两行网格在追加样式里');
assert.ok(headChildren[0].textContent.includes('.ui-afc__agent .ui-afc__step{grid-area:auto;min-width:0'), '任务行覆盖旧 grid-area');
assert.ok(headChildren[0].textContent.includes('grid-template-columns:8px auto minmax(0,1fr) auto'), '图标列按内容收缩');
assert.ok(!/\.ui-afc__avatar\s*\{[^}]*background/.test(headChildren[0].textContent), '头像不再有背景色');

// 计划清单常驻展开（不点选、无折叠）
assert.equal(typeof m5Row.props.onClick, 'undefined', '成员行不再可点选（计划常驻展开）');
assert.equal(m5Row.props['aria-pressed'], undefined, '成员行不再是折叠按钮');
const steps = byClass(card, 'ui-afc__plan-step');
assert.equal(steps.length, 3, '计划清单直接列在浮层里');
assert.deepEqual(steps.map((s) => textOf(byClass(s, 'ui-afc__plan-title')[0])), ['读大纲', '写评语', '改错字'], 'reviewer 三步计划全部展开');
assert.equal(steps[0].props['data-status'], 'done');
assert.ok(byClass(steps[0], 'ui-afc__plan-icon').length === 1, '完成的步骤用图标标记');
assert.equal(steps[1].props['data-status'], 'active', '第二步进行中');
assert.ok(byClass(steps[1], 'ui-afc__plan-icon').length === 1, '进行中的步骤用图标标记');
assert.equal(steps[2].props['data-status'], 'open');
assert.equal(textOf(byClass(card, 'ui-afc__plan-count')[0]), '1/3', '计划头部显示完成比');
assert.ok(headChildren[0].textContent.includes('.ui-afc__plan-step'), '样式里含计划清单规则');
assert.ok(byClass(card, 'ui-afc__finding').length === 0, '团队校验卡不再有「最新发现」列表');
assert.ok(byClass(card, 'ui-afc__chip').length === 0, '移除「最新发现」的成员筛选 chip');
assert.ok(!textOf(card).includes('最新发现'), '卡片里不再出现「最新发现」标题');

// --- 成员行右侧「查看对话」：有 agentSessionId 才有按钮，点了开子会话聊天面板 ---
const chatBtn = byClass(m5Row, 'ui-afc__chat')[0];
assert.ok(chatBtn, 'reviewer 行右侧有「查看对话」按钮');
assert.equal(chatBtn.props.title, '在侧栏打开该成员的对话', '按钮提示走字典');
chatBtn.props.onClick({ stopPropagation: () => {} });
assert.equal(opened.length, 1, '点「查看对话」调用 sidebarRight.openResource');
assert.equal(opened[0].opts.kind, 'subagentchat', '按子会话聊天面板打开');
assert.match(opened[0].url, /c5/, '打开的是该成员自己的会话');
assert.equal(dock.component({}), null, '在侧栏打开成员会话后浮层自动收起');
assert.equal(byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-member')[0].props['aria-pressed'], 'false',
  '收起后 chip 不再高亮');
assert.ok(headChildren[0].textContent.includes('.ui-afc__chat'), '样式里有对话按钮规则');
assert.ok(/\.dsht-afc-modal \{[^}]*position:fixed/.test(headChildren[0].textContent), '停止确认弹窗是固定定位遮罩');

// --- 停止团队：进度条右侧图标按钮 → 二次确认弹窗；弹窗里点「停止」才 POST /api/teams/{id}/stop ---
const stopBtn = byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-bar-stop')[0];
assert.ok(stopBtn, '进度条右侧有「停止团队」图标按钮');
assert.equal(textOf(stopBtn), '', '按钮只有图标，没有文字');
assert.equal(stopBtn.children.length, 1, '图标按钮内含一个 SVG');
assert.equal(stopBtn.props.disabled, false, '有成员在跑时可停止');
stopBtn.props.onClick();
let modal = byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-modal')[0];
assert.ok(modal, '点击图标弹出二次确认弹窗');
assert.ok(textOf(modal).includes('停止团队?'), '弹窗标题');
assert.ok(textOf(modal).includes('将中断所有运行中成员'), '弹窗说明会中断成员');
assert.equal(calls.length, 0, '弹窗确认前不发请求');
// 取消：弹窗关闭、不发请求
const modalBtns = () => byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-modal-btn');
modalBtns()[0].props.onClick();
assert.equal(byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-modal').length, 0, '取消后弹窗关闭');
assert.equal(calls.length, 0, '取消不发请求');
// 再来一次：点危险按钮才真正停止
byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-bar-stop')[0].props.onClick();
const okBtn = modalBtns()[1];
assert.match(okBtn.props.className, /is-danger/, '确认按钮是危险样式');
okBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(calls.length, 1, '弹窗确认后发出停止请求');
assert.match(calls[0].url, /\/api\/teams\/team_t1\/stop$/, '打到团队的 stop 路由');
assert.equal(calls[0].method, 'POST', '用 POST');
assert.match(String(calls[0].body), /reason/, '带停止原因');
assert.equal(byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-modal').length, 0, '成功后弹窗自动关闭');
const doneBtn = byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-bar-stop')[0];
assert.equal(doneBtn.props.disabled, true, '已停止后按钮短暂禁用');
assert.equal(doneBtn.props.title, '已停止', 'tooltip 提示已停止');

// --- 再点同一个成员收起浮层；用户收起过就不会被下一轮轮询重新弹开 ---
const m5ChipBtn = () => byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-member')
  .find((c) => c.props['data-dsh-team-chip'] === 'team_t1:m5');
m5ChipBtn().props.onClick();
assert.ok(dock.component({}), '先点开 m5 浮层');
m5ChipBtn().props.onClick();
assert.equal(dock.component({}), null, '再点同一个 chip 收起浮层');
assert.equal(byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-member')[3].props['aria-pressed'], 'false',
  '收起后 chip 取消高亮');
// 轮询落库不覆盖用户选择：模拟一次成功快照
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(dock.component({}), null, '轮询不重新弹开');

// --- 轮询偶发失败：进度条与已打开的浮层都保留上一份数据（只降权，不清屏）---
byClass(barReg.component({ sessionId: 's1', useSessions }), 'dsht-afc-member')[3].props.onClick();
assert.ok(dock.component({}), '再次展开');
serveStatus = false;
barReg.component({ sessionId: 's1', useSessions });
await new Promise((resolve) => setTimeout(resolve, 20));
const stale = barReg.component({ sessionId: 's1', useSessions });
assert.ok(stale, '一次取不到快照不应让入口消失');
assert.equal(stale.props['data-dsh-team-stale'], '', '失败时进度条标记为 stale');
assert.ok(dock.component({}), '浮层继续展示上一份数据');
serveStatus = true;

// --- 不是团队的子会话：进度条不渲染 ---
assert.equal(barReg.component({ sessionId: 's9', useSessions }), null, '子会话不属于任何团队时不渲染');

// --- 没有子会话 / 没有状态源：安全降级 ---
assert.equal(barReg.component({ sessionId: 's-nobody', useSessions }), null, '无子会话返回 null');
assert.equal(barReg.component({ sessionId: 's1' }), null, '缺 useSessions 时安全降级');

console.log('PASS ui-member-strip — 聊天框上方进度条：成员横向铺开、点成员看详情；右侧打开/停止');
process.exit(0); // 渲染用的轮询/计时器会留在事件循环里，断言全过就显式退出

/* dsh-team Web 面板 —— vanilla ES module，零第三方依赖、无构建、离线可用。
 * 数据原则：实时数据只来自 SSE；REST 仅首屏快照 / 重连补齐 / 操作。
 * 安全原则：所有服务端文本经 textContent / createTextNode 渲染（消息 payload、reason 均不可信）；
 *          token 只存内存，不写 sessionStorage / localStorage。
 */
'use strict';
/* ============================== 常量 / 状态 ============================== */
const TAB_NAMES = ['board', 'dag', 'timeline', 'permissions', 'approvals', 'messages'];
const PHASES = ['init', 'read', 'write', 'exec', 'net', 'env', 'msg', 'wait', 'verify', 'interrupt', 'resume', 'done', 'fail', 'decision', 'recover'];
const DOMAIN_LIST = ['fs', 'exec', 'net', 'env'];
const SSE_TYPES = ['member.status', 'step.append', 'task.state', 'message.delivered', 'scope.request', 'decision', 'lease.warn'];
const TIMELINE_CAP = 2000;
const STORE_UI = 'dsh-team.panel.ui.v1';
const STORE_LAST = 'dsh-team.panel.lastEventId.v1';
const SVG_NS = 'http://www.w3.org/2000/svg';
const state = {
  token: '', urlParsed: false, booting: false, teamFromUrl: '', teamId: null, team: null,
  teams: [], initialized: false, noTeams: false,
  members: [], memberNames: new Map(), staleMembers: new Set(), degraded: false, snapshot: null,
  dag: null, matrix: [], policies: [], scopeRequests: [], messages: [],
  errors: { status: null, dag: null, permissions: null, policies: null, approvals: null, messages: null, timeline: null },
  timeline: [], timelineIds: new Set(), pendingTimeline: [], paused: false, speed: 1, playbackTimer: null,
  tab: 'board', filters: { member: '', phase: '' },
  conn: 'connecting', es: null, lastEventId: 0, reconnectAttempt: 0, reconnectTimer: null,
  authProbing: false, resyncPromise: null,
};
/* ============================== DOM 工具（全部 textContent 渲染） ============================== */
const $ = (selector, root) => (root || document).querySelector(selector);
const $all = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));
function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
function appendKids(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'style') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'on') for (const name of Object.keys(value)) node.addEventListener(name, value[name]);
      else if (key === 'attrs') for (const attr of Object.keys(value)) node.setAttribute(attr, String(value[attr]));
      else if (key in node) node[key] = value;
      else node.setAttribute(key, String(value));
    }
  }
  appendKids(node, kids);
  return node;
}
function svgEl(tag, attrs, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}
const pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(ts) {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime())
    ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0') : '—';
}
function fmtDateTime(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function fmtAgo(ts) {
  const t = ts ? new Date(ts).getTime() : NaN;
  if (Number.isNaN(t)) return '—';
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 2) return '刚刚';
  if (secs < 60) return secs + 's 前';
  if (secs < 3600) return Math.floor(secs / 60) + 'm 前';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h 前';
  return Math.floor(secs / 86400) + 'd 前';
}
const truncate = (text, max) => { const str = String(text === null || text === undefined ? '' : text); return str.length > max ? str.slice(0, max - 1) + '…' : str; };
const enc = (value) => encodeURIComponent(String(value));
const pickItems = (response) => Array.isArray(response) ? response : (response && Array.isArray(response.items) ? response.items : []);
const safeClass = (value) => String(value || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'unknown';
const storeGet = (key) => { try { return sessionStorage.getItem(key); } catch (err) { return null; } };
const storeSet = (key, value) => { try { sessionStorage.setItem(key, value); } catch (err) { /* 隐私模式忽略 */ } };
/* ============================== 网络层 ============================== */
class ApiError extends Error {
  constructor(code, message, path) {
    super(message || code || 'request failed');
    this.name = 'ApiError';
    this.code = code || 'E_UNKNOWN';
    this.path = path;
  }
}
async function api(path, options) {
  const opts = options || {};
  const headers = { Authorization: 'Bearer ' + state.token };
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch(path, { method: opts.method || 'GET', headers, body });
  } catch (err) {
    throw new ApiError('E_NETWORK', '网络请求失败（' + path + '）：' + (err && err.message ? err.message : String(err)), path);
  }
  if (response.status === 401) {
    authOverlay();
    throw new ApiError('E_UNAUTHORIZED', '未授权（401）：token 无效或已轮换', path);
  }
  if (!response.ok) {
    let detail = null;
    try { const payload = await response.json(); detail = payload && payload.error ? payload.error : null; } catch (err) { /* 非 JSON */ }
    throw new ApiError((detail && detail.code) || ('HTTP_' + response.status), (detail && detail.message) || ('HTTP ' + response.status + ' ' + response.statusText), path);
  }
  if (opts.raw) return response;
  if (opts.text) return response.text();
  try { return await response.json(); } catch (err) { return {}; }
}
/* ============================== 视图状态持久化 ============================== */
function loadUiState() {
  const raw = storeGet(STORE_UI);
  if (raw) {
    try {
      const ui = JSON.parse(raw);
      if (ui && TAB_NAMES.indexOf(ui.tab) >= 0) state.tab = ui.tab;
      if (ui && ui.filters) {
        state.filters.member = String(ui.filters.member || '');
        state.filters.phase = String(ui.filters.phase || '');
      }
      state.paused = !!ui.paused;
      state.speed = ui.speed === 4 ? 4 : 1;
    } catch (err) { /* 损坏的存储忽略 */ }
  }
  const last = Number(storeGet(STORE_LAST));
  if (Number.isFinite(last) && last > 0) state.lastEventId = last;
}
function saveUiState() {
  storeSet(STORE_UI, JSON.stringify({ tab: state.tab, filters: { member: state.filters.member, phase: state.filters.phase }, paused: state.paused, speed: state.speed }));
}
/* ============================== 提示 / 遮罩 ============================== */
function toast(message, kind, ttl) {
  const box = $('#toasts');
  if (!box) return;
  const node = el('div', { class: 'toast ' + (kind || ''), text: String(message) });
  box.appendChild(node);
  setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, typeof ttl === 'number' ? ttl : (kind === 'error' ? 8000 : 4200));
  while (box.childElementCount > 6) box.removeChild(box.firstChild);
}
function toastError(prefix, err) { toast(prefix + '：' + (err && err.message ? err.message : String(err)), 'error'); }
function showOverlay(title, detail, actions) {
  const overlay = $('#overlay');
  if (!overlay) return;
  overlay.hidden = false;
  overlay.classList.remove('hidden');
  const titleNode = $('#overlay-title');
  const detailNode = $('#overlay-detail');
  if (titleNode) titleNode.textContent = String(title || '错误');
  if (detailNode) detailNode.textContent = String(detail || '');
  const box = clear($('#overlay-actions'));
  for (const action of (actions || [])) box.appendChild(action);
}
function hideOverlay() {
  const overlay = $('#overlay');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.classList.add('hidden');
}
function reloadButton() { return el('button', { class: 'btn', type: 'button', text: '重新加载页面', on: { click: () => location.reload() } }); }
function tokenActions() {
  const input = el('input', { type: 'password', placeholder: '粘贴 token（来自 sidecar 启动横幅）', attrs: { 'aria-label': 'token' } });
  const go = el('button', { class: 'btn btn-primary', type: 'button', text: '使用 token 进入' });
  const submit = () => {
    const value = String(input.value || '').trim();
    if (!value) { toast('token 不能为空', 'warn'); return; }
    state.token = value;
    hideOverlay();
    boot();
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  return [input, go];
}
function authOverlay() {
  showOverlay('未授权（401）', 'token 无效或已轮换。请使用 sidecar 启动横幅中的 panel 链接（…/panel#token=<token>）重新打开，或在此粘贴 token。', tokenActions().concat([reloadButton()]));
}
function missingTokenOverlay() {
  showOverlay('缺少访问 token', '本面板通过 sidecar 的本地 token 鉴权。请使用启动横幅输出的 panel 链接（形如 127.0.0.1:4317/panel#token=<token>）打开，或在此粘贴 token。token 只保存在内存，不写入浏览器存储。', tokenActions().concat([reloadButton()]));
}
/* ============================== 连接状态 ============================== */
const CONN_LABELS = { connecting: '连接中…', live: '实时', reconnecting: '重连中…', offline: '离线' };
function setConn(kind) {
  state.conn = kind;
  const box = $('#conn');
  const text = $('#conn-text');
  if (box) box.className = 'conn conn-' + kind;
  if (text) text.textContent = CONN_LABELS[kind] || kind;
}
/* ============================== 成员看板 ============================== */
function heartbeatInfo(member) {
  if (!member || !member.leaseUntil) return { label: '无租约', cls: 'hb-none' };
  const t = new Date(member.leaseUntil).getTime();
  if (Number.isNaN(t)) return { label: '租约 —', cls: 'hb-none' };
  const overdue = Math.round((Date.now() - t) / 1000);
  if (overdue <= 0) return { label: '租约剩 ' + (-overdue) + 's', cls: 'hb-ok' };
  if (overdue > 30) return { label: '租约超期 ' + overdue + 's', cls: 'hb-red' };
  if (overdue > 15) return { label: '租约超期 ' + overdue + 's', cls: 'hb-yellow' };
  return { label: '租约超期 ' + overdue + 's', cls: 'hb-ok' };
}
function blockerText(blocker) {
  if (!blocker || typeof blocker !== 'object') return String(blocker);
  return [blocker.kind || 'blocker'].concat(blocker.id ? ['#' + blocker.id] : []).concat(blocker.detail ? [String(blocker.detail)] : []).join(' ');
}
function memberCard(member) {
  const status = String(member.status || 'queued');
  const hb = heartbeatInfo(member);
  const card = el('article', { class: 'member-card status-' + safeClass(status) + (member.stale ? ' is-stale' : ''), dataset: { memberId: member.id || '' } });
  if (member.stale) card.appendChild(el('span', { class: 'stale-tag', text: 'STALE', title: 'member_state.seq 与事件流不一致（C2 告警）' }));
  card.appendChild(el('div', { class: 'member-top' },
    el('span', { class: 'member-name', text: member.name || member.id || '?' }),
    el('span', { class: 'member-role', text: [member.role, member.model].filter(Boolean).join(' · ') }),
    el('span', { class: 'pill ' + safeClass(status), text: status })));
  const rows = el('dl', { class: 'member-rows' });
  const row = (label, value, dim) => rows.append(
    el('dt', { text: label }),
    el('dd', { class: dim ? 'dim' : '', text: value === null || value === undefined || value === '' ? '—' : String(value), title: String(value === null || value === undefined ? '' : value) }));
  row('step', member.step); row('seq', member.seq); row('task', member.currentTaskId);
  row('last', member.last); row('next', member.next);
  card.appendChild(rows);
  const blockers = Array.isArray(member.blockers) ? member.blockers : [];
  const chips = el('div', { class: 'blocker-chips' });
  if (blockers.length) for (const blocker of blockers) chips.appendChild(el('span', { class: 'chip blocker', text: blockerText(blocker), title: typeof blocker === 'object' ? JSON.stringify(blocker) : String(blocker) }));
  else chips.appendChild(el('span', { class: 'chip', text: '无阻塞' }));
  card.appendChild(chips);
  const pct = (typeof member.pct === 'number' && Number.isFinite(member.pct)) ? Math.max(0, Math.min(1, member.pct)) : null;
  card.appendChild(el('div', { class: 'card-foot' },
    el('span', { class: 'hb ' + hb.cls, dataset: { hb: '1' }, text: hb.label }),
    el('span', { text: pct === null ? 'pct —' : 'pct ' + Math.round(pct * 100) + '%' })));
  if (pct !== null) { const bar = el('div', { class: 'pct' + (pct >= 1 ? ' done' : '') }); bar.appendChild(el('i', { style: { width: Math.round(pct * 100) + '%' } })); card.appendChild(bar); }
  return card;
}
function renderBoardMeta() {
  const node = $('#board-meta');
  if (!node) return;
  const counts = { total: state.members.length };
  for (const member of state.members) counts[member.status] = (counts[member.status] || 0) + 1;
  const parts = [counts.total + ' 成员'];
  for (const status of ['running', 'blocked', 'idle', 'queued', 'interrupted', 'failed', 'done']) if (counts[status]) parts.push(status + ' ' + counts[status]);
  if (state.staleMembers.size) parts.push('stale ' + state.staleMembers.size);
  const overdue = state.members.filter((member) => member.leaseUntil && Date.now() - new Date(member.leaseUntil).getTime() > 15000).length;
  if (overdue) parts.push('租约超期 ' + overdue);
  if (state.degraded) parts.push('degraded');
  node.textContent = parts.join(' · ');
}
function renderBoard() {
  const box = $('#board');
  if (!box) return;
  clear(box);
  if (!state.teamId) box.appendChild(emptyState('未选择团队', '等待 /api/teams 返回团队列表后自动加载。'));
  else if (state.errors.status && !state.members.length) box.appendChild(emptyState('成员状态加载失败', state.errors.status));
  else if (!state.members.length) box.appendChild(emptyState('暂无成员', '团队创建后成员会出现在这里；数据由 SSE 实时刷新。'));
  else for (const member of state.members) box.appendChild(memberCard(member));
  renderBoardMeta();
}
/** 每秒只更新心跳文本，不整体重绘卡片。 */
function tickLeases() {
  for (const node of $all('#board [data-hb]')) {
    const card = node.closest('.member-card');
    if (!card) continue;
    const member = state.members.find((item) => item.id === card.dataset.memberId);
    if (!member) continue;
    const hb = heartbeatInfo(member);
    node.textContent = hb.label;
    node.className = 'hb ' + hb.cls;
  }
}
/* ============================== DAG（SVG 自绘） ============================== */
const NODE_W = 208, NODE_H = 74, DAG_GAP_X = 78, DAG_GAP_Y = 22, DAG_PAD = 24;
function layoutDag(nodes) {
  const byId = new Map(nodes.map((node) => [node.taskId, node]));
  const level = new Map();
  const visiting = new Set();
  const depth = (taskId) => {
    if (level.has(taskId)) return level.get(taskId);
    if (visiting.has(taskId)) return 0; // 防御环（服务端应已环检测）
    visiting.add(taskId);
    const node = byId.get(taskId);
    let maxDepth = 0;
    for (const dep of (node && Array.isArray(node.dependsOn) ? node.dependsOn : [])) maxDepth = Math.max(maxDepth, depth(dep) + 1);
    visiting.delete(taskId);
    level.set(taskId, maxDepth);
    return maxDepth;
  };
  for (const node of nodes) depth(node.taskId);
  const columns = new Map();
  for (const node of nodes) {
    const column = level.get(node.taskId) || 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  const columnKeys = Array.from(columns.keys()).sort((a, b) => a - b);
  const positions = new Map();
  let maxRows = 1;
  for (const columnKey of columnKeys) {
    const column = columns.get(columnKey).sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
    maxRows = Math.max(maxRows, column.length);
    column.forEach((node, index) => positions.set(node.taskId, { x: DAG_PAD + columnKey * (NODE_W + DAG_GAP_X), y: DAG_PAD + index * (NODE_H + DAG_GAP_Y) }));
  }
  const width = DAG_PAD * 2 + Math.max(1, columnKeys.length) * NODE_W + Math.max(0, columnKeys.length - 1) * DAG_GAP_X;
  const height = DAG_PAD * 2 + (maxRows - 1) * (NODE_H + DAG_GAP_Y) + NODE_H;
  return { positions, width: Math.max(width, 440), height: Math.max(height, 150) };
}
function dagEmpty(svg, text) {
  svg.setAttribute('viewBox', '0 0 480 120');
  svg.setAttribute('width', '480');
  svg.setAttribute('height', '120');
  svg.appendChild(svgEl('text', { x: '20', y: '64', class: 'dag-empty-text' }, String(text)));
}
function renderDagLegend() {
  const box = $('#dag-legend');
  if (!box || box.childElementCount) return;
  const add = (cls, label) => box.appendChild(el('span', {}, el('i', { class: cls }), label));
  for (const [cls, label] of [['lg-done', 'done'], ['lg-running', 'running'], ['lg-ready', 'ready'], ['lg-blocked', 'blocked'], ['lg-failed', 'failed'], ['lg-critical', 'critical path']]) add(cls, label);
}
function renderDag() {
  const svg = $('#dag-svg');
  const metaNode = $('#dag-meta');
  if (!svg) return;
  clear(svg);
  renderDagLegend();
  const setMeta = (text) => { if (metaNode) metaNode.textContent = text; };
  if (!state.teamId) { dagEmpty(svg, '未选择团队。'); setMeta('—'); return; }
  const dag = state.dag;
  const nodes = (dag && Array.isArray(dag.nodes)) ? dag.nodes : [];
  if (state.errors.dag && !nodes.length) { dagEmpty(svg, 'DAG 加载失败：' + state.errors.dag); setMeta('—'); return; }
  if (!nodes.length) { dagEmpty(svg, '暂无任务节点。用 POST /api/tasks / /api/deps 建图后这里显示依赖关系。'); setMeta('0 节点'); return; }
  const edges = (dag && Array.isArray(dag.edges)) ? dag.edges : [];
  const layout = layoutDag(nodes);
  svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  const readySet = new Set(Array.isArray(dag.ready) ? dag.ready : []);
  for (const node of nodes) if (node.ready) readySet.add(node.taskId);
  const criticalPath = Array.isArray(dag.criticalPath) ? dag.criticalPath : [];
  const criticalSet = new Set(criticalPath);
  const criticalPairs = new Set();
  for (let i = 1; i < criticalPath.length; i += 1) criticalPairs.add(criticalPath[i - 1] + '\u0000' + criticalPath[i]);
  const defs = svgEl('defs');
  for (const [id, cls] of [['dag-arrow', 'dag-arrow'], ['dag-arrow-crit', 'dag-arrow critical']]) {
    defs.appendChild(svgEl('marker', { id, viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: cls })));
  }
  svg.appendChild(defs);
  for (const edge of edges) {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x, y2 = to.y + NODE_H / 2;
    const curve = Math.max(24, Math.min(64, Math.abs(x2 - x1) / 2));
    const isCritical = criticalPairs.has(edge.from + '\u0000' + edge.to);
    const path = svgEl('path', {
      d: 'M' + x1 + ',' + y1 + ' C' + (x1 + curve) + ',' + y1 + ' ' + (x2 - curve) + ',' + y2 + ' ' + x2 + ',' + y2,
      class: 'dag-edge' + (isCritical ? ' is-critical' : '') + (readySet.has(edge.to) ? ' is-ready' : ''),
      'marker-end': isCritical ? 'url(#dag-arrow-crit)' : 'url(#dag-arrow)',
    });
    const title = svgEl('title');
    title.textContent = edge.from + ' → ' + edge.to + ' (' + (edge.condition || 'all_success') + ')' + (edge.artifactPath ? ' artifact=' + edge.artifactPath : '');
    path.appendChild(title);
    svg.appendChild(path);
    if (edges.length <= 12) {
      svg.appendChild(svgEl('text', { class: 'dag-edge-label', x: String((x1 + x2) / 2), y: String((y1 + y2) / 2 - 4), 'text-anchor': 'middle' },
        String(edge.condition || 'all_success').replace('_success', '').replace('artifact_exists', 'artifact')));
    }
  }
  for (const node of nodes) {
    const pos = layout.positions.get(node.taskId);
    if (!pos) continue;
    const classes = ['dag-node', 'status-' + safeClass(node.status || 'pending')];
    if (readySet.has(node.taskId)) classes.push('is-ready');
    if (node.blocked) classes.push('is-blocked');
    if (criticalSet.has(node.taskId)) classes.push('is-critical');
    const group = svgEl('g', { class: classes.join(' '), transform: 'translate(' + pos.x + ' ' + pos.y + ')' });
    group.appendChild(svgEl('rect', { width: NODE_W, height: NODE_H, rx: 6 }));
    const title = svgEl('title');
    title.textContent = [node.subject || node.taskId, node.taskId + ' · ' + (node.status || '?') + (node.assignee ? ' · ' + node.assignee : '') + ' · attempts ' + (node.attempts || 0)].join('\n');
    group.appendChild(title);
    group.appendChild(svgEl('text', { class: 'node-subject', x: '10', y: '20' }, svgEl('tspan', {}, truncate(node.subject || node.taskId, 26))));
    group.appendChild(svgEl('text', { class: 'node-meta', x: '10', y: '38' }, svgEl('tspan', {}, String(node.taskId || '') + ' · ' + String(node.status || '?'))));
    group.appendChild(svgEl('text', { class: 'node-meta', x: '10', y: '55' }, svgEl('tspan', {}, (node.assignee || '未指派') + ' · #' + (node.attempts || 0))));
    const tags = [];
    if (readySet.has(node.taskId)) tags.push('READY');
    if (node.blocked) tags.push('BLOCKED');
    if (criticalSet.has(node.taskId)) tags.push('CP');
    if (tags.length) group.appendChild(svgEl('text', { class: 'node-meta', x: String(NODE_W - 10), y: '20', 'text-anchor': 'end' }, svgEl('tspan', {}, tags.join(' '))));
    svg.appendChild(group);
  }
  const readyCount = nodes.filter((node) => readySet.has(node.taskId)).length;
  const blockedCount = nodes.filter((node) => node.blocked).length;
  const pathText = criticalPath.length ? ' · 关键路径 ' + criticalPath.join(' → ') : '';
  const version = state.snapshot && state.snapshot.version !== null ? ' · v' + state.snapshot.version : '';
  setMeta(nodes.length + ' 节点 · ' + edges.length + ' 依赖 · ready ' + readyCount + ' · blocked ' + blockedCount + pathText + version);
}
/* ============================== 权限矩阵 / 策略 ============================== */
function compactObject(object, separator) {
  const parts = [];
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value === null || value === undefined || value === '') continue;
    let text;
    if (Array.isArray(value)) text = value.map((item) => item && typeof item === 'object' ? JSON.stringify(item) : String(item)).join('|');
    else if (value && typeof value === 'object') text = compactObject(value, ' ');
    else text = String(value);
    parts.push(key + '=' + text);
  }
  return parts.length ? parts.join(separator) : '—';
}
function describeSummary(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '允许' : '拒绝';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => item && typeof item === 'object' ? compactObject(item, ' ') : String(item)).join(', ') : '—';
  if (typeof value === 'object') return compactObject(value, ' · ');
  return String(value);
}
function renderPermMeta() {
  const node = $('#perm-meta');
  const errorNode = $('#perm-error');
  if (node) {
    const parts = [state.matrix.length + ' 成员', state.policies.length + ' 策略'];
    if (state.snapshot && state.snapshot.version !== null) parts.push('v' + state.snapshot.version);
    node.textContent = parts.join(' · ');
  }
  if (errorNode) {
    const message = state.errors.permissions || state.errors.policies || '';
    errorNode.textContent = message ? '加载失败：' + message : '';
    errorNode.classList.toggle('hidden', !message);
  }
}
function renderMatrix() {
  const host = $('#perm-matrix');
  if (!host) return;
  clear(host);
  if (state.errors.permissions && !state.matrix.length) { host.appendChild(notice('权限矩阵加载失败：' + state.errors.permissions)); return; }
  if (!state.matrix.length) { host.appendChild(emptyState('暂无权限数据', '矩阵来自 GET /api/permission-matrix；默认拒绝，未授权即空。')); return; }
  const table = el('table');
  const head = el('tr');
  for (const label of ['成员', 'role', 'fs', 'exec', 'net', 'env']) head.appendChild(el('th', { text: label }));
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const item of state.matrix) {
    const row = el('tr');
    row.appendChild(el('td', {}, el('span', { class: 'subject', text: item.name || item.memberId || '?' }), el('div', { class: 'member-id', text: item.memberId || '' })));
    row.appendChild(el('td', { text: item.role || '—' }));
    for (const domain of DOMAIN_LIST) {
      const value = item[domain];
      const summary = describeSummary(value);
      row.appendChild(el('td', { class: 'domain-cell' + (typeof value === 'boolean' ? (value ? ' allow' : ' deny') : ''), text: summary, title: summary }));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}
function renderPolicies() {
  const host = $('#policy-list');
  if (!host) return;
  clear(host);
  if (state.errors.policies && !state.policies.length) { host.appendChild(notice('策略加载失败：' + state.errors.policies)); return; }
  if (!state.policies.length) { host.appendChild(notice('暂无策略。默认拒绝：没有 allow 规则的域的写 / 执行 / 连接 / 读密钥都会被拒绝。')); return; }
  const table = el('table');
  const head = el('tr');
  for (const label of ['mode', 'subject', 'domain', 'matcher', 'ops', '到期', '操作']) head.appendChild(el('th', { text: label }));
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const policy of state.policies) {
    const row = el('tr');
    row.appendChild(el('td', {}, el('span', { class: 'policy-mode ' + safeClass(policy.mode), text: policy.mode || '?' })));
    row.appendChild(el('td', {}, el('span', { class: 'subject', text: (policy.subjectType || '?') + ':' + (policy.subjectId || '*') })));
    row.appendChild(el('td', { class: 'mono', text: policy.domain || '—' }));
    row.appendChild(el('td', {}, el('span', { class: 'matcher', text: policy.matcher || '*', title: policy.matcher || '' })));
    row.appendChild(el('td', { class: 'ops', text: Array.isArray(policy.ops) ? policy.ops.join(',') : (policy.ops || '—') }));
    row.appendChild(el('td', { class: 'meta', text: policy.expiresAt ? fmtDateTime(policy.expiresAt) : '不过期' }));
    const remove = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '删除' });
    remove.addEventListener('click', () => deletePolicy(policy));
    row.appendChild(el('td', {}, remove));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}
async function deletePolicy(policy) {
  const label = (policy.mode || '?') + ' ' + (policy.domain || '?') + ' ' + (policy.matcher || '*') + '（' + (policy.subjectType || '?') + ':' + (policy.subjectId || '*') + '）';
  if (!window.confirm('确认删除策略 ' + label + ' ？删除后立即生效（AC-11 热更新）。')) return;
  try {
    await api('/api/policies/' + enc(policy.id), { method: 'DELETE' });
    toast('策略已删除，正在刷新权限矩阵…', 'ok');
    await refreshPermissions();
    renderPermissions();
    scheduleRender('banner');
  } catch (err) { toastError('删除策略失败', err); }
}
function renderPermissions() {
  renderPermMeta();
  renderMatrix();
  renderPolicies();
}
let pendingPolicyBody = null;
function bindPolicyForm() {
  const form = $('#policy-form');
  if (!form) return;
  const confirmBox = $('#policy-confirm');
  const errorBox = $('#policy-error');
  const showError = (message) => { if (errorBox) { errorBox.textContent = message || ''; errorBox.classList.toggle('hidden', !message); } };
  const hideConfirm = () => { if (confirmBox) { confirmBox.classList.add('hidden'); clear(confirmBox); } pendingPolicyBody = null; };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    showError('');
    hideConfirm();
    if (!state.teamId) { showError('请先选择团队。'); return; }
    let data;
    try { data = new FormData(form); } catch (err) { showError('表单读取失败。'); return; }
    const body = {
      teamId: state.teamId,
      subjectType: String(data.get('subjectType') || 'member'),
      subjectId: String(data.get('subjectId') || '').trim(),
      domain: String(data.get('domain') || 'fs'),
      matcher: String(data.get('matcher') || '').trim(),
      ops: String(data.get('ops') || '').split(',').map((item) => item.trim()).filter(Boolean),
      mode: String(data.get('mode') || 'allow'),
    };
    if (!body.subjectId) { showError('subject id 不能为空。'); return; }
    if (!body.matcher) { showError('matcher 不能为空。'); return; }
    if (!body.ops.length) { showError('ops 至少填一个（逗号分隔）。'); return; }
    const constraintsText = String(data.get('constraints') || '').trim();
    if (constraintsText) { try { body.constraints = JSON.parse(constraintsText); } catch (err) { showError('constraints 不是合法 JSON。'); return; } }
    const expiresText = String(data.get('expiresAt') || '');
    if (expiresText) {
      const expires = new Date(expiresText);
      if (Number.isNaN(expires.getTime())) { showError('expiresAt 不是合法时间。'); return; }
      body.expiresAt = expires.toISOString();
    }
    pendingPolicyBody = body;
    if (!confirmBox) return;
    clear(confirmBox);
    confirmBox.appendChild(el('div', { text: '确认新增规则？（确认后立即 POST /api/policies 并刷新矩阵）' }));
    confirmBox.appendChild(el('div', { class: 'confirm-summary', text: body.mode + ' ' + body.subjectType + ':' + body.subjectId + ' · domain=' + body.domain + ' · matcher=' + body.matcher + ' · ops=' + body.ops.join(',') }));
    const actions = el('div', { class: 'confirm-actions' });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '确认新增' });
    const cancel = el('button', { class: 'btn', type: 'button', text: '取消' });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        await api('/api/policies', { method: 'POST', body: pendingPolicyBody });
        hideConfirm();
        form.reset();
        toast('规则已新增，正在刷新权限矩阵…', 'ok');
        await refreshPermissions();
        renderPermissions();
        scheduleRender('banner');
      } catch (err) { showError('新增失败：' + (err && err.message ? err.message : String(err))); ok.disabled = false; }
    });
    cancel.addEventListener('click', hideConfirm);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    confirmBox.appendChild(actions);
    confirmBox.classList.remove('hidden');
  });
}
/* ============================== 审批队列 ============================== */
function riskClass(risk) {
  const text = String(risk === null || risk === undefined ? '' : risk).toLowerCase();
  if (text === 'high' || text === 'critical' || text === '3') return 'high';
  if (text === 'medium' || text === '2') return 'medium';
  return 'low';
}
function approvalCard(request) {
  const card = el('article', { class: 'approval-card' });
  card.appendChild(el('div', { class: 'approval-head' },
    el('span', { class: 'domain', text: request.domain || '?' }),
    el('span', { class: 'approval-target', text: request.target || '—', title: request.target || '' }),
    el('span', { class: 'pill', text: memberName(request.memberId) }),
    el('span', { class: 'risk ' + riskClass(request.risk), text: 'risk ' + (request.risk || '?') }),
    el('span', { class: 'approval-meta-line', text: (request.blockedStep ? 'blocked@' + request.blockedStep + ' · ' : '') + fmtAgo(request.createdAt) })));
  const grid = el('dl', { class: 'approval-grid' });
  const row = (label, value) => grid.append(el('dt', { text: label }), el('dd', { text: value === null || value === undefined || value === '' ? '—' : String(value) }));
  row('member', request.memberId);
  row('reason', request.reason);
  row('diffSize', request.diffSize);
  row('fallback', request.fallback);
  row('requestId', request.id);
  card.appendChild(grid);
  const decide = el('div', { class: 'approval-decide' });
  const reasonInput = el('input', { name: 'reason', type: 'text', placeholder: '决策理由（可选，落盘 decision）' });
  const ttlInput = el('input', { name: 'ttl', type: 'number', min: '0', value: '300', title: 'scope_grant TTL（秒）' });
  const approve = el('button', { class: 'btn btn-primary', type: 'button', text: '批准' });
  const deny = el('button', { class: 'btn btn-danger', type: 'button', text: '驳回' });
  decide.append(el('label', {}, 'decision reason', reasonInput), el('label', {}, 'grant TTL (s)', ttlInput), el('span', { class: 'spacer' }), deny, approve);
  card.appendChild(decide);
  approve.addEventListener('click', () => decideScope(request, 'approved', reasonInput.value, ttlInput.value, [approve, deny]));
  deny.addEventListener('click', () => decideScope(request, 'denied', reasonInput.value, ttlInput.value, [approve, deny]));
  return card;
}
async function decideScope(request, decision, reason, ttlValue, buttons) {
  const verdict = decision === 'approved' ? '批准' : '驳回';
  if (!window.confirm('确认' + verdict + ' ' + memberName(request.memberId) + ' 的 ' + (request.domain || '?') + ' 申请「' + (request.target || '?') + '」？决策将事务落盘为 decision。')) return;
  const body = { decision, decidedBy: 'panel', singleUse: true };
  const reasonText = String(reason || '').trim();
  if (reasonText) body.reason = reasonText;
  const ttl = Number(ttlValue);
  if (decision === 'approved' && Number.isFinite(ttl) && ttl > 0) body.ttlSeconds = Math.floor(ttl);
  for (const button of buttons) button.disabled = true;
  try {
    const response = await api('/api/scope-requests/' + enc(request.id) + '/decide', { method: 'POST', body });
    const decision = response && response.decision;
    const decisionId = (decision && typeof decision === 'object' && decision.id) ? decision.id : (response && response.id && response.requestId ? response.id : '已落盘');
    toast('已' + verdict + ' ' + (request.domain || '') + ':' + (request.target || '') + '（decision ' + decisionId + '）', decision === 'approved' ? 'ok' : 'warn');
    await Promise.all([refreshApprovals(), refreshPermissions()]);
    renderApprovals();
    renderPermissions();
    updateBadges();
  } catch (err) {
    toastError(verdict + '失败', err);
    for (const button of buttons) button.disabled = false;
  }
}
function renderApprovals() {
  const host = $('#approval-list');
  if (!host) return;
  clear(host);
  const items = state.scopeRequests;
  const metaNode = $('#approvals-meta');
  if (metaNode) metaNode.textContent = [items.length + ' 条待审批'].concat(state.errors.approvals ? ['加载失败：' + state.errors.approvals] : []).join(' · ');
  if (state.errors.approvals && !items.length) { host.appendChild(notice('审批队列加载失败：' + state.errors.approvals)); return; }
  if (!items.length) { host.appendChild(emptyState('审批队列为空 ✓', '当前没有 pending 的越界申请。SSE scope.request 到达时会自动出现在这里。')); return; }
  for (const request of items) host.appendChild(approvalCard(request));
}
/* ============================== 消息 ============================== */
function isUnacked(message) {
  return !message.ackedAt && message.status !== 'acked' && message.status !== 'expired';
}
function messageRow(message, pairLabel) {
  const row = el('div', { class: 'msg-row' + (isUnacked(message) ? ' unacked' : '') });
  row.appendChild(el('span', { class: 'msg-pair', text: pairLabel || 'msg' }));
  row.appendChild(el('span', { class: 'msg-route', title: String(message.from || '') + ' → ' + String(message.to || '') },
    el('span', { class: 'from', text: message.from || '?' }), ' → ', el('span', { class: 'to', text: message.to || '?' })));
  row.appendChild(el('span', { class: 'msg-kind', text: message.kind || '—' }));
  row.appendChild(el('span', {}, el('span', { class: 'status-badge ' + safeClass(message.status || 'queued'), text: message.status || 'queued' })));
  row.appendChild(el('span', { class: 'msg-times', text: 'sent ' + fmtClock(message.sentAt) + (message.ackedAt ? ' · acked ' + fmtClock(message.ackedAt) : (message.readAt ? ' · read ' + fmtClock(message.readAt) : (message.deliveredAt ? ' · delivered ' + fmtClock(message.deliveredAt) : ''))) }));
  return row;
}
function renderMessages() {
  const host = $('#message-list');
  if (!host) return;
  clear(host);
  const unackedCount = state.messages.filter(isUnacked).length;
  const metaNode = $('#messages-meta');
  if (metaNode) metaNode.textContent = [state.messages.length + ' 条消息', '未 ack ' + unackedCount].concat(state.errors.messages ? ['加载失败：' + state.errors.messages] : []).join(' · ');
  if (state.errors.messages && !state.messages.length) { host.appendChild(notice('消息加载失败：' + state.errors.messages)); return; }
  if (!state.messages.length) { host.appendChild(emptyState('暂无消息', '信箱来自 GET /api/messages；请求-响应按 correlationId 自动配对。')); return; }
  const groups = new Map();
  for (const message of state.messages) {
    const key = message.correlationId ? ('corr:' + message.correlationId) : ('solo:' + message.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  const entries = Array.from(groups.entries());
  entries.sort((a, b) => {
    const aSolo = a[0].indexOf('solo:') === 0 ? 1 : 0, bSolo = b[0].indexOf('solo:') === 0 ? 1 : 0;
    if (aSolo !== bSolo) return aSolo - bSolo;
    return String((a[1][0] && a[1][0].sentAt) || '').localeCompare(String((b[1][0] && b[1][0].sentAt) || ''));
  });
  for (const [key, list] of entries) {
    const isCorrelation = key.indexOf('corr:') === 0;
    const rows = list.slice().sort((a, b) => String(a.sentAt || '').localeCompare(String(b.sentAt || '')));
    const card = el('div', { class: 'msg-group' });
    if (isCorrelation) {
      card.appendChild(el('div', { class: 'msg-group-head' },
        el('span', { class: 'corr', text: 'correlation ' + key.slice(5) }),
        el('span', { text: rows.length + ' 条（请求-响应配对）' }),
        el('span', { text: rows.some(isUnacked) ? '⚠ 存在未 ack' : '✓ 全部已确认' })));
    }
    const body = el('div', { class: 'msg-rows' });
    rows.forEach((message, index) => body.appendChild(messageRow(message, isCorrelation ? (index === 0 ? 'req' : (index === 1 ? 'resp' : 'msg')) : 'msg')));
    card.appendChild(body);
    host.appendChild(card);
  }
}
/* ============================== 时间线 ============================== */
function matchesFilters(entry) {
  if (state.filters.member && entry.memberId !== state.filters.member) return false;
  if (state.filters.phase && entry.phase !== state.filters.phase) return false;
  return true;
}
function timelineRow(entry, isNew) {
  const row = el('div', { class: 'tl-row phase-' + safeClass(entry.phase) + (isNew ? ' new' : ''), dataset: { eid: String(entry.id) } });
  row.appendChild(el('span', { class: 'tl-cell tl-time', text: fmtClock(entry.ts) }));
  row.appendChild(el('span', { class: 'tl-cell tl-member', text: memberName(entry.memberId), title: entry.memberId || '' }));
  row.appendChild(el('span', { class: 'tl-cell' }, el('span', { class: 'phase-badge phase-' + safeClass(entry.phase), text: entry.phase || '?' })));
  row.appendChild(el('span', { class: 'tl-cell', text: entry.action || '—', title: entry.action || '' }));
  row.appendChild(el('span', { class: 'tl-cell tl-target', text: entry.target || '—', title: entry.target || '' }));
  row.appendChild(el('span', { class: 'tl-cell tl-result', text: entry.result || '—', title: entry.result || '' }));
  row.appendChild(el('span', { class: 'tl-cell tl-next', text: entry.next || '—', title: entry.next || '' }));
  return row;
}
function appendTimelineRow(entry, isNew) {
  const host = $('#timeline');
  if (!host) return;
  const head = host.querySelector('.tl-head');
  if (!head) { renderTimeline(); return; }
  const placeholder = host.querySelector('.empty');
  if (placeholder) placeholder.remove();
  host.appendChild(timelineRow(entry, isNew));
}
function updatePauseBanner() {
  const host = $('#timeline');
  if (!host) return;
  let banner = host.querySelector('.tl-paused-banner');
  if (!state.paused) { if (banner) banner.remove(); return; }
  if (!banner) {
    banner = el('div', { class: 'tl-paused-banner' });
    const head = host.querySelector('.tl-head');
    if (head) host.insertBefore(banner, head.nextSibling);
    else host.insertBefore(banner, host.firstChild);
  }
  banner.textContent = '已暂停：' + state.pendingTimeline.length + ' 条实时事件已缓存，继续后按序回放（' + state.speed + 'x）。';
}
function renderTimelineStats() {
  const node = $('#tl-stats');
  if (!node) return;
  const parts = [state.timeline.length + '/' + TIMELINE_CAP + ' 条'];
  if (state.paused) parts.push('已暂停（缓存 ' + state.pendingTimeline.length + '）');
  else if (state.playbackTimer) parts.push('回放中（剩 ' + state.pendingTimeline.length + '）');
  else if (state.pendingTimeline.length) parts.push('待回放 ' + state.pendingTimeline.length);
  parts.push(state.speed + 'x');
  node.textContent = parts.join(' · ');
  updatePauseBanner();
}
function updateTimelineControls() {
  const pauseButton = $('#tl-pause');
  if (pauseButton) pauseButton.textContent = state.paused ? '继续' : '暂停';
  const speedSelect = $('#tl-speed');
  if (speedSelect) speedSelect.value = String(state.speed);
  const memberSelect = $('#tl-member');
  if (memberSelect) memberSelect.value = state.filters.member;
  const phaseSelect = $('#tl-phase');
  if (phaseSelect) phaseSelect.value = state.filters.phase;
  renderTimelineStats();
}
function renderTimeline() {
  const host = $('#timeline');
  if (!host) return;
  clear(host);
  host.appendChild(el('div', { class: 'tl-row tl-head' },
    el('span', { text: 'time' }), el('span', { text: 'member' }), el('span', { text: 'phase' }), el('span', { text: 'action' }),
    el('span', { text: 'target' }), el('span', { text: 'result' }), el('span', { text: 'next' })));
  const visible = state.timeline.filter(matchesFilters);
  if (!visible.length) {
    const filtered = state.timeline.length > 0;
    host.appendChild(el('div', { class: 'empty', style: { margin: '10px' } },
      el('strong', { text: state.errors.timeline ? '时间线加载失败' : (filtered ? '当前过滤条件下没有事件' : '暂无时间线事件') }),
      state.errors.timeline || (filtered ? '清空成员 / phase 过滤后即可看到事件。' : '等待 SSE step.append 事件…')));
  } else {
    for (const entry of visible) host.appendChild(timelineRow(entry, false));
  }
  renderTimelineStats();
}
function appendTimeline(entry) {
  state.timelineIds.add(entry.id);
  state.timeline.push(entry);
  if (state.timeline.length > TIMELINE_CAP) {
    const dropped = state.timeline.shift();
    state.timelineIds.delete(dropped.id);
    const host = $('#timeline');
    const row = host ? host.querySelector('[data-eid="' + dropped.id + '"]') : null;
    if (row) row.remove();
  }
  if (matchesFilters(entry)) appendTimelineRow(entry, true);
  renderTimelineStats();
}
/** SSE step.append 与 REST history 回填共用入口：处理暂停缓存与去重。 */
function ingestTimelineEntry(entry, initial) {
  if (!entry || state.timelineIds.has(entry.id)) return;
  if (!initial && (state.paused || state.playbackTimer)) {
    state.pendingTimeline.push(entry);
    while (state.pendingTimeline.length > TIMELINE_CAP) state.pendingTimeline.shift();
    renderTimelineStats();
    return;
  }
  appendTimeline(entry);
}
function stopPlayback() {
  if (state.playbackTimer) { clearInterval(state.playbackTimer); state.playbackTimer = null; }
  renderTimelineStats();
}
function flushPlayback() {
  if (state.playbackTimer) return;
  if (!state.pendingTimeline.length) { renderTimelineStats(); return; }
  state.playbackTimer = setInterval(() => {
    if (state.paused) { stopPlayback(); return; }
    const next = state.pendingTimeline.shift();
    if (!next) { stopPlayback(); return; }
    appendTimeline(next);
  }, state.speed === 4 ? 25 : 100); // 1x=100ms/条，4x=25ms/条
  renderTimelineStats();
}
function setPaused(paused) {
  state.paused = !!paused;
  if (state.paused) stopPlayback();
  else flushPlayback();
  saveUiState();
  updateTimelineControls();
}
function setSpeed(speed) {
  state.speed = speed === 4 ? 4 : 1;
  saveUiState();
  if (state.playbackTimer) { stopPlayback(); flushPlayback(); }
  updateTimelineControls();
}
function normalizeFrameEntry(frame, payload) {
  const id = Number(frame.id);
  if (!Number.isFinite(id)) return null;
  return {
    id, seq: payload.seq, memberId: frame.memberId || payload.memberId, taskId: frame.taskId || payload.taskId,
    ts: frame.ts || payload.ts || new Date().toISOString(),
    phase: payload.phase || '', action: payload.action || '', target: payload.target || '',
    result: payload.result || '', next: payload.next || '',
  };
}
function normalizeHistoryEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const id = Number(item.id);
  if (!Number.isFinite(id)) return null;
  const payload = (item.payload && typeof item.payload === 'object') ? item.payload : null;
  if (payload && (payload.phase !== undefined || payload.action !== undefined || payload.seq !== undefined)) return normalizeFrameEntry(item, payload);
  if (!item.phase) return null;
  return {
    id, seq: item.seq, memberId: item.memberId, taskId: item.taskId, ts: item.ts || new Date().toISOString(),
    phase: item.phase, action: item.action || '', target: item.target || '',
    result: item.result || '', next: item.next || '',
  };
}
function populatePhaseFilter() {
  const select = $('#tl-phase');
  if (!select) return;
  const current = state.filters.phase;
  clear(select);
  select.appendChild(el('option', { value: '', text: '全部 phase' }));
  for (const phase of PHASES) select.appendChild(el('option', { value: phase, text: phase }));
  select.value = PHASES.indexOf(current) >= 0 ? current : '';
  if (select.value !== current) state.filters.phase = select.value;
}
function populateMemberFilter() {
  const select = $('#tl-member');
  if (select) {
    const current = state.filters.member;
    clear(select);
    select.appendChild(el('option', { value: '', text: '全部成员' }));
    for (const member of state.members) select.appendChild(el('option', { value: member.id, text: member.name || member.id }));
    const known = state.members.some((member) => member.id === current);
    select.value = known ? current : '';
    if (!known) state.filters.member = '';
  }
  const datalist = $('#member-ids');
  if (datalist) { clear(datalist); for (const member of state.members) datalist.appendChild(el('option', { value: member.name || member.id })); }
}
/* ============================== 通用组件 / 状态条 ============================== */
function emptyState(title, detail) {
  return el('div', { class: 'empty' }, el('strong', { text: title }), detail ? el('div', { text: detail }) : null);
}
function notice(text) { return el('div', { class: 'notice meta', text }); }
function memberName(id) {
  if (id === null || id === undefined || id === '') return '—';
  return state.memberNames.get(id) || String(id);
}
function updateBadges() {
  const pending = state.scopeRequests.length;
  const unacked = state.messages.filter(isUnacked).length;
  const setBadge = (selector, text, hot) => {
    const node = $(selector);
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('hot', !!hot);
  };
  setBadge('#badge-board', state.members.length ? String(state.members.length) : '');
  setBadge('#badge-approvals', pending ? String(pending) : '', pending > 0);
  setBadge('#badge-messages', unacked ? String(unacked) : '', unacked > 0);
}
function renderSnapshot() {
  const node = $('#snapshot');
  if (!node) return;
  const snapshot = state.snapshot;
  if (!snapshot) { node.textContent = '—'; node.title = ''; return; }
  const parts = [];
  if (snapshot.asOf) parts.push('快照 ' + fmtDateTime(snapshot.asOf));
  if (snapshot.version !== null && snapshot.version !== undefined) parts.push('v' + snapshot.version);
  node.textContent = parts.length ? parts.join(' · ') : '—';
  node.title = snapshot.asOf ? 'asOf=' + snapshot.asOf : '';
}
function renderBanner() {
  const box = $('#banner');
  if (!box) return;
  const parts = [];
  if (state.noTeams) parts.push('尚未创建团队：请先用 CLI 或 REST（POST /api/teams）创建团队，然后点击“刷新快照”。');
  if (state.degraded) parts.push('degraded=true：状态投影与事件流不一致，部分成员数据可能陈旧（C2/FR-5.5 告警）。');
  if (state.staleMembers.size) parts.push('stale 成员：' + Array.from(state.staleMembers).map((id) => memberName(id)).join('、') + '（seq 与事件流不一致）。');
  const failed = Object.keys(state.errors).filter((key) => state.errors[key] && state.teamId);
  if (failed.length) parts.push('部分视图加载失败：' + failed.map((key) => key + '（' + state.errors[key] + '）').join('；'));
  clear(box);
  if (!parts.length) { box.classList.add('hidden'); return; }
  for (const text of parts) box.appendChild(el('div', { text }));
  box.classList.remove('hidden');
}
/* ============================== 渲染调度 / 数据刷新 ============================== */
const RENDERERS = { board: renderBoard, dag: renderDag, permissions: renderPermissions, approvals: renderApprovals, messages: renderMessages, timeline: renderTimeline, banner: renderBanner, snapshot: renderSnapshot, badges: updateBadges };
const pendingRenders = new Set();
let renderFrame = null;
function scheduleRender(name) {
  if (!RENDERERS[name]) return;
  pendingRenders.add(name);
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    const names = Array.from(pendingRenders);
    pendingRenders.clear();
    for (const renderName of names) {
      try { RENDERERS[renderName](); } catch (err) { console.error('[render]', renderName, err); }
    }
  });
}
const refreshTimers = {};
function scheduleRefresh(key, delay) {
  if (refreshTimers[key]) return;
  refreshTimers[key] = setTimeout(async () => {
    delete refreshTimers[key];
    try {
      if (key === 'status') await refreshStatus();
      else if (key === 'dag') await refreshDag();
      else if (key === 'permissions') await refreshPermissions();
      else if (key === 'approvals') await refreshApprovals();
      else if (key === 'messages') await refreshMessages();
      else return;
    } catch (err) { return; }
    if (key === 'permissions') renderPermissions();
    else if (key === 'status') renderBoard();
    else scheduleRender(key);
    updateBadges();
  }, delay || 200);
}
function renderAll() {
  renderBoard();
  renderDag();
  renderPermissions();
  renderApprovals();
  renderMessages();
  renderTimeline();
  populateMemberFilter();
  updateBadges();
  renderBanner();
  renderSnapshot();
  updateTimelineControls();
}
async function safeRefresh(key, fn) {
  try { await fn(); state.errors[key] = null; }
  catch (err) {
    if (err instanceof ApiError && err.code === 'E_UNAUTHORIZED') throw err;
    state.errors[key] = err && err.message ? err.message : String(err);
  }
}
async function refreshTeams() {
  state.teams = pickItems(await api('/api/teams'));
  state.noTeams = state.teams.length === 0;
  renderTeamSelect();
}
function renderTeamSelect() {
  const select = $('#team-select');
  if (!select) return;
  clear(select);
  if (!state.teams.length) {
    select.appendChild(el('option', { value: '', text: state.noTeams ? '暂无团队' : '团队加载失败' }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const team of state.teams) select.appendChild(el('option', { value: team.id, text: (team.name || team.id) + ' · ' + team.id }));
  if (state.teamId && state.teams.some((team) => team.id === state.teamId)) select.value = state.teamId;
}
async function refreshStatus() {
  const response = await api('/api/status?team=' + enc(state.teamId));
  state.snapshot = { asOf: response.asOf || null, version: response.version === undefined ? null : response.version };
  state.members = Array.isArray(response.members) ? response.members : pickItems(response);
  state.memberNames = new Map(state.members.map((member) => [member.id, member.name || member.id]));
  state.staleMembers = new Set(Array.isArray(response.staleMembers) ? response.staleMembers : []);
  state.degraded = !!response.degraded;
  populateMemberFilter();
  renderSnapshot();
  renderBanner();
}
async function refreshDag() { state.dag = await api('/api/dag?team=' + enc(state.teamId)); }
async function refreshPermissions() {
  const [policiesResponse, matrixResponse] = await Promise.all([
    api('/api/policies?team=' + enc(state.teamId)),
    api('/api/permission-matrix?team=' + enc(state.teamId)),
  ]);
  state.policies = pickItems(policiesResponse);
  state.matrix = pickItems(matrixResponse);
}
async function refreshApprovals() { state.scopeRequests = pickItems(await api('/api/scope-requests?team=' + enc(state.teamId) + '&status=pending')); }
async function refreshMessages() { state.messages = pickItems(await api('/api/messages?team=' + enc(state.teamId))); }
async function refreshAll() {
  await Promise.all([
    safeRefresh('status', refreshStatus),
    safeRefresh('dag', refreshDag),
    safeRefresh('permissions', refreshPermissions),
    safeRefresh('approvals', refreshApprovals),
    safeRefresh('messages', refreshMessages),
  ]);
  renderAll();
}
async function backfillTimeline() {
  try {
    const response = await api('/api/events/history?team=' + enc(state.teamId) + '&since=0');
    const raw = Array.isArray(response) ? response : pickItems(response);
    const entries = [];
    for (const item of raw) { const entry = normalizeHistoryEntry(item); if (entry) entries.push(entry); }
    entries.sort((a, b) => a.id - b.id);
    const kept = entries.length > TIMELINE_CAP ? entries.slice(entries.length - TIMELINE_CAP) : entries;
    for (const entry of kept) ingestTimelineEntry(entry, true);
    state.errors.timeline = null;
    renderTimeline();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'E_UNAUTHORIZED') throw err;
    state.errors.timeline = err && err.message ? err.message : String(err);
    renderTimeline();
  }
}
/* ============================== SSE ============================== */
function disconnectSSE() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.es) { state.es.close(); state.es = null; }
}
function patchMember(memberId, patch) {
  if (!memberId) return;
  const member = state.members.find((item) => item.id === memberId);
  if (!member) { scheduleRefresh('status', 400); return; }
  Object.assign(member, patch);
  state.memberNames.set(member.id, member.name || member.id);
}
function handleSSEFrame(type, event) {
  let frame;
  try { frame = JSON.parse(event.data); } catch (err) { return; }
  if (!frame || typeof frame !== 'object') return;
  const frameId = Number(event.lastEventId || frame.id);
  if (Number.isFinite(frameId) && frameId > state.lastEventId) {
    state.lastEventId = frameId;
    storeSet(STORE_LAST, String(frameId));
  }
  if (frame.teamId && state.teamId && frame.teamId !== state.teamId) return;
  const payload = (frame.payload && typeof frame.payload === 'object') ? frame.payload : {};
  switch (type) {
    case 'member.status': {
      patchMember(frame.memberId || payload.memberId, { status: payload.status, step: payload.step, seq: payload.seq, next: payload.next, last: payload.last, leaseUntil: payload.leaseUntil });
      scheduleRender('board');
      scheduleRender('badges');
      break;
    }
    case 'step.append': {
      const entry = normalizeFrameEntry(frame, payload);
      if (entry) ingestTimelineEntry(entry, false);
      const memberId = frame.memberId || payload.memberId;
      if (memberId) {
        const patch = {};
        if (payload.seq !== undefined) patch.seq = payload.seq;
        if (payload.action || payload.target) patch.last = [payload.action, payload.target].filter(Boolean).join(' ');
        patchMember(memberId, patch);
        scheduleRender('board');
      }
      break;
    }
    case 'task.state': scheduleRefresh('dag', 150); break;
    case 'message.delivered': scheduleRefresh('messages', 250); break;
    case 'scope.request':
      toast('新的越界申请：' + memberName(frame.memberId || payload.memberId) + ' ' + (payload.domain || '') + ' ' + (payload.target || ''), 'warn', 6000);
      scheduleRefresh('approvals', 150);
      break;
    case 'decision':
      toast('决策落盘：' + (payload.decision || '?') + ' request=' + (payload.requestId || '?') + (payload.decidedBy ? '（' + payload.decidedBy + '）' : ''), payload.decision === 'approved' ? 'ok' : 'warn');
      scheduleRefresh('approvals', 150);
      scheduleRefresh('permissions', 250);
      break;
    case 'lease.warn':
      toast('租约告警：' + memberName(payload.memberId || frame.memberId) + '（leaseUntil=' + fmtClock(payload.leaseUntil) + '，missed=' + (payload.missed === undefined ? '?' : payload.missed) + '）', 'error', 8000);
      scheduleRefresh('status', 200);
      break;
    default: break;
  }
}
async function probeAuth() {
  if (state.authProbing || !state.token) return;
  state.authProbing = true;
  try {
    const response = await fetch('/api/teams', { headers: { Authorization: 'Bearer ' + state.token } });
    if (response.status === 401) authOverlay();
  } catch (err) { /* 网络不可用：继续退避重连 */ }
  finally { state.authProbing = false; }
}
function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const attempt = state.reconnectAttempt;
  state.reconnectAttempt += 1;
  if (attempt >= 2) probeAuth();
  setConn('reconnecting');
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connectSSE(); }, Math.min(15000, 1000 * Math.pow(2, Math.min(attempt, 4))));
}
function connectSSE() {
  disconnectSSE();
  if (!state.token || !state.teamId) return;
  const query = new URLSearchParams({ team: state.teamId, token: state.token });
  if (state.lastEventId > 0) query.set('lastEventId', String(state.lastEventId));
  let source;
  try { source = new EventSource('/api/events?' + query.toString()); }
  catch (err) { setConn('offline'); scheduleReconnect(); return; }
  state.es = source;
  setConn(state.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
  source.onopen = () => { state.reconnectAttempt = 0; setConn('live'); resync(); };
  source.onerror = () => {
    if (state.es !== source) return;
    source.close();
    state.es = null;
    setConn('reconnecting');
    scheduleReconnect();
  };
  for (const type of SSE_TYPES) source.addEventListener(type, (event) => handleSSEFrame(type, event));
  // 容错：若服务端把事件名写成默认 message，但 data 里带 type，也照常路由。
  source.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data);
      if (frame && typeof frame.type === 'string' && SSE_TYPES.indexOf(frame.type) >= 0) handleSSEFrame(frame.type, event);
    } catch (err) { /* 忽略非 JSON 帧 */ }
  };
}
function resync() {
  if (state.resyncPromise) return state.resyncPromise;
  state.resyncPromise = refreshAll()
    .catch((err) => { console.warn('[resync]', err && err.message ? err.message : err); })
    .finally(() => { state.resyncPromise = null; });
  return state.resyncPromise;
}
/* ============================== 报告导出 ============================== */
const safeFileName = (name) => String(name || 'team').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'team';
async function exportReport() {
  if (!state.teamId) { toast('请先选择团队', 'warn'); return; }
  const button = $('#btn-report');
  const fileName = 'run-' + safeFileName(state.team && state.team.name ? state.team.name : state.teamId) + '.md';
  if (button) button.disabled = true;
  try {
    const response = await api('/api/report?team=' + enc(state.teamId) + '&format=md', { raw: true });
    const text = await response.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const anchor = el('a', { href: url, download: fileName });
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('报告已开始下载（' + fileName + '）', 'ok');
  } catch (err) { toastError('报告导出失败', err); }
  finally { if (button) button.disabled = false; }
}
/* ============================== 团队 / 启动 ============================== */
function resetTeamViewState() {
  stopPlayback();
  state.timeline = [];
  state.timelineIds = new Set();
  state.pendingTimeline = [];
  state.members = [];
  state.memberNames = new Map();
  state.dag = null;
  state.matrix = [];
  state.policies = [];
  state.scopeRequests = [];
  state.messages = [];
  state.staleMembers = new Set();
  state.degraded = false;
  state.snapshot = null;
  state.errors = { status: null, dag: null, permissions: null, policies: null, approvals: null, messages: null, timeline: null };
}
async function selectTeam(teamId) {
  if (!teamId) return;
  state.teamId = teamId;
  state.team = state.teams.find((team) => team.id === teamId) || null;
  state.initialized = true;
  state.teamFromUrl = teamId;
  try {
    const url = new URL(location.href);
    url.searchParams.set('team', teamId);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (err) { /* file:// 等场景忽略 */ }
  const select = $('#team-select');
  if (select && state.teams.some((team) => team.id === teamId)) select.value = teamId;
  const reportButton = $('#btn-report');
  if (reportButton) reportButton.disabled = false;
  resetTeamViewState();
  renderAll();
  await refreshAll();
  await backfillTimeline();
  connectSSE();
}
function initUrlState() {
  if (state.urlParsed) return;
  state.urlParsed = true;
  let query;
  let hash;
  try {
    query = new URLSearchParams(location.search);
    hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  } catch (err) { return; }
  state.teamFromUrl = query.get('team') || '';
  const token = hash.get('token') || query.get('token') || '';
  if (token) state.token = token;
  if (hash.has('token') || query.has('token')) {
    // token 用完即抹：不留在地址栏 / 浏览器历史里
    hash.delete('token');
    query.delete('token');
    const search = query.toString();
    const hashText = hash.toString();
    try { history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + (hashText ? '#' + hashText : '')); } catch (err) { /* ignore */ }
  }
}
async function boot() {
  if (state.booting) return;
  state.booting = true;
  try {
    initUrlState();
    if (!state.token) { setConn('offline'); missingTokenOverlay(); return; }
    hideOverlay();
    await refreshTeams();
    if (state.noTeams || !state.teams.length) { renderAll(); return; }
    const wanted = (state.teamFromUrl && state.teams.some((team) => team.id === state.teamFromUrl)) ? state.teamFromUrl : state.teams[0].id;
    await selectTeam(wanted);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'E_UNAUTHORIZED') { setConn('offline'); return; }
    showOverlay('加载失败', err && err.message ? err.message : String(err), [reloadButton()]);
  } finally { state.booting = false; }
}
/* ============================== 交互绑定 / 入口 ============================== */
function setTab(tab, options) {
  if (TAB_NAMES.indexOf(tab) < 0) tab = 'board';
  state.tab = tab;
  if (!options || !options.silent) saveUiState();
  for (const button of $all('#tabs .tab')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const section of $all('.view')) section.classList.toggle('hidden', section.dataset.view !== tab);
  const renderer = RENDERERS[tab];
  if (renderer) renderer();
  if (tab === 'timeline') updateTimelineControls();
  // 打开视图时静默补拉一次，避免只依赖 SSE 通知而看不到外部改动。
  if (state.initialized && state.teamId && !(options && options.noRefresh)) {
    if (tab === 'board') refreshStatus().then(() => scheduleRender('board')).catch(() => {});
    else if (tab === 'dag') refreshDag().then(() => scheduleRender('dag')).catch(() => {});
    else if (tab === 'permissions') refreshPermissions().then(() => scheduleRender('permissions')).catch(() => {});
    else if (tab === 'approvals') refreshApprovals().then(() => scheduleRender('approvals')).catch(() => {});
    else if (tab === 'messages') refreshMessages().then(() => scheduleRender('messages')).catch(() => {});
  }
}
function applyUiState() {
  populatePhaseFilter();
  const phaseSelect = $('#tl-phase');
  if (phaseSelect) phaseSelect.value = state.filters.phase;
  const speedSelect = $('#tl-speed');
  if (speedSelect) speedSelect.value = String(state.speed);
  setTab(state.tab, { silent: true });
  updateTimelineControls();
}
function bindChrome() {
  const tabs = $('#tabs');
  if (tabs) tabs.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('.tab') : null;
    if (button && button.dataset.tab) setTab(button.dataset.tab);
  });
  const teamSelect = $('#team-select');
  if (teamSelect) teamSelect.addEventListener('change', (event) => {
    const teamId = event.target.value;
    if (teamId && teamId !== state.teamId) selectTeam(teamId).catch((err) => toastError('切换团队失败', err));
  });
  const refreshButton = $('#btn-refresh');
  if (refreshButton) refreshButton.addEventListener('click', () => {
    if (!state.teamId) { boot(); return; }
    refreshTeams().then(() => refreshAll()).then(() => { toast('快照已刷新', 'ok', 2000); connectSSE(); }).catch((err) => toastError('刷新失败', err));
  });
  const reportButton = $('#btn-report');
  if (reportButton) reportButton.addEventListener('click', exportReport);
  const messageRefresh = $('#btn-msg-refresh');
  if (messageRefresh) messageRefresh.addEventListener('click', () => {
    refreshMessages().then(() => { renderMessages(); updateBadges(); }).catch((err) => toastError('消息刷新失败', err));
  });
  const pauseButton = $('#tl-pause');
  if (pauseButton) pauseButton.addEventListener('click', () => setPaused(!state.paused));
  const speedSelect = $('#tl-speed');
  if (speedSelect) speedSelect.addEventListener('change', (event) => setSpeed(Number(event.target.value)));
  const memberSelect = $('#tl-member');
  if (memberSelect) memberSelect.addEventListener('change', (event) => { state.filters.member = event.target.value; saveUiState(); renderTimeline(); });
  const phaseSelect = $('#tl-phase');
  if (phaseSelect) phaseSelect.addEventListener('change', (event) => { state.filters.phase = event.target.value; saveUiState(); renderTimeline(); });
  window.addEventListener('online', () => { if (state.teamId && !state.es) connectSSE(); });
  window.addEventListener('offline', () => setConn('offline'));
  setInterval(tickLeases, 1000);
  bindPolicyForm();
}
function start() {
  loadUiState();
  bindChrome();
  applyUiState();
  renderAll();
  setConn('connecting');
  boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

// @local/dsh-team-ui — Client half：侧边栏「编排」入口 + 右侧栏 Tab，内嵌 sidecar 自带 Web 面板。
// 零外部 import（只 require('react')）；样式只用 --dsw-alias-* 主题 token；
// iframe 走 Host 同源代理 /dsh-team-api/panel（浏览器拿不到 sidecar token）。
window.__ModuleLoader__.load({
  id: '@local/dsh-team-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-team';

    const DICT = {
      zh: {
        title: 'dsh-team 编排控制台',
        subtitle: '成员看板（Trace 瀑布）、DAG、时间线、权限与审批；数据来自本地 sidecar，经 Host 代理',
        side_nav: '编排',
      },
      en: {
        title: 'dsh-team console',
        subtitle: 'Trace waterfall, DAG, timeline, permissions and approvals (local sidecar via Host proxy)',
        side_nav: 'Team',
      },
    };

    const CSS = `
.dsht-page { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dsht-page-head { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; }
.dsht-page-mark { display:inline-flex; color:var(--dsw-alias-brand-primary); }
.dsht-page-title { font-size:13px; font-weight:600; white-space:nowrap; }
.dsht-page-sub { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-spacer { flex:1; }
.dsht-page-body { flex:1; min-height:0; display:flex; overflow:hidden; }
.dsht-frame { width:100%; height:100%; border:0; display:block; background:var(--dsw-alias-bg-base); color-scheme:normal; }
.dsht-panel-icon { display:inline-flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary); }
.dsht-panel-icon.is-active { color:var(--dsw-alias-brand-primary); }
.dsht-rail-btn { display:flex; align-items:center; gap:8px; width:100%; background:none; border:none; color:var(--dsw-alias-label-secondary); padding:6px 8px; border-radius:6px; font-size:12px; cursor:pointer; text-align:left; }
.dsht-rail-btn:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dsht-rail-icon { flex:none; display:inline-flex; }
.dsht-rail-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`;

    // ---------- 右侧栏 Tab（sidebar.right.pane.tab）+ 侧边栏入口 ----------
    function TeamIcon({ size = 16, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 64 64',
        'aria-hidden': true, focusable: 'false', style: { display: 'block' },
      },
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)', opacity: active ? 0.2 : 1 }),
        h('rect', { x: 12, y: 14, width: 18, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
        h('rect', { x: 34, y: 14, width: 18, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
        h('rect', { x: 12, y: 36, width: 40, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }));
    }

    /** 侧边栏底部入口按钮：点击打开右侧栏 Tab（按钮外壳归 sidebar，宽带/轨道态由 wide 决定）。 */
    function railEntry(t, open) {
      return function RailEntry(props) {
        const wide = !(props && props.wide === false);
        return h('button', {
          className: 'dsht-rail-btn', type: 'button',
          title: t('title'), 'aria-label': t('side_nav'),
          onClick: () => { try { open(); } catch (e) { console.warn('[dsh-team] openTab failed', e); } },
        },
          h('span', { className: 'dsht-rail-icon' }, h(TeamIcon, { size: 16 })),
          wide ? h('span', { className: 'dsht-rail-label' }, t('side_nav')) : null);
      };
    }

    /** 侧边栏图标（回退：中央面板入口，由 sidebar 按 id 调 layout.selectPanel） */
    function panelIcon(t) {
      return function PanelIcon(props) {
        const size = Math.max(12, Number(props && props.size) || 16);
        const active = !!(props && props.active);
        return h('span', {
          className: 'dsht-panel-icon' + (active ? ' is-active' : ''),
          title: t('title'), 'aria-label': t('side_nav'), role: 'img',
        }, h(TeamIcon, { size, active }));
      };
    }

    /** 面板主体：iframe 复用 sidecar 自带 /panel（成员看板 Trace 瀑布 + 其余视图 + SSE）。 */
    function TeamView({ t, compact }) {
      return h('div', { className: 'dsht-page' },
        h('style', null, CSS),
        h('header', { className: 'dsht-page-head' },
          h('span', { className: 'dsht-page-mark' }, h(TeamIcon, { size: compact ? 14 : 16 })),
          h('span', { className: 'dsht-page-title' }, t('title')),
          compact ? null : h('span', { className: 'dsht-page-sub' }, t('subtitle')),
          h('span', { className: 'dsht-spacer' })),
        h('div', { className: 'dsht-page-body' },
          h('iframe', {
            className: 'dsht-frame',
            title: t('title'),
            src: '/dsh-team-api/panel?api=/dsh-team-api&embed=1',
          })));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          try {
            ctx.locale.register(NS, 'zh', DICT.zh);
            ctx.locale.register(NS, 'en', DICT.en);
          } catch { /* dictionaries may already exist on hot reload */ }
        }
        const t = ctx.locale && typeof ctx.locale.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => DICT.zh[key] || key;
        const getService = (name) => {
          try {
            if (typeof ctx.get === 'function') return ctx.get(name);
            return ctx[name];
          } catch { return undefined; }
        };
        const sidebarRight = getService('sidebarRight');
        const sidebarRightTabs = getService('sidebarRightTabs');
        const disposers = [];

        if (sidebarRight && sidebarRightTabs && typeof sidebarRight.openTab === 'function') {
          // 右侧栏 Tab：id 是 body/title 槽的 key，kind 是 openTab 的名字
          disposers.push(sidebarRightTabs.register({
            id: 'dsh-team',
            kind: 'dsh-team',
            priority: 'extension',
            title: () => t('side_nav'),
          }));
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'dsh-team',
          }, () => h(TeamView, { t, compact: true }))));
          // 入口：侧边栏底部按钮 → 打开右侧栏 Tab
          disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-team',
            order: 30,
            label: () => t('side_nav'),
          }, railEntry(t, () => sidebarRight.openTab('dsh-team')))));
        } else {
          // 回退：服务不可用时用中央停靠面板（与「插件」页同级）
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'dsh-team',
          }, () => h(TeamView, { t, compact: false }))));
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dsh-team',
            order: 20,
            label: () => t('side_nav'),
          }, panelIcon(t))));
        }
        return () => { for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } } };
      },
    };
  },
});

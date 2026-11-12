// dsh-team-control-ui — Client half：把「编排」看板注册成 dsh-better-sidebar 的页签；没装时回退到
// 本插件自己的右侧栏 Tab + 侧边栏左下角入口。内容一律内嵌 sidecar 自带 Web 面板。
// 零外部 import（只 require('react')）；样式只用 --dsw-alias-* 主题 token；
// iframe 走 Host 同源代理 /dsh-team-api/panel（浏览器拿不到 sidecar token）。
window.__ModuleLoader__.load({
  id: 'dsh-team-control-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-team';

    const DICT = {
      zh: {
        title: 'dsh-team 编排控制台',
        subtitle: '成员看板（Trace 瀑布）、DAG、时间线、权限与审批；数据来自本地 sidecar，经 Host 代理',
        side_nav: '编排',
        board_nav: '看板',
        board_title: '任务看板',
        board_desc: '按工作区管理任务队列与自动执行',
        board_guide_desc: '工作区任务队列、并发与自动执行',
        board_dock_open: '在网页右侧固定显示看板',
        board_dock_close: '收起右侧固定看板',
        board_dock_resize: '拖动调整看板宽度',
        panel_loading: '正在查找该会话的团队…',
        guide_desc: '团队成员、任务 DAG 与实时进度',
        members_title: '团队成员',
        members_running: '运行中',
        members_idle: '空闲',
        members_open: '在侧栏打开该成员的对话',
        members_empty: '本会话没有团队成员',
        members_running_count: '运行中 {n}',
        // ---- 右上角团队卡片（affectui AgentFindings 移植）----
        card_open: '展开团队卡片',
        card_close: '收起团队卡片',
        card_stop: '停止团队',
        card_browser: '在默认浏览器中打开面板',
        card_stop_title: '停止团队：中断所有运行中成员，并把运行中的任务退回待派发',
        card_stop_confirm_title: '停止团队?',
        card_stop_confirm_text: '将中断所有运行中成员，并把运行中的任务退回待派发。',
        card_stop_confirm: '停止',
        card_cancel: '取消',
        card_stop_running: '停止中…',
        card_stop_done: '已停止',
        card_title: '团队校验',
        sev_critical: '严重',
        sev_warning: '警告',
        card_all_done: '全部检查完成',
        card_stopped: '已停止',
        card_plan_aria: '成员计划',
        card_plan: '计划',
        running_of: '运行中 {n}/{m}',
        status_running: '运行中',
        status_idle: '空闲',
        status_blocked: '受阻',
        status_failed: '失败',
        status_interrupted: '已中断',
        status_retired: '已退出',
        status_queued: '排队中',
        status_provisioning: '启动中',
        status_unknown: '未知状态',
        // ---- 聊天回合末尾：本次读取了哪些来自其他成员的留言 ----
        receipt_read: '读取了来自 {name} 的 {n} 条未读消息',
        receipt_expand: '展开消息内容',
        receipt_collapse: '收起消息内容',
        receipt_lead: '上级',
        receipt_empty: '（空消息）',
      },
      en: {
        title: 'dsh-team console',
        subtitle: 'Trace waterfall, DAG, timeline, permissions and approvals (local sidecar via Host proxy)',
        side_nav: 'Team',
        board_nav: 'Board',
        board_title: 'Task board',
        board_desc: 'Workspace task queue and automatic execution',
        board_guide_desc: 'Workspace task queue, concurrency and automatic execution',
        board_dock_open: 'Pin the board on the right side of the page',
        board_dock_close: 'Close the pinned board',
        board_dock_resize: 'Drag to resize the board',
        panel_loading: 'Looking up this session’s team…',
        guide_desc: 'Team members, task DAG and live progress',
        members_title: 'Team members',
        members_running: 'running',
        members_idle: 'idle',
        members_open: 'Open this member’s conversation in the sidebar',
        members_empty: 'No team members in this session',
        members_running_count: '{n} running',
        card_open: 'Show team card',
        card_close: 'Hide team card',
        card_stop: 'Stop team',
        card_browser: 'Open the panel in your browser',
        card_stop_title: 'Stop the team: interrupt running members and return running tasks to the queue',
        card_stop_confirm_title: 'Stop team?',
        card_stop_confirm_text: 'Running members will be interrupted and their running tasks returned to the queue.',
        card_stop_confirm: 'Stop',
        card_cancel: 'Cancel',
        card_stop_running: 'Stopping…',
        card_stop_done: 'Stopped',
        card_title: 'Team verification',
        sev_critical: 'critical',
        sev_warning: 'warning',
        card_all_done: 'All checks done',
        card_stopped: 'Stopped',
        card_plan_aria: 'Member plan',
        card_plan: 'Plan',
        running_of: '{n} of {m} running',
        status_running: 'running',
        status_idle: 'idle',
        status_blocked: 'blocked',
        status_failed: 'failed',
        status_interrupted: 'interrupted',
        status_retired: 'retired',
        status_queued: 'queued',
        status_provisioning: 'provisioning',
        status_unknown: 'Unknown',
        receipt_read: 'Read {n} unread message(s) from {name}',
        receipt_expand: 'Show messages',
        receipt_collapse: 'Hide messages',
        receipt_lead: 'the Lead',
        receipt_empty: '(empty message)',
      },
    };

    const CSS = `
.dsht-page { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dsht-page-head { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; }
.dsht-page-wait { display:flex; align-items:center; justify-content:center; height:100%; font-size:12px; color:var(--dsw-alias-label-secondary); }
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

/* 会话右上角的「运行中成员」条：一排可点的 chip，点开在右侧栏嵌入该成员对话 */
.dsht-members { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:46vw; overflow:hidden; }
.dsht-members-head { display:inline-flex; align-items:center; gap:4px; font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; flex:none; }
.dsht-members-count { font-variant-numeric:tabular-nums; font-weight:600; color:var(--dsw-alias-brand-primary); }
.dsht-chip { display:inline-flex; align-items:center; gap:5px; max-width:150px; padding:2px 8px 2px 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:11px; line-height:18px; cursor:pointer; flex:none; }
.dsht-chip:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dsht-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-label-tertiary); flex:none; }
.dsht-dot.is-running { background:var(--dsw-alias-brand-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); animation:dsht-pulse 1.6s ease-in-out infinite; }
.dsht-chip.is-idle { color:var(--dsw-alias-label-secondary); }
@keyframes dsht-pulse { 0%,100% { opacity:1 } 50% { opacity:.45 } }

/* 输入框权限控件右侧：团队卡片入口（affectui AgentFindings 移植） */
.dsht-afc-pill { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12px; line-height:16px; font-variant-numeric:tabular-nums; cursor:pointer; white-space:nowrap; }
.dsht-afc-pill:hover { border-color:var(--dsw-alias-brand-primary); }
.dsht-afc-pill[aria-expanded="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dsht-afc-pill-mark { display:inline-flex; flex:none; color:var(--dsw-alias-brand-primary); }
.dsht-afc-pill-run { color:var(--dsw-alias-label-secondary); }
.dsht-afc-pill-sev { display:inline-flex; align-items:center; gap:3px; }
.dsht-afc-pill-sev[data-severity="critical"] { color:var(--dsw-alias-state-error-primary); }
.dsht-afc-pill-sev[data-severity="warning"] { color:var(--dsw-alias-state-warn-primary); }
.dsht-afc-pill-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
/* 快照这一轮没取到（sidecar 抖动）时仍保留入口，只做轻微降权，避免卡片闪一下就消失 */
.dsht-afc-pill[data-dsh-team-stale] { border-style:dashed; }
.dsht-afc-pill[data-dsh-team-stale] .dsht-afc-pill-run::after { content:" ·!"; color:var(--dsw-alias-label-tertiary); font-weight:600; }

/* 卡片停靠层（shell.overlay 是点击穿透层，卡片自己接管指针） */
.dsht-afc-dock { position:fixed; top:56px; right:20px; width:368px; max-width:calc(100vw - 40px); z-index:80; pointer-events:auto; display:flex; flex-direction:column; gap:6px; }
.dsht-afc-dock-bar { display:flex; align-items:center; gap:6px; padding:4px 8px; border-radius:9px; font-size:11px; color:var(--dsw-alias-label-secondary); background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 62%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 55%, transparent); -webkit-backdrop-filter:blur(14px) saturate(150%); backdrop-filter:blur(14px) saturate(150%); }
.dsht-afc-dock-name { font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-afc-dock-close { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 65%, transparent); color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dsht-afc-dock-close:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-brand-primary); }
/* 停止团队：图标按钮与 × 并列在最右；点击只开二次确认弹窗，不直接执行 */
.dsht-afc-dock-actions { margin-left:auto; display:inline-flex; align-items:center; gap:4px; }
.dsht-afc-dock-open { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 65%, transparent); color:var(--dsw-alias-label-secondary); cursor:pointer; text-decoration:none; }
.dsht-afc-dock-open:hover { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dsht-afc-dock-stop { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 65%, transparent); color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dsht-afc-dock-stop:hover { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsht-afc-dock-stop:disabled { cursor:default; opacity:.55; }
.dsht-afc-dock-stop:disabled:hover { color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); }
/* 停止确认弹窗：盖住整帧，点遮罩/取消/Esc 关闭 */
.dsht-afc-modal { position:fixed; inset:0; z-index:90; display:grid; place-items:center; padding:16px; background:color-mix(in srgb, #000 32%, transparent); pointer-events:auto; }
.dsht-afc-modal-card { width:min(320px, 100%); display:grid; gap:10px; padding:14px 16px; border-radius:12px; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l1); box-shadow:0 18px 44px -26px color-mix(in srgb, #000 55%, transparent); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.dsht-afc-modal-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsht-afc-modal-error { color:var(--dsw-alias-state-error-primary); }
.dsht-afc-modal-actions { display:flex; justify-content:flex-end; gap:8px; }
.dsht-afc-modal-btn { height:26px; padding:0 12px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.dsht-afc-modal-btn:hover { border-color:var(--dsw-alias-brand-primary); }
.dsht-afc-modal-btn.is-danger { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color:var(--dsw-alias-state-error-primary); }
.dsht-afc-modal-btn:disabled { opacity:.55; cursor:default; }
.dsht-afc-dock-card { max-height:var(--dsht-dock-max, 80vh); overflow:auto; overscroll-behavior:contain; border-radius:12px; }
.dsht-afc-dock-card .ui-afc { max-width:none; }
.dsht-afc-dock-empty { padding:12px 14px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:12px; }

/* 卡片配色跟随宿主主题：把 affectui 的 --ui-afc-* 设计变量重绑到 --dsw-alias-*，
   不依赖 .dark / [data-theme] 类名，亮色暗色切换自动生效。 */
.dsht-afc-dock .ui-afc {
  --ui-afc-card: color-mix(in srgb, var(--dsw-alias-bg-overlay) 72%, transparent);
  --ui-afc-strong: var(--dsw-alias-label-primary);
  --ui-afc-ink: var(--dsw-alias-label-primary);
  --ui-afc-text: var(--dsw-alias-label-secondary);
  --ui-afc-muted: color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent);
  --ui-afc-faint: color-mix(in srgb, var(--dsw-alias-label-primary) 34%, transparent);
  --ui-afc-line: var(--dsw-alias-border-l1);
  --ui-afc-fill: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  --ui-afc-hover: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  --ui-afc-select: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  --ui-afc-run-bg: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
  --ui-afc-run-edge: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  --ui-afc-done-bg: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  --ui-afc-done-edge: var(--dsw-alias-border-l2);
  --ui-afc-fail-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
  --ui-afc-fail-edge: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  --ui-afc-crit: var(--dsw-alias-state-error-primary);
  --ui-afc-warn: var(--dsw-alias-state-warn-primary);
  --ui-afc-note: var(--dsw-alias-brand-primary);
  --ui-afc-focus: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  --ui-afc-shadow: 0 0 0 0.5px var(--dsw-alias-border-l1), 0 18px 44px -26px color-mix(in srgb, #000 55%, transparent);
}
/* 磨砂玻璃：卡片半透明 + 背景模糊（backdrop-filter），下面有页面内容时能透出模糊底色。
   宿主 Chromium 不支持 backdrop-filter 时退回不透明底色，保证可读性。 */
.dsht-afc-dock .ui-afc__card {
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 80%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 72%, transparent);
  -webkit-backdrop-filter:blur(24px) saturate(170%);
  backdrop-filter:blur(24px) saturate(170%);
  box-shadow:0 0 0 .5px color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent), 0 18px 44px -26px color-mix(in srgb, #000 55%, transparent);
}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
  .dsht-afc-dock .ui-afc__card { background:var(--dsw-alias-bg-overlay); }
  .dsht-afc-dock-bar { background:var(--dsw-alias-bg-layer-2); }
}
.dsht-afc-dock .ui-afc__spark { color:var(--dsw-alias-brand-primary); }
.dsht-afc-dock .ui-afc__agent[data-status="running"] .ui-afc__fill::before {
  background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent), transparent);
}

/* 「看板」行右端的固定开关：shell.overlay 里的真实按钮，按左侧栏行矩形定位 */
.dsht-dock-toggle { position:fixed; z-index:60; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer; pointer-events:auto; }
.dsht-dock-toggle:hover { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.dsht-dock-toggle[aria-pressed="true"] { color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
/* 固定看板：网页最右侧的整高停靠层，跨会话常驻（不随手风琴/对话切换卸载） */
.dsht-dock { position:fixed; top:46px; right:0; bottom:0; width:min(var(--dsht-dock-w, 680px), 92vw); z-index:70; display:flex; flex-direction:column; min-height:0; pointer-events:auto; background:var(--dsw-alias-bg-base); border-left:1px solid var(--dsw-alias-border-l1); box-shadow:-18px 0 44px -30px color-mix(in srgb, #000 55%, transparent); }
.dsht-dock-resize { position:absolute; top:0; bottom:0; left:-6px; width:14px; cursor:col-resize; touch-action:none; pointer-events:auto; background:transparent; }
.dsht-dock-resize::after { content:''; position:absolute; top:0; bottom:0; left:6px; width:2px; background:transparent; }
.dsht-dock-resize:hover::after, .dsht-dock-resize:focus-visible::after { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); }
.dsht-dock-resize:focus-visible { outline:none; }
.dsht-dock-head { display:flex; align-items:center; gap:8px; flex:none; height:38px; padding:0 10px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsht-dock-close { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dsht-dock-close:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); }
.dsht-dock-body { flex:1; min-height:0; display:flex; }
.dsht-dock-body > .dsht-page { flex:1; min-width:0; }
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

    /**
     * 左侧栏图标。id 与 main 槽的 key 一一对应，点击时 sidebar 会调 layout.selectPanel。
     * @param {string} [kind] - 'board' 用看板图标与文案，缺省为编排。
     */
    function panelIcon(t, kind) {
      const board = kind === 'board';
      const Glyph = board ? BoardIcon : TeamIcon;
      return function PanelIcon(props) {
        const size = Math.max(12, Number(props && props.size) || 16);
        const active = !!(props && props.active);
        return h('span', {
          className: 'dsht-panel-icon' + (active ? ' is-active' : ''),
          title: t(board ? 'board_nav' : 'title'),
          'aria-label': t(board ? 'board_nav' : 'side_nav'),
          role: 'img',
          'data-dsht-board-entry': board ? '1' : undefined,
        }, h(Glyph, { size, active }));
      };
    }

    // ---------- dsh-better-sidebar 页签（可选宿主，装了就把入口交给它） ----------
    /** 编排页签：原生右侧栏的 guide 胶囊 + 插件底部工作台的 + 菜单同源。 */
    function betterTabDescriptors(t, getService) {
      return [{
        id: 'dsh-team:panel',
        title: () => t('side_nav'),
        description: () => t('subtitle'),
        icon: (size) => h(TeamIcon, { size: size || 16 }),
        order: 30,
        single: true,
        component: () => h(TeamView, { t, compact: true, getService }),
      }, {
        id: 'dsh-team:board',
        title: () => t('board_nav'),
        description: () => t('board_desc'),
        icon: (size) => h(BoardIcon, { size: size || 16 }),
        order: 31,
        single: true,
        component: () => h(BoardView, { t, getService }),
      }];
    }

    /** 打开编排面板时希望面板直接选中的团队（TeamView 渲染时带上 &team=）。 */
    let pendingTeamId = null;

    /**
     * 每个会话自己的团队 id。侧栏「编排」页拿不到 sessionId prop，而面板又会随会话切换
     * 重新挂载 —— 只靠上面那个全局 pendingTeamId 会带错团队（切回老会话时它根本没被赋值，
     * 面板就以空 team 加载，进而落到第一个工作区的团队）。这里按会话记住结果，跨挂载复用。
     */
    const sessionTeamStore = (() => {
      const byId = new Map();
      const listeners = new Set();
      // 最近一次看到的团队也落 sessionStorage：整页刷新后编排页不会先空一屏跳到第一个工作区
      const LAST_TEAM_KEY = 'dsh-team:last-team';
      const LAST_CWD_KEY = 'dsh-team:last-cwd';
      let active = null;
      let lastTeamId = null;
      let forcedTeamId = null;
      let lastCwd = null;
      try { lastTeamId = window.sessionStorage.getItem(LAST_TEAM_KEY) || null; } catch { /* ignore */ }
      try { lastCwd = window.sessionStorage.getItem(LAST_CWD_KEY) || null; } catch { /* ignore */ }
      const emit = () => {
        for (const fn of listeners) { try { fn(); } catch { /* 单个订阅出错不影响其他 */ } }
      };
      return {
        setActive(sessionId) {
          const next = sessionId || null;
          if (active === next) return;
          active = next;
          forcedTeamId = null;
          emit();
        },
        /** 看板详情里点「打开编排」：强制本次面板显示指定团队，直到切会话。 */
        focusTeam(teamId) {
          const next = teamId || null;
          forcedTeamId = next;
          if (next) {
            lastTeamId = next;
            try { window.sessionStorage.setItem(LAST_TEAM_KEY, next); } catch { /* ignore */ }
          }
          emit();
        },
        /** teamId 为 null 表示「查过了，这个会话没有团队」；重复写入相同值不触发渲染。 */
        set(sessionId, teamId) {
          if (!sessionId) return;
          const prev = byId.get(sessionId);
          const nextTeam = teamId || null;
          const teamChanged = !prev || prev.teamId !== nextTeam;
          const lastChanged = !!nextTeam && nextTeam !== lastTeamId;
          if (lastChanged) {
            lastTeamId = nextTeam;
            try { window.sessionStorage.setItem(LAST_TEAM_KEY, nextTeam); } catch { /* ignore */ }
          }
          if (!teamChanged && !lastChanged) return;
          byId.set(sessionId, { teamId: nextTeam });
          emit();
        },
        get(sessionId) { return (sessionId && byId.get(sessionId)) || null; },
        /** 当前会话的工作目录：看板据此默认选中对应工作区。 */
        setCwd(sessionId, cwd) {
          if (!sessionId || sessionId !== active) return;
          const next = cwd ? String(cwd) : null;
          if (next === lastCwd) return;
          lastCwd = next;
          try {
            if (next) window.sessionStorage.setItem(LAST_CWD_KEY, next);
            else window.sessionStorage.removeItem(LAST_CWD_KEY);
          } catch { /* ignore */ }
          emit();
        },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        /**
         * lastTeamId：最近一次解析到的团队。侧栏还能开「子 agent 聊天」这类没有自己团队的
         * 页签，它会把 active 切成子会话；这时编排页沿用上一次的团队，而不是空等或跳回
         * 第一个工作区。
         */
        snapshot() { return { sessionId: active, info: (active && byId.get(active)) || null, lastTeamId, forcedTeamId, cwd: lastCwd }; },
      };
    })();

    /**
     * 「看板」固定停靠开关：把看板放在网页最右侧（shell.overlay，跨会话常驻），
     * 而不是放进会随对话变更的右侧栏。状态落 localStorage，刷新/切会话都保持。
     */
    const boardDockStore = (() => {
      const KEY = 'dsh-team:board-dock';
      const WIDTH_KEY = 'dsh-team:board-dock-width';
      const MIN_WIDTH = 360;
      const MAX_WIDTH = 1000;
      const DEFAULT_WIDTH = 680;
      const clampWidth = (value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return DEFAULT_WIDTH;
        return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)));
      };
      const listeners = new Set();
      let open = false;
      let width = DEFAULT_WIDTH;
      try {
        open = window.localStorage.getItem(KEY) === '1';
        const saved = window.localStorage.getItem(WIDTH_KEY);
        if (saved != null && saved !== '') width = clampWidth(saved);
      } catch { /* ignore */ }
      const emit = () => {
        for (const fn of listeners) { try { fn(); } catch { /* 单个订阅出错不影响其他 */ } }
      };
      const set = (next) => {
        const value = !!next;
        if (open === value) return;
        open = value;
        try { window.localStorage.setItem(KEY, value ? '1' : '0'); } catch { /* ignore */ }
        emit();
      };
      const setWidth = (next) => {
        const value = clampWidth(next);
        if (width === value) return;
        width = value;
        try { window.localStorage.setItem(WIDTH_KEY, String(value)); } catch { /* ignore */ }
        emit();
      };
      return {
        isOpen: () => open,
        set,
        toggle() { set(!open); },
        width: () => width,
        setWidth,
        minWidth: MIN_WIDTH,
        maxWidth: MAX_WIDTH,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      };
    })();

    /** 面板主体：iframe 复用 sidecar 自带 /panel（成员看板 Trace 瀑布 + 其余视图 + SSE）。 */
    function TeamView({ t, compact, getService }) {
      const [sessionTeam, setSessionTeam] = React.useState(() => sessionTeamStore.snapshot());
      React.useEffect(() => {
        const sync = () => setSessionTeam(sessionTeamStore.snapshot());
        sync();
        return sessionTeamStore.subscribe(sync);
      }, []);
      // 当前会话自己的团队优先；没有（子 agent 聊天页签、还没查完）就沿用最近一次的团队，
      // 再没有才回落到 pendingTeamId。绝不能退回「空 team」——那会让面板跳去第一个工作区。
      const ownTeam = (sessionTeam.info && sessionTeam.info.teamId) || '';
      const teamParam = sessionTeam.forcedTeamId || ownTeam || sessionTeam.lastTeamId || pendingTeamId || '';
      // 一个团队都还不知道、但已经在等查询结果时才显示占位，避免先用空 team 加载一屏再重载。
      const waitingTeam = !teamParam && !!sessionTeam.sessionId && !sessionTeam.info;
      const frameSrc = '/dsh-team-api/panel?api=/dsh-team-api&embed=1'
        + (teamParam ? '&team=' + encodeURIComponent(teamParam) : '');
      const frameRef = React.useRef(null);
      // 面板（同源 iframe）里点成员 → 在这里真正打开 DSH 的成员对话侧栏。
      React.useEffect(() => {
        const onMessage = (event) => {
          const frame = frameRef.current;
          if (!frame || !event || event.source !== frame.contentWindow) return;
          const data = event.data;
          if (!data || data.type !== 'dsh-team:open-member') return;
          const childSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
          if (!childSessionId) return;
          const parentSessionId = typeof data.parentSessionId === 'string' ? data.parentSessionId : '';
          if (!openMemberAside(getService, parentSessionId, childSessionId)) {
            console.warn('[dsh-team] 无法打开成员会话：缺少 sidebarRight / uiWorkspace');
          }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [getService]);
      return h('div', { className: 'dsht-page' },
        h('header', { className: 'dsht-page-head' },
          h('span', { className: 'dsht-page-mark' }, h(TeamIcon, { size: compact ? 14 : 16 })),
          h('span', { className: 'dsht-page-title' }, t('title')),
          compact ? null : h('span', { className: 'dsht-page-sub' }, t('subtitle')),
          h('span', { className: 'dsht-spacer' })),
        h('div', { className: 'dsht-page-body' },
          waitingTeam
            ? h('div', { className: 'dsht-page-wait' }, t('panel_loading'))
            : h('iframe', {
              ref: frameRef,
              key: teamParam || 'default',
              className: 'dsht-frame',
              title: t('title'),
              src: frameSrc,
            })));
    }

    /** 独立任务看板：整页 iframe 指向 #/board，不继承任何 team。 */
    function BoardView({ t, getService }) {
      const frameRef = React.useRef(null);
      // 只在打开看板（本组件挂载）时取一次当前会话的 cwd：固定停靠的看板不跟着会话切换
      // 刷新，否则 iframe 会重载、把用户手动选的工作区冲掉。
      const [cwd] = React.useState(() => sessionTeamStore.snapshot().cwd);
      const frameSrc = '/dsh-team-api/panel?api=/dsh-team-api&embed=1'
        + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '')
        + '#/board';
      // 看板详情里点「打开编排」→ 在 Host 侧切到编排页，并把 iframe 指到对应团队。
      React.useEffect(() => {
        const onMessage = (event) => {
          const frame = frameRef.current;
          if (!frame || !event || event.source !== frame.contentWindow) return;
          const data = event.data;
          if (!data) return;
          if (data.type === 'dsh-team:open-session') {
            // 看板任务详情 → 打开该任务 Lead 所在的 DSH 会话
            const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
            if (!sessionId) return;
            const workspace = getService('uiWorkspace');
            if (workspace && typeof workspace.openSession === 'function') {
              workspace.openSession(sessionId);
              return;
            }
            console.warn('[dsh-team] 无法打开看板会话：缺少 uiWorkspace');
            return;
          }
          if (data.type !== 'dsh-team:open-team') return;
          const teamId = typeof data.teamId === 'string' ? data.teamId : '';
          if (!teamId) return;
          openTeamForTeam(getService, teamId, typeof data.sessionId === 'string' ? data.sessionId : '');
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [getService]);
      return h('div', { className: 'dsht-page dsht-page--board' },
        h('iframe', {
          ref: frameRef,
          className: 'dsht-frame',
          title: t('board_title'),
          src: frameSrc,
        }));
    }

    function BoardIcon({ size }) {
      const s = size || 16;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 2, y: 2.5, width: 3.4, height: 11, rx: 1 }),
        h('rect', { x: 6.3, y: 2.5, width: 3.4, height: 7, rx: 1 }),
        h('rect', { x: 10.6, y: 2.5, width: 3.4, height: 9, rx: 1 }));
    }

    /** 「固定到右侧」图标：外框 + 右列（打开时右列填充）。 */
    function DockIcon({ size = 14, open = false }) {
      const s = size;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false', style: { display: 'block' },
      },
        h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.8 }),
        h('rect', { x: 9.4, y: 4.4, width: 3.4, height: 7.2, rx: 0.9, fill: open ? 'currentColor' : 'none' }));
    }

    /**
     * 左侧栏「看板」行右端的固定开关。宿主把 panellist 的图标放在行 <button> 里，
     * 自己再注册一个可点行会被 layout.selectPanel 拒绝；所以按钮放在 shell.overlay，
     * 按行矩形 position:fixed 贴到行右端（折叠态隐藏）。
     */
    function boardDockToggle(T) {
      return function BoardDockToggle() {
        const [open, setOpen] = React.useState(() => boardDockStore.isOpen());
        const [pos, setPos] = React.useState(null);
        React.useEffect(() => boardDockStore.subscribe(() => setOpen(boardDockStore.isOpen())), []);
        React.useLayoutEffect(() => {
          let alive = true;
          let raf = 0;
          const measure = () => {
            if (!alive || typeof document === 'undefined') return;
            const marker = document.querySelector('[data-dsht-board-entry]');
            const row = marker && typeof marker.closest === 'function' ? marker.closest('button') : null;
            let next = null;
            if (row) {
              const rect = row.getBoundingClientRect();
              // 折叠态只剩图标列，没有放开关的空间；行滚出视口时也不显示
              if (rect.width >= 120 && rect.top >= 0 && rect.bottom <= (window.innerHeight || 0)) {
                next = {
                  left: Math.round(rect.right - 30),
                  top: Math.round(rect.top + (rect.height - 24) / 2),
                };
              }
            }
            setPos((prev) => {
              if (!prev && !next) return prev;
              if (prev && next && prev.left === next.left && prev.top === next.top) return prev;
              return next;
            });
          };
          const schedule = () => {
            if (raf) return;
            const run = () => { raf = 0; measure(); };
            if (typeof window.requestAnimationFrame === 'function') raf = window.requestAnimationFrame(run);
            else run();
          };
          for (const delay of [0, 80, 240, 600, 1200]) {
            const kick = setTimeout(schedule, delay);
            kick?.unref?.();
          }
          const timer = setInterval(measure, 1000);
          timer?.unref?.();
          window.addEventListener('resize', schedule);
          return () => {
            alive = false;
            if (raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(raf);
            clearInterval(timer);
            window.removeEventListener('resize', schedule);
          };
        }, []);
        if (!pos) return null;
        return h('button', {
          type: 'button',
          className: 'dsht-dock-toggle',
          style: { left: pos.left + 'px', top: pos.top + 'px' },
          title: T(open ? 'board_dock_close' : 'board_dock_open'),
          'aria-label': T(open ? 'board_dock_close' : 'board_dock_open'),
          'aria-pressed': open ? 'true' : 'false',
          onClick: (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            boardDockStore.toggle();
          },
        }, h(DockIcon, { size: 14, open }));
      };
    }

    /** 网页最右侧的固定看板：跨会话常驻的整高停靠层（不是右侧栏页签），宽度可拖拽并落盘。 */
    function boardDockView(T, getService) {
      return function BoardDock() {
        const [state, setState] = React.useState(() => ({ open: boardDockStore.isOpen(), width: boardDockStore.width() }));
        const dockRef = React.useRef(null);
        React.useEffect(() => boardDockStore.subscribe(
          () => setState({ open: boardDockStore.isOpen(), width: boardDockStore.width() })), []);
        // 停靠时让主区让出同样的宽度：宿主 frame 是 CSS grid，padding 只压缩内容盒（overlayLayer 与 fixed 停靠层不受影响）
        React.useEffect(() => {
          if (!state.open) return undefined;
          const node = dockRef.current;
          let layer = node && node.parentElement;
          for (let i = 0; layer && i < 4; i += 1) {
            if (/overlayLayer/.test(String(layer.className || ''))) break;
            layer = layer.parentElement;
          }
          const frame = layer && /overlayLayer/.test(String(layer.className || '')) ? layer.parentElement : null;
          if (!frame) return undefined;
          const previous = frame.style.paddingRight;
          const apply = () => {
            const cap = Math.max(0, Math.round((window.innerWidth || 0) * 0.92));
            frame.style.paddingRight = Math.min(state.width, cap) + 'px';
            frame.setAttribute('data-dsht-dock', '1');
          };
          apply();
          window.addEventListener('resize', apply);
          return () => {
            window.removeEventListener('resize', apply);
            frame.style.paddingRight = previous;
            frame.removeAttribute('data-dsht-dock');
          };
        }, [state.open, state.width]);
        if (!state.open) return null;
        const startResize = (event) => {
          if (!event || (typeof event.button === 'number' && event.button !== 0)) return;
          event.preventDefault();
          const handle = event.currentTarget;
          try { handle?.setPointerCapture?.(event.pointerId); } catch { /* 老浏览器无指针捕获 */ }
          const startX = event.clientX;
          const startWidth = boardDockStore.width();
          const cap = () => Math.max(boardDockStore.minWidth, Math.min(boardDockStore.maxWidth, (window.innerWidth || 0) - 160));
          const move = (ev) => {
            const next = startWidth + (startX - ev.clientX);
            boardDockStore.setWidth(Math.max(boardDockStore.minWidth, Math.min(cap(), next)));
          };
          const stop = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
          };
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'col-resize';
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', stop);
          window.addEventListener('pointercancel', stop);
        };
        const nudge = (event) => {
          if (!event || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
          event.preventDefault();
          const delta = event.key === 'ArrowLeft' ? 40 : -40;
          boardDockStore.setWidth(boardDockStore.width() + delta);
        };
        return h('aside', {
          ref: dockRef,
          className: 'dsht-dock',
          style: { '--dsht-dock-w': state.width + 'px' },
          'aria-label': T('board_title'),
        },
          h('div', {
            className: 'dsht-dock-resize',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': T('board_dock_resize'),
            title: T('board_dock_resize'),
            tabIndex: 0,
            onPointerDown: startResize,
            onKeyDown: nudge,
          }),
          h('div', { className: 'dsht-dock-head' },
            h('span', { className: 'dsht-page-mark' }, h(BoardIcon, { size: 14 })),
            h('span', null, T('board_title')),
            h('span', { className: 'dsht-spacer' }),
            h('button', {
              type: 'button',
              className: 'dsht-dock-close',
              title: T('board_dock_close'),
              'aria-label': T('board_dock_close'),
              onClick: () => boardDockStore.set(false),
            }, '×')),
          h('div', { className: 'dsht-dock-body' }, h(BoardView, { t: T, getService })));
      };
    }

    // ---------- 会话右上角：当前会话的运行中成员（点击在右侧栏内嵌该成员对话） ----------
    const SIDECAR_BASE = '/dsh-team-api';
    /** 独立面板地址：浏览器里直接开 sidecar 自带的 /panel（不经过 Host 代理，可脱离 GUI 用）。 */
    const PANEL_ORIGIN = 'http://127.0.0.1:4317';
    function panelBrowserUrl(teamId) {
      return PANEL_ORIGIN + '/?team=' + encodeURIComponent(teamId || '');
    }

    /** 成员名缓存：agentSessionId → {name, teamId, status}；15s 内复用，避免每次渲染都打 sidecar。 */
    const memberCache = { at: 0, bySession: {}, loading: null };

    /** 拉一遍所有团队的成员建 agentSessionId 索引；sidecar 不可用时静默降级（用会话标题当名字）。 */
    function loadMembers() {
      if (Date.now() - memberCache.at < 15000 && Object.keys(memberCache.bySession).length) {
        return Promise.resolve(memberCache.bySession);
      }
      if (memberCache.loading) return memberCache.loading;
      memberCache.loading = (async () => {
        const bySession = {};
        try {
          const teamsRes = await fetch(SIDECAR_BASE + '/api/teams', { headers: { accept: 'application/json' } });
          const teams = teamsRes.ok ? ((await teamsRes.json()).items || []) : [];
          await Promise.all(teams.map(async (team) => {
            try {
              const res = await fetch(SIDECAR_BASE + '/api/teams/' + encodeURIComponent(team.id) + '/members',
                { headers: { accept: 'application/json' } });
              if (!res.ok) return;
              for (const member of ((await res.json()).items || [])) {
                if (member.agentSessionId) bySession[member.agentSessionId] = { name: member.name, teamId: team.id, status: member.status };
              }
            } catch { /* 单个团队失败不影响其它 */ }
          }));
        } catch { /* sidecar 没起：降级 */ }
        memberCache.at = Date.now();
        memberCache.bySession = bySession;
        return bySession;
      })().finally(() => { memberCache.loading = null; });
      return memberCache.loading;
    }

    /** 成员对话的侧栏资源地址：DSH 内置 subagentchat 页，右侧栏内嵌该子会话的完整对话。 */
    function memberAsideUrl(getService, parentSessionId, childSessionId) {
      const sessions = getService('sessions');
      let address;
      try {
        address = sessions && typeof sessions.subagentAddress === 'function' ? sessions.subagentAddress(childSessionId) : undefined;
      } catch { address = undefined; }
      if (!address) address = { parentSessionId, childSessionId, mode: 'continuable' };
      const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode || 'continuable' });
      return 'dsh-resource://subagentchat/session/' + encodeURIComponent(childSessionId) + '?' + query.toString();
    }

    /** 在右侧栏打开成员对话；没有 sidebarRight 时退回主面板切换会话。 */
    function openMemberAside(getService, parentSessionId, childSessionId) {
      const sidebarRight = getService('sidebarRight');
      if (sidebarRight && typeof sidebarRight.openResource === 'function') {
        sidebarRight.openResource(memberAsideUrl(getService, parentSessionId, childSessionId),
          { kind: 'subagentchat', preferNewPane: true });
        return true;
      }
      const workspace = getService('uiWorkspace');
      if (workspace && typeof workspace.openSession === 'function') {
        const sessions = getService('sessions');
        let address;
        try { address = sessions && sessions.subagentAddress ? sessions.subagentAddress(childSessionId) : undefined; } catch { /* ignore */ }
        workspace.openSession(address || childSessionId);
        return true;
      }
      return false;
    }

    /**
     * 把「编排」页在右侧栏（DSH 原生 Sidebar）打开。
     * better-sidebar 的 openTab 只会落它自己的底部工作台，右侧栏要走 DSH 原生的
     * sidebarRight.openTab(kind)：装了 better-sidebar 时它会把自己注册的页签同步成
     * 原生 kind（本插件的 descriptor id 即 'dsh-team:panel'），没装时用本插件在
     * client.js 兜底分支注册的 'dsh-team'。kind 未注册会抛错，所以逐个尝试。
     */
    function openTeamPanel(getService, sessionId) {
      if (typeof getService !== 'function') return false;
      const right = getService('sidebarRight');
      if (right && typeof right.openTab === 'function') {
        for (const kind of ['dsh-team:panel', 'dsh-team']) {
          try { right.openTab(kind); return true; } catch { /* 该 kind 未注册，试下一个 */ }
        }
        console.warn('[dsh-team] no sidebarRight kind registered for the team panel');
      }
      const better = getService('betterSidebar');
      if (better && typeof better.openTab === 'function') {
        // 最后兜底：bottom 工作台（右侧栏打不开时至少能看到编排页）
        try { better.openTab({ type: 'dsh-team:panel' }, { sessionId }); return true; } catch (e) { console.warn('[dsh-team] openTab failed', e); }
      }
      return false;
    }

    /** 看板详情 → 编排侧栏：先锁定团队，再打开原生右侧栏页签。 */
    function openTeamForTeam(getService, teamId, sessionId) {
      if (!teamId || typeof getService !== 'function') return false;
      pendingTeamId = teamId;
      sessionTeamStore.focusTeam(teamId);
      return openTeamPanel(getService, sessionId);
    }

    /** 本会话是否已经自动推开过一次（用户手动收起后不再打扰）。 */
    const AUTO_OPEN_KEY = 'dsh-team.autoopen.v1.';

    /* ------------------------------------------------------------------
     * 会话右上角团队卡片（移植 affectui `agent-findings`）
     * - 右上角 pill：本会话团队 · 运行中 n/m · 严重/警告计数，点击展开卡片
     * - 卡片本体渲染在 shell.overlay（frame-wide 浮层），停靠会话右上角
     * - 数据：Host 代理 /dsh-team-api → sidecar（/status /teams /tasks /events）
     * ------------------------------------------------------------------ */
    const AGENT_FINDINGS_CSS = `.ui-afc{--ui-afc-card: #ffffff;--ui-afc-strong: #000000;--ui-afc-ink: rgba(0, 0, 0, 0.88);--ui-afc-text: rgba(0, 0, 0, 0.61);--ui-afc-muted: rgba(0, 0, 0, 0.45);--ui-afc-faint: rgba(0, 0, 0, 0.27);--ui-afc-line: rgba(0, 0, 0, 0.06);--ui-afc-fill: rgba(0, 0, 0, 0.06);--ui-afc-hover: rgba(0, 0, 0, 0.025);--ui-afc-select: rgba(0, 0, 0, 0.04);--ui-afc-run-bg: rgba(0, 96, 226, 0.1);--ui-afc-run-edge: rgba(0, 96, 226, 0.32);--ui-afc-done-bg: rgba(0, 0, 0, 0.05);--ui-afc-done-edge: rgba(0, 0, 0, 0.1);--ui-afc-fail-bg: #f52b0018;--ui-afc-fail-edge: rgba(215, 36, 0, 0.34);--ui-afc-crit: #d72400;--ui-afc-warn: #cc4e00;--ui-afc-note: rgba(0, 96, 226, 0.8);--ui-afc-focus: rgba(0, 96, 226, 0.35);--ui-afc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);--ui-afc-ease: cubic-bezier(0.22, 1, 0.36, 1);position: relative;box-sizing: border-box;width: 100%;max-width: 640px;container-type: inline-size;font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;font-size: 13px;font-weight: 400;line-height: 20px;color: var(--ui-afc-text);text-align: left;-webkit-font-smoothing: antialiased}.ui-afc *, .ui-afc *::before, .ui-afc *::after{box-sizing: border-box}:where(.ui-afc) button{margin: 0;padding: 0;border: 0;background: none;font: inherit;color: inherit;text-align: inherit;cursor: pointer;-webkit-tap-highlight-color: transparent}.ui-afc button:focus-visible{outline: 2px solid var(--ui-afc-focus);outline-offset: -2px}.ui-afc :is(ul, ol){margin: 0;padding: 0;list-style: none}.ui-afc svg{display: block;flex: none}@keyframes ui-afc-swap{from{opacity: 0;transform: translateY(3px)}}@keyframes ui-afc-sheen{from{transform: translateX(-40px)}to{transform: translateX(160px)}}@keyframes ui-afc-breathe{from{opacity: 0.45}to{opacity: 1}}@container (max-width: 480px){.ui-afc__agent{grid-template-columns: 24px minmax(0, 1fr) 40px auto;gap: 8px}}@media (prefers-reduced-motion: reduce){.ui-afc *, .ui-afc *::before, .ui-afc *::after{animation: none !important;transition: none !important}}:where(.dark, [data-theme="dark"]) .ui-afc{--ui-afc-card: #1c1c1f;--ui-afc-strong: #ffffff;--ui-afc-ink: rgba(255, 255, 255, 0.9);--ui-afc-text: rgba(255, 255, 255, 0.62);--ui-afc-muted: rgba(255, 255, 255, 0.45);--ui-afc-faint: rgba(255, 255, 255, 0.28);--ui-afc-line: rgba(255, 255, 255, 0.08);--ui-afc-fill: rgba(255, 255, 255, 0.08);--ui-afc-hover: rgba(255, 255, 255, 0.04);--ui-afc-select: rgba(255, 255, 255, 0.06);--ui-afc-run-bg: rgba(112, 184, 255, 0.18);--ui-afc-run-edge: rgba(112, 184, 255, 0.5);--ui-afc-done-bg: rgba(255, 255, 255, 0.08);--ui-afc-done-edge: rgba(255, 255, 255, 0.14);--ui-afc-fail-bg: #ff35232b;--ui-afc-fail-edge: rgba(255, 151, 125, 0.45);--ui-afc-crit: #ff977d;--ui-afc-warn: #ffa057;--ui-afc-note: #70b8ff;--ui-afc-focus: rgba(91, 154, 255, 0.45);--ui-afc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4)}:where(.dark, [data-theme="dark"]) .ui-afc__spark{color: #70b8ff}:where(.dark, [data-theme="dark"]) .ui-afc__agent[data-status="running"] .ui-afc__fill::before{background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.14), transparent)}`;

    /** 成员计划清单：选中成员时在行下展开（状态符号 + 标题；done 划掉、blocked 标警告色）。 */
    const PLAN_CSS = `.ui-afc__plan-wrap{display: grid; gap: 4px; margin: 4px 20px 10px 46px}.ui-afc__plan-head{display: flex; align-items: center; gap: 8px; padding: 0 8px; font-size: 11px; line-height: 14px; color: var(--ui-afc-muted)}.ui-afc__plan-label{font-weight: 500; letter-spacing: 0.3px; text-transform: uppercase}.ui-afc__plan-bar{flex: 1 1 auto; height: 3px; border-radius: 2px; background: var(--ui-afc-fill); overflow: hidden}.ui-afc__plan-bar > i{display: block; height: 100%; border-radius: 2px; background: var(--ui-afc-note); transition: width 600ms var(--ui-afc-ease)}.ui-afc__plan-count{flex: none; font-variant-numeric: tabular-nums}.ui-afc__plan{display: grid; gap: 1px; margin: 0; padding: 0; list-style: none}.ui-afc__plan-step{display: grid; grid-template-columns: 14px minmax(0, 1fr); align-items: start; gap: 8px; padding: 4px 8px; border-radius: 6px; font-size: 12px; line-height: 16px; color: var(--ui-afc-text); transition: background-color 160ms ease, color 160ms ease}.ui-afc__plan-step:hover{background: var(--ui-afc-hover)}.ui-afc__plan-icon{display: block; width: 14px; height: 14px; margin-top: 1px; color: var(--ui-afc-faint)}.ui-afc__plan-title{min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis}.ui-afc__plan-step[data-status="active"]{color: var(--ui-afc-ink)}.ui-afc__plan-step[data-status="active"] .ui-afc__plan-icon{color: var(--ui-afc-note); animation: ui-afc-spin 1200ms linear infinite}.ui-afc__plan-step[data-status="blocked"] .ui-afc__plan-icon{color: var(--ui-afc-warn)}.ui-afc__plan-step[data-status="done"], .ui-afc__plan-step[data-status="skipped"]{color: var(--ui-afc-muted)}.ui-afc__plan-step[data-status="done"] .ui-afc__plan-icon{color: var(--ui-afc-note); opacity: 0.72}.ui-afc__plan-step[data-status="done"] .ui-afc__plan-title, .ui-afc__plan-step[data-status="skipped"] .ui-afc__plan-title{text-decoration: line-through}.ui-afc__plan-step[data-status="skipped"] .ui-afc__plan-icon{opacity: 0.55}@keyframes ui-afc-spin{to{transform: rotate(360deg)}}.ui-afc__row{display: grid}.ui-afc__row .ui-afc__agent{cursor: default}.ui-afc__agents{padding-bottom: 10px}.ui-afc__chat{display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: var(--ui-afc-muted); transition: background-color 160ms ease, color 160ms ease}.ui-afc__chat:hover{background: var(--ui-afc-fill); color: var(--ui-afc-ink)}.ui-afc__agent{grid-template-columns: 24px minmax(0, 1fr) 128px auto auto}@container (max-width: 480px){.ui-afc__agent{grid-template-columns: 24px minmax(0, 1fr) 40px auto auto}}@container (max-width: 560px){.ui-afc__agent{grid-template-columns: 24px minmax(0, 1fr) auto auto;grid-template-areas: \"avatar who count chat\" \"track track track track\";column-gap: 8px;row-gap: 7px;padding: 9px 10px}.ui-afc__avatar{grid-area: avatar}.ui-afc__who{grid-area: who}.ui-afc__track{grid-area: track;width: auto}.ui-afc__count{grid-area: count}.ui-afc__chat{grid-area: chat}.ui-afc__plan-wrap{margin: 4px 8px 8px 10px;gap: 6px}.ui-afc__plan-head{padding: 0 4px}.ui-afc__plan-step{padding: 4px 4px;line-height: 17px}.ui-afc__plan-title{white-space: normal;overflow: visible;text-overflow: clip;word-break: break-word}}.ui-afc__agents{padding: 8px 10px 10px}.ui-afc__who{display: flex;align-items: baseline;gap: 6px;min-width: 0}.ui-afc__name{flex: none;max-width: 52%;overflow: hidden;white-space: nowrap;text-overflow: ellipsis;color: var(--ui-afc-ink);font-weight: 600}.ui-afc__step{min-width: 0;overflow: hidden;white-space: nowrap;text-overflow: ellipsis}.ui-afc__chat{justify-self: end}@container (max-width: 560px){.ui-afc__agents{padding: 6px 8px 8px}.ui-afc__who{gap: 6px}}`;

    const API_BASE = '/dsh-team-api/api';
    const POLL_MS = 4000;
    // 侧车只保证这几个状态；出现新状态时不要让卡片掉出原始 key
    const KNOWN_STATUS = ['running', 'idle', 'blocked', 'failed', 'interrupted', 'retired', 'queued', 'provisioning'];

    /** 拉 sidecar JSON；非 2xx 抛错，由调用方决定降级。 */
    async function fetchJson(path) {
      const res = await fetch(API_BASE + path, { headers: { accept: 'application/json' } });
      if (!res || !res.ok) throw new Error('E_HTTP ' + (res ? res.status : 'no-response'));
      return res.json();
    }

    const EMPTY_CARD = {
      phase: 'idle',
      open: false,
      pinned: false,
      teamId: null,
      teamName: '',
      agents: [],
      findings: [],
      running: 0,
      memberCount: 0,
      asOf: 0,
      error: null,
      /** 连续拿不到快照的次数：偶发一次失败不清屏，连续 MISS_LIMIT 次才认为团队真的没了。 */
      misses: 0,
    };
    const MISS_LIMIT = 3;

    /**
     * 轮询请求的乱序保护。
     * 4s 一次轮询 + 网络抖动时很容易出现「先发后到」：旧请求的响应会覆盖掉更新的状态
     * （表现为卡片先被错误清空、或错误提示被旧的成功响应抹掉）。每次请求带一个递增 token，
     * 只有 token 不小于已应用 token 的响应才允许落库。
     */
    const requestGate = {
      seq: 0,
      applied: new Map(),
      begin(sessionId) {
        this.seq += 1;
        return { sessionId, token: this.seq };
      },
      accept(request) {
        const last = this.applied.get(request.sessionId) || 0;
        if (request.token < last) return false;
        this.applied.set(request.sessionId, request.token);
        return true;
      },
    };

    /** 极简外部 store：pill 与浮层卡片共享同一份快照，任意一侧改动都会触发重渲染。 */
    const cardStore = {
      map: new Map(),
      active: null,
      listeners: new Set(),
      get(sessionId) {
        return (sessionId && this.map.get(sessionId)) || EMPTY_CARD;
      },
      set(sessionId, patch) {
        if (!sessionId) return;
        this.map.set(sessionId, Object.assign({}, this.get(sessionId), patch));
        this.emit();
      },
      setActive(sessionId) {
        if (this.active === sessionId) return;
        this.active = sessionId;
        this.emit();
      },
      subscribe(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn(); } catch { /* 单个订阅者出错不影响其它订阅者 */ }
        }
      },
      toggle(sessionId) {
        const card = this.get(sessionId);
        this.set(sessionId, { open: !card.open, pinned: true });
      },
      close(sessionId) {
        this.set(sessionId, { open: false, pinned: true });
      },
    };

    const STEP_RE = /^S(\d+)$/;
    const stepIndex = (step) => {
      const hit = STEP_RE.exec(String(step || ''));
      return hit ? Number(hit[1]) : null;
    };
    const clip = (text, max) => {
      const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      return value.length > max ? value.slice(0, max - 1) + '…' : value;
    };
    const BLOCKER_SEVERITY = {
      scope_request: 'warning',
      dep: 'note',
      quota: 'critical',
      interrupt: 'critical',
      agent: 'critical',
      lease: 'critical',
      worker: 'critical',
    };
    /** sidecar 事件 result → 发现严重度（FAIL* → 严重，DENIED/CONFLICT → 警告，其它仅作备注）。 */
    const eventSeverity = (result) => {
      const value = String(result || '').toUpperCase();
      if (value.startsWith('FAIL')) return 'critical';
      if (value === 'DENIED' || value === 'CONFLICT') return 'warning';
      return 'note';
    };
    const memberStatus = (status) => {
      if (status === 'failed') return 'failed';
      if (status === 'running' || status === 'blocked' || status === 'provisioning' || status === 'queued') return 'running';
      if (status === 'idle' || status === 'retired') return 'done';
      // 侧车冒出未知状态时不要当成「已完成」，否则进度条会显示 1/1 全部完成
      return 'idle';
    };
    /**
     * 成员在页面上的状态：任务还在 running 就一定按「运行中」画。
     * DSH 的 agent 在维护阶段（上下文压缩、整理）会短暂报 idle，只看 member.status
     * 会把正在干活的成员画成灰色已完成；任务状态是更可靠的事实源。
     */
    const memberDisplayStatus = (member, current) => {
      if (member.status === 'failed') return 'failed';
      if (current && current.status === 'running') return 'running';
      return memberStatus(member.status);
    };
    /** sidecar 计划步骤状态 → 卡片里的符号。 */
    /** 计划行状态图标（对齐 web-ui PlanSteps：pending 虚线圈 / active 转圈 / done 对勾 / blocked 叉 / skipped 减号）。 */
    function PlanIcon(props) {
      const status = props.status || 'open';
      const common = {
        className: 'ui-afc__plan-icon',
        width: 14, height: 14, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      };
      const ring = (dashed) => h('circle', {
        cx: 12, cy: 12, r: 9, strokeDasharray: dashed ? '2 3' : undefined,
      });
      if (status === 'done') return h('svg', common, ring(false), h('path', { d: 'm8.4 12.6 2.5 2.5 4.9-5.4' }));
      if (status === 'active') return h('svg', common, h('circle', { cx: 12, cy: 12, r: 9, opacity: 0.3 }), h('path', { d: 'M21 12a9 9 0 0 0-9-9' }));
      if (status === 'blocked') return h('svg', common, ring(false), h('path', { d: 'm9.4 9.4 5.2 5.2m0-5.2-5.2 5.2' }));
      if (status === 'skipped') return h('svg', common, ring(false), h('path', { d: 'M8.5 12h7' }));
      return h('svg', common, ring(true));
    };

    /**
     * sidecar 快照 → affectui AgentFindings 的 {agents, findings}。
     * agents 的 done/total 取「当前任务 plan 步数」优先、其次「已分配任务数」；
     * findings 由成员 blockers（sidecar 的策略/租约/依赖阻塞）+ 最近事件汇总，最新在前。
     */
    function buildCardModel(snapshot) {
      const members = snapshot.members || [];
      const tasks = snapshot.tasks || [];
      const events = snapshot.events || [];
      const asOf = snapshot.asOf || Date.now();
      const taskById = new Map();
      for (const task of tasks) {
        if (task && task.id) taskById.set(task.id, task);
      }
      const agents = [];
      const findings = [];
      const planByMember = new Map();
      for (const todo of snapshot.todos || []) {
        if (!todo || !todo.memberId) continue;
        if (!planByMember.has(todo.memberId)) planByMember.set(todo.memberId, []);
        planByMember.get(todo.memberId).push(todo);
      }

      for (const member of members) {
        const assigned = tasks.filter((task) => task && task.assignee === member.id);
        const doneTasks = assigned.filter((task) => task && task.status === 'done').length;
        const current = taskById.get(member.currentTaskId) || null;
        const idx = stepIndex(member.step);
        let total = assigned.length;
        let done = doneTasks;
        let planDriven = false;
        // 成员自己报的步骤清单（team_todo，或内置 todo_write 被镜像成计划）才是真实进度，优先用它。
        const plan = (planByMember.get(member.id) || [])
          .slice()
          .sort((a, b) => (a.orderNo || 0) - (b.orderNo || 0))
          .map((todo) => ({ title: String(todo.title || ''), status: String(todo.status || 'open') }));
        const planDone = plan.filter((step) => step.status === 'done' || step.status === 'skipped').length;
        const activeStep = plan.find((step) => step.status === 'active')
          || plan.find((step) => step.status === 'blocked')
          || plan.find((step) => step.status !== 'done' && step.status !== 'skipped')
          || null;
        if (plan.length > 0) {
          planDriven = true;
          total = plan.length;
          done = planDone;
        } else if (current && Array.isArray(current.plan) && current.plan.length > 0) {
          planDriven = true;
          const planSteps = current.plan.length;
          // sidecar 的 pct = (当前步序 + 1) / plan 步数；没有 pct 时退化为「已完成步数」。
          const planStepDone = member.pct != null
            ? Math.min(planSteps, Math.round(member.pct * planSteps))
            : (idx != null ? Math.min(planSteps, idx) : 0);
          total = Math.max(total, planSteps);
          done = Math.max(doneTasks, planStepDone);
        }
        if (!total) {
          total = 1;
          done = memberStatus(member.status) === 'done' ? 1 : 0;
        }
        agents.push({
          id: member.id,
          name: member.name || member.id,
          model: member.model || '',
          effort: member.reasoningEffort || '',
          step: member.step || '',
          planStep: activeStep ? activeStep.title : '',
          plan,
          done,
          total,
          status: memberDisplayStatus(member, current),
          statusRaw: member.status || '',
          pct: typeof member.pct === 'number' ? member.pct : null,
          planDriven,
          agentSessionId: member.agentSessionId || '',
        });
        for (let i = 0; i < (member.blockers || []).length; i += 1) {
          const blocker = member.blockers[i] || {};
          findings.push({
            id: 'b:' + member.id + ':' + (blocker.id || blocker.kind || i),
            agentId: member.id,
            title: blocker.detail ? clip(blocker.detail, 96) : clip(blocker.kind || 'blocker', 48),
            severity: BLOCKER_SEVERITY[blocker.kind] || 'warning',
            location: member.step || blocker.kind || '',
            at: asOf,
          });
        }
      }

      const recent = events.slice(-48);
      for (let i = 0; i < recent.length; i += 1) {
        const ev = recent[i] || {};
        const title = clip([ev.action || ev.phase || 'event', ev.target || ''].filter(Boolean).join(' '), 96);
        findings.push({
          id: 'e:' + (ev.seq != null ? ev.seq : i),
          agentId: ev.memberId || null,
          title: title || 'event',
          severity: eventSeverity(ev.result),
          location: ev.taskId ? String(ev.taskId) : (ev.phase || ''),
          at: ev.ts ? Date.parse(ev.ts) : asOf,
        });
      }

      return {
        agents,
        findings,
        running: agents.filter((agent) => agent.status === 'running').length,
        memberCount: agents.length,
      };
    }

    /** 读 sidecar：/status 里按子会话 agentSessionId 认出团队，再补任务、事件与成员计划。 */
    async function loadSnapshot(sessionIds) {
      const wanted = new Set(sessionIds);
      const [status, teams] = await Promise.all([fetchJson('/status'), fetchJson('/teams')]);
      const all = (status && status.members) || [];
      const mine = all.filter((member) => member && member.agentSessionId && wanted.has(member.agentSessionId));
      if (!mine.length) return null;
      const teamId = mine[0].teamId;
      const team = ((teams && teams.items) || []).find((item) => item.id === teamId) || { id: teamId, name: teamId };
      const members = all.filter((member) => member && member.teamId === teamId && member.status !== 'retired');
      const encoded = encodeURIComponent(teamId);
      const [tasksRes, eventsRes, todosRes] = await Promise.all([
        fetchJson('/tasks?team=' + encoded).catch(() => null),
        fetchJson('/events/history?team=' + encoded + '&limit=40').catch(() => null),
        fetchJson('/todos?team=' + encoded).catch(() => null),
      ]);
      const tasks = (tasksRes && (tasksRes.items || tasksRes.tasks)) || [];
      const events = (eventsRes && (eventsRes.items || eventsRes.events)) || [];
      const todos = (todosRes && (todosRes.items || todosRes.todos)) || [];
      return { team, members, tasks, events, todos, asOf: Date.now() };
    }

    /**
     * 快照落库。
     * - 卡片**不自动展开**：只有用户点过 pill（pinned）时才沿用其选择；否则一直收起，
     *   团队在跑也不弹计划列表，避免聊天框被自动撑开。
     * - 空快照/请求失败不清屏：团队可能只是这一轮没查到（sidecar 重启、成员列表抖动），
     *   连续 MISS_LIMIT 次为空才真正收起入口，避免卡片闪一下就消失。
     */
    function applySnapshot(sessionId, snapshot) {
      const prev = cardStore.get(sessionId);
      if (!snapshot) {
        const misses = (prev.misses || 0) + 1;
        if (prev.teamId && misses < MISS_LIMIT) {
          cardStore.set(sessionId, { misses });
          return;
        }
        cardStore.set(sessionId, {
          phase: 'ready', teamId: null, teamName: '', agents: [], findings: [],
          running: 0, memberCount: 0, error: null, misses: 0,
          open: false, pinned: false,
        });
        return;
      }
      const model = buildCardModel(snapshot);
      cardStore.set(sessionId, {
        phase: 'ready',
        teamId: snapshot.team.id,
        teamName: snapshot.team.name || snapshot.team.id,
        agents: model.agents,
        findings: model.findings,
        running: model.running,
        memberCount: model.memberCount,
        asOf: snapshot.asOf,
        error: null,
        misses: 0,
        open: prev.pinned ? prev.open : false,
      });
    }

    /** 请求失败：已经拿到过团队就继续展示上一份数据（并标注错误），否则才进入 error 态。 */
    function applyError(sessionId, err) {
      const prev = cardStore.get(sessionId);
      const message = String((err && err.message) || err);
      if (prev.teamId) {
        cardStore.set(sessionId, { error: message });
        return;
      }
      cardStore.set(sessionId, { phase: 'error', error: message });
    }

    /** 订阅某个会话的卡片快照。 */
    function useCard(sessionId) {
      const [snap, setSnap] = React.useState(() => cardStore.get(sessionId));
      React.useEffect(() => {
        setSnap(cardStore.get(sessionId));
        return cardStore.subscribe(() => setSnap(cardStore.get(sessionId)));
      }, [sessionId]);
      return snap;
    }

    /** 浮层卡片没有 sessionId prop，订阅「当前活跃会话」。 */
    function useActiveCard() {
      const read = () => ({ sessionId: cardStore.active, card: cardStore.get(cardStore.active) });
      const [snap, setSnap] = React.useState(read);
      React.useEffect(() => {
        const sync = () => setSnap(read());
        sync();
        return cardStore.subscribe(sync);
      }, []);
      return snap;
    }

    // ---- affectui AgentFindings 原样移植（TSX → createElement） ----
    const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map((word) => (word ? word[0] : '')).join('').toUpperCase();
    /** 模型品牌图标（内嵌 data URI，避免客户端插件额外请求静态资源）。 */
    const MODEL_BRANDS = {
      claude: { label: "Anthropic Claude", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkNsYXVkZTwvdGl0bGU+PHBhdGggZD0iTTQuNzA5IDE1Ljk1NWw0LjcyLTIuNjQ3LjA4LS4yMy0uMDgtLjEyOEg5LjJsLS43OS0uMDQ4LTIuNjk4LS4wNzMtMi4zMzktLjA5Ny0yLjI2Ni0uMTIyLS41NzEtLjEyMUwwIDExLjc4NGwuMDU1LS4zNTIuNDgtLjMyMS42ODYuMDYgMS41Mi4xMDMgMi4yNzguMTU4IDEuNjUyLjA5NyAyLjQ0OS4yNTVoLjM4OWwuMDU1LS4xNTctLjEzNC0uMDk4LS4xMDMtLjA5Ny0yLjM1OC0xLjU5Ni0yLjU1Mi0xLjY4OC0xLjMzNi0uOTcyLS43MjQtLjQ5MS0uMzY0LS40NjItLjE1OC0xLjAwOC42NTYtLjcyMi44ODEuMDYuMjI1LjA2MS44OTMuNjg2IDEuOTA4IDEuNDc2IDIuNDkxIDEuODMzLjM2NS4zMDQuMTQ1LS4xMDMuMDE5LS4wNzMtLjE2NC0uMjc0LTEuMzU1LTIuNDQ2LTEuNDQ2LTIuNDktLjY0NC0xLjAzMi0uMTctLjYxOWEyLjk3IDIuOTcgMCAwMS0uMTA0LS43MjlMNi4yODMuMTM0IDYuNjk2IDBsLjk5Ni4xMzQuNDIuMzY0LjYyIDEuNDE0IDEuMDAyIDIuMjI5IDEuNTU1IDMuMDMuNDU2Ljg5OC4yNDMuODMyLjA5MS4yNTVoLjE1OFY5LjAxbC4xMjgtMS43MDYuMjM3LTIuMDk1LjIzLTIuNjk1LjA4LS43Ni4zNzYtLjkxLjc0Ny0uNDkyLjU4NC4yOC40OC42ODUtLjA2Ny40NDQtLjI4NiAxLjg1MS0uNTU5IDIuOTAzLS4zNjQgMS45NDJoLjIxMmwuMjQzLS4yNDIuOTg1LTEuMzA2IDEuNjUyLTIuMDY0LjczLS44Mi44NS0uOTA0LjU0Ny0uNDMxaDEuMDMzbC43NiAxLjEyOS0uMzQgMS4xNjYtMS4wNjQgMS4zNDctLjg4MSAxLjE0Mi0xLjI2NCAxLjctLjc5IDEuMzYuMDczLjExLjE4OC0uMDIgMi44NTYtLjYwNiAxLjU0My0uMjggMS44NDEtLjMxNS44MzMuMzg4LjA5MS4zOTUtLjMyOC44MDctMS45NjkuNDg2LTIuMzA5LjQ2Mi0zLjQzOS44MTMtLjA0Mi4wMy4wNDkuMDYxIDEuNTQ5LjE0Ni42NjIuMDM2aDEuNjIybDMuMDIuMjI1Ljc5LjUyMi40NzQuNjM4LS4wNzkuNDg1LTEuMjE1LjYyLTEuNjQtLjM4OS0zLjgyOS0uOTEtMS4zMTItLjMyOWgtLjE4MnYuMTFsMS4wOTMgMS4wNjggMi4wMDYgMS44MSAyLjUwOSAyLjMzLjEyNy41NzgtLjMyMi40NTUtLjM0LS4wNDktMi4yMDUtMS42NTctLjg1MS0uNzQ3LTEuOTI2LTEuNjJoLS4xMjh2LjE3bC40NDQuNjQ5IDIuMzQ1IDMuNTIxLjEyMiAxLjA4LS4xNy4zNTMtLjYwOC4yMTMtLjY2OC0uMTIyLTEuMzc0LTEuOTI1LTEuNDE1LTIuMTY3LTEuMTQzLTEuOTQzLS4xNC4wOC0uNjc0IDcuMjU0LS4zMTYuMzctLjcyOS4yOC0uNjA3LS40NjEtLjMyMi0uNzQ3LjMyMi0xLjQ3Ni4zODktMS45MjQuMzE1LTEuNTMuMjg2LTEuOS4xNy0uNjMyLS4wMTItLjA0Mi0uMTQuMDE4LTEuNDM0IDEuOTY3LTIuMTggMi45NDUtMS43MjYgMS44NDUtLjQxNC4xNjQtLjcxNy0uMzcuMDY3LS42NjIuNDAxLS41ODkgMi4zODgtMy4wMzYgMS40NC0xLjg4Mi45My0xLjA4Ni0uMDA2LS4xNThoLS4wNTVMNC4xMzIgMTguNTZsLTEuMTMuMTQ2LS40ODctLjQ1Ni4wNjEtLjc0Ni4yMzEtLjI0MyAxLjkwOC0xLjMxMi0uMDA2LjAwNnoiIGZpbGw9IiNEOTc3NTciIGZpbGwtcnVsZT0ibm9uemVybyI+PC9wYXRoPjwvc3ZnPg==' },
      openai: { label: "OpenAI", uri: 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5PcGVuQUk8L3RpdGxlPjxwYXRoIGQ9Ik05LjIwNSA4LjY1OHYtMi4yNmMwLS4xOS4wNzItLjMzMy4yMzgtLjQyOGw0LjU0My0yLjYxNmMuNjE5LS4zNTcgMS4zNTYtLjUyMyAyLjExNy0uNTIzIDIuODU0IDAgNC42NjIgMi4yMTIgNC42NjIgNC41NjYgMCAuMTY3IDAgLjM1Ny0uMDI0LjU0N2wtNC43MS0yLjc1OWEuNzk3Ljc5NyAwIDAwLS44NTYgMGwtNS45NyAzLjQ3M3ptMTAuNjA5IDguOFYxMi4wNmMwLS4zMzMtLjE0My0uNTctLjQyOS0uNzM3bC01Ljk3LTMuNDczIDEuOTUtMS4xMThhLjQzMy40MzMgMCAwMS40NzYgMGw0LjU0MyAyLjYxN2MxLjMwOS43NiAyLjE4OSAyLjM3OCAyLjE4OSAzLjk0OCAwIDEuODA4LTEuMDcgMy40NzMtMi43NiA0LjE2M3pNNy44MDIgMTIuNzAzbC0xLjk1LTEuMTQyYy0uMTY3LS4wOTUtLjIzOS0uMjM4LS4yMzktLjQyOFY1Ljg5OWMwLTIuNTQ1IDEuOTUtNC40NzIgNC41OTEtNC40NzIgMSAwIDEuOTI3LjMzMyAyLjcxMi45MjhMOC4yMyA1LjA2N2MtLjI4NS4xNjYtLjQyOC40MDQtLjQyOC43Mzd2Ni44OTh6TTEyIDE1LjEyOGwtMi43OTUtMS41N3YtMy4zM0wxMiA4LjY1OGwyLjc5NSAxLjU3djMuMzNMMTIgMTUuMTI4em0xLjc5NiA3LjIzYy0xIDAtMS45MjctLjMzMi0yLjcxMi0uOTI3bDQuNjg2LTIuNzEyYy4yODUtLjE2Ni40MjgtLjQwNC40MjgtLjczN3YtNi44OThsMS45NzQgMS4xNDJjLjE2Ny4wOTUuMjM4LjIzOC4yMzguNDI4djUuMjMzYzAgMi41NDUtMS45NzQgNC40NzItNC42MTQgNC40NzJ6bS01LjYzNy01LjMwM2wtNC41NDQtMi42MTdjLTEuMzA4LS43NjEtMi4xODgtMi4zNzgtMi4xODgtMy45NDhBNC40ODIgNC40ODIgMCAwMTQuMjEgNi4zMjd2NS40MjNjMCAuMzMzLjE0My41NzEuNDI4LjczOGw1Ljk0NyAzLjQ0OS0xLjk1IDEuMTE4YS40MzIuNDMyIDAgMDEtLjQ3NiAwem0tLjI2MiAzLjljLTIuNjg4IDAtNC42NjItMi4wMjEtNC42NjItNC41MTkgMC0uMTkuMDI0LS4zOC4wNDctLjU3bDQuNjg2IDIuNzFjLjI4Ni4xNjcuNTcxLjE2Ny44NTYgMGw1Ljk3LTMuNDQ4djIuMjZjMCAuMTktLjA3LjMzMy0uMjM3LjQyOGwtNC41NDMgMi42MTZjLS42MTkuMzU3LTEuMzU2LjUyMy0yLjExNy41MjN6bTUuODk5IDIuODNhNS45NDcgNS45NDcgMCAwMDUuODI3LTQuNzU2QzIyLjI4NyAxOC4zMzkgMjQgMTUuODQgMjQgMTMuMjk2YzAtMS42NjUtLjcxMy0zLjI4Mi0xLjk5OC00LjQ0OC4xMTktLjUuMTktLjk5OS4xOS0xLjQ5OCAwLTMuNDAxLTIuNzU5LTUuOTQ3LTUuOTQ2LTUuOTQ3LS42NDIgMC0xLjI2LjA5NS0xLjg4LjMxQTUuOTYyIDUuOTYyIDAgMDAxMC4yMDUgMGE1Ljk0NyA1Ljk0NyAwIDAwLTUuODI3IDQuNzU3QzEuNzEzIDUuNDQ3IDAgNy45NDUgMCAxMC40OWMwIDEuNjY2LjcxMyAzLjI4MyAxLjk5OCA0LjQ0OC0uMTE5LjUtLjE5IDEtLjE5IDEuNDk5IDAgMy40MDEgMi43NTkgNS45NDYgNS45NDYgNS45NDYuNjQyIDAgMS4yNi0uMDk1IDEuODgtLjMwOWE1Ljk2IDUuOTYgMCAwMDQuMTYyIDEuNzEzeiI+PC9wYXRoPjwvc3ZnPg==' },
      gemini: { label: "Google Gemini", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkdlbWluaTwvdGl0bGU+PHBhdGggZD0iTTIwLjYxNiAxMC44MzVhMTQuMTQ3IDE0LjE0NyAwIDAxLTQuNDUtMy4wMDEgMTQuMTExIDE0LjExMSAwIDAxLTMuNjc4LTYuNDUyLjUwMy41MDMgMCAwMC0uOTc1IDAgMTQuMTM0IDE0LjEzNCAwIDAxLTMuNjc5IDYuNDUyIDE0LjE1NSAxNC4xNTUgMCAwMS00LjQ1IDMuMDAxYy0uNjUuMjgtMS4zMTguNTA1LTIuMDAyLjY3OGEuNTAyLjUwMiAwIDAwMCAuOTc1Yy42ODQuMTcyIDEuMzUuMzk3IDIuMDAyLjY3N2ExNC4xNDcgMTQuMTQ3IDAgMDE0LjQ1IDMuMDAxIDE0LjExMiAxNC4xMTIgMCAwMTMuNjc5IDYuNDUzLjUwMi41MDIgMCAwMC45NzUgMGMuMTcyLS42ODUuMzk3LTEuMzUxLjY3Ny0yLjAwM2ExNC4xNDUgMTQuMTQ1IDAgMDEzLjAwMS00LjQ1IDE0LjExMyAxNC4xMTMgMCAwMTYuNDUzLTMuNjc4LjUwMy41MDMgMCAwMDAtLjk3NSAxMy4yNDUgMTMuMjQ1IDAgMDEtMi4wMDMtLjY3OHoiIGZpbGw9IiMzMTg2RkYiPjwvcGF0aD48cGF0aCBkPSJNMjAuNjE2IDEwLjgzNWExNC4xNDcgMTQuMTQ3IDAgMDEtNC40NS0zLjAwMSAxNC4xMTEgMTQuMTExIDAgMDEtMy42NzgtNi40NTIuNTAzLjUwMyAwIDAwLS45NzUgMCAxNC4xMzQgMTQuMTM0IDAgMDEtMy42NzkgNi40NTIgMTQuMTU1IDE0LjE1NSAwIDAxLTQuNDUgMy4wMDFjLS42NS4yOC0xLjMxOC41MDUtMi4wMDIuNjc4YS41MDIuNTAyIDAgMDAwIC45NzVjLjY4NC4xNzIgMS4zNS4zOTcgMi4wMDIuNjc3YTE0LjE0NyAxNC4xNDcgMCAwMTQuNDUgMy4wMDEgMTQuMTEyIDE0LjExMiAwIDAxMy42NzkgNi40NTMuNTAyLjUwMiAwIDAwLjk3NSAwYy4xNzItLjY4NS4zOTctMS4zNTEuNjc3LTIuMDAzYTE0LjE0NSAxNC4xNDUgMCAwMTMuMDAxLTQuNDUgMTQuMTEzIDE0LjExMyAwIDAxNi40NTMtMy42NzguNTAzLjUwMyAwIDAwMC0uOTc1IDEzLjI0NSAxMy4yNDUgMCAwMS0yLjAwMy0uNjc4eiIgZmlsbD0idXJsKCNsb2JlLWljb25zLWdlbWluaS0wLV9SXzBfKSI+PC9wYXRoPjxwYXRoIGQ9Ik0yMC42MTYgMTAuODM1YTE0LjE0NyAxNC4xNDcgMCAwMS00LjQ1LTMuMDAxIDE0LjExMSAxNC4xMTEgMCAwMS0zLjY3OC02LjQ1Mi41MDMuNTAzIDAgMDAtLjk3NSAwIDE0LjEzNCAxNC4xMzQgMCAwMS0zLjY3OSA2LjQ1MiAxNC4xNTUgMTQuMTU1IDAgMDEtNC40NSAzLjAwMWMtLjY1LjI4LTEuMzE4LjUwNS0yLjAwMi42NzhhLjUwMi41MDIgMCAwMDAgLjk3NWMuNjg0LjE3MiAxLjM1LjM5NyAyLjAwMi42NzdhMTQuMTQ3IDE0LjE0NyAwIDAxNC40NSAzLjAwMSAxNC4xMTIgMTQuMTEyIDAgMDEzLjY3OSA2LjQ1My41MDIuNTAyIDAgMDAuOTc1IDBjLjE3Mi0uNjg1LjM5Ny0xLjM1MS42NzctMi4wMDNhMTQuMTQ1IDE0LjE0NSAwIDAxMy4wMDEtNC40NSAxNC4xMTMgMTQuMTEzIDAgMDE2LjQ1My0zLjY3OC41MDMuNTAzIDAgMDAwLS45NzUgMTMuMjQ1IDEzLjI0NSAwIDAxLTIuMDAzLS42Nzh6IiBmaWxsPSJ1cmwoI2xvYmUtaWNvbnMtZ2VtaW5pLTEtX1JfMF8pIj48L3BhdGg+PHBhdGggZD0iTTIwLjYxNiAxMC44MzVhMTQuMTQ3IDE0LjE0NyAwIDAxLTQuNDUtMy4wMDEgMTQuMTExIDE0LjExMSAwIDAxLTMuNjc4LTYuNDUyLjUwMy41MDMgMCAwMC0uOTc1IDAgMTQuMTM0IDE0LjEzNCAwIDAxLTMuNjc5IDYuNDUyIDE0LjE1NSAxNC4xNTUgMCAwMS00LjQ1IDMuMDAxYy0uNjUuMjgtMS4zMTguNTA1LTIuMDAyLjY3OGEuNTAyLjUwMiAwIDAwMCAuOTc1Yy42ODQuMTcyIDEuMzUuMzk3IDIuMDAyLjY3N2ExNC4xNDcgMTQuMTQ3IDAgMDE0LjQ1IDMuMDAxIDE0LjExMiAxNC4xMTIgMCAwMTMuNjc5IDYuNDUzLjUwMi41MDIgMCAwMC45NzUgMGMuMTcyLS42ODUuMzk3LTEuMzUxLjY3Ny0yLjAwM2ExNC4xNDUgMTQuMTQ1IDAgMDEzLjAwMS00LjQ1IDE0LjExMyAxNC4xMTMgMCAwMTYuNDUzLTMuNjc4LjUwMy41MDMgMCAwMDAtLjk3NSAxMy4yNDUgMTMuMjQ1IDAgMDEtMi4wMDMtLjY3OHoiIGZpbGw9InVybCgjbG9iZS1pY29ucy1nZW1pbmktMi1fUl8wXykiPjwvcGF0aD48ZGVmcz48bGluZWFyR3JhZGllbnQgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiIGlkPSJsb2JlLWljb25zLWdlbWluaS0wLV9SXzBfIiB4MT0iNyIgeDI9IjExIiB5MT0iMTUuNSIgeTI9IjEyIj48c3RvcCBzdG9wLWNvbG9yPSIjMDhCOTYyIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDhCOTYyIiBzdG9wLW9wYWNpdHk9IjAiPjwvc3RvcD48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgaWQ9ImxvYmUtaWNvbnMtZ2VtaW5pLTEtX1JfMF8iIHgxPSI4IiB4Mj0iMTEuNSIgeTE9IjUuNSIgeTI9IjExIj48c3RvcCBzdG9wLWNvbG9yPSIjRjk0NTQzIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRjk0NTQzIiBzdG9wLW9wYWNpdHk9IjAiPjwvc3RvcD48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgaWQ9ImxvYmUtaWNvbnMtZ2VtaW5pLTItX1JfMF8iIHgxPSIzLjUiIHgyPSIxNy41IiB5MT0iMTMuNSIgeTI9IjEyIj48c3RvcCBzdG9wLWNvbG9yPSIjRkFCQzEyIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIuNDYiIHN0b3AtY29sb3I9IiNGQUJDMTIiIHN0b3Atb3BhY2l0eT0iMCI+PC9zdG9wPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvc3ZnPg==' },
      grok: { label: "xAI Grok", uri: 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5Hcm9rPC90aXRsZT48cGF0aCBkPSJNOS4yNyAxNS4yOWw3Ljk3OC01Ljg5N2MuMzkxLS4yOS45NS0uMTc3IDEuMTM3LjI3Mi45OCAyLjM2OS41NDIgNS4yMTUtMS40MSA3LjE2OS0xLjk1MSAxLjk1NC00LjY2NyAyLjM4Mi03LjE0OSAxLjQwNmwtMi43MTEgMS4yNTdjMy44ODkgMi42NjEgOC42MTEgMi4wMDMgMTEuNTYyLS45NTMgMi4zNDEtMi4zNDQgMy4wNjYtNS41MzkgMi4zODgtOC40MmwuMDA2LjAwN2MtLjk4My00LjIzMi4yNDItNS45MjQgMi43NS05LjM4My4wNi0uMDgyLjEyLS4xNjQuMTc5LS4yNDhsLTMuMzAxIDMuMzA1di0uMDFMOS4yNjcgMTUuMjkyTTcuNjIzIDE2LjcyM2MtMi43OTItMi42Ny0yLjMxLTYuODAxLjA3MS05LjE4NCAxLjc2MS0xLjc2MyA0LjY0Ny0yLjQ4MyA3LjE2Ni0xLjQyNWwyLjcwNS0xLjI1YTcuODA4IDcuODA4IDAgMDAtMS44MjktMUE4Ljk3NSA4Ljk3NSAwIDAwNS45ODQgNS44M2MtMi41MzMgMi41MzYtMy4zMyA2LjQzNi0xLjk2MiA5Ljc2NCAxLjAyMiAyLjQ4Ny0uNjUzIDQuMjQ2LTIuMzQgNi4wMjItLjU5OS42My0xLjE5OSAxLjI1OS0xLjY4MiAxLjkyNWw3LjYyLTYuODE1Ij48L3BhdGg+PC9zdmc+' },
      deepseek: { label: "DeepSeek", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkRlZXBTZWVrPC90aXRsZT48cGF0aCBkPSJNMjMuNzQ4IDQuNDgyYy0uMjU0LS4xMjQtLjM2NC4xMTMtLjUxMi4yMzQtLjA1MS4wMzktLjA5NC4wOS0uMTM3LjEzNi0uMzcyLjM5Ny0uODA2LjY1Ny0xLjM3My42MjYtLjgyOS0uMDQ2LTEuNTM3LjIxNC0yLjE2My44NDgtLjEzMy0uNzgyLS41NzUtMS4yNDgtMS4yNDctMS41NDgtLjM1Mi0uMTU2LS43MDgtLjMxMS0uOTU1LS42NS0uMTcyLS4yNDEtLjIxOS0uNTEtLjMwNS0uNzc0LS4wNTUtLjE2LS4xMS0uMzIzLS4yOTMtLjM1LS4yLS4wMzEtLjI3OC4xMzYtLjM1Ni4yNzYtLjMxMy41NzItLjQzNCAxLjIwMi0uNDIyIDEuODQuMDI3IDEuNDM2LjYzMyAyLjU4IDEuODM4IDMuMzkzLjEzNy4wOTMuMTcyLjE4Ny4xMjkuMzIzLS4wODIuMjgtLjE4LjU1Mi0uMjY2LjgzMy0uMDU1LjE3OS0uMTM3LjIxNy0uMzI5LjE0YTUuNTI2IDUuNTI2IDAgMDEtMS43MzYtMS4xOGMtLjg1Ny0uODI4LTEuNjMxLTEuNzQyLTIuNTk3LTIuNDU4YTExLjM2NSAxMS4zNjUgMCAwMC0uNjg5LS40NzFjLS45ODUtLjk1Ny4xMy0xLjc0My4zODgtMS44MzYuMjctLjA5OC4wOTMtLjQzMi0uNzc5LS40MjgtLjg3Mi4wMDQtMS42Ny4yOTUtMi42ODcuNjg0YTMuMDU1IDMuMDU1IDAgMDEtLjQ2NS4xMzcgOS41OTcgOS41OTcgMCAwMC0yLjg4My0uMTAyYy0xLjg4NS4yMS0zLjM5IDEuMTAyLTQuNDk3IDIuNjIzQy4wODIgOC42MDYtLjIzMSAxMC42ODQuMTUyIDEyLjg1Yy40MDMgMi4yODQgMS41NjkgNC4xNzUgMy4zNiA1LjY1MyAxLjg1OCAxLjUzMyAzLjk5NyAyLjI4NCA2LjQzOCAyLjE0IDEuNDgyLS4wODUgMy4xMzMtLjI4NCA0Ljk5NC0xLjg2LjQ3LjIzNC45NjIuMzI3IDEuNzguMzk3LjYzLjA1OSAxLjIzNi0uMDMgMS43MDUtLjEyOC43MzUtLjE1Ni42ODQtLjgzNy40MTktLjk2MS0yLjE1NS0xLjAwNC0xLjY4Mi0uNTk1LTIuMTEzLS45MjYgMS4wOTYtMS4yOTYgMi43NDYtMi42NDIgMy4zOTItNy4wMDMuMDUtLjM0Ny4wMDctLjU2NSAwLS44NDUtLjAwNC0uMTcuMDM1LS4yMzcuMjMtLjI1NmE0LjE3MyA0LjE3MyAwIDAwMS41NDUtLjQ3NWMxLjM5Ni0uNzYzIDEuOTYtMi4wMTUgMi4wOTMtMy41MTcuMDItLjIzLS4wMDQtLjQ2Ny0uMjQ3LS41ODh6TTExLjU4MSAxOGMtMi4wODktMS42NDItMy4xMDItMi4xODMtMy41Mi0yLjE2LS4zOTIuMDI0LS4zMjEuNDcxLS4yMzUuNzYzLjA5LjI4OC4yMDcuNDg2LjM3MS43MzkuMTE0LjE2Ny4xOTIuNDE2LS4xMTMuNjAzLS42NzMuNDE2LTEuODQyLS4xNC0xLjg5Ny0uMTY3LTEuMzYxLS44MDItMi41LTEuODYtMy4zMDEtMy4zMDctLjc3NC0xLjM5My0xLjIyNC0yLjg4Ny0xLjI5OC00LjQ4Mi0uMDItLjM4Ni4wOTMtLjUyMi40NzctLjU5MmE0LjY5NiA0LjY5NiAwIDAxMS41MjktLjAzOWMyLjEzMi4zMTIgMy45NDYgMS4yNjUgNS40NjggMi43NzQuODY4Ljg2IDEuNTI1IDEuODg3IDIuMjAyIDIuODkxLjcyIDEuMDY2IDEuNDk0IDIuMDgyIDIuNDggMi45MTQuMzQ4LjI5Mi42MjUuNTE0Ljg5MS42NzctLjgwMi4wOS0yLjE0LjExLTMuMDU0LS42MTR6bTEtNi40NGEuMzA2LjMwNiAwIDAxLjQxNS0uMjg3LjMwMi4zMDIgMCAwMS4yLjI4OC4zMDYuMzA2IDAgMDEtLjMxLjMwNy4zMDMuMzAzIDAgMDEtLjMwNC0uMzA4em0zLjExIDEuNTk2Yy0uMi4wODEtLjM5OS4xNTEtLjU5LjE2YTEuMjQ1IDEuMjQ1IDAgMDEtLjc5OC0uMjU0Yy0uMjc0LS4yMy0uNDctLjM1OC0uNTUyLS43NThhMS43MyAxLjczIDAgMDEuMDE2LS41ODhjLjA3LS4zMjctLjAwOC0uNTM3LS4yMzktLjcyNy0uMTg3LS4xNTYtLjQyNi0uMTk5LS42ODgtLjE5OWEuNTU5LjU1OSAwIDAxLS4yNTQtLjA3OGMtLjExLS4wNTQtLjItLjE5LS4xMTQtLjM1OC4wMjgtLjA1NC4xNi0uMTg2LjE5Mi0uMjEuMzU2LS4yMDIuNzY3LS4xMzYgMS4xNDYuMDE2LjM1Mi4xNDQuNjE4LjQwOCAxLjAwMS43ODIuMzkxLjQ1MS40NjIuNTc2LjY4NS45MTQuMTc2LjI2NS4zMzYuNTM3LjQ0NS44NDguMDY3LjE5NS0uMDE5LjM1NC0uMjUuNDUyeiIgZmlsbD0iIzRENkJGRSI+PC9wYXRoPjwvc3ZnPg==' },
      qwen: { label: "Qwen", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPlF3ZW48L3RpdGxlPjxwYXRoIGQ9Ik0xOS43MTMgMi44MjVoLTUuOTA3YzAtLjI1MS0uMDY2LS41MDMtLjE5Ni0uNzI4TDEyLjgxOS43MjhBMS40NiAxLjQ2IDAgMCAwIDExLjU1OSAwaC0xLjU4Yy0uNTIgMC0xIC4yNzUtMS4yNi43MjhsLTIuNDIgNC4xOWExLjQ1IDEuNDUgMCAwIDAgMCAxLjQ1M2wuNzkxIDEuMzdjLjI2LjQ0OC43NC43MjcgMS4yNi43MjdoMTEuMzZjLjUyIDAgMS0uMjc1IDEuMjYtLjcyOGwuNzktMS4zN2ExLjQ1IDEuNDUgMCAwIDAgMC0xLjQ1MWwtLjc5LTEuMzdhMS40NiAxLjQ2IDAgMCAwLTEuMjYtLjcyOHpNLjE5NSA5LjkwNWwyLjk1MSA1LjExNWExLjQ2IDEuNDYgMCAwIDAtLjUzMS41MzFsLS43OTEgMS4zN2ExLjQ1IDEuNDUgMCAwIDAgMCAxLjQ1MmwuNzkgMS4zN2MuMjYuNDQ4Ljc0LjcyNyAxLjI2LjcyN2g0Ljg0Yy41MiAwIDEtLjI3NSAxLjI2LS43MjhsLjc5LTEuMzdhMS40NSAxLjQ1IDAgMCAwIDAtMS40NTFMNS4wODYgNy4wODNhMS40NiAxLjQ2IDAgMCAwLTEuMjYtLjcyOGgtMS41OGMtLjUyIDAtMSAuMjc2LTEuMjYuNzI4bC0uNzkgMS4zN2ExLjQ1IDEuNDUgMCAwIDAgMCAxLjQ1Mm0xNS44ODggMTMuMzY3IDIuOTUxLTUuMTE1Yy4yMTcuMTI1LjQ2OS4xOTYuNzI4LjE5NmgxLjU4MmMuNTIgMCAxLS4yNzUgMS4yNi0uNzI4bC43OS0xLjM3YTEuNDUgMS40NSAwIDAgMCAwLTEuNDUxbC0yLjQyLTQuMTkxYTEuNDYgMS40NiAwIDAgMC0xLjI1OS0uNzI4aC0xLjU4MmMtLjUyIDAtMSAuMjc2LTEuMjU5LjcyOGwtNS42NzggOS44MzhhMS40NSAxLjQ1IDAgMCAwIDAgMS40NTJsLjc5IDEuMzdjLjI2LjQ0OC43NC43MjcgMS4yNi43MjdoMS41ODJjLjUyIDAgMS0uMjc1IDEuMjYtLjcyOHoiIGZpbGw9IiMwODJkZmYiPjwvcGF0aD48L3N2Zz4=' },
      kimi: { label: "Kimi", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPktpbWk8L3RpdGxlPjxwYXRoIGQ9Ik0yMS44NDYgMGExLjkyMyAxLjkyMyAwIDExMCAzLjg0NkgyMC4xNWEuMjI2LjIyNiAwIDAxLS4yMjctLjIyNlYxLjkyM0MxOS45MjMuODYxIDIwLjc4NCAwIDIxLjg0NiAweiIgZmlsbD0iIzE3ODNGRiI+PC9wYXRoPjxwYXRoIGQ9Ik0xMS4wNjUgMTEuMTk5bDcuMjU3LTcuMmMuMTM3LS4xMzYuMDYtLjQxLS4xMTYtLjQxSDE0LjNhLjE2NC4xNjQgMCAwMC0uMTE3LjA1MWwtNy44MiA3Ljc1NmMtLjEyMi4xMi0uMzAyLjAxMy0uMzAyLS4xNzlWMy44MmMwLS4xMjctLjA4My0uMjMtLjE4NS0uMjNIMy4xODZjLS4xMDMgMC0uMTg2LjEwMy0uMTg2LjIzVjE5Ljc3YzAgLjEyOC4wODMuMjMuMTg2LjIzaDIuNjljLjEwMyAwIC4xODYtLjEwMi4xODYtLjIzdi0zLjI1YzAtLjA2OS4wMjUtLjEzNS4wNjktLjE3OGwyLjQyNC0yLjQwNmEuMTU4LjE1OCAwIDAxLjIwNS0uMDIzbDYuNDg0IDQuNzcyYTcuNjc3IDcuNjc3IDAgMDAzLjQ1MyAxLjI4M2MuMTA4LjAxMi4yLS4wOTUuMi0uMjN2LTMuMDZjMC0uMTE3LS4wNy0uMjEyLS4xNjQtLjIyN2E1LjAyOCA1LjAyOCAwIDAxLTIuMDI3LS44MDdsLTUuNjEzLTQuMDY0Yy0uMTE3LS4wNzgtLjEzMi0uMjc5LS4wMjgtLjM4MXoiIGZpbGw9ImN1cnJlbnRDb2xvciI+PC9wYXRoPjwvc3ZnPg==' },
      zai: { label: "智谱 GLM", uri: 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5aLmFpPC90aXRsZT48cGF0aCBkPSJNMTIuMTA1IDJMOS45MjcgNC45NTNILjY1M0wyLjgzIDJoOS4yNzZ6TTIzLjI1NCAxOS4wNDhMMjEuMDc4IDIyaC05LjI0MmwyLjE3NC0yLjk1Mmg5LjI0NHpNMjQgMkw5LjI2NCAyMkgwTDE0LjczNiAySDI0eiI+PC9wYXRoPjwvc3ZnPg==' },
      doubao: { label: "Doubao", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkRvdWJhbzwvdGl0bGU+PHBhdGggZD0iTTUuMzEgMTUuNzU2Yy4xNzItMy43NSAxLjg4My01Ljk5OSAyLjU0OS02LjczOS0zLjI2IDIuMDU4LTUuNDI1IDUuNjU4LTYuMzU4IDguMzA4djEuMTJDMS41MDEgMjEuNTEzIDQuMjI2IDI0IDcuNTkgMjRhNi41OSA2LjU5IDAgMDAyLjItLjM3NWMuMzUzLS4xMi43LS4yNDggMS4wMzktLjM3OC45MTMtLjg5OSAxLjY1LTEuOTEgMi4yNDMtMi45OTItNC44NzcgMi40MzEtNy45NzQuMDcyLTcuNzYzLTQuNWwuMDAyLjAwMXoiIGZpbGw9IiMxRTM3RkMiPjwvcGF0aD48cGF0aCBkPSJNMjIuNTcgMTAuMjgzYy0xLjIxMi0uOTAxLTQuMTA5LTIuNDA0LTcuMzk3LTIuOC4yOTUgMy43OTIuMDkzIDguNzY2LTIuMSAxMi43NzNhMTIuNzgyIDEyLjc4MiAwIDAxLTIuMjQ0IDIuOTkyYzMuNzY0LTEuNDQ4IDYuNzQ2LTMuNDU3IDguNTk2LTUuMjE5IDIuODItMi42ODMgMy4zNTMtNS4xNzggMy4zNjEtNi42NmEyLjczNyAyLjczNyAwIDAwLS4yMTYtMS4wODR2LS4wMDJ6IiBmaWxsPSIjMzdFMUJFIj48L3BhdGg+PHBhdGggZD0iTTE0LjMwMyAxLjg2N0MxMi45NTUuNyAxMS4yNDggMCA5LjM5IDAgNy41MzIgMCA1Ljg4My42NzcgNC41NDUgMS44MDcgMi43OTEgMy4yOSAxLjYyNyA1LjU1NyAxLjUgOC4xMjV2OS4yMDFjLjkzMi0yLjY1IDMuMDk3LTYuMjUgNi4zNTctOC4zMDcuNS0uMzE4IDEuMDI1LS41OTUgMS41NjktLjgyOSAxLjg4My0uODAxIDMuODc4LS45MzIgNS43NDYtLjcwNi0uMjIyLTIuODMtLjcxOC01LjAwMi0uODctNS42MTdoLjAwMXoiIGZpbGw9IiNBNTY5RkYiPjwvcGF0aD48cGF0aCBkPSJNMTcuMzA1IDQuOTYxYTE5OS40NyAxOTkuNDcgMCAwMS0xLjA4LTEuMDk0Yy0uMjAyLS4yMTMtLjM5OC0uNDE5LS41ODYtLjYyMmwtMS4zMzMtMS4zNzhjLjE1MS42MTUuNjQ4IDIuNzg2Ljg2OSA1LjYxNyAzLjI4OC4zOTUgNi4xODUgMS44OTggNy4zOTYgMi44LTEuMzA2LTEuMjc1LTMuNDc1LTMuNDg3LTUuMjY2LTUuMzIzeiIgZmlsbD0iIzFFMzdGQyI+PC9wYXRoPjwvc3ZnPg==' },
      hunyuan: { label: "Hunyuan", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkh1bnl1YW48L3RpdGxlPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIGZpbGw9IiMwMDU1RTkiIHI9IjEyIj48L2NpcmNsZT48cGF0aCBkPSJNMTIgMGMuNTE4IDAgMS4wMjguMDMzIDEuNTI4LjA5NkE2LjE4OCA2LjE4OCAwIDAxMTIuMTIgMTIuMjhsLS4xMi4wMDFjLTIuOTkgMC01LjI0MiAyLjE3OS01LjU1NCA1LjExLS4yMjMgMi4wODYuMzUzIDQuNDEyIDIuMjQyIDYuMTQ2QzMuNjcyIDIyLjEgMCAxNy40NzkgMCAxMiAwIDUuMzczIDUuMzczIDAgMTIgMHoiIGZpbGw9IiNBOERGRjUiPjwvcGF0aD48cGF0aCBkPSJNNS4yODYgNWEyLjQzOCAyLjQzOCAwIDAxLjY4MiAzLjM4Yy0zLjk2MiA1Ljk2Ni0zLjIxNSAxMC43NDMgMi42NDggMTUuMTM2QzMuNjM2IDIyLjA1NiAwIDE3LjQ1MiAwIDEyYzAtMS43ODcuMzktMy40ODIgMS4wOS01LjAwNi4yNTMtLjQzNS41MjUtLjg3Mi44MTctMS4zMTFBMi40MzggMi40MzggMCAwMTUuMjg2IDV6IiBmaWxsPSIjMDA1NUU5Ij48L3BhdGg+PHBhdGggZD0iTTEyLjk4LjA0Yy4yNzIuMDIxLjU0My4wNTMuODEuMDkzLjU4My4xMDYgMS4xMTcuMjU0IDEuNTM4LjQ0IDYuNjM4IDIuOTI3IDguMDcgMTAuMDUyIDEuNzQ4IDE1LjY0MmE0LjEyNSA0LjEyNSAwIDAxLTUuODIyLS4zNThjLTEuNTEtMS43MDYtMS4zLTQuMTg0LjM1Ny01LjgyMi44NTgtLjg0OCAzLjEwOC0xLjIyMyA0LjA0NS0yLjQ0MSAxLjI1Ny0xLjYzNCAyLjEyMi02LjAwOS0yLjUyMy03LjUwNkwxMi45OC4wMzl6IiBmaWxsPSIjMDBCQ0ZGIj48L3BhdGg+PHBhdGggZD0iTTEzLjUyOC4wOTZBNi4xODcgNi4xODcgMCAwMTEyIDEyLjI4MWE1Ljc1IDUuNzUgMCAwMC0xLjcxLjI1NWMuMTQ3LS45MDUuNTk1LTEuNzg0IDEuMzIxLTIuNTAxLjg1OC0uODQ4IDMuMTA4LTEuMjIzIDQuMDQ1LTIuNDQxIDEuMjctMS42NTEgMi4xNC02LjEwNC0yLjY3Ni03LjU1NC4xODQuMDE0LjM2Ny4wMzMuNTQ4LjA1NnoiIGZpbGw9IiNFQ0VDRUUiPjwvcGF0aD48L3N2Zz4=' },
      minimax: { label: "MiniMax", uri: 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk1pbmltYXg8L3RpdGxlPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0ibG9iZS1pY29ucy1taW5pbWF4LV9SXzBfIiB4MT0iMCUiIHgyPSIxMDAuMTgyJSIgeTE9IjUwLjA1NyUiIHkyPSI1MC4wNTclIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjRTIxNjdFIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjRkU2MDNDIj48L3N0b3A+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggZD0iTTE2LjI3OCAyYzEuMTU2IDAgMi4wOTMuOTI3IDIuMDkzIDIuMDd2MTIuNTAxYS43NC43NCAwIDAwLjc0NC43MDkuNzQuNzQgMCAwMC43NDMtLjcwOVY5LjA5OWEyLjA2IDIuMDYgMCAwMTIuMDcxLTIuMDQ5QTIuMDYgMi4wNiAwIDAxMjQgOS4xdjYuNTYxYS42NDkuNjQ5IDAgMDEtLjY1Mi42NDUuNjQ5LjY0OSAwIDAxLS42NTMtLjY0NVY5LjFhLjc2Mi43NjIgMCAwMC0uNzY2LS43NTguNzYyLjc2MiAwIDAwLS43NjYuNzU4djcuNDcyYTIuMDM3IDIuMDM3IDAgMDEtMi4wNDggMi4wMjYgMi4wMzcgMi4wMzcgMCAwMS0yLjA0OC0yLjAyNnYtMTIuNWEuNzg1Ljc4NSAwIDAwLS43ODgtLjc1My43ODUuNzg1IDAgMDAtLjc4OS43NTJsLS4wMDEgMTUuOTA0QTIuMDM3IDIuMDM3IDAgMDExMy40NDEgMjJhMi4wMzcgMi4wMzcgMCAwMS0yLjA0OC0yLjAyNlYxOC4wNGMwLS4zNTYuMjkyLS42NDUuNjUyLS42NDUuMzYgMCAuNjUyLjI4OS42NTIuNjQ1djEuOTM0YzAgLjI2My4xNDIuNTA2LjM3Mi42MzguMjMuMTMxLjUxNC4xMzEuNzQ0IDBhLjczNC43MzQgMCAwMC4zNzItLjYzOFY0LjA3YzAtMS4xNDMuOTM3LTIuMDcgMi4wOTMtMi4wN3ptLTUuNjc0IDBjMS4xNTYgMCAyLjA5My45MjcgMi4wOTMgMi4wN3YxMS41MjNhLjY0OC42NDggMCAwMS0uNjUyLjY0NS42NDguNjQ4IDAgMDEtLjY1Mi0uNjQ1VjQuMDdhLjc4NS43ODUgMCAwMC0uNzg5LS43OC43ODUuNzg1IDAgMDAtLjc4OS43OHYxNC4wMTNhMi4wNiAyLjA2IDAgMDEtMi4wNyAyLjA0OCAyLjA2IDIuMDYgMCAwMS0yLjA3MS0yLjA0OFY5LjFhLjc2Mi43NjIgMCAwMC0uNzY2LS43NTguNzYyLjc2MiAwIDAwLS43NjYuNzU4djMuOGEyLjA2IDIuMDYgMCAwMS0yLjA3MSAyLjA0OUEyLjA2IDIuMDYgMCAwMTAgMTIuOXYtMS4zNzhjMC0uMzU3LjI5Mi0uNjQ2LjY1Mi0uNjQ2LjM2IDAgLjY1My4yOS42NTMuNjQ2VjEyLjljMCAuNDE4LjM0My43NTcuNzY2Ljc1N3MuNzY2LS4zMzkuNzY2LS43NTdWOS4wOTlhMi4wNiAyLjA2IDAgMDEyLjA3LTIuMDQ4IDIuMDYgMi4wNiAwIDAxMi4wNzEgMi4wNDh2OC45ODRjMCAuNDE5LjM0My43NTguNzY3Ljc1OC40MjMgMCAuNzY2LS4zMzkuNzY2LS43NThWNC4wN2MwLTEuMTQzLjkzNy0yLjA3IDIuMDkzLTIuMDd6IiBmaWxsPSJ1cmwoI2xvYmUtaWNvbnMtbWluaW1heC1fUl8wXykiIGZpbGwtcnVsZT0ibm9uemVybyI+PC9wYXRoPjwvc3ZnPg==' },
      xiaomimimo: { label: "MiMo", uri: 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSIxZW0iIHN0eWxlPSJmbGV4Om5vbmU7bGluZS1oZWlnaHQ6MSIgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMWVtIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0aXRsZT5YaWFvbWlNaU1vPC90aXRsZT48cGF0aCBkPSJNLjk1OCAxNS45MzZhLjQ1OS40NTkgMCAwMS40NTkuNDR2Mi43MjlhLjQ2LjQ2IDAgMDEtLjkxOCAwdi0yLjcyOWEuNDU5LjQ1OSAwIDAxLjQ1OS0uNDR6bTQuODE0LTIuMDM1YS40Ni40NiAwIDAxLjU1My40NXY0Ljc1NGEuNDU4LjQ1OCAwIDExLS45MTggMFYxNS40OEwzLjc0IDE3LjIwMmEuNDYyLjQ2MiAwIDAxLS42NTUuMDE2LjQ2Mi40NjIgMCAwMS0uMDY1LS4wODJMLjYyOCAxNC42N2EuNDU5LjQ1OSAwIDAxLjY1OC0uNjM3bDIuMTI0IDIuMTg3IDIuMTI3LTIuMTg4YS40Ni40NiAwIDAxLjIzNS0uMTN6bTIuMDY4LjAwNGEuNDYuNDYgMCAwMS40NTguNDQ1djQuNzU1YS40Ni40NiAwIDAxLS40NTguNDU4LjQ1OS40NTkgMCAwMS0uNDU4LS40NThWMTQuMzVhLjQ1OS40NTkgMCAwMS40NTgtLjQ0NXptMS45NzMgMi4wMTRhLjQ2LjQ2IDAgMDEuNDYuNDU3djIuNzI5YS40Ni40NiAwIDAxLS43ODQuMzI0LjQ2LjQ2IDAgMDEtLjEzNC0uMzI0di0yLjcyOWEuNDYuNDYgMCAwMS40NTgtLjQ1OHptLjAwMi0yLjA0NWEuNDU4LjQ1OCAwIDAxLjMyOC4xNTdsMi4xMjcgMi4xOSAyLjEyNS0yLjE5YS40NTkuNDU5IDAgMDEuNzg0LjMxOHY0Ljc1NmEuNDYuNDYgMCAwMS0uNDU1LjQ1OC40Ni40NiAwIDAxLS40NTgtLjQ1OFYxNS40OGwtMS42NjcgMS43MjNhLjQ2LjQ2IDAgMDEtLjY1LjAwOGwtLjAwNS0uMDA1YzAtLjAwMi0uMDAyLS4wMDItLjAwNC0uMDAzbC0yLjQ1NS0yLjUzNGEuNDYuNDYgMCAwMS0uMDA4LS42NjcuNDYxLjQ2MSAwIDAxLjMzOC0uMTI4em02Ljc5NyAxLjIwNmEuNDYuNDYgMCAwMS41My42NTFBMS45NjYgMS45NjYgMCAwMDE5LjgxIDE4LjRhLjQ2Mi40NjIgMCAwMS42MjMuMTguNDYuNDYgMCAwMS0uMTgxLjYyNCAyLjg2MyAyLjg2MyAwIDAxLTEuMzguMzUzbC0uMTQyLS4wMDRhMi44OCAyLjg4IDAgMDEtMi4zOTMtNC4yNjMuNDYxLjQ2MSAwIDAxLjI3NC0uMjF6bS44NjQtLjkzMWEyLjg4NCAyLjg4NCAwIDAxMy45MTUgMy45MTQuNDYuNDYgMCAwMS0uNDAyLjI0bC0uMDU3LS4wMDRhLjQ1OC40NTggMCAwMS0uMTY0LS4wNTUuNDYuNDYgMCAwMS0uMTgyLS42MjIgMS45NjcgMS45NjcgMCAwMC0yLjY2OS0yLjY3LjQ1OS40NTkgMCAxMS0uNDQxLS44MDN6TTkuNTkgNi4zNjhjMS40ODEgMCAxLjY5NiAxLjIwMiAxLjY5NiAxLjY1NHYyLjY0OGgtLjkxN3YtLjQzMmMtLjI2LjM0Ni0uNzkyLjUzNS0xLjM2LjUzNS0uMTMzIDAtMS4yODktLjAzLTEuMzg0LTEuMTM2LS4wODItLjkzMi42NzUtMS42MSAyLjA1My0xLjYxaC42OTFjMC0uNTYzLS4zNjctLjg4Ni0uOTgzLS44ODYtLjQ0LjAxMy0uODY0LjE3NC0xLjIuNDU4bC0uMzYtLjY2NGMuNDg0LS4zNzkgMS4wMTItLjU2NyAxLjc2NC0uNTY3em00LjQyNy4xYzEuMjYzIDAgMi4wODIuOTcgMi4wODMgMi4xNSAwIDEuMTgxLS44MjQgMi4xNTQtMi4wODMgMi4xNTQtMS4yNiAwLTIuMDg0LS45NzItMi4wODQtMi4xNTIgMC0xLjE4LjgyLTIuMTUzIDIuMDg0LTIuMTUzem02LjgwMS4wMTVjLjY4IDAgMS4yMDIuNDY1IDEuMTk3IDEuNTQ4djIuNjQySDIxLjFWOC4yOWMwLS4zMTItLjAwMi0uOTgtLjYzLS45OHMtLjYyOC42NjctLjYyOC44Mzh2Mi41MjRoLS44OVY4LjE0OGMwLS4xNy0uMDAxLS44MzgtLjYzLS44MzgtLjYyOCAwLS42MjguNjY4LS42MjguOTh2Mi4zODNoLS45MTd2LTQuMDNoLjkxN1Y3YTEuMjIgMS4yMiAwIDAxLjk0Ny0uNTE2Yy4zOTggMCAuNzYuMTkzLjk4Mi42ODZhMS4zMjEgMS4zMjEgMCAwMTEuMTk1LS42ODZ6bS0xOC4wOTMuODcybDEuNDU3LTEuNzcySDUuMzJMMy4zMTEgOC4wN2wyLjE0IDIuNjAySDQuMjRMMi43MjUgOC43OTYgMS4yMSAxMC42NzJIMEwyLjEzOCA4LjA3LjEzIDUuNTgzaDEuMTM4bDEuNDU4IDEuNzcyem00LjE0OSAzLjMxN2gtLjkxNlY2LjY0NGguOTE2djQuMDI4em0xNi45OSAwaC0uOTE2VjYuNjQ0aC45MTZ2NC4wMjh6TTkuOTI1IDguNzFjLTEuMDU1IDAtMS4zNTkuNDEyLTEuMzI2Ljc0Mi4wMzIuMzI5LjMyNC41MzcuNzU3LjUzN2ExLjAxMyAxLjAxMyAwIDAwMS4wMTQtLjk2OGwuMDAyLS4zMWgtLjQ0N3pNMTQuMDE4IDcuM2MtLjY2MyAwLTEuMTg0LjQ4Ny0xLjE4NCAxLjMyIDAgLjgzMi41MiAxLjMyIDEuMTg0IDEuMzIuNjYyIDAgMS4xODItLjQ5IDEuMTgyLTEuMzIgMC0uODMyLS41Mi0xLjMyLTEuMTgyLTEuMzJ6TTYuNDE3IDUuMDAxYS41NjguNTY4IDAgMDEuNTg3LjU4Mi41ODguNTg4IDAgMDEtMS4xNzUgMEEuNTcuNTcgMCAwMTYuNDE3IDV6bTE2Ljk5MSAwYS41Ny41NyAwIDAxLjU5Mi41ODIuNTg4LjU4OCAwIDAxLTEuMTc0IDAgLjU3LjU3IDAgMDEuMzU3LS41NDIuNTcyLjU3MiAwIDAxLjIyNS0uMDR6Ij48L3BhdGg+PC9zdmc+' },
      muse: { label: "Muse", uri: 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJub25lIiBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPk11c2U8L3RpdGxlPjxwYXRoIGQ9Ik01LjkxIDMuODY5QzYuNzc3IDMuODY5IDcuMzk2IDQuNTQ2IDcuMzk2IDUuNjA3IDcuMzk2IDYuNjY5IDcuMjI1IDcuNjI2IDYuOTQxIDkuNjU5IDYuNzM4IDExLjA4NCA2LjM4OSAxMy4yNTggNi4yNDMgMTQuMTYyIDYuNTIzIDEzLjYyOCA3LjE3OCAxMi4zNzggNy4yOTQgMTIuMTQ0IDguNjY2IDkuMzc1IDEwLjA5NiA2LjkwMSAxMC41MDggNi4yNDYgMTEuMDU0IDUuMzcyIDExLjUzNSA1LjAyMSAxMi4yNzggNS4wMjEgMTIuNjY0IDUuMDIyIDEzLjEyNCA1LjIxNyAxMy4zNTIgNS40NzcgMTMuNjYgNS44MjkgMTMuNzI1IDYuMzk4IDEzLjcxNCA3LjAxOSAxMy42OTggNy45NyAxMy41NzQgOS40ODYgMTMuNDA1IDExLjE3NyAxMy4zMyAxMS45MjkgMTMuMTg1IDEzLjQ2NiAxMy4wODcgMTQuNDk2IDEzLjk2NSAxMi45MjUgMTUuNTkxIDEwLjAzNSAxNi4yNDYgOS4wMjUgMTYuODE3IDguMTQ2IDE3LjM5MiA3LjU3OSAxOC4xNjQgNy41NzkgMTguODMgNy41NzkgMTkuNjUxIDguMDUgMTkuNjAzIDkuMzAyIDE5LjUzMSAxMS4xNDkgMTkuMjY0IDE1LjE3NCAxOS4xNDMgMTYuOTc5IDE5Ljk2IDE1Ljc5IDIxLjAzMyAxNC4wMjkgMjEuNDM2IDEzLjM2NyAyMS44NDIgMTIuNjk4IDIyLjI2IDEyLjE1NyAyMi44OTQgMTIuMTM5IDIzLjU0NCAxMi4xMiAyMy45NzkgMTIuNTYyIDIzLjk5OSAxMy4yNDQgMjQuMDE5IDEzLjkyNyAyMy42MTIgMTQuNjk0IDIzLjA3MiAxNS41NjUgMjIuNDg2IDE2LjUxMSAyMS44MzEgMTcuNTIzIDIxLjAzMyAxOC40NjggMjAuMjM2IDE5LjQxMyAxOS41MDIgMjAuMTMxIDE4LjM4NCAyMC4xMzEgMTcuMzgyIDIwLjEzMSAxNi42NzcgMTkuNDY1IDE2LjYyOCAxOC4yNDYgMTYuNjAyIDE3LjYwNyAxNi43MjMgMTYuMjM0IDE2LjgxNCAxNS4xNiAxNi45MiAxMy45MTcgMTcuMDQ4IDEyLjcxNyAxNy4xMzcgMTEuOTIzIDE2LjI1NiAxMy41MzUgMTQuNDAyIDE2LjkxMiAxMy41NjggMTguMjMgMTIuNzUyIDE5LjUyIDEyLjM1NSAxOS45NzQgMTEuNDkzIDE5Ljk3NSAxMC42MzEgMTkuOTc1IDEwLjI1MyAxOS4zNTQgMTAuMjQxIDE4LjQyIDEwLjIyNyAxNy40MDcgMTAuOTg4IDExLjMyNCAxMS4yNDYgOS4yOTcgMTAuODI4IDEwLjE5MSA5LjgwMSAxMi4zODUgOS4xNTcgMTMuNjkgOC41MzQgMTQuOTUzIDcuNDg5IDE3LjEzNSA2LjczIDE4LjM5MyA2LjE4NCAxOS4yOTggNS41NyAxOS45NzUgNC42NiAxOS45NzUgMy43NSAxOS45NzUgMy4yMzYgMTkuMzYzIDMuMjM2IDE4LjM3OSAzLjIzNiAxNy4zOTUgMy41MjEgMTUuNzU2IDMuODI3IDEzLjcyMyAzLjk4IDEyLjczOSA0LjE1NSAxMS42NjcgNC4zNTIgMTAuNTMgNC40OTYgOS43MDggNC43NDYgOC4yNiA0LjkgNy4zNzEgNC4yIDguNDYxIDIuOTQxIDEwLjQyMyAyLjU1OCAxMS4wMTQgMi4xMzEgMTEuNjcxIDEuNzQ5IDEyLjE1IDEuMTE1IDEyLjE1IDAuNDE2IDEyLjE1IDAgMTEuNjA1IDAgMTAuOTcxIDAgMTAuMzM3IDAuMzIyIDkuODQ4IDAuODQ2IDguOTg4IDEuNTE4IDcuODgzIDIuNzI2IDYuMzc3IDMuMzg4IDUuNTg2IDQuMTY4IDQuNjU0IDQuOTQ3IDMuODY5IDUuOTEgMy44NjlaIiBmaWxsPSJ1cmwoI2xvYmUtaWNvbnMtbXVzZS1fUl8wXykiPjwvcGF0aD48ZGVmcz48bGluZWFyR3JhZGllbnQgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiIGlkPSJsb2JlLWljb25zLW11c2UtX1JfMF8iIHgxPSIzMS45NzkiIHgyPSI1Ljk4MSIgeTE9IjI2LjE3MSIgeTI9Ii0zLjAxNCI+PHN0b3Agb2Zmc2V0PSIuMjU1IiBzdG9wLWNvbG9yPSIjMDA4MkZCIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIuNjk3IiBzdG9wLWNvbG9yPSIjMDA2NEUwIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDA0MERDIj48L3N0b3A+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PC9zdmc+' },
    };

    /** 模型 → 品牌：与 web-ui/src/lib/model-brand.ts 同一套词元规则（精简版）。 */
    const MODEL_BRAND_RULES = [
      ['claude', ['claude', 'anthropic']],
      ['openai', ['openai', 'gpt', 'chatgpt', 'davinci', 'codex']],
      ['gemini', ['gemini', 'gemma', 'palm', 'google', 'vertex']],
      ['grok', ['grok', 'xai']],
      ['deepseek', ['deepseek']],
      ['qwen', ['qwen', 'qwq', 'tongyi', 'alibaba']],
      ['kimi', ['kimi', 'moonshot']],
      ['zai', ['glm', 'chatglm', 'zhipu', 'zai']],
      ['doubao', ['doubao', 'volcengine', 'bytedance', 'seed']],
      ['hunyuan', ['hunyuan', 'tencent']],
      ['minimax', ['minimax', 'abab']],
      ['xiaomimimo', ['mimo', 'xiaomi']],
      ['muse', ['muse']],
    ];
    const PROVIDER_ALIASES = [[/z[-_]ai/g, 'zai'], [/x[-_]ai/g, 'xai'], [/zhipu[-_]?ai/g, 'zhipu'], [/moonshot[-_]?ai/g, 'moonshot']];
    const brandTokens = (value) => {
      let normalized = String(value || '').toLowerCase();
      for (const [pattern, replacement] of PROVIDER_ALIASES) normalized = normalized.replace(pattern, replacement);
      return normalized.split(/[^a-z0-9]+/).filter(Boolean);
    };
    function brandOfModel(model, name) {
      for (const value of [model, name]) {
        const tokens = brandTokens(value);
        if (!tokens.length) continue;
        for (const [brand, needles] of MODEL_BRAND_RULES) {
          if (needles.some((needle) => tokens.some((token) => token === needle || token.startsWith(needle)))) return brand;
        }
      }
      return null;
    }
    /** 品牌图标元素；识别不出品牌时返回 null（调用方回退到首字母）。 */
    function modelLogo(model, name) {
      const meta = MODEL_BRANDS[brandOfModel(model, name) || ''];
      if (!meta) return null;
      return h('img', { src: meta.uri, alt: meta.label, title: meta.label, width: 14, height: 14, decoding: 'async' });
    }
    /** 卡片头部的 spark 图标（affectui Spark）。 */
    function Spark(props) {
      const size = props.size || 14;
      return h('svg', { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': 'true', fill: 'none' },
        h('path', {
          d: 'M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z',
          fill: 'currentColor',
        }),
        h('circle', { cx: 11.6, cy: 11.4, r: 1.1, fill: 'currentColor', opacity: 0.55 }));
    }

    /** 团队校验卡片：成员进度 + 计划（计划全部展开，不再折叠；「最新发现」已移除）。 */
    function AgentFindings(props) {
      const t = props.t || ((key) => key);
      const agents = props.agents || [];

      const statusText = (agent) => {
        if (agent.status === 'done') return t('card_all_done');
        if (agent.status === 'failed') return t('card_stopped');
        // 有计划时优先显示「当前在做的步骤」，比 sidecar 的步序（S3）更好懂。
        if (agent.planStep) return clip(agent.planStep, 96);
        if (agent.step) return agent.step;
        const raw = agent.statusRaw || 'running';
        return t('status_' + (KNOWN_STATUS.includes(raw) ? raw : 'unknown'));
      };
      return h('div', {
        className: 'ui-afc',
        'data-dsh-team-findings': agents.length,
      },
      h('div', { className: 'ui-afc__card' },
        h('ul', { className: 'ui-afc__agents' }, agents.map((agent) => {
          // 计划驱动的成员按「已完成步数 / 计划步数」画，和右侧数字保持一致；
          // 没有计划时退回 sidecar 上报的 pct（当前步序进度）。
          const percent = agent.planDriven && agent.total
            ? Math.min(100, Math.max(0, ((agent.done || 0) / agent.total) * 100))
            : agent.pct != null
              ? Math.min(100, Math.max(0, agent.pct * 100))
              : (agent.total ? Math.min(100, ((agent.done || 0) / agent.total) * 100) : 0);
          const progressLabel = !agent.planDriven && agent.pct != null
            ? Math.round(percent) + '%'
            : (agent.done || 0) + '/' + (agent.total || 0);
          const logo = modelLogo(agent.model, agent.name);
          const taskText = statusText(agent);
          const planTotal = agent.plan.length;
          const planDone = agent.plan.filter((step) => step.status === 'done').length;
          const planPercent = planTotal ? Math.round((planDone / planTotal) * 100) : 0;
          return h('li', { key: agent.id, className: 'ui-afc__row' },
            h('div', {
              className: 'ui-afc__agent',
              'data-status': agent.status || 'running',
            },
            // 第一行：状态圆点 + 图标 + 名称，右侧「查看对话」
            h('span', { className: 'ui-afc__dot', 'aria-hidden': 'true' }),
            h('span', { className: 'ui-afc__avatar', 'data-logo': logo ? '' : undefined }, logo || initials(agent.name)),
            h('span', { className: 'ui-afc__who' },
              h('span', { className: 'ui-afc__name', title: agent.name }, agent.name)),
            typeof props.onOpenMember === 'function' && agent.agentSessionId
              ? h('button', {
                type: 'button',
                className: 'ui-afc__chat',
                title: t('members_open'),
                'aria-label': t('members_open'),
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                  props.onOpenMember(agent);
                },
              }, h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', fill: 'none' },
                h('path', {
                  d: 'M2.4 3.2h9.2v5.9H7.3L4.6 11.2V9.1H2.4z',
                  stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
                })))
              : null,
            // 第二行：当前正在做的事（单行截断）+ 进度条与完成比
            h('span', { className: 'ui-afc__task' },
              h('span', { className: 'ui-afc__step', title: taskText }, taskText),
              h('span', { className: 'ui-afc__track' },
                h('span', { className: 'ui-afc__fill', style: { width: percent + '%' } })),
              h('span', {
                className: 'ui-afc__count',
                title: t('card_plan') + ' ' + (agent.done || 0) + '/' + (agent.total || 0)
                  + (agent.model ? ' · ' + agent.model : '')
                  + (agent.effort ? ' · effort ' + agent.effort : ''),
              }, progressLabel))),

            // 计划清单：全部展开，不再按选中折叠（成员自报的 todo / team_todo 步骤）
            planTotal > 0
              ? h('div', { className: 'ui-afc__plan-wrap' },
                h('div', { className: 'ui-afc__plan-head' },
                  h('span', { className: 'ui-afc__plan-label' }, t('card_plan')),
                  h('span', { className: 'ui-afc__plan-bar' }, h('i', { style: { width: planPercent + '%' } })),
                  h('span', { className: 'ui-afc__plan-count' }, planDone + '/' + planTotal)),
                h('ol', { className: 'ui-afc__plan', 'aria-label': t('card_plan_aria') },
                  agent.plan.map((step, index) => h('li', {
                    key: index,
                    className: 'ui-afc__plan-step',
                    'data-status': step.status,
                  },
                  h(PlanIcon, { status: step.status }),
                  h('span', { className: 'ui-afc__plan-title', title: step.title }, step.title)))))
              : null);
        }))));
    }

    /** 输入框权限控件右侧入口：本会话的子会话（团队成员）→ 团队卡片开关。 */
    function memberStrip(t, getService) {
      return function TeamCardEntry(props) {
        const sessionId = (props && props.sessionId) || '';
        const byId = (props && typeof props.useSessions === 'function'
          ? props.useSessions((state) => state.byId)
          : null) || null;
        const kids = [];
        if (sessionId && byId) {
          for (const key of Object.keys(byId)) {
            const row = byId[key];
            if (row && row.parentId === sessionId && row.origin === 'subagent') kids.push(row);
          }
        }
        kids.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const kidsKey = kids.map((kid) => kid.id).join(',');
        const selfRow = sessionId && byId ? byId[sessionId] : null;
        const selfCwd = (selfRow && typeof selfRow.cwd === 'string' && selfRow.cwd) || '';
        const card = useCard(sessionId);

        // 当前是哪个会话：侧栏「编排」页据此决定 iframe 带哪个 team
        React.useEffect(() => {
          if (!sessionId) return undefined;
          sessionTeamStore.setActive(sessionId);
          return undefined;
        }, [sessionId]);

        // 当前会话的工作目录：看板据此默认选中对应工作区
        React.useEffect(() => {
          if (!sessionId) return undefined;
          sessionTeamStore.setCwd(sessionId, selfCwd);
          return undefined;
        }, [sessionId, selfCwd]);

        // 解析本会话的团队并记住；首次解析到团队时把「编排」页自动推到右侧栏（每会话一次）。
        // 只查团队每次挂载都做（很便宜），「自动打开」只有一次 —— 切回已经打开过的会话时
        // 不再打扰用户，但仍能拿到自己的团队，避免面板显示第一个工作区的团队。
        React.useEffect(() => {
          if (!sessionId) return undefined;
          let stopped = false;
          let timer = null;
          let attempt = 0;
          const tick = async () => {
            if (stopped) return;
            attempt += 1;
            let team = null;
            try {
              const res = await fetch(SIDECAR_BASE + '/api/teams/by-lead/' + encodeURIComponent(sessionId),
                { headers: { accept: 'application/json' } });
              if (res && res.ok) team = ((await res.json()) || {}).item || null;
            } catch { /* sidecar 没起：下一轮再试 */ }
            if (stopped) return;
            if (team) {
              sessionTeamStore.set(sessionId, team.id || null);
              pendingTeamId = team.id || null;
              const key = AUTO_OPEN_KEY + sessionId;
              let opened = false;
              try { opened = window.sessionStorage.getItem(key) === '1'; } catch { /* ignore */ }
              if (!opened) {
                try { window.sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
                openTeamPanel(getService, sessionId);
              }
              return;
            }
            // 连续几次都没有团队就先按「无团队」放行面板，之后仍然会继续轮询补上
            if (attempt >= 3) sessionTeamStore.set(sessionId, null);
            // 前 1 分钟勤快点（刚建团队），之后降频，避免长期空转
            timer = setTimeout(tick, attempt < 20 ? 3000 : 15000);
          };
          timer = setTimeout(tick, 500);
          return () => { stopped = true; if (timer) clearTimeout(timer); };
        }, [sessionId]);

        React.useEffect(() => {
          if (!sessionId || !kidsKey) return undefined;
          cardStore.setActive(sessionId);
          let stopped = false;
          const run = () => {
            const request = requestGate.begin(sessionId);
            loadSnapshot(kidsKey.split(','))
              .then((snapshot) => {
                if (stopped || !requestGate.accept(request)) return;
                applySnapshot(sessionId, snapshot);
              })
              .catch((err) => {
                if (stopped || !requestGate.accept(request)) return;
                applyError(sessionId, err);
              });
          };
          run();
          const timer = setInterval(run, POLL_MS);
          return () => {
            stopped = true;
            clearInterval(timer);
            // 离开这个会话就把浮层让给别的会话，避免卡片挂在已关闭的会话上
            if (cardStore.active === sessionId) cardStore.setActive(null);
          };
        }, [sessionId, kidsKey]);

        // 只在本会话确实挂着团队时出现：避免非团队子会话（普通 subagent）闪一下空入口。
        // 注意不能要求 phase === 'ready'：轮询偶发失败时会清掉入口，视觉上「闪一下就没了」。
        if (!kids.length || !card.teamId) return null;

        const critical = card.findings.filter((finding) => finding.severity === 'critical').length;
        const warning = card.findings.filter((finding) => finding.severity === 'warning').length;
        const open = !!card.open;
        const name = card.teamName || t('members_title');
        const summary = t('running_of', { n: card.running, m: card.memberCount });
        // 精简：图标 + n/m + 非零的严重/警告计数；团队名只进 tooltip，不占工具行宽度。
        return h('button', {
          type: 'button',
          className: 'dsht-afc-pill',
          'data-dsh-team-pill': card.teamId || 'pending',
          'data-dsh-team-stale': card.error ? '' : undefined,
          'aria-expanded': open ? 'true' : 'false',
          title: card.error || (name + ' · ' + summary + ' · ' + t(open ? 'card_close' : 'card_open')),
          'aria-label': name + ' · ' + summary,
          onClick: () => cardStore.toggle(sessionId),
        },
        h('span', { className: 'dsht-afc-pill-mark' }, h(Spark, { size: 12 })),
        h('span', { className: 'dsht-afc-pill-run' }, (card.running || 0) + '/' + (card.memberCount || 0)),
        critical
          ? h('span', { className: 'dsht-afc-pill-sev', 'data-severity': 'critical', title: t('sev_critical') },
            h('span', { className: 'dsht-afc-pill-dot' }), critical)
          : null,
        warning
          ? h('span', { className: 'dsht-afc-pill-sev', 'data-severity': 'warning', title: t('sev_warning') },
            h('span', { className: 'dsht-afc-pill-dot' }), warning)
          : null);
      };
    }

    /**
     * 量一下胶囊按钮的位置：卡片要贴着按钮弹出（而不是钉在窗口右上角）。
     * 胶囊在输入框工具行、卡片在 shell.overlay 全局浮层，两者不在同一棵 DOM 子树，
     * 所以只能按 data 属性找按钮再取 rect；取不到时返回 null，退回 CSS 兜底位置。
     * 输入框在页面底部：下方放不下卡片时翻到按钮上方弹出。
     */
    const DOCK_WIDTH = 368;

    // 打开控制台调试开关可看测量过程：window.__DSH_TEAM_DEBUG = true
    function debugOn() {
      try { return typeof window !== 'undefined' && !!window && window.__DSH_TEAM_DEBUG === true; } catch { return false; }
    }

    /** 按 data 属性找胶囊：团队 id 可能带引号/反斜杠，选择器失败就退回全量扫描。 */
    function findPillNode(teamId) {
      if (typeof document === 'undefined' || !document || typeof document.querySelector !== 'function') return null;
      const id = String(teamId || '');
      try {
        const exact = document.querySelector('[data-dsh-team-pill="' + id.replace(/["\\]/g, '\\$&') + '"]');
        if (exact) return exact;
      } catch { /* 非法选择器：走下面扫描 */ }
      if (typeof document.querySelectorAll !== 'function') return null;
      try {
        for (const node of document.querySelectorAll('[data-dsh-team-pill]')) {
          if (node && typeof node.getAttribute === 'function' && node.getAttribute('data-dsh-team-pill') === id) return node;
        }
      } catch { /* ignore */ }
      return null;
    }

    function measureDockAnchor(teamId) {
      const node = findPillNode(teamId);
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      const rect = node.getBoundingClientRect();
      if (!rect || !rect.width) return null;
      const viewportWidth = (typeof window !== 'undefined' && window && window.innerWidth) || 0;
      const viewportHeight = (typeof window !== 'undefined' && window && window.innerHeight) || 0;
      // 横向：默认右对齐按钮；按钮离左边太近就改左对齐，避免卡片被推出屏幕左侧。
      const horizontal = rect.right < DOCK_WIDTH + 24
        ? { left: Math.max(12, Math.round(rect.left)) }
        : { right: Math.max(12, Math.round(viewportWidth - rect.right)) };
      // 成员列表最多占视口 80%，多出来的内容自己滚；上下放不下就挑空间更大的一侧
      const cap = viewportHeight ? Math.max(200, Math.round(viewportHeight * 0.8)) : null;
      const below = viewportHeight ? Math.round(viewportHeight - rect.bottom - 24) : 0;
      const above = Math.round(rect.top - 24);
      if (viewportHeight && above > below) {
        return {
          placement: 'above',
          ...horizontal,
          bottom: Math.max(12, Math.round(viewportHeight - rect.top + 8)),
          maxHeight: Math.min(cap, Math.max(200, above)),
        };
      }
      return {
        placement: 'below',
        ...horizontal,
        top: Math.round(rect.bottom + 8),
        maxHeight: cap ? Math.min(cap, Math.max(200, below)) : null,
      };
    }

    /** 浮层卡片（shell.overlay）：展示当前活跃会话的团队校验卡片。 */
    function teamCardDock(t, getService) {
      return function TeamCardDock() {
        const active = useActiveCard();
        const card = active.card;
        const teamId = card && card.teamId ? card.teamId : '';
        // position:fixed 贴着胶囊按钮：按钮在输入框槽、卡片在 overlay 槽，只能按按钮 rect 定位。
        const [anchor, setAnchor] = React.useState(() => (teamId ? measureDockAnchor(teamId) : null));
        React.useEffect(() => {
          if (!teamId) return () => {};
          // scroll 会高频触发：位置没变就复用旧对象，避免无意义重渲染
          const key = (a) => (a ? [a.placement, a.top, a.bottom, a.left, a.right, a.maxHeight].join('|') : '');
          const sync = () => {
            const next = measureDockAnchor(teamId);
            if (debugOn()) console.debug('[dsh-team] dock anchor', teamId, next);
            setAnchor((prev) => (key(prev) === key(next) ? prev : next));
          };
          sync();
          // 卡片和胶囊在不同槽位挂载，首帧可能还量不到胶囊：轮询兜底，量到就贴上去
          const timer = typeof setInterval === 'function' ? setInterval(sync, 300) : null;
          if (typeof window === 'undefined' || !window || typeof window.addEventListener !== 'function') {
            return () => { if (timer) clearInterval(timer); };
          }
          window.addEventListener('resize', sync);
          window.addEventListener('scroll', sync, true);
          return () => {
            if (timer) clearInterval(timer);
            window.removeEventListener('resize', sync);
            window.removeEventListener('scroll', sync, true);
          };
        }, [teamId]);
        // 停止团队：图标按钮 + 二次确认弹窗（弹窗里再点「停止」才发请求）。
        // 状态带 teamId 归属：卡片换团队时自然回到 idle，不依赖 reset effect。
        const [stopUi, setStopUi] = React.useState({ teamId: null, state: 'idle', open: false, error: null });
        const stopView = stopUi.teamId === teamId ? stopUi : { teamId, state: 'idle', open: false, error: null };
        const stopState = stopView.state;
        const patchStop = (patch) => {
          setStopUi((prev) => Object.assign({}, prev && prev.teamId === teamId ? prev : { teamId }, { teamId }, patch));
        };
        const stopTimerRef = React.useRef(null);
        React.useEffect(() => () => { if (stopTimerRef.current) clearTimeout(stopTimerRef.current); }, []);
        const closeConfirm = () => {
          if (stopState === 'busy') return;
          patchStop({ open: false, error: null });
        };
        const confirmStop = () => {
          if (!teamId || stopState === 'busy') return;
          patchStop({ state: 'busy', error: null, open: true });
          fetch(API_BASE + '/teams/' + encodeURIComponent(teamId) + '/stop', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'team card stop' }),
          }).then((res) => {
            if (!res || !res.ok) throw new Error('E_HTTP ' + (res ? res.status : 'no-response'));
            patchStop({ state: 'done', open: false, error: null });
            // 2.5s 后回到可点状态：团队可能又被派发新任务，不该永久锁死这个按钮
            stopTimerRef.current = setTimeout(() => patchStop({ state: 'idle' }), 2500);
            // 乐观更新；下一轮轮询（≤4s）再对齐真实状态
            if (active.sessionId) cardStore.set(active.sessionId, { running: 0 });
          }).catch((err) => {
            patchStop({ state: 'idle', error: String((err && err.message) || err || '停止团队失败') });
          });
        };
        // 弹窗打开时把按键事件接过来：Esc 关闭 / Enter 确认，避免只能鼠标点
        React.useEffect(() => {
          if (!stopView.open) return () => {};
          if (typeof window === 'undefined' || !window || typeof window.addEventListener !== 'function') return () => {};
          const onKey = (event) => {
            const key = event && event.key;
            if (key === 'Escape') closeConfirm();
            if (key === 'Enter') confirmStop();
          };
          window.addEventListener('keydown', onKey);
          return () => { window.removeEventListener('keydown', onKey); };
        }, [stopView.open, stopState]);
        if (!card || !card.open || !card.teamId) return null;
        const openMember = (agent) => {
          if (agent && agent.agentSessionId && active.sessionId) {
            openMemberAside(getService, active.sessionId, agent.agentSessionId);
          }
        };
        const openConfirm = () => {
          if (!teamId || stopState === 'busy') return;
          patchStop({ open: true, error: null });
        };
        const dockStyle = anchor
          ? {
            // 只给一边，另一边显式 auto：否则 CSS 兜底的 top:56px / right:20px 会跟内联值打架
            top: anchor.top === undefined ? 'auto' : anchor.top + 'px',
            bottom: anchor.bottom === undefined ? 'auto' : anchor.bottom + 'px',
            left: anchor.left === undefined ? 'auto' : anchor.left + 'px',
            right: anchor.right === undefined ? 'auto' : anchor.right + 'px',
            '--dsht-dock-max': anchor.maxHeight ? anchor.maxHeight + 'px' : undefined,
          }
          : undefined;
        return h('div', { className: 'dsht-afc-dock', 'data-dsh-team-card': card.teamId, style: dockStyle },
          h('div', { className: 'dsht-afc-dock-bar' },
            h('span', { className: 'dsht-afc-dock-name' }, card.teamName || t('members_title')),
            h('span', {}, t('running_of', { n: card.running, m: card.memberCount })),
            card.error ? h('span', { title: card.error }, '⚠') : null,
            h('span', { className: 'dsht-afc-dock-actions' },
              // 在系统浏览器里打开独立面板（带上当前团队），方便和 GUI 并排看
              h('a', {
                className: 'dsht-afc-dock-open',
                href: panelBrowserUrl(card.teamId),
                target: '_blank',
                rel: 'noopener noreferrer',
                title: t('card_browser'),
                'aria-label': t('card_browser'),
              }, h('svg', { width: 10, height: 10, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
                h('path', { d: 'M8.1 2.4h3.5v3.5M11.6 2.4 6.7 7.3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                h('path', { d: 'M10.8 8.3v2.3a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1h2.3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
              h('button', {
                type: 'button',
                className: 'dsht-afc-dock-stop',
                disabled: stopState === 'busy' || stopState === 'done',
                title: stopState === 'done' ? t('card_stop_done') : t('card_stop_title'),
                'aria-label': t('card_stop'),
                onClick: openConfirm,
              }, h('svg', { width: 10, height: 10, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
                h('rect', { x: 3.2, y: 3.2, width: 7.6, height: 7.6, rx: 1.4, fill: 'currentColor' }))),
              h('button', {
                type: 'button',
                className: 'dsht-afc-dock-close',
                title: t('card_close'),
                'aria-label': t('card_close'),
                onClick: () => cardStore.close(active.sessionId),
              }, '×'))),
          h('div', { className: 'dsht-afc-dock-card' },
            h(AgentFindings, {
              t,
              agents: card.agents,
              onOpenMember: openMember,
            })),
          stopView.open
            ? h('div', {
              className: 'dsht-afc-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('card_stop_confirm_title'),
              onClick: (event) => { if (event && event.target === event.currentTarget) closeConfirm(); },
            },
            h('div', { className: 'dsht-afc-modal-card' },
              h('div', { className: 'dsht-afc-modal-title' }, t('card_stop_confirm_title')),
              h('div', null, t('card_stop_confirm_text')),
              stopView.error ? h('div', { className: 'dsht-afc-modal-error' }, stopView.error) : null,
              h('div', { className: 'dsht-afc-modal-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsht-afc-modal-btn',
                  disabled: stopState === 'busy',
                  onClick: closeConfirm,
                }, t('card_cancel')),
                h('button', {
                  type: 'button',
                  className: 'dsht-afc-modal-btn is-danger',
                  disabled: stopState === 'busy',
                  onClick: confirmStop,
                }, stopState === 'busy' ? t('card_stop_running') : t('card_stop_confirm')))))
            : null);
      };
    }

    /**
     * 把插件样式一次性注入 <head>。
     * 之前样式是随 TeamView / AgentFindings 一起用 <style> 节点渲染的：面板没打开时
     * 胶囊和浮层就没有样式；卡片里的 <style> 还会在列表上方露出一段固定文本。
     * 统一挂到 head 后，样式全局可用、只注入一份、也不再出现在组件树里。
     */
    /**
     * 包一层 t：宿主 locale 里没有这个 key 时，t 会把 key 原样返回，卡片上就会出现
     * 一行永远不变的 `status_provisioning`、`card_checks` 之类的原始 key。
     * 这里兜底成本地字典的文案，并按 {name} 自己补一遍插值（宿主若不支持参数也不会露馅）。
     */
    function localizer(t, dict) {
      const interpolate = (text, vars) => {
        if (!text || !vars) return text;
        return String(text).replace(/\{(\w+)\}/g, (match, name) => (
          vars[name] === undefined || vars[name] === null ? match : String(vars[name])
        ));
      };
      return function translate(key, vars) {
        let out;
        try { out = vars === undefined ? t(key) : t(key, vars); } catch { out = undefined; }
        if (typeof out !== 'string' || !out || out === key) {
          out = (dict && dict.zh && dict.zh[key]) || (dict && dict.en && dict.en[key]) || key;
        }
        return interpolate(out, vars);
      };
    }

    /**
     * 成员行两行布局（覆盖 affectui 的单行网格）：
     * 第一行 状态圆点 + 图标 + 名称 … 右侧「查看对话」；第二行 当前任务（单行截断）+ 进度条 + 完成比。
     * 放在 PLAN_CSS 之后写，同权重规则按源码顺序取胜，容器查询里的旧网格也会被覆盖。
     */
    const CARD_LAYOUT_CSS = `.ui-afc__agent{display:grid;grid-template-columns:8px auto minmax(0,1fr) auto;grid-template-areas:"dot avatar who chat" "task task task task";align-items:center;column-gap:6px;row-gap:3px;padding:8px 10px}
.ui-afc__dot{grid-area:dot;justify-self:center;width:6px;height:6px;border-radius:50%;background:var(--ui-afc-faint)}
.ui-afc__agent[data-status="running"] .ui-afc__dot{background:var(--ui-afc-note);box-shadow:0 0 0 3px color-mix(in srgb, var(--ui-afc-note) 16%, transparent)}
.ui-afc__agent[data-status="failed"] .ui-afc__dot{background:var(--ui-afc-crit)}
.ui-afc__agent .ui-afc__avatar{grid-area:avatar;display:flex;align-items:center;line-height:1;font-size:12px}
.ui-afc__agent .ui-afc__avatar img{display:block}
.ui-afc__agent .ui-afc__who{grid-area:who;display:block;min-width:0;max-width:none}
.ui-afc__agent .ui-afc__name{display:block;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ui-afc__agent .ui-afc__chat{grid-area:chat;justify-self:end}
.ui-afc__task{grid-area:task;display:grid;grid-template-columns:minmax(0,1fr) 48px auto;align-items:center;gap:8px;min-width:0;padding-left:16px}
.ui-afc__agent .ui-afc__step{grid-area:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:16px;color:var(--ui-afc-muted)}
.ui-afc__agent .ui-afc__track{grid-area:auto;display:block;width:48px;height:3px;border-radius:2px;background:var(--ui-afc-fill);overflow:hidden}
.ui-afc__agent .ui-afc__fill{display:block;height:100%;border-radius:2px;background:var(--ui-afc-note);transition:width 600ms var(--ui-afc-ease)}
.ui-afc__agent .ui-afc__count{grid-area:auto;font-variant-numeric:tabular-nums;font-size:11px;line-height:14px;color:var(--ui-afc-muted)}
`;

    /**
     * 输入框下方的常驻回执条：本会话最近一批「来自其他 agent 的留言」。
     * 数据来源是聊天快照里的 user 节点（`source.kind === 'agent-message'`，
     * 由 dsh-subagent 的 createAgentMessage 打标），不额外记状态。
     */
    const READ_RECEIPT_CSS = `
.dsht-receipt { display:flex; flex-direction:column; align-items:center; gap:6px; max-width:100%; font-size:12px; line-height:17px; color:var(--dsw-alias-label-secondary); }
.dsht-receipt-group { display:flex; flex-direction:column; align-items:center; gap:5px; min-width:0; max-width:100%; }
.dsht-receipt-head { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:2px 8px 2px 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:inherit; font:inherit; cursor:pointer; }
.dsht-receipt-head:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dsht-receipt-head:focus-visible { outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); outline-offset:1px; }
.dsht-receipt-dot { width:5px; height:5px; border-radius:50%; background:var(--dsw-alias-brand-primary); flex:none; }
.dsht-receipt-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-receipt-caret { flex:none; font-size:9px; opacity:.7; }
.dsht-receipt-list { display:flex; flex-direction:column; gap:3px; margin:0; padding:0 0 0 10px; list-style:none; border-left:1px solid var(--dsw-alias-border-l1); width:min(520px, 92vw); max-height:150px; overflow-y:auto; text-align:left; }
.dsht-receipt-item { display:flex; gap:8px; min-width:0; }
.dsht-receipt-time { flex:none; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-tertiary); }
.dsht-receipt-body { min-width:0; color:var(--dsw-alias-label-primary); white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
`;

    /** `Agent <id> sent a message: ` 是宿主给跨 agent 消息加的前缀，回执里去掉。 */
    const AGENT_MESSAGE_PREFIX = /^Agent [^\s]+ sent a message:[ \t]*/;
    const EMPTY_KEYS = Object.freeze([]);

    /** 把一条 user 消息的文本块拼起来（图片等非文本块直接跳过）。 */
    function userMessageText(content) {
      if (!content || typeof content.length !== 'number') return '';
      const parts = [];
      for (let i = 0; i < content.length; i += 1) {
        const block = content[i];
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      const text = parts.join('\n').replace(AGENT_MESSAGE_PREFIX, '');
      return text.trim();
    }

    /** 一条 user 节点若是跨 agent 消息，折成回执行；否则 null。 */
    function agentMessageRow(key, node) {
      if (!node || node.kind !== 'user') return null;
      const location = node.location;
      if (!location || (location.kind !== 'turn' && location.kind !== 'step')) return null;
      const data = node.data;
      const source = data && data.source;
      if (!source || source.kind !== 'agent-message') return null;
      const owner = location.turn;
      const ownerTurn = owner && typeof owner === 'object' ? owner.turn : owner;
      return {
        key,
        turn: typeof ownerTurn === 'number' ? ownerTurn : null,
        sender: source.senderSessionId ? String(source.senderSessionId) : '',
        time: typeof data.time === 'number' ? data.time : 0,
        text: userMessageText(data.content),
      };
    }

    /** 一回合里的跨 agent 消息（按出现顺序）。 */
    function collectAgentMessages(nodes, order, turnNo) {
      const rows = [];
      if (!nodes || !order || !order.length || turnNo === null) return rows;
      for (let i = 0; i < order.length; i += 1) {
        const key = order[i];
        let node;
        try { node = nodes.get(key); } catch { node = undefined; }
        const row = agentMessageRow(key, node);
        if (row && row.turn === turnNo) rows.push(row);
      }
      return rows;
    }

    /** 最近一批跨 agent 消息所在的回合号；没有就 null。 */
    function latestAgentTurn(nodes, order) {
      if (!nodes || !order || !order.length) return null;
      let latest = null;
      for (let i = 0; i < order.length; i += 1) {
        const key = order[i];
        let node;
        try { node = nodes.get(key); } catch { node = undefined; }
        const row = agentMessageRow(key, node);
        if (!row || row.turn === null) continue;
        if (latest === null || row.turn > latest) latest = row.turn;
      }
      return latest;
    }

    /** 发送者显示名：成员用团队里的名字，其余一律当「上级」。 */
    function senderLabel(sender) {
      const cached = sender ? memberCache.bySession[sender] : null;
      return (cached && cached.name) || null;
    }

    /** `HH:MM`，时间缺失就不显示。 */
    function clockText(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
      const date = new Date(ms);
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }

    /**
     * 注册到 `conversation.composer.dock`（输入框下方的常驻行）：显示本会话最近一批
     * 「读取了来自 {name} 的 {n} 条未读消息」，点开看每条正文与时间。
     * 没有跨 agent 消息时返回 null，不占位置。
     */
    function readReceiptDock(T) {
      return function TeamReadReceipt(props) {
        const useChat = props && props.useChat;
        const order = typeof useChat === 'function'
          ? useChat((state) => (state && state.order) || EMPTY_KEYS)
          : EMPTY_KEYS;
        const nodes = typeof useChat === 'function'
          ? useChat((state) => (state && state.nodes) || null)
          : null;
        const turnNo = React.useMemo(() => latestAgentTurn(nodes, order), [nodes, order]);
        const rows = React.useMemo(
          () => collectAgentMessages(nodes, order, turnNo),
          [nodes, order, turnNo],
        );
        const rowKey = rows.map((row) => row.key).join('|');
        const [openSender, setOpenSender] = React.useState('');
        // 成员名来自 sidecar（异步 + 15s 缓存）：拉到后重渲染一次，名字从「上级」换成真名
        const [, setNameTick] = React.useState(0);
        React.useEffect(() => {
          if (!rowKey) return undefined;
          let stopped = false;
          loadMembers()
            .then(() => { if (!stopped) setNameTick((value) => value + 1); })
            .catch(() => { /* sidecar 没起：保持占位名 */ });
          return () => { stopped = true; };
        }, [rowKey]);
        if (rows.length === 0) return null;
        const groups = [];
        const index = {};
        for (const row of rows) {
          let group = index[row.sender];
          if (!group) {
            group = { sender: row.sender, items: [] };
            index[row.sender] = group;
            groups.push(group);
          }
          group.items.push(row);
        }
        return h('div', { className: 'dsht-receipt', 'data-dsh-team-receipt': 'messages' },
          groups.map((group) => {
            const open = openSender === group.sender && group.items.length > 0;
            const name = senderLabel(group.sender) || T('receipt_lead');
            const label = T('receipt_read', { name, n: group.items.length });
            return h('div', { className: 'dsht-receipt-group', key: group.sender || 'unknown' },
              h('button', {
                type: 'button',
                className: 'dsht-receipt-head',
                title: open ? T('receipt_collapse') : T('receipt_expand'),
                'aria-expanded': open ? 'true' : 'false',
                onClick: () => setOpenSender(open ? '' : group.sender),
              },
              h('span', { className: 'dsht-receipt-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'dsht-receipt-text' }, label),
              h('span', { className: 'dsht-receipt-caret', 'aria-hidden': 'true' }, open ? '▴' : '▾')),
              open ? h('ul', { className: 'dsht-receipt-list' },
                group.items.map((item) => h('li', { className: 'dsht-receipt-item', key: item.key },
                  h('span', { className: 'dsht-receipt-time' }, clockText(item.time)),
                  h('span', { className: 'dsht-receipt-body' }, item.text || T('receipt_empty'))))) : null);
          }));
      };
    }

    function ensureStyles() {
      if (typeof document === 'undefined' || !document || !document.head) return;
      if (document.getElementById('dsh-team-ui-styles')) return;
      const node = document.createElement('style');
      node.id = 'dsh-team-ui-styles';
      node.textContent = CSS + '\n' + AGENT_FINDINGS_CSS + '\n' + PLAN_CSS + '\n' + CARD_LAYOUT_CSS + '\n' + READ_RECEIPT_CSS;
      document.head.appendChild(node);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles();
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          try {
            ctx.locale.register(NS, 'zh', DICT.zh);
            ctx.locale.register(NS, 'en', DICT.en);
          } catch { /* dictionaries may already exist on hot reload */ }
        }
        const t = ctx.locale && typeof ctx.locale.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => DICT.zh[key] || key;
        // 卡片文案统一走 T：宿主字典缺 key 时 t 会原样返回 key（界面上就是一行不变的
        // `status_xxx` / `card_checks`），这里兜底成本地字典并自己补一遍 {var} 插值。
        const T = localizer(t, DICT);
        const getService = (name) => {
          try {
            if (typeof ctx.get === 'function') return ctx.get(name);
            return ctx[name];
          } catch { return undefined; }
        };

        // 深链：独立面板 window.open `${dshWebUrl}/#dsh-session=<id>`，这里接管并打开该会话。
        // uiWorkspace 由宿主插件按加载顺序晚到，所以在浏览器里短暂重试，不额外声明注入依赖。
        const readDeepLink = () => {
          try {
            const m = /(?:^#|&)dsh-session=([^&]+)/.exec((window.location && window.location.hash) || '');
            return m ? decodeURIComponent(m[1]) : null;
          } catch { return null; }
        };
        const deepLinkSession = typeof window === 'undefined' ? null : readDeepLink();
        const openDeepLinkedSession = (workspace) => {
          try {
            if (!deepLinkSession || !workspace || typeof workspace.openSession !== 'function') return false;
            const base = window.location.pathname + window.location.search;
            window.history.replaceState(null, '', base);
            workspace.openSession(deepLinkSession);
            return true;
          } catch (e) {
            console.warn('[dsh-team] deep link open-session failed', e);
            return false;
          }
        };
        const waitForWorkspace = (attempt) => {
          if (openDeepLinkedSession(getService('uiWorkspace'))) return;
          if (attempt >= 40 || typeof setTimeout !== 'function') return;
          const timer = setTimeout(() => waitForWorkspace(attempt + 1), 250);
          timer?.unref?.();
        };
        if (deepLinkSession) waitForWorkspace(0);

        // 注册全部挂在 effect 作用域内：插件卸载/热替换时自动撤销（含 ctx.inject 派生的等待 fiber）
        ctx.effect(() => {
          const disposers = [];
          let betterDispose = [];
          const release = () => {
            for (const dispose of disposers.splice(0).reverse()) {
              try { dispose(); } catch { /* ignore */ }
            }
          };
          /**
           * 额外注册成 better-sidebar 页签（可选宿主）。
           * 装了 better-sidebar 也照样保留 DSH 原生侧栏入口，两边都能进。
           */
          const useBetterSidebar = (service) => {
            if (betterDispose.length) return true;
            if (!service || typeof service.registerTab !== 'function') return false;
            for (const descriptor of betterTabDescriptors(t, getService)) {
              try {
                betterDispose.push(service.registerTab(descriptor));
              } catch (e) {
                console.warn('[dsh-team] betterSidebar.registerTab failed', descriptor.id, e);
              }
            }
            return betterDispose.length > 0;
          };
          /** better-sidebar 晚于本插件加载时补注册（原生入口不动） */
          const watchBetterSidebar = () => {
            if (typeof ctx.inject !== 'function') return;
            ctx.inject(['betterSidebar'], (child) => {
              for (const dispose of betterDispose.splice(0)) {
                try { dispose(); } catch { /* ignore */ }
              }
              useBetterSidebar(child.betterSidebar);
            });
          };
          const cleanup = () => {
            for (const dispose of betterDispose.splice(0)) {
              try { dispose(); } catch { /* ignore */ }
            }
            release();
          };

          const sidebarRight = getService('sidebarRight');
          const sidebarRightTabs = getService('sidebarRightTabs');
          // 1) DSH 原生右侧栏入口：guide 让它出现在右侧栏「开始」页，不占左侧栏底部。
          //    sidebarRightTabs 可能晚于本插件挂载（冷启动时 apply 顺序不保证），
          //    直接 getService 会拿到 undefined 而永久跳过注册 —— 用 ctx.inject 等它就绪。
          const registerTabType = (tabs) => {
            if (!tabs || typeof tabs.register !== 'function') return;
            try {
              disposers.push(tabs.register({
                id: 'dsh-team',
                kind: 'dsh-team',
                priority: 'extension',
                title: () => t('side_nav'),
                guide: [{
                  id: 'dsh-team',
                  order: 40,
                  title: () => t('side_nav'),
                  description: () => t('guide_desc'),
                  icon: () => h(TeamIcon, { size: 22 }),
                }],
              }));
              disposers.push(tabs.register({
                id: 'dsh-team-board',
                kind: 'dsh-team-board',
                priority: 'extension',
                title: () => t('board_nav'),
                guide: [{
                  id: 'dsh-team-board',
                  order: 41,
                  title: () => t('board_nav'),
                  description: () => t('board_guide_desc'),
                  icon: () => h(BoardIcon, { size: 22 }),
                }],
              }));
            } catch (e) {
              console.warn('[dsh-team] sidebarRightTabs.register failed', e);
            }
          };
          if (sidebarRightTabs) registerTabType(sidebarRightTabs);
          else if (typeof ctx.inject === 'function') {
            ctx.inject(['sidebarRightTabs'], (child) => {
              registerTabType(child.sidebarRightTabs);
            });
          }
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'dsh-team',
          }, () => h(TeamView, { t, compact: true, getService }))));
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'dsh-team-board',
          }, () => h(BoardView, { t, getService }))));

          // 2) 左侧栏常驻入口：「编排」「看板」各有一份中央主面板 + 左侧栏图标行。
          //    与右侧栏页签、better-sidebar 并存（不互斥）：装没装扩展，左侧栏都始终有两个入口。
          //    sidebar.panellist 的 id 与 main 的 key 一一对应，点击由 sidebar 调 layout.selectPanel。
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'dsh-team',
          }, () => h(TeamView, { t, compact: false, getService }))));
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'dsh-team-board',
          }, () => h(BoardView, { t, getService }))));
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dsh-team',
            order: 20,
            label: () => t('side_nav'),
          }, panelIcon(t))));
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dsh-team-board',
            order: 21,
            label: () => t('board_nav'),
          }, panelIcon(t, 'board'))));

          // 3) 装了 better-sidebar 就再加一份页签入口；没装则等它加载
          const betterNow = getService('betterSidebar');
          if (betterNow && useBetterSidebar(betterNow)) return cleanup;
          watchBetterSidebar();
          return cleanup;
        }, 'dsh-team-ui.entry()');

        // 会话输入框：本会话团队卡片入口（pill）+ shell.overlay 浮层卡片。
        // 挂在 conversation.input.left —— 它渲染在 permission/plan 控件组的下一个位置，
        // 也就是输入框权限控件右侧的同一工具行（permission 是 single 槽，不能再收第二个入口）。
        // 独立 effect：入口在 better-sidebar / 原生侧栏之间切换时，这条始终在位。
        ctx.effect(() => {
          const slots = ctx.slots;
          if (!slots || typeof slots.inject !== 'function') return () => {};
          const disposers = [];
          disposers.push(slots.inject('conversation.input.left', () => slots.register({
            name: 'conversation.input.left',
            id: 'dsh-team:members',
            order: 5,
            label: () => T('card_open'),
          }, memberStrip(T, getService))));
          disposers.push(slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'dsh-team:findings',
            order: 30,
            label: () => T('card_title'),
          }, teamCardDock(T, getService))));
          // 成员/上级对话里：输入框下方常驻「读取了来自 X 的 N 条未读消息」回执
          disposers.push(slots.inject('conversation.composer.dock', () => slots.register({
            name: 'conversation.composer.dock',
            id: 'dsh-team:read-receipt',
            order: 90,
            locale: NS,
          }, readReceiptDock(T))));
          // 「看板」行右端的固定开关 + 网页最右侧的固定看板（跨会话常驻，不进右侧栏）
          disposers.push(slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'dsh-team:board-dock-toggle',
            order: 25,
            label: () => T('board_dock_open'),
          }, boardDockToggle(T))));
          disposers.push(slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'dsh-team:board-dock',
            order: 40,
            label: () => T('board_title'),
          }, boardDockView(T, getService))));
          return () => {
            for (const dispose of disposers.splice(0).reverse()) {
              try { dispose(); } catch { /* ignore */ }
            }
          };
        }, 'dsh-team-ui.member-strip()');
      },
    };
  },
});

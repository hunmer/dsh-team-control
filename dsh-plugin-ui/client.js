// @local/dsh-team-ui — Client half：把「编排」看板注册成 dsh-better-sidebar 的页签；没装时回退到
// 本插件自己的右侧栏 Tab + 侧边栏左下角入口。内容一律内嵌 sidecar 自带 Web 面板。
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
        members_title: '团队成员',
        members_running: '运行中',
        members_idle: '空闲',
        members_open: '在侧栏打开该成员的对话',
        members_empty: '本会话没有团队成员',
        members_running_count: '运行中 {n}',
        // ---- 右上角团队卡片（affectui AgentFindings 移植）----
        card_open: '展开团队卡片',
        card_close: '收起团队卡片',
        card_title: '团队校验',
        card_checks: '{done} / {total} 项检查',
        card_checks_aria: '{done} of {total} checks',
        card_critical: '严重',
        card_warning: '警告',
        card_latest: '最新发现',
        card_empty: '暂无发现',
        card_all_done: '全部检查完成',
        card_stopped: '已停止',
        card_totals_aria: '{c} 严重，{w} 警告',
        card_found_aria: '{c} 严重，{w} 警告',
        card_expand_hint: '点击筛选该成员',
        sev_critical: '严重',
        sev_warning: '警告',
        sev_note: '备注',
        running_of: '运行中 {n}/{m}',
        status_running: '运行中',
        status_idle: '空闲',
        status_blocked: '受阻',
        status_failed: '失败',
        status_interrupted: '已中断',
        status_retired: '已退出',
        status_queued: '排队中',
        status_provisioning: '启动中',
      },
      en: {
        title: 'dsh-team console',
        subtitle: 'Trace waterfall, DAG, timeline, permissions and approvals (local sidecar via Host proxy)',
        side_nav: 'Team',
        members_title: 'Team members',
        members_running: 'running',
        members_idle: 'idle',
        members_open: 'Open this member’s conversation in the sidebar',
        members_empty: 'No team members in this session',
        members_running_count: '{n} running',
        card_open: 'Show team card',
        card_close: 'Hide team card',
        card_title: 'Team verification',
        card_checks: '{done} of {total} checks',
        card_checks_aria: '{done} of {total} checks',
        card_critical: 'critical',
        card_warning: 'warnings',
        card_latest: 'Latest findings',
        card_empty: 'Nothing found yet',
        card_all_done: 'All checks done',
        card_stopped: 'Stopped',
        card_totals_aria: '{c} critical, {w} warnings',
        card_found_aria: '{c} critical, {w} warnings',
        card_expand_hint: 'Click to filter this member',
        sev_critical: 'Critical',
        sev_warning: 'Warning',
        sev_note: 'Note',
        running_of: '{n} of {m} running',
        status_running: 'running',
        status_idle: 'idle',
        status_blocked: 'blocked',
        status_failed: 'failed',
        status_interrupted: 'interrupted',
        status_retired: 'retired',
        status_queued: 'queued',
        status_provisioning: 'provisioning',
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

/* 会话右上角：团队卡片入口（affectui AgentFindings 移植） */
.dsht-afc-pill { display:inline-flex; align-items:center; gap:8px; height:26px; padding:0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12px; line-height:16px; cursor:pointer; white-space:nowrap; }
.dsht-afc-pill:hover { border-color:var(--dsw-alias-brand-primary); }
.dsht-afc-pill[aria-expanded="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dsht-afc-pill-mark { display:inline-flex; flex:none; color:var(--dsw-alias-brand-primary); }
.dsht-afc-pill-name { max-width:132px; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
.dsht-afc-pill-run { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dsht-afc-pill-sev { display:inline-flex; align-items:center; gap:4px; font-variant-numeric:tabular-nums; }
.dsht-afc-pill-sev[data-severity="critical"] { color:#d72400; }
.dsht-afc-pill-sev[data-severity="warning"] { color:#cc4e00; }
.dsht-afc-pill-sev[data-zero] { opacity:.4; }
.dsht-afc-pill-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
/* 快照这一轮没取到（sidecar 抖动）时仍保留入口，只做轻微降权，避免卡片闪一下就消失 */
.dsht-afc-pill[data-dsh-team-stale] { border-style:dashed; }
.dsht-afc-pill[data-dsh-team-stale] .dsht-afc-pill-run::after { content:" ·!"; color:var(--dsw-alias-label-tertiary); font-weight:600; }
.dark .dsht-afc-pill-sev[data-severity="critical"], [data-theme="dark"] .dsht-afc-pill-sev[data-severity="critical"] { color:#ff977d; }
.dark .dsht-afc-pill-sev[data-severity="warning"], [data-theme="dark"] .dsht-afc-pill-sev[data-severity="warning"] { color:#ffa057; }

/* 卡片停靠层（shell.overlay 是点击穿透层，卡片自己接管指针） */
.dsht-afc-dock { position:fixed; top:56px; right:20px; width:368px; max-width:calc(100vw - 40px); z-index:80; pointer-events:auto; display:flex; flex-direction:column; gap:6px; }
.dsht-afc-dock-bar { display:flex; align-items:center; gap:6px; padding:0 2px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dsht-afc-dock-name { font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-afc-dock-close { margin-left:auto; display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dsht-afc-dock-close:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-brand-primary); }
.dsht-afc-dock-card { max-height:calc(100vh - 140px); overflow:auto; border-radius:12px; }
.dsht-afc-dock-card .ui-afc { max-width:none; }
.dsht-afc-dock-empty { padding:12px 14px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:12px; }
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

    // ---------- dsh-better-sidebar 页签（可选宿主，装了就把入口交给它） ----------
    /** 看板在 better-sidebar 里的页签描述：原生右侧栏的 guide 胶囊 + 插件底部工作台的 + 菜单同源。 */
    function betterTabDescriptor(t) {
      return {
        id: 'dsh-team:panel',
        title: () => t('side_nav'),
        description: () => t('subtitle'),
        icon: (size) => h(TeamIcon, { size: size || 16 }),
        order: 30,
        single: true,
        component: () => h(TeamView, { t, compact: true }),
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

    // ---------- 会话右上角：当前会话的运行中成员（点击在右侧栏内嵌该成员对话） ----------
    const SIDECAR_BASE = '/dsh-team-api';

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

    /* ------------------------------------------------------------------
     * 会话右上角团队卡片（移植 affectui `agent-findings`）
     * - 右上角 pill：本会话团队 · 运行中 n/m · 严重/警告计数，点击展开卡片
     * - 卡片本体渲染在 shell.overlay（frame-wide 浮层），停靠会话右上角
     * - 数据：Host 代理 /dsh-team-api → sidecar（/status /teams /tasks /events）
     * ------------------------------------------------------------------ */
    const AGENT_FINDINGS_CSS = `.ui-afc{--ui-afc-card: #ffffff;--ui-afc-strong: #000000;--ui-afc-ink: rgba(0, 0, 0, 0.88);--ui-afc-text: rgba(0, 0, 0, 0.61);--ui-afc-muted: rgba(0, 0, 0, 0.45);--ui-afc-faint: rgba(0, 0, 0, 0.27);--ui-afc-line: rgba(0, 0, 0, 0.06);--ui-afc-fill: rgba(0, 0, 0, 0.06);--ui-afc-hover: rgba(0, 0, 0, 0.025);--ui-afc-select: rgba(0, 0, 0, 0.04);--ui-afc-run-bg: rgba(0, 96, 226, 0.1);--ui-afc-run-edge: rgba(0, 96, 226, 0.32);--ui-afc-done-bg: rgba(0, 0, 0, 0.05);--ui-afc-done-edge: rgba(0, 0, 0, 0.1);--ui-afc-fail-bg: #f52b0018;--ui-afc-fail-edge: rgba(215, 36, 0, 0.34);--ui-afc-crit: #d72400;--ui-afc-warn: #cc4e00;--ui-afc-note: rgba(0, 96, 226, 0.8);--ui-afc-focus: rgba(0, 96, 226, 0.35);--ui-afc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);--ui-afc-ease: cubic-bezier(0.22, 1, 0.36, 1);--ui-afc-row: 40px;position: relative;box-sizing: border-box;width: 100%;max-width: 640px;container-type: inline-size;font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;font-size: 13px;font-weight: 400;line-height: 20px;color: var(--ui-afc-text);text-align: left;-webkit-font-smoothing: antialiased}.ui-afc *, .ui-afc *::before, .ui-afc *::after{box-sizing: border-box}:where(.ui-afc) button{margin: 0;padding: 0;border: 0;background: none;font: inherit;color: inherit;text-align: inherit;cursor: pointer;-webkit-tap-highlight-color: transparent}.ui-afc button:focus-visible{outline: 2px solid var(--ui-afc-focus);outline-offset: -2px}.ui-afc :is(ul, ol){margin: 0;padding: 0;list-style: none}.ui-afc svg{display: block;flex: none}.ui-afc b{font-weight: 500}.ui-afc__sr{position: absolute;width: 1px;height: 1px;overflow: hidden;clip-path: inset(50%);white-space: nowrap}.ui-afc__card{border-radius: 10px;background: var(--ui-afc-card);box-shadow: var(--ui-afc-shadow);overflow: hidden}.ui-afc__bar{display: flex;align-items: center;gap: 10px;min-width: 0;padding: 14px 16px;border-bottom: 0.5px solid var(--ui-afc-line)}.ui-afc__spark{display: grid;flex: none;place-items: center;width: 16px;color: rgba(0, 96, 226, 0.765)}.ui-afc__title{font-weight: 500;color: var(--ui-afc-strong);white-space: nowrap}.ui-afc__progress{flex: 1;min-width: 0;overflow: hidden;font-size: 12px;line-height: 16px;color: var(--ui-afc-muted);white-space: nowrap;text-overflow: ellipsis;font-variant-numeric: tabular-nums}.ui-afc__totals{display: flex;flex: none;gap: 12px;font-size: 12px;line-height: 16px;white-space: nowrap}.ui-afc__totals > span{display: inline-flex;align-items: center;gap: 6px;transition: color 300ms ease}.ui-afc__totals > span::before{content: "";width: 6px;height: 6px;border-radius: 50%;background: currentColor}.ui-afc__totals [data-severity="critical"]{color: var(--ui-afc-crit)}.ui-afc__totals [data-severity="warning"]{color: var(--ui-afc-warn)}.ui-afc__totals [data-zero]{color: var(--ui-afc-faint)}.ui-afc__totals b, .ui-afc__found b{display: inline-block;font-variant-numeric: tabular-nums;animation: ui-afc-roll 420ms var(--ui-afc-ease)}.ui-afc__agents{padding: 6px 6px 2px}.ui-afc__agent{display: grid;grid-template-columns: 24px minmax(0, 1fr) 128px 40px 60px;align-items: center;gap: 12px;width: 100%;height: 48px;padding: 0 10px;border-radius: 8px;transition: background-color 160ms ease, opacity 220ms ease}.ui-afc__agent:hover{background: var(--ui-afc-hover)}.ui-afc__agent[aria-pressed="true"]{background: var(--ui-afc-select)}.ui-afc__agent[data-dim]{opacity: 0.5}.ui-afc__agent[data-dim]:hover{opacity: 0.8}.ui-afc__avatar{display: grid;place-items: center;width: 24px;height: 24px;overflow: hidden;border-radius: 6px;background: var(--ui-afc-fill);font-size: 10px;font-weight: 500;letter-spacing: 0.3px;color: var(--ui-afc-text)}.ui-afc__avatar[data-logo]{background: var(--ui-afc-card);box-shadow: var(--ui-afc-shadow)}.ui-afc__avatar > svg{width: 14px;height: 14px}.ui-afc__who{display: grid;min-width: 0}.ui-afc__name{overflow: hidden;font-weight: 500;line-height: 18px;color: var(--ui-afc-ink);white-space: nowrap;text-overflow: ellipsis}.ui-afc__step{overflow: hidden;font-size: 12px;line-height: 16px;color: var(--ui-afc-muted);white-space: nowrap;text-overflow: ellipsis;animation: ui-afc-swap 360ms var(--ui-afc-ease)}.ui-afc__track{position: relative;height: 6px;border-radius: 3px;background: var(--ui-afc-fill);overflow: hidden}.ui-afc__fill{position: absolute;inset: 0 auto 0 0;overflow: hidden;border-radius: 3px;background: var(--ui-afc-done-bg);box-shadow: inset 0 0 0 0.5px var(--ui-afc-done-edge);transition: width 700ms var(--ui-afc-ease), background-color 300ms ease}.ui-afc__agent[data-status="running"] .ui-afc__fill{background: var(--ui-afc-run-bg);box-shadow: inset 0 0 0 0.5px var(--ui-afc-run-edge)}.ui-afc__agent[data-status="failed"] .ui-afc__fill{background: var(--ui-afc-fail-bg);box-shadow: inset 0 0 0 0.5px var(--ui-afc-fail-edge)}.ui-afc__agent[data-status="running"] .ui-afc__fill::before{content: "";position: absolute;inset: 0 auto 0 0;width: 40px;background: linear-gradient(90deg, transparent, var(--ui-afc-card), transparent);opacity: 0.7;animation: ui-afc-sheen 1500ms linear infinite}.ui-afc__agent[data-status="running"] .ui-afc__fill::after{content: "";position: absolute;inset: 0 0 0 auto;width: 18px;background: linear-gradient(90deg, transparent, var(--ui-afc-run-edge));animation: ui-afc-breathe 1100ms ease-in-out infinite alternate}.ui-afc__count{font-size: 12px;line-height: 16px;color: var(--ui-afc-muted);text-align: right;font-variant-numeric: tabular-nums}.ui-afc__found{display: flex;justify-content: flex-end;gap: 10px;font-size: 12px;line-height: 16px}.ui-afc__found > span{display: inline-flex;align-items: center;gap: 4px;min-width: 22px}.ui-afc__found [data-zero]{opacity: 0.28}.ui-afc__found [data-zero] .ui-afc__mark{color: var(--ui-afc-faint)}.ui-afc__found [data-severity="critical"] b{color: var(--ui-afc-crit)}.ui-afc__found [data-severity="warning"] b{color: var(--ui-afc-warn)}.ui-afc__found [data-zero] b{color: var(--ui-afc-muted)}.ui-afc__mark[data-severity="critical"]{color: var(--ui-afc-crit)}.ui-afc__mark[data-severity="warning"]{color: var(--ui-afc-warn)}.ui-afc__mark[data-severity="note"]{color: var(--ui-afc-note)}.ui-afc__feed-head{display: flex;align-items: center;gap: 8px;height: 40px;margin-top: 4px;padding: 0 16px;border-top: 0.5px solid var(--ui-afc-line)}.ui-afc__label{font-size: 10px;font-weight: 500;line-height: 16px;letter-spacing: 0.5px;text-transform: uppercase;color: var(--ui-afc-muted)}.ui-afc__chip{display: inline-flex;align-items: center;gap: 4px;height: 20px;padding: 0 6px 0 8px;border-radius: 6px;background: var(--ui-afc-fill);font-size: 12px;font-weight: 500;line-height: 16px;color: var(--ui-afc-ink);animation: ui-afc-swap 260ms var(--ui-afc-ease)}.ui-afc__chip svg{color: var(--ui-afc-muted)}.ui-afc__feed{position: relative;height: calc(var(--ui-afc-rows) * var(--ui-afc-row) + 8px);margin: 0 6px;padding-bottom: 8px;overflow: hidden}.ui-afc__slot{position: absolute;top: 0;right: 0;left: 0;height: var(--ui-afc-row);transition: transform 520ms var(--ui-afc-ease), opacity 320ms ease}.ui-afc__slot[data-out]{opacity: 0;pointer-events: none}.ui-afc__finding{display: block;width: 100%;height: 100%;border-radius: 8px;transition: background-color 160ms ease}.ui-afc__finding:hover{background: var(--ui-afc-hover)}.ui-afc__in{display: flex;align-items: center;gap: 10px;height: 100%;min-width: 0;padding: 0 10px;animation: ui-afc-in 560ms var(--ui-afc-ease)}.ui-afc__ftitle{flex: 0 1 auto;min-width: 0;overflow: hidden;color: var(--ui-afc-ink);white-space: nowrap;text-overflow: ellipsis}.ui-afc__meta{display: flex;flex: 1 1 0;align-items: center;gap: 6px;min-width: 0;overflow: hidden;font-size: 12px;line-height: 16px;color: var(--ui-afc-muted);white-space: nowrap}.ui-afc__meta code{overflow: hidden;font-family: ui-monospace, "SF Mono", Menlo, monospace;font-size: 11.5px;text-overflow: ellipsis}.ui-afc__dot{color: var(--ui-afc-faint)}.ui-afc__time{flex: none;min-width: 28px;font-size: 12px;line-height: 16px;color: var(--ui-afc-faint);text-align: right;font-variant-numeric: tabular-nums}.ui-afc__empty{display: grid;place-items: center;height: var(--ui-afc-row);font-size: 12px;color: var(--ui-afc-muted)}@keyframes ui-afc-in{from{opacity: 0;transform: translateY(-10px);filter: blur(2px)}}@keyframes ui-afc-swap{from{opacity: 0;transform: translateY(3px)}}@keyframes ui-afc-roll{from{opacity: 0;transform: translateY(-5px)}}@keyframes ui-afc-sheen{from{transform: translateX(-40px)}to{transform: translateX(160px)}}@keyframes ui-afc-breathe{from{opacity: 0.45}to{opacity: 1}}@container (max-width: 480px){.ui-afc__agent{grid-template-columns: 24px minmax(0, 1fr) 64px 52px;gap: 10px}.ui-afc__count{display: none}.ui-afc__progress{display: none}.ui-afc__meta{display: none}.ui-afc__ftitle{flex: 1}}@media (prefers-reduced-motion: reduce){.ui-afc *, .ui-afc *::before, .ui-afc *::after{animation: none !important;transition: none !important}}:where(.dark, [data-theme="dark"]) .ui-afc{--ui-afc-card: #1c1c1f;--ui-afc-strong: #ffffff;--ui-afc-ink: rgba(255, 255, 255, 0.9);--ui-afc-text: rgba(255, 255, 255, 0.62);--ui-afc-muted: rgba(255, 255, 255, 0.45);--ui-afc-faint: rgba(255, 255, 255, 0.28);--ui-afc-line: rgba(255, 255, 255, 0.08);--ui-afc-fill: rgba(255, 255, 255, 0.08);--ui-afc-hover: rgba(255, 255, 255, 0.04);--ui-afc-select: rgba(255, 255, 255, 0.06);--ui-afc-run-bg: rgba(112, 184, 255, 0.18);--ui-afc-run-edge: rgba(112, 184, 255, 0.5);--ui-afc-done-bg: rgba(255, 255, 255, 0.08);--ui-afc-done-edge: rgba(255, 255, 255, 0.14);--ui-afc-fail-bg: #ff35232b;--ui-afc-fail-edge: rgba(255, 151, 125, 0.45);--ui-afc-crit: #ff977d;--ui-afc-warn: #ffa057;--ui-afc-note: #70b8ff;--ui-afc-focus: rgba(91, 154, 255, 0.45);--ui-afc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4)}:where(.dark, [data-theme="dark"]) .ui-afc__spark{color: #70b8ff}:where(.dark, [data-theme="dark"]) .ui-afc__agent[data-status="running"] .ui-afc__fill::before{background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.14), transparent)}`;

    const API_BASE = '/dsh-team-api/api';
    const POLL_MS = 4000;
    const ROW_HEIGHT = 40;

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
      return 'done';
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

      for (const member of members) {
        const assigned = tasks.filter((task) => task && task.assignee === member.id);
        const doneTasks = assigned.filter((task) => task && task.status === 'done').length;
        const current = taskById.get(member.currentTaskId) || null;
        const idx = stepIndex(member.step);
        let total = assigned.length;
        let done = doneTasks;
        if (current && Array.isArray(current.plan) && current.plan.length > 0) {
          const planSteps = current.plan.length;
          // sidecar 的 pct = (当前步序 + 1) / plan 步数；没有 pct 时退化为「已完成步数」。
          const planDone = member.pct != null
            ? Math.min(planSteps, Math.round(member.pct * planSteps))
            : (idx != null ? Math.min(planSteps, idx) : 0);
          total = Math.max(total, planSteps);
          done = Math.max(doneTasks, planDone);
        }
        if (!total) {
          total = 1;
          done = memberStatus(member.status) === 'done' ? 1 : 0;
        }
        agents.push({
          id: member.id,
          name: member.name || member.id,
          model: member.model || '',
          step: member.step || '',
          done,
          total,
          status: memberStatus(member.status),
          statusRaw: member.status || '',
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

    /** 读 sidecar：/status 里按子会话 agentSessionId 认出团队，再补任务与事件。 */
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
      const [tasksRes, eventsRes] = await Promise.all([
        fetchJson('/tasks?team=' + encoded).catch(() => null),
        fetchJson('/events/history?team=' + encoded + '&limit=40').catch(() => null),
      ]);
      const tasks = (tasksRes && (tasksRes.items || tasksRes.tasks)) || [];
      const events = (eventsRes && (eventsRes.items || eventsRes.events)) || [];
      return { team, members, tasks, events, asOf: Date.now() };
    }

    /**
     * 快照落库。
     * - 首次轮询到「有人在跑」时自动展开；用户点过 pill/关闭按钮（pinned）后一律尊重用户选择，
     *   否则每轮轮询都会把用户手动展开的卡片又收回去。
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
        open: prev.pinned ? prev.open : (prev.open || model.running > 0),
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
    const toTime = (value) => {
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number') return value;
      const parsed = Date.parse(String(value));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const relativeTime = (from, now) => {
      const seconds = Math.max(0, Math.floor((now - from) / 1000));
      if (seconds < 1) return 'now';
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm';
      return Math.floor(minutes / 60) + 'h';
    };
    const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map((word) => (word ? word[0] : '')).join('').toUpperCase();
    const SEVERITY_OPACITY = {
      critical: [1, 1, 1, 0.6],
      warning: [1, 0.6, 0.6, 0.3],
      note: [0.6, 0.3, 0.3, 0.3],
    };

    /** 四格严重度标记（affectui SeverityMark）。 */
    function SeverityMark(props) {
      const severity = props.severity || 'note';
      const opacity = SEVERITY_OPACITY[severity] || SEVERITY_OPACITY.note;
      return h('svg', {
        width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true',
        className: 'ui-afc__mark', 'data-severity': severity,
      }, opacity.map((value, index) => h('rect', {
        key: index,
        x: (index % 2) * 6, y: Math.floor(index / 2) * 6,
        width: 4, height: 4, rx: 1,
        fill: 'currentColor', opacity: value,
      })));
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

    /** 团队校验卡片：成员进度 + 最新发现（最新在前，点击成员筛选，点击发现打开成员对话）。 */
    function AgentFindings(props) {
      const t = props.t || ((key) => key);
      const agents = props.agents || [];
      const findings = props.findings || [];
      const rows = props.rows == null ? 3 : props.rows;
      const [selected, setSelected] = React.useState(null);
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 5000);
        return () => clearInterval(timer);
      }, []);

      const checksTotal = agents.reduce((sum, agent) => sum + Math.max(0, agent.total || 0), 0);
      const checksDone = agents.reduce((sum, agent) => sum + Math.min(agent.done || 0, agent.total || 0), 0);
      const count = (severity, agentId) => findings.reduce(
        (total, finding) => total + (finding.severity === severity && (!agentId || finding.agentId === agentId) ? 1 : 0),
        0,
      );
      const criticalAll = count('critical');
      const warningAll = count('warning');
      const visible = findings
        .filter((finding) => !selected || finding.agentId === selected)
        .sort((a, b) => toTime(b.at) - toTime(a.at))
        .slice(0, rows + 1);
      const statusText = (agent) => {
        if (agent.status === 'done') return t('card_all_done');
        if (agent.status === 'failed') return t('card_stopped');
        if (agent.step) return agent.step;
        return t('status_' + (agent.statusRaw || 'running'));
      };
      const agentName = (id) => {
        const hit = agents.find((agent) => agent.id === id);
        return hit ? hit.name : '';
      };

      return h('div', {
        className: 'ui-afc',
        'data-dsh-team-findings': agents.length,
        style: { '--ui-afc-rows': String(rows) },
      },
      h('style', { href: 'ui-agent-findings-clean', precedence: 'default' }, AGENT_FINDINGS_CSS),
      h('div', { className: 'ui-afc__card' },
        h('header', { className: 'ui-afc__bar' },
          h('span', { className: 'ui-afc__spark' }, h(Spark, { size: 14 })),
          h('span', { className: 'ui-afc__title' }, props.title || t('card_title')),
          h('span', { className: 'ui-afc__progress' }, t('card_checks', { done: checksDone, total: checksTotal })),
          h('span', { className: 'ui-afc__totals', 'aria-label': t('card_totals_aria', { c: criticalAll, w: warningAll }) },
            h('span', { 'data-severity': 'critical', 'data-zero': criticalAll ? undefined : '' },
              h('b', { key: criticalAll }, criticalAll), ' ' + t('card_critical')),
            h('span', { 'data-severity': 'warning', 'data-zero': warningAll ? undefined : '' },
              h('b', { key: warningAll }, warningAll), ' ' + t('card_warning')))),
        h('ul', { className: 'ui-afc__agents' }, agents.map((agent) => {
          const percent = agent.total ? Math.min(100, ((agent.done || 0) / agent.total) * 100) : 0;
          const critical = count('critical', agent.id);
          const warning = count('warning', agent.id);
          const pressed = selected === agent.id;
          return h('li', { key: agent.id },
            h('button', {
              type: 'button',
              className: 'ui-afc__agent',
              'data-status': agent.status || 'running',
              'aria-pressed': pressed,
              'data-dim': selected && !pressed ? '' : undefined,
              title: t('card_expand_hint'),
              onClick: () => setSelected(pressed ? null : agent.id),
            },
            h('span', { className: 'ui-afc__avatar' }, initials(agent.name)),
            h('span', { className: 'ui-afc__who' },
              h('span', { className: 'ui-afc__name' }, agent.name),
              h('span', { className: 'ui-afc__step' }, statusText(agent))),
            h('span', { className: 'ui-afc__track' },
              h('span', { className: 'ui-afc__fill', style: { width: percent + '%' } })),
            h('span', { className: 'ui-afc__count' }, (agent.done || 0) + '/' + (agent.total || 0)),
            h('span', { className: 'ui-afc__found' },
              h('span', { 'data-severity': 'critical', 'data-zero': critical ? undefined : '' },
                h(SeverityMark, { severity: 'critical' }), h('b', { key: critical }, critical)),
              h('span', { 'data-severity': 'warning', 'data-zero': warning ? undefined : '' },
                h(SeverityMark, { severity: 'warning' }), h('b', { key: warning }, warning)))));
        })),
        h('div', { className: 'ui-afc__feed-head' },
          h('span', { className: 'ui-afc__title' }, t('card_latest')),
          selected
            ? h('button', { type: 'button', className: 'ui-afc__chip', onClick: () => setSelected(null) },
              h(Spark, { size: 10 }), h('span', {}, agentName(selected)))
            : null),
        h('ol', { className: 'ui-afc__feed' },
          visible.length === 0
            ? h('li', { className: 'ui-afc__empty' }, t('card_empty'))
            : visible.map((finding, index) => h('li', {
              key: finding.id,
              className: 'ui-afc__slot',
              style: { transform: 'translateY(' + index * ROW_HEIGHT + 'px)' },
              'data-out': index > rows - 1 ? '' : undefined,
              'aria-hidden': index > rows - 1 ? 'true' : undefined,
            },
            h('button', {
              type: 'button',
              className: 'ui-afc__finding',
              title: finding.title,
              onClick: props.onOpen ? () => props.onOpen(finding) : undefined,
            },
            h('span', { className: 'ui-afc__in' },
              h(SeverityMark, { severity: finding.severity }),
              h('span', { className: 'ui-afc__sr' }, t('sev_' + finding.severity)),
              h('span', { className: 'ui-afc__ftitle' }, finding.title),
              h('span', { className: 'ui-afc__meta' },
                h('span', {}, agentName(finding.agentId)),
                finding.location ? h('code', {}, clip(finding.location, 28)) : null),
              h('span', { className: 'ui-afc__time' }, relativeTime(toTime(finding.at), now)))))))));
    }

    /** 会话右上角入口：本会话的子会话（团队成员）→ 团队卡片开关。 */
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
        const card = useCard(sessionId);

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
        return h('button', {
          type: 'button',
          className: 'dsht-afc-pill',
          'data-dsh-team-pill': card.teamId || 'pending',
          'data-dsh-team-stale': card.error ? '' : undefined,
          'aria-expanded': open ? 'true' : 'false',
          title: card.error || t(open ? 'card_close' : 'card_open'),
          onClick: () => cardStore.toggle(sessionId),
        },
        h('span', { className: 'dsht-afc-pill-mark' }, h(Spark, { size: 13 })),
        h('span', { className: 'dsht-afc-pill-name' }, name),
        h('span', { className: 'dsht-afc-pill-run' }, t('running_of', { n: card.running, m: card.memberCount })),
        h('span', { className: 'dsht-afc-pill-sev', 'data-severity': 'critical', 'data-zero': critical ? undefined : '' },
          h('span', { className: 'dsht-afc-pill-dot' }), critical),
        h('span', { className: 'dsht-afc-pill-sev', 'data-severity': 'warning', 'data-zero': warning ? undefined : '' },
          h('span', { className: 'dsht-afc-pill-dot' }), warning));
      };
    }

    /** 浮层卡片（shell.overlay）：展示当前活跃会话的团队校验卡片。 */
    function teamCardDock(t, getService) {
      return function TeamCardDock() {
        const active = useActiveCard();
        const card = active.card;
        if (!card || !card.open || !card.teamId) return null;
        const openFinding = (finding) => {
          const agent = (card.agents || []).find((item) => item.id === finding.agentId);
          if (agent && agent.agentSessionId && active.sessionId) {
            openMemberAside(getService, active.sessionId, agent.agentSessionId);
          }
        };
        return h('div', { className: 'dsht-afc-dock', 'data-dsh-team-card': card.teamId },
          h('div', { className: 'dsht-afc-dock-bar' },
            h('span', { className: 'dsht-afc-dock-name' }, card.teamName || t('members_title')),
            h('span', {}, t('running_of', { n: card.running, m: card.memberCount })),
            card.error ? h('span', { title: card.error }, '⚠') : null,
            h('button', {
              type: 'button',
              className: 'dsht-afc-dock-close',
              title: t('card_close'),
              'aria-label': t('card_close'),
              onClick: () => cardStore.close(active.sessionId),
            }, '×')),
          h('div', { className: 'dsht-afc-dock-card' },
            h(AgentFindings, {
              t,
              agents: card.agents,
              findings: card.findings,
              rows: 3,
              onOpen: openFinding,
            })));
      };
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

        // 注册全部挂在 effect 作用域内：插件卸载/热替换时自动撤销（含 ctx.inject 派生的等待 fiber）
        ctx.effect(() => {
          const disposers = [];
          let betterDispose = null;
          /** 撤掉本插件在 DSH 原生侧栏上的全部注册（切换到 better-sidebar 或卸载时调用）。 */
          const release = () => {
            for (const dispose of disposers.splice(0).reverse()) {
              try { dispose(); } catch { /* ignore */ }
            }
          };
          /** 注册成 better-sidebar 页签；成功（或已注册）返回 true。 */
          const useBetterSidebar = (service) => {
            if (betterDispose) return true;
            if (!service || typeof service.registerTab !== 'function') return false;
            try {
              betterDispose = service.registerTab(betterTabDescriptor(t));
              return true;
            } catch (e) {
              console.warn('[dsh-team] betterSidebar.registerTab failed', e);
              return false;
            }
          };
          /** better-sidebar 晚于本插件加载时再切过去：装上就撤掉自己的左下角入口。 */
          const upgradeToBetterSidebar = () => {
            if (typeof ctx.inject !== 'function') return;
            ctx.inject(['betterSidebar'], (child) => {
              betterDispose = null; // 服务实例变化时重新注册（旧注册随旧实例失效）
              if (useBetterSidebar(child.betterSidebar)) release();
            });
          };
          const cleanup = () => {
            if (betterDispose) {
              try { betterDispose(); } catch { /* ignore */ }
              betterDispose = null;
            }
            release();
          };

          // 1) 首选：入口注册到 dsh-better-sidebar（原生右侧栏 guide + 插件底部工作台同一套页签）
          const betterNow = getService('betterSidebar');
          if (betterNow && useBetterSidebar(betterNow)) return cleanup;

          const sidebarRight = getService('sidebarRight');
          const sidebarRightTabs = getService('sidebarRightTabs');

          if (sidebarRight && sidebarRightTabs && typeof sidebarRight.openTab === 'function') {
            // 2) 没装 better-sidebar：保留本插件自己的右侧栏 Tab + 侧边栏左下角入口
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
            disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
              name: 'sidebar.footer.action',
              id: 'dsh-team',
              order: 30,
              label: () => t('side_nav'),
            }, railEntry(t, () => sidebarRight.openTab('dsh-team')))));
            upgradeToBetterSidebar();
            return cleanup;
          }

          // 3) 都没有：中央停靠面板兜底（与「插件」页同级）
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
          upgradeToBetterSidebar();
          return cleanup;
        }, 'dsh-team-ui.entry()');

        // 会话右上角：本会话团队卡片入口（pill）+ shell.overlay 浮层卡片。
        // 独立 effect：入口在 better-sidebar / 原生侧栏之间切换时，这条始终在位。
        ctx.effect(() => {
          const slots = ctx.slots;
          if (!slots || typeof slots.inject !== 'function') return () => {};
          const disposers = [];
          disposers.push(slots.inject('conversation.session.header.utilities', () => slots.register({
            name: 'conversation.session.header.utilities',
            id: 'dsh-team:members',
            order: 5,
            label: () => t('card_open'),
          }, memberStrip(t, getService))));
          disposers.push(slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'dsh-team:findings',
            order: 30,
            label: () => t('card_title'),
          }, teamCardDock(t, getService))));
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

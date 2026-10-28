// @local/dsh-team-ui — Client half：设置 → 插件 的 dsh-team 仪表盘。
// 零外部 import（只 require('react')）；样式只用 --dsw-alias-* 主题 token；
// 数据来自 Host 同源代理 /dsh-team-api/**（浏览器拿不到 sidecar token）。
window.__ModuleLoader__.load({
  id: '@local/dsh-team-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const NS = 'dsh-team';
    const API = '/dsh-team-api';

    const DICT = {
      zh: {
        title: 'dsh-team 编排控制台',
        subtitle: '成员、DAG、事件流、权限与越界审批（数据来自本地 sidecar，经 Host 代理）',
        side_nav: '编排',
        close_panel: '关闭面板',
        loading_label: '加载中',
        team: '团队',
        refresh: '刷新',
        retry: '重试',
        loading: '加载中…',
        no_teams: '还没有团队。让 Agent 调用 team_create 建队，或在终端里用 dsh-team CLI / REST 建队。',
        tab_members: '成员',
        tab_dag: 'DAG',
        tab_timeline: '时间线',
        tab_matrix: '权限',
        tab_approvals: '审批',
        status: '状态',
        step: '步骤',
        seq: 'seq',
        next: '下一步',
        last: '最后动作',
        blockers: '阻塞',
        no_blockers: '无阻塞',
        lease: '租约',
        none: '—',
        ready: '就绪',
        critical_path: '关键路径',
        depends: '依赖',
        attempts: '尝试',
        filter_member: '成员过滤',
        all: '全部',
        time: '时间',
        phase: '阶段',
        action: '动作',
        target: '目标',
        result: '结果',
        approve: '批准',
        deny: '驳回',
        reason: '决策理由（落盘 decision）',
        ttl: 'grant TTL（秒）',
        no_pending: '没有待审批的越界申请。',
        member: '成员',
        domain: '域',
        matrix_empty: '暂无权限数据。',
        allow: 'allow',
        deny_effect: 'deny',
        default_effect: 'default',
        error: '请求失败',
        just_now: '刚刚',
        no_events: '还没有事件。',
        confirm_approve: '确认批准这条越界申请？决策会事务落盘并生成单次 grant。',
        confirm_deny: '确认驳回这条越界申请？',
        updated: '更新于',
        missing_team: '该团队没有成员。',
      },
      en: {
        title: 'dsh-team console',
        subtitle: 'Members, DAG, event stream, permissions and scope approvals (local sidecar via Host proxy)',
        side_nav: 'Team',
        close_panel: 'Close panel',
        loading_label: 'Loading',
        team: 'Team',
        refresh: 'Refresh',
        retry: 'Retry',
        loading: 'Loading…',
        no_teams: 'No teams yet. Ask the agent to call team_create, or create one with the dsh-team CLI / REST.',
        tab_members: 'Members',
        tab_dag: 'DAG',
        tab_timeline: 'Timeline',
        tab_matrix: 'Permissions',
        tab_approvals: 'Approvals',
        status: 'Status',
        step: 'Step',
        seq: 'seq',
        next: 'Next',
        last: 'Last',
        blockers: 'Blockers',
        no_blockers: 'None',
        lease: 'Lease',
        none: '—',
        ready: 'Ready',
        critical_path: 'Critical path',
        depends: 'deps',
        attempts: 'attempts',
        filter_member: 'Member',
        all: 'All',
        time: 'Time',
        phase: 'Phase',
        action: 'Action',
        target: 'Target',
        result: 'Result',
        approve: 'Approve',
        deny: 'Deny',
        reason: 'Decision reason (persisted)',
        ttl: 'Grant TTL (s)',
        no_pending: 'No pending scope requests.',
        member: 'Member',
        domain: 'Domain',
        matrix_empty: 'No permission data.',
        allow: 'allow',
        deny_effect: 'deny',
        default_effect: 'default',
        error: 'Request failed',
        just_now: 'just now',
        no_events: 'No events yet.',
        confirm_approve: 'Approve this scope request? The decision is persisted and a single-use grant is created.',
        confirm_deny: 'Deny this scope request?',
        updated: 'updated',
        missing_team: 'This team has no members.',
      },
    };

    const CSS = `
.dsht-root { display:flex; flex-direction:column; gap:14px; height:100%; min-height:0; padding:16px 18px 24px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dsht-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.dsht-head h2 { margin:0 0 4px; font-size:16px; font-weight:600; }
.dsht-sub { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsht-controls { display:flex; align-items:center; gap:8px; flex:none; }
.dsht-select, .dsht-input { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:5px 8px; font-size:12px; outline:none; }
.dsht-btn { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; }
.dsht-btn:hover { border-color:var(--dsw-alias-border-l2); }
.dsht-btn[disabled] { opacity:.5; cursor:default; }
.dsht-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.dsht-btn-danger { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsht-conn { display:inline-flex; align-items:center; gap:6px; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; }
.dsht-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
.dsht-dot.live { background:var(--dsw-alias-state-success-primary); }
.dsht-dot.err { background:var(--dsw-alias-state-error-primary); }
.dsht-err { border:1px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); border-radius:8px; padding:8px 10px; display:flex; gap:10px; align-items:center; }
.dsht-empty { color:var(--dsw-alias-label-secondary); border:1px dashed var(--dsw-alias-border-l1); border-radius:8px; padding:18px; text-align:center; }
.dsht-summary { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dsht-chip { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:999px; padding:2px 9px; font-size:11.5px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dsht-chip b { color:var(--dsw-alias-label-primary); font-weight:600; }
.dsht-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsht-tab { background:none; border:none; border-bottom:2px solid transparent; color:var(--dsw-alias-label-secondary); padding:7px 12px; font-size:12.5px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
.dsht-tab[aria-selected="true"] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-brand-primary); font-weight:600; }
.dsht-badge { background:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-bg-base); border-radius:999px; font-size:10.5px; padding:0 6px; min-width:16px; text-align:center; }
.dsht-body { flex:1; min-height:0; overflow:auto; }
.dsht-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:10px; }
.dsht-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:9px; padding:10px 12px; display:flex; flex-direction:column; gap:6px; min-width:0; }
.dsht-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dsht-name { font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-role { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsht-pill { border-radius:999px; padding:1px 8px; font-size:10.5px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dsht-pill.running { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dsht-pill.blocked { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dsht-pill.idle { color:var(--dsw-alias-state-idle-primary); }
.dsht-pill.done { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.dsht-pill.failed, .dsht-pill.interrupted { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsht-kv { display:grid; grid-template-columns:64px 1fr; gap:2px 8px; font-size:11.5px; }
.dsht-k { color:var(--dsw-alias-label-secondary); }
.dsht-v { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-bar { height:4px; border-radius:2px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.dsht-bar i { display:block; height:100%; background:var(--dsw-alias-brand-primary); }
.dsht-blockers { display:flex; flex-wrap:wrap; gap:4px; }
.dsht-blk { font-size:10.5px; border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); border-radius:4px; padding:0 5px; }
.dsht-ok { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.dsht-dag { display:flex; gap:18px; align-items:flex-start; padding:6px 2px; }
.dsht-col { display:flex; flex-direction:column; gap:8px; min-width:190px; }
.dsht-col-title { font-size:10.5px; color:var(--dsw-alias-label-secondary); text-transform:uppercase; letter-spacing:.06em; }
.dsht-node { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:4px; }
.dsht-node.running { border-color:var(--dsw-alias-brand-primary); }
.dsht-node.blocked, .dsht-node.pending { border-style:dashed; }
.dsht-node.done { border-color:var(--dsw-alias-state-success-primary); }
.dsht-node.failed { border-color:var(--dsw-alias-state-error-primary); }
.dsht-node-key { font-size:10px; color:var(--dsw-alias-label-secondary); font-family:ui-monospace,monospace; }
.dsht-node-sub { font-size:12px; font-weight:600; }
.dsht-node-meta { font-size:11px; color:var(--dsw-alias-label-secondary); display:flex; gap:6px; flex-wrap:wrap; }
.dsht-table { width:100%; border-collapse:collapse; font-size:11.5px; }
.dsht-table th { text-align:left; font-weight:600; color:var(--dsw-alias-label-secondary); border-bottom:1px solid var(--dsw-alias-border-l1); padding:5px 8px; white-space:nowrap; }
.dsht-table td { border-bottom:1px solid var(--dsw-alias-border-l1); padding:4px 8px; vertical-align:top; }
.dsht-mono { font-family:ui-monospace,monospace; font-size:10.5px; }
.dsht-ellipsis { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-approvals { display:flex; flex-direction:column; gap:10px; }
.dsht-approval { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:9px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.dsht-approval-top { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dsht-domain { font-size:11px; font-weight:600; color:var(--dsw-alias-brand-primary); text-transform:uppercase; }
.dsht-target { font-family:ui-monospace,monospace; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; }
.dsht-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dsht-actions .dsht-input { flex:1; min-width:140px; }
.dsht-mini { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.dsht-side-btn { display:flex; align-items:center; gap:8px; width:100%; background:none; border:none; color:var(--dsw-alias-label-secondary); padding:6px 8px; border-radius:6px; font-size:12px; cursor:pointer; text-align:left; }
.dsht-side-btn:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dsht-side-btn[aria-pressed="true"] { color:var(--dsw-alias-brand-primary); }
.dsht-side-icon { flex:none; width:16px; height:16px; display:inline-flex; }
.dsht-side-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-overlay-root { position:fixed; inset:0; z-index:60; pointer-events:none; }
.dsht-drawer { position:absolute; top:0; right:0; bottom:0; width:min(780px, 94vw); pointer-events:auto; display:flex; flex-direction:column; min-height:0; background:var(--dsw-alias-bg-layer-1); border-left:1px solid var(--dsw-alias-border-l2); box-shadow:-12px 0 32px rgba(0,0,0,.28); }
.dsht-drawer-head { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsht-drawer-title { font-size:13px; font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsht-drawer-body { flex:1; min-height:0; display:flex; overflow:hidden; }
.dsht-drawer-body > * { flex:1; min-width:0; }
`;

    const api = async (path, init) => {
      const res = await fetch(API + path, init);
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) {
        const msg = (body && body.error && body.error.message) || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return body;
    };

    const pillClass = (s) => 'dsht-pill ' + String(s || '');
    const fmtClock = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } };
    const fmtAgo = (iso) => {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return '';
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 5) return 'just now';
      if (s < 60) return s + 's';
      if (s < 3600) return Math.round(s / 60) + 'm';
      return Math.round(s / 3600) + 'h';
    };
    const leaseText = (ms) => {
      if (!ms) return null;
      const left = Math.round((ms - Date.now()) / 1000);
      return left >= 0 ? left + 's' : '−' + Math.abs(left) + 's';
    };

    function dagLevels(nodes) {
      const byId = new Map(nodes.map((n) => [n.taskId, n]));
      const memo = new Map();
      const depth = (id, seen) => {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return 0;
        const n = byId.get(id);
        if (!n) return 0;
        seen.add(id);
        let d = 0;
        for (const p of n.dependsOn || []) d = Math.max(d, depth(p, seen) + 1);
        seen.delete(id);
        memo.set(id, d);
        return d;
      };
      const levels = [];
      for (const n of nodes) {
        const d = depth(n.taskId, new Set());
        if (!levels[d]) levels[d] = [];
        levels[d].push(n);
      }
      return levels;
    }

    function MemberCard({ m, t }) {
      const lease = leaseText(m.leaseUntil);
      return h('article', { className: 'dsht-card' },
        h('div', { className: 'dsht-card-head' },
          h('span', { className: 'dsht-name', title: m.name }, m.name),
          h('span', { className: pillClass(m.status) }, m.status)),
        h('div', { className: 'dsht-role' }, [m.role, m.model].filter(Boolean).join(' · ')),
        h('div', { className: 'dsht-kv' },
          h('span', { className: 'dsht-k' }, t('step')), h('span', { className: 'dsht-v' }, m.step || t('none')),
          h('span', { className: 'dsht-k' }, t('seq')), h('span', { className: 'dsht-v' }, String(m.seq)),
          h('span', { className: 'dsht-k' }, t('next')), h('span', { className: 'dsht-v', title: m.next || '' }, m.next || t('none')),
          h('span', { className: 'dsht-k' }, t('last')), h('span', { className: 'dsht-v', title: m.last || '' }, m.last || t('none'))),
        typeof m.pct === 'number' ? h('div', { className: 'dsht-bar' }, h('i', { style: { width: Math.round(m.pct * 100) + '%' } })) : null,
        h('div', { className: 'dsht-blockers' },
          (m.blockers || []).length
            ? m.blockers.map((b, i) => h('span', { key: i, className: 'dsht-blk', title: b.detail || '' }, b.kind + (b.id ? ':' + b.id : '')))
            : h('span', { className: 'dsht-ok' }, t('no_blockers'))),
        h('div', { className: 'dsht-mini' },
          lease ? t('lease') + ' ' + lease : '',
          m.stale ? ' · STALE' : '',
          m.asOf ? ' · ' + fmtAgo(m.asOf) : ''));
    }

    function MembersView({ status, t }) {
      const members = (status && status.members) || [];
      if (!members.length) return h('div', { className: 'dsht-empty' }, t('missing_team'));
      return h('div', { className: 'dsht-grid' }, members.map((m) => h(MemberCard, { key: m.id || m.name, m, t })));
    }

    function DagView({ dag, t }) {
      if (!dag || !dag.nodes || !dag.nodes.length) return h('div', { className: 'dsht-empty' }, t('no_events'));
      const levels = dagLevels(dag.nodes);
      const columns = levels.map((col, i) => {
        const nodes = col.map((n) => {
          const meta = h('div', { className: 'dsht-node-meta' },
            h('span', { className: pillClass(n.status) }, n.status),
            n.assignee ? h('span', { className: 'dsht-mini' }, n.assignee) : null,
            n.attempts > 1 ? h('span', { className: 'dsht-mini' }, t('attempts') + ' ' + n.attempts) : null);
          const deps = (n.dependsOn || []).length
            ? h('div', { className: 'dsht-mini', title: n.dependsOn.join(', ') }, '↑ ' + n.dependsOn.join(', '))
            : null;
          return h('div', { key: n.taskId, className: 'dsht-node ' + n.status },
            h('div', { className: 'dsht-node-key' }, n.taskId),
            h('div', { className: 'dsht-node-sub', title: n.subject }, n.subject),
            meta,
            deps);
        });
        return h('div', { className: 'dsht-col', key: i },
          h('div', { className: 'dsht-col-title' }, 'L' + i),
          nodes);
      });
      const summary = h('div', { className: 'dsht-summary', style: { marginTop: '10px' } },
        h('span', { className: 'dsht-chip' }, t('ready') + ' ', h('b', null, String((dag.ready || []).length))),
        h('span', { className: 'dsht-chip' }, t('critical_path') + ' ', h('b', null, String((dag.criticalPath || []).length))));
      const path = h('div', { className: 'dsht-mini', style: { marginTop: '6px' } }, (dag.criticalPath || []).join(' → ') || t('none'));
      return h('div', null, h('div', { className: 'dsht-dag' }, columns), summary, path);
    }

    function TimelineView({ events, t, memberFilter, setMemberFilter, members }) {
      const rows = useMemo(() => {
        const list = events.slice().reverse().filter((e) => !memberFilter || e.memberId === memberFilter);
        return list.slice(0, 200);
      }, [events, memberFilter]);
      return h('div', null,
        h('div', { className: 'dsht-summary', style: { marginBottom: '8px' } },
          h('label', { className: 'dsht-mini' }, t('filter_member')),
          h('select', { className: 'dsht-select', value: memberFilter || '', onChange: (e) => setMemberFilter(e.target.value) },
            h('option', { value: '' }, t('all')),
            members.map((m) => h('option', { key: m.id, value: m.id }, m.name)))),
        rows.length
          ? h('table', { className: 'dsht-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('time')), h('th', null, t('member')), h('th', null, t('phase')),
              h('th', null, t('action')), h('th', null, t('target')), h('th', null, t('result')), h('th', null, t('next')))),
            h('tbody', null, rows.map((e) => h('tr', { key: e.id },
              h('td', { className: 'dsht-mono' }, fmtClock(e.ts)),
              h('td', null, e.memberId || ''),
              h('td', null, e.phase),
              h('td', null, e.action),
              h('td', { className: 'dsht-mono dsht-ellipsis', title: e.target || '' }, e.target || t('none')),
              h('td', { className: String(e.result || '').startsWith('FAIL') ? 'dsht-blk' : '' }, e.result || ''),
              h('td', { className: 'dsht-ellipsis', title: e.next || '' }, e.next || '')))))
          : h('div', { className: 'dsht-empty' }, t('no_events')));
    }

    function MatrixView({ matrix, t }) {
      if (!matrix || !matrix.length) return h('div', { className: 'dsht-empty' }, t('matrix_empty'));
      const CELLS = [
        ['fs', 'read'], ['fs', 'write'], ['exec', 'spawn'], ['net', 'connect'], ['env', 'read'],
      ];
      const find = (item, domain, op) => {
        const list = (item.matrix && item.matrix[domain]) || [];
        return list.find((p) => p.op === op) || null;
      };
      return h('table', { className: 'dsht-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('member')),
          h('th', null, 'role'),
          CELLS.map(([d, o]) => h('th', { key: d + o }, d + '.' + o)))),
        h('tbody', null, matrix.map((item) => h('tr', { key: item.memberId },
          h('td', null, item.name || item.memberId),
          h('td', { className: 'dsht-mini' }, item.role || t('none')),
          CELLS.map(([d, o]) => {
            const p = find(item, d, o);
            const effect = p ? p.effect : 'default';
            const cls = effect === 'allow' || effect === 'grant' ? 'dsht-pill done' : effect === 'deny' ? 'dsht-pill failed' : 'dsht-pill';
            return h('td', { key: d + o }, h('span', { className: cls, title: (p && p.rule) || '' }, effect));
          })))));
    }

    function ApprovalsView({ pending, t, onDecide, busy }) {
      if (!pending.length) return h('div', { className: 'dsht-empty' }, t('no_pending'));
      return h('div', { className: 'dsht-approvals' }, pending.map((r) => h(ApprovalCard, { key: r.id, r, t, onDecide, busy })));
    }

    function ApprovalCard({ r, t, onDecide, busy }) {
      const [reason, setReason] = useState('');
      const [ttl, setTtl] = useState('60');
      return h('article', { className: 'dsht-approval' },
        h('div', { className: 'dsht-approval-top' },
          h('span', { className: 'dsht-domain' }, r.domain),
          h('span', { className: 'dsht-target', title: r.target }, r.target),
          h('span', { className: 'dsht-pill' }, r.memberId || ''),
          r.blockedStep ? h('span', { className: 'dsht-mini' }, 'blocked@' + r.blockedStep) : null,
          h('span', { className: 'dsht-mini' }, r.createdAt ? fmtAgo(r.createdAt) : '')),
        h('div', { className: 'dsht-kv' },
          h('span', { className: 'dsht-k' }, 'reason'), h('span', { className: 'dsht-v', title: r.reason || '' }, r.reason || t('none')),
          h('span', { className: 'dsht-k' }, 'requestId'), h('span', { className: 'dsht-v dsht-mono' }, r.id)),
        h('div', { className: 'dsht-actions' },
          h('input', { className: 'dsht-input', placeholder: t('reason'), value: reason, onChange: (e) => setReason(e.target.value) }),
          h('input', { className: 'dsht-input', style: { flex: '0 0 110px', minWidth: '90px' }, type: 'number', min: '1', title: t('ttl'), value: ttl, onChange: (e) => setTtl(e.target.value) }),
          h('button', {
            className: 'dsht-btn dsht-btn-danger', disabled: busy,
            onClick: () => { if (window.confirm(t('confirm_deny'))) onDecide(r.id, 'denied', reason, ttl); },
          }, t('deny')),
          h('button', {
            className: 'dsht-btn dsht-btn-primary', disabled: busy,
            onClick: () => { if (window.confirm(t('confirm_approve'))) onDecide(r.id, 'approved', reason, ttl); },
          }, t('approve'))));
    }

    function Panel({ t }) {
      const [teams, setTeams] = useState([]);
      const [teamId, setTeamId] = useState('');
      const [tab, setTab] = useState('members');
      const [status, setStatus] = useState(null);
      const [dag, setDag] = useState(null);
      const [pending, setPending] = useState([]);
      const [events, setEvents] = useState([]);
      const [matrix, setMatrix] = useState([]);
      const [error, setError] = useState('');
      const [live, setLive] = useState(false);
      const [busy, setBusy] = useState(false);
      const [memberFilter, setMemberFilter] = useState('');
      const alive = useRef(true);

      useEffect(() => () => { alive.current = false; }, []);

      const loadTeams = useCallback(async () => {
        try {
          const res = await api('/teams');
          if (!alive.current) return;
          const items = (res && res.items) || [];
          setTeams(items);
          setTeamId((prev) => (prev && items.some((x) => x.id === prev) ? prev : (items[0] ? items[0].id : '')));
          setError('');
        } catch (e) {
          if (alive.current) { setError(e.message); setLive(false); }
        }
      }, []);

      useEffect(() => {
        loadTeams();
        const iv = setInterval(loadTeams, 15000);
        return () => clearInterval(iv);
      }, [loadTeams]);

      const refresh = useCallback(async () => {
        if (!teamId) return;
        try {
          const [st, dg, pd, hist, mx] = await Promise.all([
            api('/status?team=' + encodeURIComponent(teamId)),
            api('/dag?team=' + encodeURIComponent(teamId)),
            api('/scope-requests?team=' + encodeURIComponent(teamId) + '&status=pending'),
            api('/events/history?team=' + encodeURIComponent(teamId) + '&limit=200'),
            api('/permission-matrix?team=' + encodeURIComponent(teamId)),
          ]);
          if (!alive.current) return;
          setStatus(st); setDag(dg); setPending((pd && pd.items) || []);
          setEvents((hist && hist.items) || []); setMatrix((mx && mx.items) || []);
          setError(''); setLive(true);
        } catch (e) {
          if (alive.current) { setError(e.message); setLive(false); }
        }
      }, [teamId]);

      useEffect(() => {
        if (!teamId) return;
        refresh();
        const iv = setInterval(refresh, 2000);
        return () => clearInterval(iv);
      }, [teamId, refresh]);

      const onDecide = useCallback(async (requestId, decision, reason, ttl) => {
        setBusy(true);
        try {
          await api('/scope-requests/' + encodeURIComponent(requestId) + '/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              decision,
              decidedBy: 'panel',
              ...(reason ? { reason } : {}),
              ttlSeconds: Math.max(1, Number(ttl) || 60),
              singleUse: true,
            }),
          });
          await refresh();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, [refresh]);

      const members = (status && status.members) || [];
      const counts = useMemo(() => {
        const c = {};
        for (const m of members) c[m.status] = (c[m.status] || 0) + 1;
        return c;
      }, [members]);
      const tabs = [
        ['members', t('tab_members'), members.length],
        ['dag', t('tab_dag'), ((dag && dag.nodes) || []).length],
        ['timeline', t('tab_timeline'), events.length],
        ['matrix', t('tab_matrix'), matrix.length],
        ['approvals', t('tab_approvals'), pending.length],
      ];

      return h('div', { className: 'dsht-root' },
        h('style', null, CSS),
        h('header', { className: 'dsht-head' },
          h('div', null,
            h('h2', null, t('title')),
            h('p', { className: 'dsht-sub' }, t('subtitle'))),
          h('div', { className: 'dsht-controls' },
            h('span', { className: 'dsht-conn' },
              h('i', { className: 'dsht-dot ' + (live ? 'live' : (error ? 'err' : '')) }),
              live ? 'live' : (error ? 'error' : '…')),
            h('label', { className: 'dsht-mini' }, t('team')),
            h('select', {
              className: 'dsht-select', value: teamId,
              onChange: (e) => { setTeamId(e.target.value); setMemberFilter(''); },
            }, teams.map((x) => h('option', { key: x.id, value: x.id }, x.name))),
            h('button', { className: 'dsht-btn', onClick: () => { loadTeams(); refresh(); } }, t('refresh')))),
        error ? h('div', { className: 'dsht-err' },
          h('span', null, t('error') + '：' + error),
          h('button', { className: 'dsht-btn', onClick: () => { loadTeams(); refresh(); } }, t('retry'))) : null,
        !teams.length && !error ? h('div', { className: 'dsht-empty' }, t('no_teams')) : null,
        teams.length ? h('div', null,
          h('div', { className: 'dsht-summary' },
            h('span', { className: 'dsht-chip' }, t('status') + ' ',
              h('b', null, Object.entries(counts).map(([k, v]) => k + ':' + v).join(' ') || t('none'))),
            h('span', { className: 'dsht-chip' }, t('blockers') + ' ', h('b', null, String((status && status.staleMembers || []).length))),
            h('span', { className: 'dsht-chip' }, 'version ', h('b', null, String((status && status.version) || 0))),
            status && status.asOf ? h('span', { className: 'dsht-mini' }, t('updated') + ' ' + fmtAgo(status.asOf)) : null),
          h('nav', { className: 'dsht-tabs', role: 'tablist' }, tabs.map(([id, label, n]) =>
            h('button', {
              key: id, role: 'tab', 'aria-selected': tab === id ? 'true' : 'false',
              className: 'dsht-tab', onClick: () => setTab(id),
            }, label, n ? h('span', { className: 'dsht-badge' }, String(n)) : null))),
          h('div', { className: 'dsht-body' },
            tab === 'members' ? h(MembersView, { status, t }) : null,
            tab === 'dag' ? h(DagView, { dag, t }) : null,
            tab === 'timeline' ? h(TimelineView, { events, t, memberFilter, setMemberFilter, members }) : null,
            tab === 'matrix' ? h(MatrixView, { matrix, t }) : null,
            tab === 'approvals' ? h(ApprovalsView, { pending, t, onDecide, busy }) : null)) : null);
    }

    // ---------- 侧边栏入口 + 浮层抽屉（两个 Slot 共享开关状态） ----------
    function createStore(init) {
      let value = init;
      const subs = new Set();
      return {
        get: () => value,
        set: (next) => { value = next; for (const fn of [...subs]) { try { fn(); } catch { /* ignore */ } } },
        subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
      };
    }
    function useStore(store) {
      const [value, setValue] = useState(store.get);
      useEffect(() => store.subscribe(() => setValue(store.get())), [store]);
      return value;
    }

    function TeamIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: 'var(--dsw-alias-bg-layer-2)' }),
        h('rect', { x: 12, y: 14, width: 18, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
        h('rect', { x: 34, y: 14, width: 18, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
        h('rect', { x: 12, y: 36, width: 40, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }));
    }

    function SidebarEntry({ t, store, wide }) {
      const state = useStore(store);
      return h('button', {
        className: 'dsht-side-btn',
        type: 'button',
        title: t('title'),
        'aria-pressed': state.open ? 'true' : 'false',
        'aria-label': t('side_nav'),
        onClick: () => store.set({ open: !store.get().open }),
      },
        h('span', { className: 'dsht-side-icon' }, h(TeamIcon, { size: 16 })),
        wide ? h('span', { className: 'dsht-side-label' }, t('side_nav')) : null);
    }

    function TeamDrawer({ t, store }) {
      const state = useStore(store);
      useEffect(() => {
        if (!state.open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') store.set({ open: false }); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [state.open, store]);
      if (!state.open) return null;
      return h('div', { className: 'dsht-overlay-root' },
        h('aside', { className: 'dsht-drawer', role: 'dialog', 'aria-label': t('title') },
          h('div', { className: 'dsht-drawer-head' },
            h('span', { className: 'dsht-side-icon' }, h(TeamIcon, { size: 16 })),
            h('span', { className: 'dsht-drawer-title' }, t('title')),
            h('button', {
              className: 'dsht-btn', type: 'button', title: t('close_panel'), 'aria-label': t('close_panel'),
              onClick: () => store.set({ open: false }),
            }, '✕')),
          h('div', { className: 'dsht-drawer-body' }, h(Panel, { t }))));
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
        const store = createStore({ open: false });
        const Entry = (props) => h(SidebarEntry, { t, store, wide: !(props && props.wide === false) });
        const Drawer = () => h(TeamDrawer, { t, store });
        const disposers = [];
        // 入口：侧边栏底部 Settings 旁（展开态显示文字，56px 轨道态只显示图标）
        disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-team',
          order: 30,
          label: () => t('side_nav'),
        }, Entry)));
        // 面板：frame-wide 浮层里的右侧抽屉（overlay 本身穿透，抽屉自己接管 pointer events）
        disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-team-panel',
          order: 40,
          label: () => t('title'),
        }, Drawer)));
        return () => { for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } } };
      },
    };
  },
});

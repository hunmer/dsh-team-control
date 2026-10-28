#!/usr/bin/env node
// bin/dsh-team.mjs — CLI：up / down / status / dag / logs / approve / report
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'help';
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--follow') { opts.follow = true; continue; }
    if (a === '-o' || a === '--out') { opts.out = argv[++i]; continue; }
    if (a === '--deny') { opts.deny = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { opts[k] = next; i++; } else opts[k] = true;
      continue;
    }
    opts._.push(a);
  }
  return { cmd, opts };
}

const homeDir = (opts) => path.resolve(opts.data || process.env.DSH_TEAM_HOME || path.join(os.homedir(), '.dsh', 'team'));

function discover(opts) {
  const home = homeDir(opts);
  let url = opts.url || process.env.DSH_TEAM_URL || null;
  if (!url) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, 'run', 'sidecar.json'), 'utf8'));
      url = j.url;
    } catch { /* ignore */ }
  }
  let token = opts.token || process.env.DSH_TEAM_TOKEN || null;
  if (!token) {
    try { token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); } catch { /* ignore */ }
  }
  return { home, url, token };
}

async function api(opts, pathname, init = {}) {
  const { url, token } = discover(opts);
  if (!url) throw new Error('sidecar 未运行：先执行 `dsh-team up`，或用 --url 指定地址');
  const res = await fetch(url + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

function printStatus(res) {
  if (res.degraded) console.log('⚠ 存在 stale 成员（member_state 与事件流不一致）');
  console.log(`${pad('MEMBER', 18)} ${pad('STATUS', 12)} ${pad('STEP', 6)} ${pad('SEQ', 5)} ${pad('PCT', 5)} NEXT / BLOCKERS`);
  for (const m of res.members) {
    const extra = m.blockers?.length ? `BLOCKED: ${m.blockers.map((b) => b.kind + (b.id ? '#' + b.id : '')).join(',')}` : (m.next || '');
    console.log(`${pad(m.name, 18)} ${pad(m.status, 12)} ${pad(m.step ?? '-', 6)} ${pad(m.seq, 5)} ${pad(m.pct == null ? '-' : Math.round(m.pct * 100) + '%', 5)} ${extra}`);
  }
  console.log(`\nas_of=${res.asOf} version=${res.version} members=${res.members.length}`);
}

function printDag(d) {
  const byId = new Map(d.nodes.map((n) => [n.taskId, n]));
  console.log(`DAG ${d.teamId}  ready=[${d.ready.join(', ') || '-'}]`);
  for (const n of d.nodes) {
    const mark = n.status === 'done' ? '✔' : n.status === 'running' ? '▶' : n.status === 'failed' ? '✘' : n.ready ? '○' : '·';
    const deps = n.dependsOn.length ? ` <- ${n.dependsOn.join(',')}` : '';
    console.log(`${mark} ${pad(n.status, 8)} ${pad(n.subject, 34)} ${pad(n.assignee || '-', 14)}${deps}`);
    if (n.blockers?.length) for (const b of n.blockers) console.log(`    └ blocked: ${b.detail}`);
  }
  if (d.criticalPath.length) console.log(`\ncritical path: ${d.criticalPath.join(' → ')}`);
  console.log(`as_of=${d.asOf} version=${d.version}`);
}

function fmtEvent(e) {
  return `#${String(e.seq).padEnd(4)} ${e.ts} ${pad(e.phase, 9)} ${pad(e.action, 14)} ${pad(e.target ?? '-', 24)} ${pad(e.result ?? '-', 16)} ${e.next ?? ''}`;
}

async function cmdUp(opts) {
  const { startServer } = await import('../src/server.mjs');
  const home = homeDir(opts);
  const port = opts.port === undefined ? Number(process.env.DSH_TEAM_PORT || 4317) : Number(opts.port);
  const s = await startServer({ home, port: Number.isFinite(port) ? port : 4317 });
  process.stdout.write(JSON.stringify({
    event: 'ready', url: s.url, port: s.port, pid: process.pid, dataDir: home,
    token: s.token, tokenFile: path.join(home, 'token'), panel: `${s.url}/panel#token=${s.token}`,
    recovered: s.core.recovered,
  }) + '\n');
  const stop = async (sig) => { try { await s.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

async function cmdDown(opts) {
  const { home } = discover(opts);
  const file = path.join(home, 'run', 'sidecar.json');
  let info;
  try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log('没有发现运行中的 sidecar'); return; }
  try { process.kill(info.pid); console.log(`已停止 sidecar pid=${info.pid}`); } catch (e) { console.log(`停止失败（可能已退出）：${e.code || e.message}`); }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}

const HELP = `dsh-team — Agent 编排控制平面 CLI

用法：
  dsh-team up [--port N] [--data DIR]
  dsh-team down
  dsh-team status <team> [--json]
  dsh-team dag <team> [--json]
  dsh-team logs <member> [-f] [--since N]
  dsh-team approve <request-id> [--deny] [--reason TEXT] [--ttl SEC]
  dsh-team report <team> [-o run.md]

全局：--url URL / --token TOKEN / --data DIR（默认 ~/.dsh/team 或 $DSH_TEAM_HOME）
`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'up': return cmdUp(opts);
    case 'down': return cmdDown(opts);
    case 'status': {
      const team = opts._[0];
      if (!team) throw new Error('用法：dsh-team status <team>');
      const res = await api(opts, `/api/status?team=${encodeURIComponent(team)}`);
      if (opts.json) console.log(JSON.stringify(res, null, 2)); else printStatus(res);
      return;
    }
    case 'dag': {
      const team = opts._[0];
      if (!team) throw new Error('用法：dsh-team dag <team>');
      const res = await api(opts, `/api/dag?team=${encodeURIComponent(team)}`);
      if (opts.json) console.log(JSON.stringify(res, null, 2)); else printDag(res);
      return;
    }
    case 'logs': {
      const member = opts._[0];
      if (!member) throw new Error('用法：dsh-team logs <member> [-f]');
      const since = Number(opts.since || 0);
      if (!opts.follow) {
        const res = await api(opts, `/api/steps?member=${encodeURIComponent(member)}&since=${since}`);
        for (const e of res.items) console.log(fmtEvent(e));
        return;
      }
      const { url, token } = discover(opts);
      if (!url) throw new Error('sidecar 未运行');
      const res = await fetch(`${url}/api/events?member=${encodeURIComponent(member)}&token=${encodeURIComponent(token || '')}`);
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6));
            console.log(`[${ev.type}] ${ev.memberId || ev.teamId || ''} ${ev.payload?.phase || ''} ${ev.payload?.action || ev.payload?.status || ''} ${ev.payload?.target || ''} ${ev.payload?.result || ''}`);
          } catch { /* ignore */ }
        }
      }
      return;
    }
    case 'approve': {
      const id = opts._[0];
      if (!id) throw new Error('用法：dsh-team approve <request-id> [--deny]');
      const body = {
        decision: opts.deny ? 'denied' : 'approved',
        decidedBy: 'cli',
        reason: opts.reason || (opts.deny ? 'denied by CLI' : 'approved by CLI'),
        ttlSeconds: Number(opts.ttl || 60),
        singleUse: true,
      };
      const res = await api(opts, `/api/scope-requests/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify(body) });
      console.log(`${body.decision} ${id}  grant=${res.grant?.id ?? '-'}  decision=${res.decision?.id ?? '-'}`);
      return;
    }
    case 'report': {
      const team = opts._[0];
      if (!team) throw new Error('用法：dsh-team report <team> [-o run.md]');
      const md = await api(opts, `/api/report?team=${encodeURIComponent(team)}&format=md`);
      if (opts.out) { fs.writeFileSync(opts.out, md); console.log(`报告已写入 ${opts.out}（${md.length} 字节）`); }
      else process.stdout.write(md);
      return;
    }
    default:
      process.stdout.write(HELP);
  }
}

main().catch((e) => { console.error(`dsh-team: ${e.message}`); process.exit(1); });

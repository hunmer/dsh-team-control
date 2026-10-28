// worker.mjs — 受限 Worker（C1）。单文件、除 node:module 外零 import。
// 进程启动即：① 锁死模块解析 ② 中和所有原生 IO 逃逸口 ③ 只通过 stdio NDJSON RPC 与 sidecar 通信。
// 这个文件就是「代理工具面」的客户端；它拿不到 fs/net/child_process，因此 FR-3 不可能被绕过。
import { registerHooks } from 'node:module';

// ---------- ① 模块解析白名单 ----------
// 静态 import 已在此行之前完成；此后任何 specifier（含 CJS require 路径）都必须过这里。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:module') return nextResolve(specifier, context);
    const e = new Error(`module "${specifier}" is not mounted in this worker`);
    e.code = 'ERR_ACCESS_DENIED';
    throw e;
  },
});

// ---------- ② 中和原生 IO 逃逸口 ----------
const denied = () => { const e = new Error('Access to this API has been restricted by dsh-team worker sandbox'); e.code = 'ERR_ACCESS_DENIED'; throw e; };
for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try { Object.defineProperty(globalThis, g, { value: undefined, configurable: false, writable: false }); } catch { /* ignore */ }
}
for (const p of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'report', 'kill']) {
  try { Object.defineProperty(process, p, { value: denied, configurable: false, writable: false }); } catch { /* ignore */ }
}
// console 输出必须走 stderr：stdout 是 RPC 帧通道，绝不允许被日志污染
for (const k of ['log', 'info', 'warn', 'debug', 'trace', 'dir']) {
  console[k] = (...a) => process.stderr.write(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ') + '\n');
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

// ---------- ③ RPC 传输 ----------
let seqBuf = '';
let nextId = 1;
const waiters = new Map();
let interrupted = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  seqBuf += chunk;
  let i;
  while ((i = seqBuf.indexOf('\n')) >= 0) {
    const line = seqBuf.slice(0, i);
    seqBuf = seqBuf.slice(i + 1);
    if (!line.trim()) continue;
    let fr;
    try { fr = JSON.parse(line); } catch { continue; }
    handleFrame(fr);
  }
});
process.stdin.on('end', () => process.exit(0));   // sidecar 死亡 → 管道断 → 自杀，杜绝孤儿
process.on('uncaughtException', (e) => { try { process.stderr.write(`[worker] uncaught ${e?.stack || e}\n`); } catch { /* ignore */ } });
process.on('unhandledRejection', (e) => { try { process.stderr.write(`[worker] unhandledRejection ${e?.stack || e}\n`); } catch { /* ignore */ } });

function handleFrame(fr) {
  if (fr.type === 'control') {
    if (fr.action === 'interrupt') interrupted = true;
    return;
  }
  const w = waiters.get(fr.id);
  if (!w) return;
  waiters.delete(fr.id);
  if (fr.ok) w.resolve(fr.data);
  else {
    const e = new Error(fr.error?.message || 'rpc error');
    e.code = fr.error?.code || 'E_RPC';
    e.detail = fr.error?.detail;
    w.reject(e);
  }
}

function rpc(op, args = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    process.stdout.write(safeJson({ id, op, args }) + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ④ 动作执行 ----------
function describe(step) {
  const op = step.op || {};
  switch (op.kind) {
    case 'fs.read': return `read ${op.args?.path}`;
    case 'fs.write': return `write ${op.args?.path}`;
    case 'fs.append': return `append ${op.args?.path}`;
    case 'fs.list': return `list ${op.args?.path || '.'}`;
    case 'exec': return `exec ${(op.args?.argv || []).join(' ')}`;
    case 'net': return `net ${op.args?.method || 'GET'} ${op.args?.url}`;
    case 'env': return `env ${op.args?.name}`;
    case 'scope': return `scope ${op.args?.domain}:${op.args?.target}`;
    case 'escape': return 'escape probe';
    case 'sleep': return `sleep ${op.args?.ms}ms`;
    case 'fail': return 'fail';
    default: return step.action || op.kind || 'noop';
  }
}

function summarize(v) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : safeJson(v);
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

class Interrupted extends Error { constructor() { super('interrupted'); this.code = 'E_INTERRUPTED'; } }

const versions = new Map();   // path → 最近一次读到的 version（支持 expectVersion:'auto'）

async function runOp(op, limits) {
  const a = op.args || {};
  switch (op.kind) {
    case 'fs.read': {
      const r = await rpc('fs.read', { path: a.path });
      versions.set(r.path, r.version);
      return r;
    }
    case 'fs.write': {
      const expect = a.expectVersion === 'auto' ? (versions.get(a.path) ?? 0) : a.expectVersion;
      const r = await rpc('fs.write', { path: a.path, content: a.content ?? '', expectVersion: expect });
      versions.set(r.path, r.version);
      return r;
    }
    case 'fs.append': {
      // AC-5 的原语：读 → 改 → CAS 写；冲突按退避重试，上限可配（FR-3.6 / FR-6.3）
      const maxRetries = Math.max(0, Number(a.retries ?? limits.maxRetries ?? 5));
      const base = Math.max(10, Number(limits.retryBaseMs ?? 40));
      let attempt = 0;
      for (;;) {
        const cur = await rpc('fs.read', { path: a.path });
        const marker = a.marker ?? '';
        const nextContent = (cur.content || '') + marker + (a.terminator ?? '\n');
        try {
          const w = await rpc('fs.write', { path: a.path, content: nextContent, expectVersion: cur.version });
          return { ...w, attempts: attempt + 1 };
        } catch (e) {
          if (e.code !== 'E_VERSION') throw e;
          attempt++;
          if (attempt > maxRetries) throw Object.assign(new Error(`version conflict after ${maxRetries} retries on ${a.path}`), { code: 'E_VERSION', detail: e.detail });
          await sleep(Math.floor(base * 2 ** (attempt - 1) * (0.5 + Math.random())));
        }
      }
    }
    case 'fs.list': return rpc('fs.list', { path: a.path || '.' });
    case 'exec': return rpc('exec.run', { argv: a.argv, cwd: a.cwd, timeoutMs: a.timeoutMs });
    case 'net': return rpc('net.fetch', { url: a.url, method: a.method, headers: a.headers, body: a.body });
    case 'env': return rpc('env.read', { name: a.name });
    case 'escape': {
      // AC-3/C1 证据：真实尝试原生直连 IO，必须全部 BLOCKED
      const probes = [];
      const att = async (name, fn) => {
        try { await fn(); probes.push({ name, blocked: false }); }
        catch (e) { probes.push({ name, blocked: true, code: e.code || e.name }); }
      };
      const kinds = Array.isArray(a.attempts) ? a.attempts : ['fs', 'net', 'exec', 'builtin', 'binding', 'report', 'sqlite'];
      for (const k of kinds) {
        if (k === 'fs') await att('import node:fs', () => import('node:fs'));
        else if (k === 'net') await att('global fetch', () => globalThis.fetch('http://127.0.0.1:1'));
        else if (k === 'exec') await att('import node:child_process', () => import('node:child_process'));
        else if (k === 'builtin') await att('process.getBuiltinModule', () => process.getBuiltinModule('node:fs'));
        else if (k === 'binding') await att('process.binding', () => process.binding('fs'));
        else if (k === 'report') await att('process.report.writeReport', () => process.report.writeReport());
        else if (k === 'sqlite') await att('import node:sqlite', () => import('node:sqlite'));
        else probes.push({ name: k, blocked: true, code: 'UNKNOWN_PROBE' });
      }
      return { probes, allBlocked: probes.every((p) => p.blocked) };
    }
    case 'sleep': {
      const total = Math.max(0, Number(a.ms) || 0);
      const t0 = Date.now();
      while (Date.now() - t0 < total) {
        if (interrupted) throw new Interrupted();
        await sleep(Math.min(100, total - (Date.now() - t0)));
      }
      return { sleptMs: Date.now() - t0 };
    }
    case 'scope': {
      const r = await rpc('scope.request', {
        domain: a.domain, target: a.target, reason: a.reason,
        diffSize: a.diffSize, risk: a.risk, blockedStep: a.blockedStep, fallback: a.fallback,
        timeoutMs: a.timeoutMs,
      });
      if (r.status === 'approved' && a.then) return { scope: r, retried: await runOp(a.then, limits) };
      if (r.status === 'approved') return { scope: r };
      const e = new Error(`scope ${a.domain}:${a.target} ${r.status}`); e.code = 'E_DENIED'; e.detail = { ...r, scopeStatus: r.status }; throw e;
    }
    case 'fail': {
      const e = new Error(a.message || 'scripted failure'); e.code = 'E_SCRIPTED'; e.retryable = a.retryable !== false; throw e;
    }
    case 'noop': default: return { noop: true };
  }
}

// ---------- ⑤ 主流程 ----------
function phaseOf(step) { return step.phase || (step.op?.kind || 'worker').split('.')[0]; }

async function main() {
  const boot = await rpc('bootstrap', {});
  const { task, resumeFrom, limits, env } = boot;
  const plan = Array.isArray(task.plan) ? task.plan : [];
  const total = plan.length;
  const start = Math.max(0, Math.min(total, Number(resumeFrom) || 0));

  process.stderr.write(`[worker] ${env?.member || ''} task=${task.id} plan=${total} start=${start}\n`);

  if (start > 0) {
    await rpc('event.append', {
      phase: 'resume', action: 'resume', target: `S${start}`,
      result: 'OK', next: total > start ? describe(plan[start]) : 'done',
      meta: { stepIndex: start - 1, step: `S${start}`, stepTotal: total, resumeFrom: start },
    });
  }

  for (let i = start; i < total; i++) {
    if (interrupted) throw new Interrupted();
    const step = plan[i] || {};
    const label = step.step || `S${i + 1}`;
    const begin = await rpc('step.begin', { index: i, step: label });
    if (begin?.interrupted) throw new Interrupted();

    // 消息在 step 边界注入（FR-4.2：≤1 step 送达），并回写事件 + 回执
    for (const m of begin?.pending || []) {
      await rpc('event.append', {
        phase: 'msg', action: 'receive', target: m.id, result: 'OK',
        next: `${phaseOf(step)}`, meta: { stepIndex: i - 1, step: label, stepTotal: total, messageId: m.id, correlationId: m.correlationId || null },
      });
      await rpc('msg.ack', { id: m.id, state: 'acked' });
    }

    const nextDesc = i + 1 < total ? describe(plan[i + 1]) : 'task done';
    await rpc('event.append', {
      phase: phaseOf(step), action: step.action || (step.op?.kind || 'noop'), target: step.target ?? null,
      result: 'RUNNING', next: nextDesc,
      meta: { stepIndex: i, step: label, stepTotal: total, op: step.op?.kind ?? null },
    });

    let out; let err = null;
    try {
      out = await runOp(step.op || { kind: 'noop' }, limits);
    } catch (e) {
      if (e instanceof Interrupted || e.code === 'E_INTERRUPTED') throw new Interrupted();
      err = e;
      // FR-3.4：被拒时按声明自动升级为越界申请；批准后原操作重试一次（单次授权）
      if (e.code === 'E_DENIED' && step.onDenied === 'scope') {
        try {
          const sc = await rpc('scope.request', {
            domain: step.domain || (step.op?.kind || '').split('.')[0] || 'fs',
            target: step.scopeTarget ?? step.op?.args?.path ?? step.target,
            reason: step.scopeReason || `step ${label} needs ${step.action || step.op?.kind}`,
            diffSize: step.diffSize ?? null, risk: step.risk ?? null,
            blockedStep: label, fallback: step.fallback ?? null,
            timeoutMs: step.scopeTimeoutMs,
          });
          if (sc.status === 'approved') { out = await runOp(step.op || { kind: 'noop' }, limits); err = null; }
          else err = Object.assign(new Error(`scope ${sc.status}`), { code: 'E_DENIED', detail: { ...sc, scopeStatus: sc.status } });
        } catch (e2) {
          if (e2 instanceof Interrupted || e2.code === 'E_INTERRUPTED') throw new Interrupted();
          err = e2;
        }
      }
    }

    if (err) {
      await rpc('event.append', {
        phase: phaseOf(step), action: step.action || (step.op?.kind || 'noop'), target: step.target ?? null,
        result: `FAIL:${err.code || 'ERROR'}`, next: `handle failure: ${String(err.message).slice(0, 120)}`,
        meta: { stepIndex: i, step: label, stepTotal: total, error: summarize(err.message), detail: err.detail ?? null },
      });
      if (err.code === 'E_TIMEOUT' || err.code === 'E_DENIED' || err.code === 'E_SCRIPTED') throw err;
      // 非致命（如 net 失败）继续下一步，除非 step.fatal
      if (step.fatal) throw err;
    } else {
      await rpc('event.append', {
        phase: phaseOf(step), action: step.action || (step.op?.kind || 'noop'), target: step.target ?? null,
        result: 'OK', next: nextDesc,
        meta: { stepIndex: i, step: label, stepTotal: total, resultSummary: summarize(out) },
      });
      // C1 证据：越界探针的完整结果单独落一条事件，供审计/测试取证
      if (out && Array.isArray(out.probes)) {
        await rpc('event.append', {
          phase: 'verify', action: 'escape.probes',
          target: `${out.probes.filter((p) => p.blocked).length}/${out.probes.length} blocked`,
          result: out.allBlocked ? 'OK' : 'FAIL:escape',
          next: null,
          meta: { stepIndex: i, step: label, stepTotal: total, probes: out.probes },
        });
      }
    }
  }

  if (interrupted) throw new Interrupted();
  await rpc('task.done', { result: { steps: total } });
  return 0;
}

const hb = setInterval(() => {
  rpc('ping', {}).catch(() => { /* sidecar 已消失，stdin end 会接管 */ });
}, 5000);
hb.unref?.();

main()
  .then((code) => { clearInterval(hb); process.exit(code || 0); })
  .catch(async (e) => {
    clearInterval(hb);
    if (e instanceof Interrupted || e.code === 'E_INTERRUPTED') { process.exit(0); }
    try {
      await rpc('event.append', {
        phase: 'fail', action: 'fail', target: 'worker', result: `FAIL:${e.code || 'ERROR'}`,
        next: 'report failure', meta: { stepIndex: -1, error: summarize(e.message) },
      });
      await rpc('task.fail', {
        error: summarize(e.message),
        // 权限拒绝不自动重试：重试同样会被拒，应由人决定后 resume；其余错误按策略重试
        retryable: e.retryable !== false && e.code !== 'E_DENIED',
      });
    } catch { /* ignore */ }
    process.exit(1);
  });

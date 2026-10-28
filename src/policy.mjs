// policy.mjs — C3 纯求值器：默认拒绝 / deny 优先 / 多规则取最严
// 纯函数，无 IO。所有权限判定都必须走这里，调用方不得自行短路。
import { matchGlob, toPosix } from './util.mjs';

export const DOMAINS = ['fs', 'exec', 'net', 'env'];
export const OPS_BY_DOMAIN = {
  fs: ['read', 'write', 'delete', 'rename', 'list'],
  exec: ['spawn'],
  net: ['connect'],
  env: ['read', 'write'],
};
export const DEFAULT_OP = { fs: 'read', exec: 'spawn', net: 'connect', env: 'read' };

/** target 归一化：fs→rel path，exec→argv，net→"host:port"，env→var name */
export function normalizeTarget(domain, target) {
  if (domain === 'fs') return toPosix(String(target || '')).replace(/^\.\//, '');
  if (domain === 'net') return String(target || '').toLowerCase();
  if (domain === 'exec') return Array.isArray(target) ? target.map(String) : [String(target || '')];
  return String(target || '');
}

// ---------- 各域 matcher 语义 ----------
function matchFs(matcher, target) { return matchGlob(matcher, target); }

function matchExec(matcher, argv) {
  const m = String(matcher || '').trim();
  if (!m) return false;
  const cmd = argv[0] || '';
  const joined = argv.join(' ');
  if (/[*?]/.test(m)) return matchGlob(m, cmd) || matchGlob(m, joined);
  if (m.includes(' ')) return joined === m || joined.startsWith(m + ' ');
  // 命令名：允许绝对路径 exe 的 basename 命中
  return cmd === m || cmd.endsWith('/' + m) || cmd.endsWith('\\' + m);
}

function splitHostPort(s) {
  const str = String(s || '');
  const i = str.lastIndexOf(':');
  if (i <= 0) return [str, null];
  const port = str.slice(i + 1);
  if (!/^\d+$/.test(port)) return [str, null];
  return [str.slice(0, i), port];
}

function matchHost(mh, host) {
  if (!mh) return false;
  if (mh === '*' || mh === host) return true;
  if (mh.startsWith('*.')) return host === mh.slice(2) || host.endsWith(mh.slice(1));
  return matchGlob(mh, host);
}

function matchNet(matcher, target) {
  const [host, port] = splitHostPort(target);
  const [mh, mp] = splitHostPort(String(matcher || ''));
  const hostOk = matchHost(mh, host);
  if (mp == null) return hostOk;
  return hostOk && (mp === port || mp === '*');
}

function matchEnv(matcher, name) { return matchGlob(matcher, name); }

export function matchTarget(domain, matcher, target) {
  switch (domain) {
    case 'fs': return matchFs(matcher, target);
    case 'exec': return matchExec(matcher, Array.isArray(target) ? target : [target]);
    case 'net': return matchNet(matcher, target);
    case 'env': return matchEnv(matcher, target);
    default: return false;
  }
}

/** 主体过滤：rule 只对特定 member/role/task/team 生效（FR-3.1） */
export function subjectMatches(rule, subject) {
  const st = rule.subjectType || rule.subject_type;
  const sid = rule.subjectId || rule.subject_id;
  switch (st) {
    case 'team': return !subject.teamId || sid === subject.teamId;
    case 'member': return sid === subject.memberId;
    case 'role': return !!subject.role && sid === subject.role;
    case 'task': return !!subject.taskId && sid === subject.taskId;
    default: return false;
  }
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 最严合并：多个 allow 同时命中时取交集/最小值（C3） */
export function mergeConstraints(list) {
  const out = { maxRuntimeMs: null, methods: null, argvAllow: null, readOnly: false, sensitive: false };
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (Number.isFinite(Number(c.maxRuntimeMs))) {
      out.maxRuntimeMs = out.maxRuntimeMs == null ? Number(c.maxRuntimeMs) : Math.min(out.maxRuntimeMs, Number(c.maxRuntimeMs));
    }
    if (Array.isArray(c.methods)) {
      const set = c.methods.map((x) => String(x).toUpperCase());
      out.methods = out.methods == null ? set : out.methods.filter((m) => set.includes(m));
    }
    if (Array.isArray(c.argvAllow)) {
      out.argvAllow = out.argvAllow == null ? [...c.argvAllow] : out.argvAllow.filter((a) => c.argvAllow.includes(a));
    }
    if (c.readOnly === true) out.readOnly = true;
    if (c.sensitive === true) out.sensitive = true;
  }
  return out;
}

export function isExpired(rule, nowMs = Date.now()) {
  const exp = rule.expiresAt ?? rule.expires_at;
  return exp != null && Number(exp) <= nowMs;
}

/**
 * 核心求值。顺序固定：显式 deny > 有效 grant > 显式 allow > 默认拒绝。
 * @param {object[]} rules 已按 subject/domain 过滤前的全部规则（kind: policy|grant）
 * @param {{teamId,memberId,role?,taskId?,domain,op,target}} req
 * @returns {{allowed,effect:'deny'|'grant'|'allow'|'default',denyRule,allowRule,grantRule,constraints,reason}}
 */
export function evaluate(rules, req, nowMs = Date.now()) {
  const { domain, op, target, ...subject } = req;
  if (!DOMAINS.includes(domain)) {
    return { allowed: false, effect: 'default', constraints: mergeConstraints([]), reason: `unknown domain ${domain}` };
  }
  const relevant = [];
  for (const r of rules || []) {
    if ((r.domain || '') !== domain) continue;
    if (isExpired(r, nowMs)) continue;
    if (!subjectMatches(r, { ...subject, teamId: req.teamId })) continue;
    const ops = r.ops || r.ops_json || [];
    if (!Array.isArray(ops) || !ops.includes(op)) continue;
    if (!matchTarget(domain, r.matcher, target)) continue;
    // 只读授权不得放行变更类操作（最严原则）
    const ro = r.constraints?.readOnly === true;
    if (ro && domain === 'fs' && op !== 'read' && op !== 'list') continue;
    relevant.push(r);
  }

  const denyRule = relevant.find((r) => (r.mode || 'allow') === 'deny');
  if (denyRule) {
    return { allowed: false, effect: 'deny', denyRule, constraints: mergeConstraints([denyRule.constraints]), reason: `deny by ${denyRule.id}` };
  }

  const grants = relevant.filter((r) => r.kind === 'grant' && isGrantUsable(r, nowMs));
  if (grants.length) {
    const merged = mergeConstraints(grants.map((g) => g.constraints));
    return { allowed: true, effect: 'grant', grantRule: grants[0], grants, constraints: merged, reason: `grant ${grants[0].id}` };
  }

  const allows = relevant.filter((r) => r.kind !== 'grant' && (r.mode || 'allow') === 'allow');
  if (allows.length) {
    const merged = mergeConstraints(allows.map((a) => a.constraints));
    return { allowed: true, effect: 'allow', allowRule: allows[0], allows, constraints: merged, reason: `allow ${allows[0].id}` };
  }

  return { allowed: false, effect: 'default', constraints: mergeConstraints([]), reason: 'default deny' };
}

export function isGrantUsable(g, nowMs = Date.now()) {
  if (!g || g.kind !== 'grant') return false;
  if (isExpired(g, nowMs)) return false;
  const single = g.singleUse ?? g.single_use;
  if (Number(single) === 1 && (g.usedAt || g.used_at)) return false;
  return true;
}

/** 供权限矩阵展示：某成员对典型目标的判定摘要 */
export function matrixSummary(rules, subject) {
  const probe = {
    fs: [{ op: 'read', target: '**' }, { op: 'write', target: '**' }, { op: 'delete', target: '**' }],
    exec: [{ op: 'spawn', target: ['git', 'status'] }],
    net: [{ op: 'connect', target: 'api.example.com:443' }],
    env: [{ op: 'read', target: 'EXAMPLE_VAR' }],
  };
  const out = {};
  for (const d of DOMAINS) {
    out[d] = probe[d].map((p) => {
      const r = evaluate(rules, { ...subject, domain: d, op: p.op, target: p.target });
      return { op: p.op, target: Array.isArray(p.target) ? p.target.join(' ') : p.target, allowed: r.allowed, effect: r.effect, rule: r.denyRule?.id || r.grantRule?.id || r.allowRule?.id || null };
    });
  }
  return out;
}

export { num };

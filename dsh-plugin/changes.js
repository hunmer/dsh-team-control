// @local/dsh-team-plugin — 成员改动采集：把成员的 write/edit 落盘差异算成 unified diff。
//
// 只做三件事，不碰 sidecar 之外的东西：
// 1. 读改前/改后文本（读不到/超过大小上限就放弃，宁缺毋滥）；
// 2. 算 unified diff（带 3 行上下文、`@@ -a,b +c,d @@` 头、行号可直接被面板渲染）；
// 3. 统计新增/删除行数。
// 零第三方依赖：只用 Node 内置模块。
import fs from 'node:fs';
import path from 'node:path';

/** 超过这个大小不读（二进制约文件、超大日志没必要进审阅页）。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 上下文行数：与 git diff 默认一致。 */
const CONTEXT = 3;
/** 中间段 LCS 的 DP 上限（n*m 超过就退化成整段替换，避免大文件卡死 host）。 */
const LCS_CELL_LIMIT = 4_000_000;

/** 读文本；不存在 / 目录 / 太大 / 读失败都返回 null。 */
export function readTextSafe(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 归一化换行后按行切；空文本是 0 行。 */
export function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * 行级 LCS 编辑脚本：返回 [{ type: ' ' | '-' | '+', text }]。
 * 中间段过大时退化为「全删 + 全加」，diff 仍然正确，只是不精细。
 */
export function lineOps(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  // 共同前缀/后缀先剥掉，DP 只跑中间段（改动通常集中在一小段）
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops = [];
  for (let i = 0; i < head; i += 1) ops.push({ type: ' ', text: a[i] });
  const n = midA.length;
  const m = midB.length;
  if (n * m > LCS_CELL_LIMIT) {
    for (const line of midA) ops.push({ type: '-', text: line });
    for (const line of midB) ops.push({ type: '+', text: line });
  } else if (n || m) {
    // dp[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度
    const width = m + 1;
    const dp = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = midA[i] === midB[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ type: ' ', text: midA[i] }); i += 1; j += 1; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: '-', text: midA[i] }); i += 1; }
      else { ops.push({ type: '+', text: midB[j] }); j += 1; }
    }
    while (i < n) { ops.push({ type: '-', text: midA[i] }); i += 1; }
    while (j < m) { ops.push({ type: '+', text: midB[j] }); j += 1; }
  }
  for (let i = a.length - tail; i < a.length; i += 1) ops.push({ type: ' ', text: a[i] });
  return ops;
}

/**
 * 算 unified diff。`file` 只用于 `--- a/<file>` / `+++ b/<file>` 头（相对路径更好读）。
 * 没有差异时返回空串。
 */
export function unifiedDiff(file, before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lineOps(before, after);
  const hasChange = ops.some((op) => op.type !== ' ');
  if (!hasChange) return '';
  const label = String(file || 'file').replace(/\\/g, '/');
  const out = [`--- a/${label}`, `+++ b/${label}`];
  // 每个 op 在旧/新文件里的起始行号（1 基）
  let oldNo = 1;
  let newNo = 1;
  const at = ops.map((op) => {
    const here = { old: oldNo, new: newNo };
    if (op.type === ' ') { oldNo += 1; newNo += 1; }
    else if (op.type === '-') oldNo += 1;
    else newNo += 1;
    return here;
  });
  // 改动块：连续改动之间的上下文空档不超过 2*CONTEXT 就并进同一段
  const changed = [];
  for (let i = 0; i < ops.length; i += 1) if (ops[i].type !== ' ') changed.push(i);
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor];
    let last = first;
    while (cursor + 1 < changed.length && changed[cursor + 1] - last <= CONTEXT * 2 + 1) {
      cursor += 1;
      last = changed[cursor];
    }
    cursor += 1;
    const start = Math.max(0, first - CONTEXT);
    const end = Math.min(ops.length, last + CONTEXT + 1);
    const body = ops.slice(start, end);
    const oldCount = body.filter((op) => op.type !== '+').length;
    const newCount = body.filter((op) => op.type !== '-').length;
    // git 惯例：侧边计数为 0 时，起始行写「插入点前一行」
    const oldStart = oldCount === 0 ? at[start].old - 1 : at[start].old;
    const newStart = newCount === 0 ? at[start].new - 1 : at[start].new;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of body) out.push(op.type + op.text);
  }
  return out.join('\n') + '\n';
}

/** 统计 diff 里的新增/删除行数（只看 `+`/`-` 前缀行，跳过 `---`/`+++` 文件头）。 */
export function countDiff(diff) {
  let added = 0;
  let deleted = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) deleted += 1;
  }
  return { added, deleted };
}

/** 成员的写改工具名（DSH 内置工具）。 */
export const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'multi_edit']);

/** 从工具参数里取目标文件（不同工具的参数名不同）。 */
export function targetFile(name, args) {
  if (!args || typeof args !== 'object') return '';
  const raw = args.file_path ?? args.path ?? args.filePath ?? args.filename;
  return typeof raw === 'string' ? raw : '';
}

/** 相对路径：在 baseDir 下时保留相对路径（面板更好读），否则用绝对路径。
 *  统一成正斜杠：Windows 上 path.relative 给反斜杠，面板按 / 过滤与展示，diff 头也用 /。 */
export function displayPath(abs, baseDir) {
  const posix = (p) => String(p).replace(/\\/g, '/');
  if (!baseDir) return posix(abs);
  try {
    const rel = path.relative(baseDir, abs);
    return posix(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs);
  } catch {
    return posix(abs);
  }
}

/** 工具名 → 变更类型（新文件 = add；其余 = edit）。 */
export function changeKind(before, after) {
  if (before === null && after !== null) return 'add';
  return 'edit';
}

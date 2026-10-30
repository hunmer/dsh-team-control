// tests/changes-diff.mjs — 审阅页 diff 计算（纯函数，无 sidecar）：unified diff 的格式/行号/计数。
import assert from 'node:assert/strict';
import { countDiff, lineOps, splitLines, unifiedDiff } from '../dsh-plugin/changes.js';

const eq = (name, fn) => {
  try { fn(); console.log(`✔ ${name}`); } catch (err) { console.log(`✘ ${name}`); throw err; }
};

eq('splitLines: 空文本 0 行 / CRLF 归一', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b', '']);
});

eq('lineOps: 相同内容全是上下文', () => {
  const ops = lineOps('a\nb', 'a\nb');
  assert.deepEqual(ops.map((o) => o.type), [' ', ' ']);
});

eq('unifiedDiff: 单行修改的 hunk 头与上下文', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
  const after = ['1', '2', '3', '4', 'five', '6', '7', '8', '9'].join('\n');
  const diff = unifiedDiff('doc.md', before, after);
  const lines = diff.trimEnd().split('\n');
  assert.equal(lines[0], '--- a/doc.md');
  assert.equal(lines[1], '+++ b/doc.md');
  // 第 5 行改动，前后各 3 行上下文 → -2,7 +2,7
  assert.equal(lines[2], '@@ -2,7 +2,7 @@');
  assert.equal(lines[3], ' 2');
  assert.equal(lines[4], ' 3');
  assert.equal(lines[5], ' 4');
  assert.equal(lines[6], '-5');
  assert.equal(lines[7], '+five');
  assert.equal(lines[8], ' 6');
});

eq('unifiedDiff: 新文件用 -0,0 头，全部是 +', () => {
  const diff = unifiedDiff('new.md', '', 'a\nb\n');
  const lines = diff.trimEnd().split('\n');
  assert.equal(lines[2], '@@ -0,0 +1,3 @@');
  assert.deepEqual(lines.slice(3), ['+a', '+b', '+']);
});

eq('unifiedDiff: 删除文件用 +0,0 头', () => {
  const diff = unifiedDiff('gone.md', 'a\nb\n', '');
  const lines = diff.trimEnd().split('\n');
  assert.equal(lines[2], '@@ -1,3 +0,0 @@');
  assert.deepEqual(lines.slice(3), ['-a', '-b', '-']);
});

eq('unifiedDiff: 相同内容返回空串', () => {
  assert.equal(unifiedDiff('same.md', 'x\ny\n', 'x\ny\n'), '');
});

eq('unifiedDiff: 相隔很远的改动分成两个 hunk', () => {
  const before = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n');
  const after = before.split('\n').map((l) => (l === 'L2' || l === 'L28' ? l + 'x' : l)).join('\n');
  const diff = unifiedDiff('far.md', before, after);
  const hunks = diff.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunks.length, 2);
});

eq('unifiedDiff: 行数可被面板按行渲染（每行带 +/-/空格前缀）', () => {
  const diff = unifiedDiff('p.md', 'a\nb\n', 'a\nc\n');
  for (const line of diff.trimEnd().split('\n')) {
    assert.ok(/^(-{3}|\+{3}|@@|[-+ ])/.test(line), `unexpected line: ${line}`);
  }
});

eq('countDiff: 统计新增/删除行且不计文件头', () => {
  const diff = unifiedDiff('c.md', 'a\nb\n', 'a\nc\nd\n');
  const { added, deleted } = countDiff(diff);
  assert.equal(deleted, 1); // −b
  assert.equal(added, 2); // +c +d
});

eq('lineOps: 大文件退化路径仍然给出完整改动', () => {
  const before = Array.from({ length: 2100 }, (_, i) => `x${i}`).join('\n');
  const after = Array.from({ length: 2100 }, (_, i) => `y${i}`).join('\n');
  const diff = unifiedDiff('big.md', before, after);
  assert.ok(diff.includes('-x0'));
  assert.ok(diff.includes('+y2099'));
});

console.log('\nchanges-diff 全部通过');

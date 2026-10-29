// tests/run-all.mjs — 顺序跑全部 AC 脚本并汇总（支持 --only ac-05 过滤）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const files = fs.readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .filter((f) => !only || f.startsWith(only))
  .sort((a, b) => {
    // AC 脚本先跑，其余（plugin-/panel-/routes-/cli-）随后
    const rank = (f) => (/^ac-\d+/.test(f) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

if (!files.length) { console.error('没有找到测试脚本'); process.exit(1); }

const results = [];
for (const f of files) {
  const id = f.replace(/\.mjs$/, '');
  process.stdout.write(`\n===== ${id} =====\n`);
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, f)], { stdio: 'inherit', cwd: path.resolve(here, '..') });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  results.push({ id, code, ms: Date.now() - t0 });
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n================ 汇总 ================');
for (const r of results) console.log(`${r.code === 0 ? '✔' : '✘'} ${r.id.padEnd(24)} ${String(r.ms).padStart(7)}ms`);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) { console.log('失败：' + failed.map((f) => f.id).join(', ')); process.exit(1); }

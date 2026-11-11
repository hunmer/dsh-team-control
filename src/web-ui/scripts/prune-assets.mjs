#!/usr/bin/env node
// 构建后清理：src/web/assets 只保留 panel.html 当前引用的构建产物，
// 并同步 .gitignore 的白名单，避免旧 hash 产物被提交 / 打进 npm 包。
import { readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webUi = path.resolve(here, '..');
const repo = path.resolve(webUi, '..', '..');
const webDir = path.join(repo, 'src', 'web');
const assetsDir = path.join(webDir, 'assets');
const panelHtml = path.join(webDir, 'panel.html');
const gitignorePath = path.join(repo, '.gitignore');

const STALE_RE = /^(app|chunk)-.*\.js$|^panel-.*\.css$/;

const html = await readFile(panelHtml, 'utf8');
const keep = new Set([...html.matchAll(/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
if (keep.size === 0) {
  console.error('prune-assets: panel.html 里没有找到 assets/ 引用，放弃清理');
  process.exit(1);
}

let removed = 0;
let freed = 0;
for (const name of await readdir(assetsDir)) {
  if (keep.has(name) || !STALE_RE.test(name)) continue;
  const file = path.join(assetsDir, name);
  try {
    const st = await stat(file);
    await rm(file, { force: true });
    removed += 1;
    freed += st.size;
  } catch (err) {
    console.warn(`prune-assets: 跳过 ${name}（${err.message}）`);
  }
}

// .gitignore 白名单跟随当前引用，保证新 hash 产物能被提交、旧的不再出现。
const sorted = [...keep].sort();
const whitelist = sorted.map((name) => `!src/web/assets/${name}`);
let gi = await readFile(gitignorePath, 'utf8');
const eol = gi.includes('\r\n') ? '\r\n' : '\n';
gi = gi.replace(
  /(^src\/web\/assets\/\*\r?\n)(?:!src\/web\/assets\/[^\r?\n]*\r?\n)*/m,
  `$1${whitelist.join(eol)}${eol}`,
);
await writeFile(gitignorePath, gi);

const mb = (freed / 1048576).toFixed(1);
console.log(`prune-assets: 保留 ${sorted.length} 个（${sorted.join(', ')}），清理 ${removed} 个旧产物，释放 ${mb} MB`);

#!/usr/bin/env node
/**
 * sync-coss.mjs — 从 coss ui 官方 registry（https://coss.com/ui/r/<name>.json，
 * shadcn 兼容）拉取组件源码到本仓库（copy-paste 理念），并重写 import 别名：
 *   @/registry/default/ui/**    -> @/components/ui/**
 *   @/registry/default/lib/**   -> @/lib/**
 *   @/registry/default/hooks/** -> @/hooks/**
 * 同时下载官方主题 globals.css 与 lib/utils.ts。
 *
 * 用法：node scripts/sync-coss.mjs [name ...]   （无参数时同步 COMPONENTS 全集）
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const SRC = join(root, 'src');
const REGISTRY_BASE = 'https://coss.com/ui/r/';
const THEME_CSS_URL =
  'https://raw.githubusercontent.com/cosscom/ui/main/packages/ui/src/styles/globals.css';
const UTILS_URL =
  'https://raw.githubusercontent.com/cosscom/ui/main/apps/ui/registry/default/lib/utils.ts';

export const COMPONENTS = [
  'alert', 'avatar', 'badge', 'button', 'card', 'collapsible', 'dialog', 'empty',
  'input', 'kbd', 'label', 'menu', 'popover', 'progress', 'scroll-area',
  'segmented-control', 'select', 'separator', 'sheet', 'sidebar', 'skeleton',
  'spinner', 'switch', 'table', 'tabs', 'textarea', 'toast', 'tooltip',
];

const rewriteImport = (code) => code
  .replaceAll('@/registry/default/ui/', '@/components/ui/')
  .replaceAll('@/registry/default/lib/', '@/lib/')
  .replaceAll('@/registry/default/hooks/', '@/hooks/');

function mapPath(registryPath) {
  let rel = registryPath.replace(/^registry\/(?:default|new-york)\//, '');
  if (rel.startsWith('ui/')) rel = 'components/' + rel;
  return join(SRC, rel);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json(res);
}

async function syncItem(name, seen, deps) {
  if (seen.has(name)) return;
  seen.add(name);
  const item = await fetchJson(REGISTRY_BASE + encodeURIComponent(name) + '.json');
  for (const dep of item.dependencies || []) deps.add(dep);
  for (const file of item.files || []) {
    const target = mapPath(file.path);
    const code = file.type === 'registry:ui' || file.path.endsWith('.tsx') || file.path.endsWith('.ts') || file.path.endsWith('.css')
      ? rewriteImport(file.content)
      : file.content;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code, 'utf8');
    console.log('  ✓', file.path, '->', target.slice(root.length + 1));
  }
  for (const dep of item.registryDependencies || []) {
    await syncItem(dep.replace(/^@coss\//, ''), seen, deps);
  }
}

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : COMPONENTS;
  console.log('[coss-ui] 同步组件:', wanted.join(', '));
  const seen = new Set();
  const deps = new Set(['react', 'react-dom']);
  for (const name of wanted) await syncItem(name, seen, deps);

  await mkdir(join(SRC, 'lib'), { recursive: true });
  const theme = await (await fetch(THEME_CSS_URL)).text();
  await writeFile(join(SRC, 'coss-theme.css'), theme, 'utf8');
  console.log('  ✓ theme globals.css -> src/coss-theme.css');
  const utils = await (await fetch(UTILS_URL)).text();
  await writeFile(join(SRC, 'lib', 'utils.ts'), utils, 'utf8');
  console.log('  ✓ lib/utils.ts');

  // 提示需要安装的 npm 依赖（参考 package.json 已有的）
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const missing = [...deps].filter((d) => !(d in (pkg.dependencies || {})) && !(d in (pkg.devDependencies || {})));
  console.log('[coss-ui] registry 声明的依赖:', [...deps].join(' '));
  if (missing.length) console.log('[coss-ui] ⚠ 未在 package.json 中声明:', missing.join(' '), '（请 npm install）');
  console.log('[coss-ui] 完成，共', seen.size, '个 registry 项。');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error('[coss-ui] 失败:', err.message); process.exit(1); });
}

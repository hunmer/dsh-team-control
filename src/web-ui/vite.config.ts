import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { inspectorServer } from '@react-dev-inspector/vite-plugin';
import { transformAsync, type BabelFileResult } from '@babel/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 给每个 JSX 节点注入 data-inspector-line/-column/-relative-path 源码位置
// 属性，DevInspector 点击定位依赖它们。仅 dev 生效，生产构建不受影响。
// 路径统一用正斜杠：Windows 反斜杠经过多轮转义会不稳定，
// 且正斜杠在 path.resolve 与编辑器 CLI 中跨平台通用。
function inspectorTransform(): Plugin {
  return {
    name: 'react-dev-inspector-transform',
    apply: 'serve',
    enforce: 'pre',
    async transform(code, id) {
      const [file] = id.split('?');
      if (!/\.tsx?$/.test(file) || file.includes('node_modules')) return;
      const relativePath = path.relative(here, file).replaceAll('\\', '/');
      const result: BabelFileResult | null = await transformAsync(code, {
        filename: file,
        sourceType: 'module',
        parserOpts: { plugins: ['typescript', 'jsx', 'decorators-legacy'] },
        plugins: [
          ({ types: t }: { types: typeof import('@babel/core').types }) => ({
            visitor: {
              JSXOpeningElement(nodePath: any) {
                const name = nodePath.node.name;
                if (
                  (t.isJSXIdentifier(name) && name.name.endsWith('Fragment')) ||
                  (t.isJSXMemberExpression(name) &&
                    name.property.name.endsWith('Fragment'))
                ) {
                  return;
                }
                const line = nodePath.node.loc?.start.line;
                const column = nodePath.node.loc?.start.column;
                if (line == null || column == null) return;
                nodePath.node.attributes.unshift(
                  t.jsxAttribute(
                    t.jsxIdentifier('data-inspector-line'),
                    t.stringLiteral(String(line)),
                  ),
                  t.jsxAttribute(
                    t.jsxIdentifier('data-inspector-column'),
                    t.stringLiteral(String(column)),
                  ),
                  t.jsxAttribute(
                    t.jsxIdentifier('data-inspector-relative-path'),
                    t.stringLiteral(relativePath),
                  ),
                );
              },
            },
          }),
        ],
        sourceMaps: true,
      });
      if (!result?.code) return;
      return { code: result.code, map: result.map ?? null };
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    inspectorTransform(),
    // 提供 /__open-stack-frame-in-editor 路由，配合 DevInspector 组件实现
    // 点击页面元素后在编辑器中打开源码。编辑器由 REACT_EDITOR 环境变量
    // 指定，默认 `code`（VS Code）。仅 dev 生效。
    inspectorServer(),
    // dev 模式：/panel/ 目录路径落到 panel.html（生产由 sidecar 托管时同样行为）
    {
      name: 'panel-dev-fallback',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/panel' || req.url === '/panel/') req.url = '/panel/panel.html';
          next();
        });
      },
    },
  ],
  base: '/panel/',
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
    },
  },
  build: {
    // 产物直接输出到 sidecar 静态目录：/panel 由 src/server.mjs 托管
    outDir: path.resolve(here, '../web'),
    emptyOutDir: false,
    assetsDir: 'assets',
    rollupOptions: {
      input: path.resolve(here, 'panel.html'),
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/chunk-[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    port: 5183,
    proxy: {
      // 开发模式：代理到本地 sidecar（默认 127.0.0.1:4317）
      '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true },
    },
  },
});

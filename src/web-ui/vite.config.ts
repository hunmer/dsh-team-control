import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

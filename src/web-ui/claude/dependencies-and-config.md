# 构建与依赖

## 命令

```bash
cd src/web-ui
npm install          # 首次
npm run dev          # vite dev server，5183，/api 代理到 127.0.0.1:4317
npm run build        # 输出到 ../web/（base 为 /panel/）
npx tsc -b           # 类型检查（strict，noEmit）
```

## `vite.config.ts` 关键项

| 项 | 值 | 影响 |
|---|---|---|
| `base` | `/panel/` | 产物按 `/panel/` 引用 assets，与 sidecar 的静态路由一致 |
| `build.outDir` | `../web` | 直接落到 `src/web/`，sidecar 从那里托管 |
| `server.port` | `5183` | 与 sidecar 的 4317 分开 |
| `server.proxy['/api']` | `http://127.0.0.1:4317` | 开发时前端直连本机 sidecar |
| `resolve.alias['@']` | `./src` | 与 tsconfig 的 `paths` 对应 |

## `tsconfig`

`target/lib: ES2022`、`strict: true`、`noEmit: true`、`verbatimModuleSyntax: true`、`paths: { "@/*": ["./src/*"] }`。

`verbatimModuleSyntax` 意味着**类型必须用 `import type`**；混用会编译失败（不是警告）。

## 产物约定

```text
src/web/
  panel.html                     唯一入口，引用下面两个 assets
  assets/app-FxBUmmrD.js         面板主包
  assets/panel-y8c8jBiH.css      样式
  legacy/{panel.html,app.js,app.css}   旧 vanilla 面板备份
```

`.gitignore` **只白名单** `panel.html` 与被引用的那两个 assets；其余构建垃圾不入库。
文件名带内容 hash：重新 build 会改名，`tests/panel-contract` 会校验一致性——所以**改完必须重新 build 并提交新产物**，否则测试与线上会不一致。

## coss ui 同步

```bash
node scripts/sync-coss.mjs            # 抓 https://coss.com/ui/r/{name}.json
```

- 组件下载到 `src/components/ui/`，并把 `@/registry/default/*` 别名重写成项目内路径。
- **不要手改 `components/ui/**`**：下次同步会被覆盖。要定制就在业务组件里包一层。
- 加新 coss 组件：在同步脚本的清单里加名字，跑一遍，再 import。

## 依赖升级注意

- React 19：`use()`、Server Components 相关 API 不要用（这是纯客户端构建）。
- Tailwind v4：配置在 CSS 里（`@theme`），不再是 `tailwind.config.js`。
- Vite 6：`base`/`outDir` 改错会直接让 `/panel` 白屏。
- 升级后务必 `npx tsc -b` + `npm run build` + 跑 `tests/panel-contract` 与 `tests/ui-member-strip`。

# dsh-team panel UI（coss ui 版）

sidecar 面板（`/panel`，端口 4317）用 [coss ui](https://coss.com/ui/docs/get-started)
重写：React 19 + Tailwind CSS v4 + Vite，组件从 coss 官方 registry 拷贝（copy-paste 理念），
主题使用 coss 官方 `globals.css` 设计令牌，支持亮/暗双色。

## 结构

```
src/web-ui/                 前端源码（本目录）
  panel.html                Vite 入口（构建产物名与 sidecar 路由 /panel 匹配）
  components.json           shadcn 兼容配置（registries 指向 https://coss.com/ui/r/）
  scripts/sync-coss.mjs     从 coss registry 拉取/更新组件（node scripts/sync-coss.mjs [name...]）
  src/components/ui/        coss ui 组件（button/card/table/tabs/select/dialog/... 由 sync 脚本生成）
  src/components/agent-tree/ affectui agent-tree 组件（DAG 视图的卡片树效果，含连接线动画）
  src/components/agent-lanes/ affectui agent-lanes 组件（时间线视图的成员泳道效果，时间块随 now 滑动）
  src/coss-theme.css        coss 官方主题（globals.css，由 sync 脚本下载）
  src/store.tsx             状态层：REST 首屏快照 + SSE 实时（member.status / step.append / ...）
  src/views/                6 个视图：看板 / DAG（agent-tree 卡片树）/ 时间线（agent-lanes 泳道）/ 权限矩阵 / 审批队列 / 消息
src/web/                    构建产物（sidecar 静态托管目录，/panel 路由）
src/web/legacy/             旧版 vanilla 面板备份（panel.html / app.js / app.css）
```

## 构建

```bash
cd src/web-ui
npm install            # 沙箱/CI 环境可加 --ignore-scripts --cache ./.npm-cache
npm run build          # tsc + vite build，产物输出到 ../web（panel.html + assets/）
```

开发模式：`npm run dev`（端口 5183，`/api` 代理到 127.0.0.1:4317）。

注意：本机沙箱环境下 esbuild 的临时目录可能被拦截，构建时把 TMP/TEMP 指到工作区内：
`$env:TMP="$PWD/.tmp"; $env:TEMP="$PWD/.tmp"; npm run build`。

## 更新 coss 组件

```bash
npm run sync:coss              # 同步 package 内置清单（16 个组件 + 主题 + utils）
npm run sync:coss button card  # 只同步指定组件
```

sync 脚本会把 registry 里的 `@/registry/default/**` 别名重写为 `@/components/ui/**`、
`@/lib/**`、`@/hooks/**`，依赖声明（`@base-ui/react` 等）保持在 package.json 中。

## 与旧版的面差异

- 鉴权已移除：面板与 API 免 token 直接访问（sidecar 仅监听回环）；旧链接里的 `#token=` 仍被接受并自动抹除。
  同源嵌入模式全部保留；DSH 插件 iframe（`/dsh-team-api/panel?...`）无需改动。
- 视觉换成 coss ui 设计系统（Base UI 原语 + Tailwind v4 令牌），亮暗跟随 `prefers-color-scheme`。
- 旧 vanilla 实现备份在 `src/web/legacy/`，需要时把三个文件拷回 `src/web/` 即可回滚。

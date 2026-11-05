# src/web-ui · 面板前端源码

## 项目简单介绍

`src/web-ui/` 是 dsh-team 面板的源码（私有包 `@local/dsh-team-panel-ui` v1.0.0）：React 19 + Tailwind v4 + Vite 6 + **coss ui**（copy-paste registry）。它构建出的 `panel.html` + assets 落到 `../web/`，由 sidecar 静态托管到 `/panel`，再被 `dsh-plugin-ui` 用 iframe 挂进 DSH GUI。

状态层是「REST 首屏快照 + SSE 增量」：`store.tsx` 的 `PanelProvider` 先拉全量，再订阅 `/api/events`，用 `lastEventId` 续传保证不丢帧。视图共 8 个（主页 = 时间线 `Timeline.tsx` + 7 个页签，含「组合预设」），单一 `AppShell` 侧栏导航（ADR-010）。

## 约定的规则

- 改 UI 一律改这里 + `npm run build`，**不要手改 `src/web/assets/`**。
- `src/components/ui/**` 是 coss 同步产物（`scripts/sync-coss.mjs`），手改会被下次同步覆盖；要定制请在业务组件里包一层。
- 路径别名 `@/` → `src/web-ui/src`；必须用别名，不要写相对 `../../..`。
- `strict` + `verbatimModuleSyntax`：类型导入必须 `import type`，不能混进值导入。
- 新增页签要三处同步：`TAB_NAMES`（`store.tsx`）、`TAB_LABELS/TAB_ORDER`（`shell.tsx`）、`App.tsx` 的视图分发。
- 状态只从 `usePanel()` 取，不要在组件里直接 `fetch` `/api`。
- 嵌入模式（`embed=1`）下要隐藏外层壳；判断走 `lib/api.ts` 暴露的标志，不要自己读 URL。
- 主题：首帧前读 `localStorage['dsh-team.panel.theme.v1']` 上暗色 class，避免闪白；`applyDshTheme` 同步宿主主题。

## 文件索引

| 文件 | 用途 | 何时阅读 |
|---|---|---|
| [结构与状态层](claude/overview.md) | 视图清单、store 形状、SSE 增量策略 | 加视图或改状态流 |
| [构建与依赖](claude/dependencies-and-config.md) | vite/tsconfig/coss 同步、产物约定 | 改构建或升级依赖 |
| [常见问题](claude/faq.md) | 白屏/样式/主题/类型错误 | 面板出问题先看这里 |

## 扫描状态

- 更新时间：2026-11-05（增量，含深读）
- 已扫描：`panel.html`、`main.tsx`、`App.tsx`、`store.tsx`（深读：路由/SSE 帧/去抖/轮询/竞态约定，见 overview.md）、`shell.tsx`、`types.ts`、`lib/{api,board,dsh-bridge,workspace,model-brand,model-icons,format,json,utils}.ts`、`views/`（`Board.tsx`/`BoardPage.tsx`/`board-status-icon.tsx`/`tasks/TasksView` 深读）、`components/` 目录清单、构建配置。
- 未逐行：`views/Home.tsx`（约千行）与 `tasks/TasksView.tsx` 内部细节。
- 下一步：改首页前读 `views/Home.tsx`；改看板交互前读 `views/tasks/TasksView.tsx`。

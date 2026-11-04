# dsh-plugin-ui · GUI 面板挂载

## 项目简单介绍

`dsh-plugin-ui/`（`dsh-team-control-ui` v0.1.7）把 sidecar 自带的面板挂进 DSH GUI。它分两半：Host half（`index.js`，`inject:['webServer']`）挂一个**同源代理** `/dsh-team-api/*` 转发到 sidecar 并代填 token；Client half（`client.js`）在浏览器里注册两个独立入口——「编排」（team 维度）与「任务看板」（workspace 维度，路由 `#/board[/<ws>]`）；优先 better-sidebar 页签，退化到右侧栏 + 底栏按钮，再退化到 main panel，内容统一是 iframe 指向代理。

这样**浏览器永远拿不到 sidecar token**（ADR-008）。

## 约定的规则

- Client half 零外部 import，只允许 `require('react')`；必须走 `window.__ModuleLoader__.load({id:'dsh-team-control-ui', factory})`。
- 注册必须**逐级回退**，不能假设宿主一定有 better-sidebar。
- 面板 URL 固定带 `?api=/dsh-team-api&embed=1`；改参数要同时改 `src/web-ui/src/lib/api.ts`。
- 代理路径前缀 `/dsh-team-api` 与面板里的 `api` 参数是**一对**，改一个必须改另一个。
- Host half 不缓存、不改写响应体；只补 `Authorization`（读 `home/token`）并转发。
- 不要在这里塞业务逻辑——业务在 sidecar，渲染在 `src/web-ui/`。

## 文件索引

| 文件 | 用途 | 何时阅读 |
|---|---|---|
| [挂载与代理](claude/overview.md) | 注册回退链、代理细节、配置项 | 排查「页签不出现 / 请求 401」 |

## 扫描状态

- 更新时间：2026-11-01
- 已扫描：`index.js` 导出（`name`、`inject`、`resolveConfig/isUp/spawnSidecar/ensureSidecar/proxyHandler/apply`）；`client.js` 的 loader 形态、注册顺序与 iframe 参数；`cordis.patch.yml`；`package.json` 的 `dsh.bundle.patch` 与 `dsh.client`。
- 未逐行：`client.js`（1532 行）的 UI 细节实现。
- 下一步：改挂载方式前先读 `client.js` 的 fallback 分支，确认目标宿主版本支持哪个注入点。

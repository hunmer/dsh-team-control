# dsh-plugin-ui · GUI 面板挂载

## 项目简单介绍

`dsh-plugin-ui/`（`dsh-team-control-ui` v0.2.4）把 sidecar 自带的面板挂进 DSH GUI。它分两半：Host half（`index.js`，`inject:['webServer']`）挂一个**同源代理** `/dsh-team-api/*` 转发到 sidecar 并代填 token；Client half（`client.js`）在浏览器里常驻注册两个左侧栏入口——「编排」（team 维度，id `dsh-team`）与「任务看板」（workspace 维度，路由 `#/board[/<ws>]`，id `dsh-team-board`），各对应一个 `main` 主面板；另并存注册右侧栏页签与 better-sidebar 页签，内容统一是 iframe 指向代理。

这样**浏览器永远拿不到 sidecar token**（ADR-008）。

## 约定的规则

- Client half 零外部 import，只允许 `require('react')`；必须走 `window.__ModuleLoader__.load({id:'dsh-team-control-ui', factory})`。
- 注册必须对宿主能力做降级并用 `ctx.slots.inject` / `ctx.inject` 等待服务就绪（不能假设宿主一定有 better-sidebar / sidebarRight）；但左侧栏「编排」「看板」两个入口**必须始终注册**。
- 「看板」行右端的固定开关（`boardDockStore` + `boardDockToggle`）与右侧停靠层（`boardDockView`）都注册在 `shell.overlay`：开关按行矩形 `position:fixed` 贴到行右端，停靠层是 frame 级常驻 aside（开关/宽度落 localStorage，`dsh-team:board-dock` / `dsh-team:board-dock-width`）；停靠时给宿主 frame 加 `padding-right` 让主区让宽。宿主 panellist 的图标位于行 `<button>` 内，另注册可点行会被 `layout.selectPanel` 拒绝。
- **看板不跟随当前会话**：`BoardView` 只在挂载（打开看板/停靠层）时取一次 `sessionTeamStore.snapshot().cwd` 拼进 iframe 的 `&cwd=`，不订阅会话切换；切会话不重载看板，工作区下拉由面板自己选。
- **自动开面板只限一次**：团队创建时自动把右侧栏「编排」页推开一次（`AUTO_OPEN_KEY` 记在 sessionStorage，每会话一次，用户收起后不再打扰）；聊天框上方的团队进度条常驻，点成员 chip 才弹出该成员详情浮层（再点收起，轮询不改选择）。
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

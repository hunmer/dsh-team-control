# 结构与状态层

## 启动链

```text
panel.html
  ├ #root
  ├ 内联脚本：首帧前读 localStorage['dsh-team.panel.theme.v1'] → 上暗色 class（防闪白）
  └ <script type="module" src="/src/main.tsx">

main.tsx
  applyDshTheme(readDshTheme())
  <PanelProvider><App /></PanelProvider>

App.tsx
  usePanel() → AppShell + SidebarMenu + 当前视图
```

## 视图

| 视图 | 文件 | 看什么 |
|---|---|---|
| Home | `views/Home.tsx` | 团队总览、成员引导卡、Plan/Activity；底部内嵌 `Timeline.tsx` 事件时间线（cap 2000，原 timeline 页签并入此处，落地页不算页签） |
| Board | `views/Board.tsx` | **成员 Trace 瀑布**（`GET /api/trace`，root(团队)→member→step/span）；注意不是任务看板 |
| Review | `views/Review.tsx` | 待评审/变更（`member_change`） |
| Context | `views/Context.tsx` | 上下文占用（`context_snapshot`） |
| Dag | `views/Dag.tsx` | 依赖图与关键路径 |
| Models | `views/Models.tsx` | provider/route 与启停 |
| Messages | `views/Messages.tsx` | 持久信箱 |
| Presets | `views/Presets.tsx` | 组合预设目录 |
| Tasks | `views/tasks/TasksView.tsx` | **工作区任务看板**（ADR-012），被 `BoardPage` 内嵌，也可在编排面板中用 |
| BoardPage | `views/BoardPage.tsx` | 独立看板页（`#/board[/<ws>]`），69 行：仅工作区 Select + 主题按钮 + `<TasksView standalone/>` |

`TAB_NAMES = ['board','review','context','dag','models','messages','presets']`（store.tsx:14）。

## 路由（store.tsx 手写 hash 路由，无 router 库）

- `#/w/<ws>/t/<team>/<tab>`：编排面板；`#/board[/<workspaceId>]`：独立看板页。
- `parseRoute/buildRoute/applyRoute`（store.tsx:175-211）；push=true 用 `history.pushState`，`hashchange` 同步（store.tsx:998-1022）。
- `state.page==='board'` 时 `App.tsx` 不渲染 AppShell/侧栏，直接 `<BoardPage/>`；`boot()` 对 board 页只 `refreshWorkspaces`+设 wsId（校验存在，否则取第一个），**不 selectTeam、不连 SSE、不改写 URL**。
- tab='home' 不持久化、不进 URL。

## 工作区看板（TasksView + lib/board.ts）

状态流转全部走 `lib/board.ts` 的 `boardApi`（纯函数封装，与 store.tsx 解耦；TasksView 自管数据、自带刷新）：

- 列表：`GET /api/board?workspaceId=<id>[&archived=1]` → `{workspace, settings, counts, slots{planning,inprogress}, tasks}`
- 创建：`POST /api/board/tasks`（`workspaceId/title/description/auto/executionMode('same'|'new')/planRoute/leadRoute/teamModels`）
- 状态动作：`POST .../start|stop|retry|archive|restore|status`、`PATCH /api/board/tasks/<id>`、`DELETE /api/board/tasks/<id>`；设置 `GET/PUT /api/board/settings`
- 状态机：`todo → planning(生成 planMd/planningSessionId) → planned → inprogress(leadSessionId) → done|failed`；`stopRequested/resumed/lastError` 为辅助字段
- **两套状态枚举**：sidecar `BoardStatus = 'todo'|'planning'|'planned'|'inprogress'|'done'|'failed'`（lib/board.ts:4）；`board-status-icon.tsx` 的 `BoardStatusKind = 'backlog'|'todo'|'progress'|'review'|'done'|'canceled'` 是 affectUI 视觉分类，需在 TasksView 里映射。

## 状态层（`store.tsx`，1086 行）

导出：`PanelProvider`、`usePanel(): PanelActions`、`TAB_NAMES`、`OTHER_WORKSPACE_ID='__other'`（虚拟工作区：注册表匹配不到归属的旧团队）、`pendingTimelineRef`、`PHASES`。

总纲（文件头注释）：**数据只来自 SSE；REST 仅首屏快照 / 重连补齐 / 操作**。`selectTeam` → 清空切片 + `refreshAll`（10 个并发 `safe()` REST）+ `backfillTimeline(/api/events/history?since=0)` + `connectSSE`。

PanelState 要点：`page('panel'|'board')`、`teamId/team/teams`、`workspaces/workspaceId`、`members/staleMembers/degraded/snapshot`、`dag`、`tasks`（**/api/tasks，team 维度，与 /api/board 的 workspace 维度区分**）、`todos/artifacts/changes`、`contexts/contextLead`、`trace+traceWindow(默认 30 分钟)+traceHasOlder`、`messages/presets/errors/timeline(cap 2000)/paused/speed/tab/filters`、`conn('connecting'|'live'|'reconnecting'|'offline')`。

```text
SSE（store.tsx:624-717）
  GET /api/events?team=<id>[&token][&lastEventId]
  具名帧 SSE_TYPES = member.status / step.append / task.state / message.delivered /
                     span.append / artifact.added / context.update
  （'change.added' 未入具名列表，靠 onmessage 的 type 分发兜底）
  ├ 帧 data 即 payload 本身（无 envelope）；history 回填才有 {payload} 包裹（:658）
  ├ member.status → patchMember + 去抖 refreshTeams(400ms)
  ├ step.append  → 时间线 ingest + 去抖 trace(200ms)；action==='task.todo' 时刷 todos
  ├ task.state   → dag/tasks/artifacts 去抖
  └ span.append  → trace 去抖(120ms)

lastEventId：每帧取 event.lastEventId 存 localStorage('dsh-team.panel.lastEventId.v1')，重连带 query 续传
重连：onopen → refreshAll 补快照；onerror → 指数退避（min 15s），attempt≥2 时 probeAuth
去抖：scheduleRefresh(key, delay) 单例 timer 表（refreshTimers）
轮询兜底：团队列表无 SSE，5s setInterval pollTeams（document.hidden 跳过）+ visibilitychange 立即刷；
          工作区注册表每 6 轮（约 30s）补刷；online/offline 控制 conn 与重连
Trace 分页：tracePages ref 累积 + mergeTracePages 按 min(originMs) 统一原点合并；
            loadOlderTrace 用 until=<oldest> 前翻，空批封底 hasOlder=false
竞态：所有 team 维度 refresh 响应后比对 stateRef.current.teamId 丢弃过期；
      selectTeam 先写 stateRef 再 setState（:736-737）
UI 持久化：STORE_UI='dsh-team.panel.ui.v1'（tab 白名单= TAB_NAMES，不含 home；filters/paused/speed）
```

**加新帧类型**：先确认 sidecar 已发（7 基础 + 4 合成），再在 store 的帧分派处加分支并更新 `types.ts`。

## 类型（`types.ts`）

`Member`、`Dag*`（Node/Edge/Graph）、`Policy`、`MatrixRow`、`ScopeRequest`、`TeamMessage`、`TimelineEntry`、`Task`、`Team`、`Workspace`、`PanelSettings`、`Trace*`、`Todo`、`TaskArtifact`、`Context*`、`ChangeRisk`。
**这些类型应与 `docs/CONTRACT.md` 的响应体保持一致**；sidecar 改响应形状时这里必须同步。

## 外壳（`shell.tsx`）

`TAB_LABELS`、`TAB_ORDER`、`buildNav()`、`tabFromLabel()`、`ShellChrome`。ADR-010：用单一 `AppShell` 侧栏替代横向 Tabs。

## 特色组件（`components/`）

`agent-tree`、`agent-lanes`、`agent-queue`、`trace-waterfall`、`fan-out-grid`、`context-map`、`bar-race-chart`。
`components/ui/` 是 31 个 coss 组件（`button/card/dialog/table/…`），同步产物。

## 品牌资产

`assets/models/` 下 13 个厂商 SVG；`lib/model-brand.ts` / `model-icons.ts` 负责模型名 → 品牌/图标映射。加新厂商：补 SVG + 在映射表登记。

## API 与嵌入（`lib/api.ts`）

```text
普通访问：base = ''        → 同源 /api/*
嵌入访问：?api=/dsh-team-api&embed=1 → base = '/dsh-team-api'，并置 embed 标志（EMBEDDED = embed=1 || API_BASE!==''）
token：只存内存（模块变量），initUrlToken 兼容旧 #token 链接（现免鉴权可忽略）
board 封装不在 api.ts，在 lib/board.ts 的 boardApi（见上）
```

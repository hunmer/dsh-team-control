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

## 视图（10 个）

| 视图 | 文件 | 看什么 |
|---|---|---|
| Home | `views/Home.tsx` | 团队总览、成员条、实时活动 |
| Board | `views/Board.tsx` | 看板（按状态分列） |
| Review | `views/Review.tsx` | 待评审/变更 |
| Context | `views/Context.tsx` | 上下文占用（`context_snapshot`） |
| Dag | `views/Dag.tsx` | 依赖图与关键路径 |
| Timeline | `views/Timeline.tsx` | 事件时间线（trace 瀑布入口） |
| Models | `views/Models.tsx` | provider/route 与启停 |
| Permissions | `views/Permissions.tsx` | 四域矩阵 |
| Approvals | `views/Approvals.tsx` | `scope_request` 待办与裁决 |
| Messages | `views/Messages.tsx` | 持久信箱 |

`TAB_NAMES = ['board','review','context','dag','timeline','models','permissions','approvals','messages']`（Home 不算页签，是落地页）。

## 状态层（`store.tsx`）

导出：`TAB_NAMES`、`TabName`、`PHASES`（15 个，与 sidecar 的 `phase` 枚举对齐）、`OTHER_WORKSPACE_ID='__other'`、`pendingTimelineRef`、`PanelProvider`、`usePanel`。

```text
首次挂载
  ├ 并行拉快照：/api/status /api/teams /api/dag /api/permissions /api/approvals /api/messages …
  ├ 打开 SSE：/api/events（带 lastEventId）
  └ 增量帧落到各自 slice；未识别的帧进 timeline

断线重连
  └ 用最后收到的 seq 作为 lastEventId 续传，服务端从 event 表回放缺口

实时偏好
  └ pendingTimelineRef 暂存「刚发生的动作」，避免乐观更新与 SSE 回放打架
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
嵌入访问：?api=/dsh-team-api&embed=1 → base = '/dsh-team-api'，并置 embed 标志
token：只存内存（模块变量），URL hash 里的 token 用完立即从地址栏抹掉
```

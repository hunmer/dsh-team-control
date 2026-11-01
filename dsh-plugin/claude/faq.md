# dsh-plugin 常见问题

**工具全报 `connect ECONNREFUSED`**
`autoStart:true` 时插件应自己拉起 sidecar，失败看 `startTimeoutMs` 是否打满（说明 spawn 成功但没读到 ready 行）。手工验证：`node bin/dsh-team.mjs up --foreground`，看第一行是不是单行 JSON。

**`team_spawn` 报 `unknown teamId`**
`team_create` 返回的是 `result.team.id`，不是入参 `name`。后续所有调用都要用这个 id（`plugin-teamid-guard` 测试专门守这个）。

**`assignee` 传了成员名字但不生效**
`team_task` 的 `assignee` 要的是 **member id**（`team_spawn` 返回的 `id`），不是名字。

**agent 成员永远不报任务**
简报里没写「最后调用 `team_report_task`」。成员看不到 Lead 的对话，必须在 prompt 里明确：teamId、taskId（或让 `team_task` 派发时带上）、以及验收标准。

**成员 idle 了但任务没派出去**
等 `agentDispatchMs` 一个周期，或直接调 `team_dispatch`。仍不行就看 sidecar 的 `GET /api/blockers`（上限打满 / 全员 blocked）。

**任务被重复派给同一成员**
`agent/status → idle` 的 settle 窗口被配得太小（`agentIdleSettleMs`）。宿主两次 turn 之间会有短暂无活动。

**span 里入参被截断**
`traceInputMax` 默认 1200 字符，按需调大。截断是刻意的——避免 trace 表被大 payload 撑爆。

**费用对不上账单**
`pricing.js` 是内置估算表（含峰值时段），可用 config `pricingTables` 覆盖。它不是权威账单。

**面板 Change 视图看不到某个工具的改动**
新工具名不在 `changes.js` 的 `FILE_TOOLS` 白名单里。

**关掉上报会不会影响功能**
不会。`reportToolCalls/reportChanges/reportLlmCalls/reportContext` 只是观测；关掉后面板少数据，任务照跑。

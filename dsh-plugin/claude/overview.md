# dsh-plugin 实现要点

## 关键内存态（`index.js`）

`leadByTeam`（teamId→Lead 句柄；**成员消息必须由 live Lead 发**，成员互通也借它）、`teamCache`、`sessionMember`（成员 sessionId→{teamId,memberId,cwd,permissionPreset,name}）、`teamBySession`（粘性 teamId）、`dispatching`（防重入）、`pendingApprovals`、`heldSessions`（interrupt 冻结，防 idle 回写覆盖）、`boardSessions`。`teamOf()`（:700）对 undefined/null teamId 兜底并 404 报「团队不存在」。

## 逐工具实现速查（端点 → 要点）

- `team_create` → `POST /api/teams`。先 `guardBoardTeamReuse`（看板任务已有团队且非 force 时禁止重复建队）；`resolvePermissionPreset` 校验（正则+宿主 names，默认 workspace-write）；`bindBoardTeam` 把新团队绑到 `/api/board/tasks/<id>/teams`。
- `team_spawn`（:1988）→ `subagents.startActivation` + `POST /api/agents/register` 双注册。contextMode 非 fork 且未指定 agentPreset 时补 hostDefaultAgentPreset（否则 fresh 成员缺工具）；route 合并：args 覆盖 Lead 的 leadRouteOf，reasoningEffort 仅 route 未变时继承；看板 teamModels 白名单强制；`assertRouteEnabled` 过启用闸门。startActivation 后立即 `applyPermissionPreset`（覆盖子代理继承的 approval=never）。
- `team_models` → `GET /api/llm/catalog`（只报 enabled，efforts 过 allowedEfforts）。
- `team_preset`（:2151）→ 主链路在宿主（`presetDir/<id>.json` + `agentPresets.register` 即时生效），save 后 `POST /api/presets/sync` 镜像；面板删除走 pending-deletes 队列（≥5 次放弃）。
- `team_status` → `GET /api/dag` 或 `GET /api/status`，投影 members（status/step/seq/pct/blockers/两个预设）。
- `team_task` → `POST /api/tasks`；`dispatch!==false` 时 sleep(agentSettleMs=250ms 依赖窗口) 后 dispatchLoop。
- `team_send`（:2324）→ `POST /api/messages` + `subagents.sendMessage`；to='lead' 只落信箱；成员→成员借 Lead 句柄；送达后 `POST /api/messages/<id>/ack`(delivered)。
- `team_todo` → `POST /api/tasks/<taskId>/todos`（整份替换，≤50 条）。
- `team_report_task`（:2430）→ `POST /api/agents/report` 推进 DAG → `collectArtifacts`（扫成员会话事件，按 lastArtifactSeq 增量，取后 12 条）`POST /api/artifacts` → 再跑一轮 dispatchLoop。
- `team_dispatch` → 本地 dispatchLoop：循环 `POST /api/agents/dispatch` 原子认领（≤16 轮）+ deliverTask（先 `POST /api/messages` 落含 team_report_task 模板的简报，再 subs.sendMessage）；投递失败按 failed 交回重试。
- `team_approve`（:2484）→ 纯本地决定 + `POST /api/approvals/<requestId>/decide` 镜像。校验 pendingApprovals 存在、teamId 匹配、调用者是 Lead；`settleApproval` resolve 挂起 Promise 写回宿主 outcome（allowed-once/rejected）。入口：`approval/request` 钩子（:1153）先镜像再 sendMessage 通知 Lead；超时(approvalTimeoutMs=600s)自动 rejected(expired)；通知不到 Lead 立即 deny。
- `team_control`（:2517）→ interrupt：`POST /api/members/<id>/interrupt` + subs.interrupt，前置 heldSessions.add 冻结；resume 解冻；assign → `POST /api/members/<id>/assign`；abort → `POST /api/tasks/<id>/abort`（wasRunning 时同样冻结+interrupt）。
- `team_member`（:2596）→ retire/remove → `DELETE /api/members/<id>?mode=…`（remove 需 confirm）+ releaseSession；update：running/blocked 需先 interrupt；改 model/provider/contextMode/agentPreset/effort 任一 → 重建子会话（startActivation + register + PATCH 只写显式字段）；仅改 role/permissionPreset → PATCH + applyPermissionPreset 热生效。
- `team_report` → `GET /api/report?format=md`（截 200k；聚合全在 sidecar：members/tasks/DAG/审批/审计）。
- `board_plan_submit`（:2787）→ `POST /api/board/agents/plan`；executionMode=new 时 5s 后 dispose 规划会话。
- `board_task_status` → `POST /api/board/agents/status` {sessionId,status,summary}。

## 配置解析（`resolveConfig`）

优先级：显式 config > 环境变量（`DSH_TEAM_PORT` / `DSH_TEAM_HOME`）> 默认值。
`baseUrl` 默认 `http://127.0.0.1:4317`；给了 `port` 会重算 `baseUrl`。
`autoStart:false` → 不发 spawn，直接对 `baseUrl` 说话（测试/外部托管场景）。

## sidecar 拉起（`ensureSidecar`）

```text
isUp(baseUrl) ? 直接返回
 : spawn(process.execPath, [entry, 'up', '--port', port, '--data', home], {detached:true})
   读 stdout 第一行 → JSON.parse → {url, port, pid}
   超时 startTimeoutMs(20s) → 报错并 kill 子进程
```

**坑**：sidecar 的 ready 是 stdout **第一行**。插件的解析实现一旦改成「逐行找 JSON」，遇到 `--foreground` 之外的前置输出就会卡满 20 秒。

## 上报管线的降级策略

三类上报（tool span / file change / llm usage）全部包在 try/catch 里：失败只记一次 warn，**绝不向外抛**。原因：观测是附属品，不能因为 sidecar 抖一下就让用户的 `write` 工具失败。
`reportToolCalls / reportChanges / reportLlmCalls / reportContext` 四个开关可分别关掉（排查性能问题时先关这三个）。

## `agent/status` 回写的两个陷阱

1. **settle 窗口**：子会话在两次 turn 之间会短暂没有活动，直接判 `idle` 会导致重复派活。所以要等 `agentIdleSettleMs`。
2. **维护期**：宿主在做 maintenance 时会发状态事件，这不是真的空闲，必须忽略，否则派出去的任务会卡死。

## 派发保底泵（`agentDispatchMs`）

`team_task` 正常会立即派发；但如果成员当时正好在切换状态，任务可能悬着。这个泵周期性调一次派发，`team_dispatch` 工具也走同一条路径——**成员 idle 却没活时，先手动泵一次再怀疑别的**。

## 上下文/工作区/模型目录泵

- 上下文泵：把当前会话的占用（token/消息数）写 `context_snapshot`，面板 Context 视图用。
- 工作区泵：把 workspace 变更登记进 `workspace` / `file_state`。（注意：当前版本该泵为**占位**，若要做实时索引需补实现。）
- 模型目录泵：把宿主 enabled 路由同步进 `llm_provider` / `llm_route`，供 `team_models` 与面板 Models 视图读。

## 文件改动 diff（`changes.js`）

`FILE_TOOLS` 白名单决定哪些工具会被算作「文件改动」。新增文件类工具必须加进白名单，否则面板的 Change 视图看不到。
`displayPath` 会把绝对路径转成 workspace 相对的展示路径；`countDiff` 统计增删行。

## 计价（`pricing.js`）

`isPeakTime(ts)` 用 `HOLIDAY_RANGES` 与时段表判定是否峰值；`resolveTable(provider, model)` 找计价表（可被 config 的 `pricingTables` 覆盖）；`priceUsage` 输出分项与合计。
计价是**估算**，不替代账单。

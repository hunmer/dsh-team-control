# dsh-plugin 实现要点

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

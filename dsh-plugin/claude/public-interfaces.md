# 工具面与生命周期

## 12 个 `team_*` 工具（`index.js` `buildTools`）

| 工具 | 行号 | 关键参数 | 语义 |
|---|---|---|---|
| `team_create` | :1030 | `name`、`workspace`、`runtime:"worker"\|"agent"`、`maxMembers`、`maxConcurrency`、`failurePolicy`、`maxAttempts` | 建团队。`runtime` 决定成员是什么 |
| `team_spawn` | :1068 | `teamId`、`name`、`role`、`agentProvider`、`model`、`reasoningEffort`、`contextMode`、`prompt`、`description` | 加成员。agent 团队按难度选便宜/强推理路由 |
| `team_models` | :1179 | 无 | 列出宿主已启用的 provider/model 路由 |
| `team_status` | :1219 | `teamId`、`detail:"summary"\|"dag"` | 成员快照或任务 DAG（含依赖/就绪/关键路径） |
| `team_task` | :1267 | `teamId`、`subject`、`plan`、`assignee`、`deps[]`、`acceptance`、`priority`、`dispatch` | 建 DAG 节点。worker 的 `plan` 是代理动作；agent 的 `plan` 是简报 |
| `team_send` | :1326 | `teamId`、`to`(名字/`*`)、`message`、`correlationId` | 投消息（agent 进子会话信箱，worker 在步边界读） |
| `team_todo` | :1395 | `teamId`、`taskId`、`items[]`、`by` | 任务清单，落 sidecar，面板可见 |
| `team_report_task` | :1433 | `teamId`、`taskId`、`status:"done"\|"failed"\|"blocked"`、`summary` | 成员交卷：推进 DAG、释放成员、套用失败策略 |
| `team_dispatch` | :1471 | `teamId` | 手动泵一次派发器（成员 idle 却没收到活时用） |
| `team_scope` | :1487 | `action:"list"\|"request"\|"decide"`、`domain`、`target`、`requestId`、`decision`、`ttlSeconds` | 四域越界申请的查看/发起/裁决 |
| `team_control` | :1557 | `action:"interrupt"\|"resume"\|"assign"`、`memberId`、`taskId`、`teamId` | 中断/恢复/指派 |
| `team_report` | :1600 | `teamId` | 导出 Markdown 运行报告（成员/任务/DAG/决策/audit 前后哈希） |

> `README.md` 与 `skills/dsh-agent-team/SKILL.md` 仍写「11 个」——`team_todo` 后加，文档待同步。

## 插件元信息

```js
export const name = 'dsh-team'
export const inject = ['tools']
```

`cordis.patch.yml`：
```yaml
insert:
  id: dsh-team
  name: dsh-team-control
  config: { baseUrl: 'http://127.0.0.1:4317', autoStart: true }
```

## `apply(ctx, config)` 做的事

1. `resolveConfig(config)` → 归一 `baseUrl/port/home/autoStart/entry/...`（键表见 [根目录依赖与配置](../../claude/dependencies-and-config.md)）。
2. `ctx.effect(...)` 注册 12 个工具。
3. `ctx.inject(['skills'])` 注册 skills provider（rank 600，目录 `skills/`）——模型因此能看到 `dsh-agent-team` 技能。
4. `ensureSidecar()`：`autoStart` 时 spawn `bin/dsh-team.mjs up`，等第一行 ready JSON，超时 `startTimeoutMs`（20s）。
5. 挂事件钩子（见下）。
6. 起 5 个泵。

## 事件钩子

| 钩子 | 作用 |
|---|---|
| `ctx.on('tools/execute')` | 工具调用 → span；文件类工具 diff → `member_change`；todo 镜像到 sidecar |
| `ctx.on('llm/stream')` | 记 token 用量，按 `pricing.js` 算费用 |
| `ctx.on('llm/adapters-updated')` | 重同步模型目录 |
| `ctx.on('agent/status')` | 回写 `running`/`idle`；`idle` 有 settle 窗口，维护期（maintenance）忽略 |
| `ctx.on('session/event')` | 抓 assistant/message 正文、turn/end 的错误 |

## 泵

心跳（`agentHeartbeatMs`）、上下文（`contextReportMs`）、工作区（`workspaceReportMs`）、模型目录（`llmCatalogMs`）、派发保底（`agentDispatchMs`，`agentAutoDispatch` 开关）。

## agent 成员派发时序（插件侧）

```text
team_task(dispatch:true) → sidecar 原子认领（task→running + event）
  → 插件 subagents.startActivation(...) 拿到 agentSessionId
  → subagents.sendMessage(agentSessionId, 简报)   // 简报必须自包含
  → 成员干活，最后调 team_report_task
  → sidecar 推进 DAG → 派发下一个
```

成员**看不到 Lead 的对话**，所以 `prompt`/简报必须写清：teamId、任务、workspace、以及「结束时调 team_report_task」。

## 辅助文件

- `changes.js`（168 行）：`FILE_TOOLS = ['write','edit','apply_patch','str_replace_editor','multi_edit']`；`unifiedDiff`、`countDiff`、`targetFile`、`displayPath`、`changeKind`、`readTextSafe`、`lineOps`。
- `pricing.js`（165 行）：`HOLIDAY_RANGES`、`expandHolidayRanges`、`isPeakTime`、`DEFAULT_PRICE_TABLES`、`resolveTable`、`resolveRate`、`priceUsage`（峰值时段计价）。
- `locale/{zh,en}.json`：只有 `meta.title` / `meta.description`。

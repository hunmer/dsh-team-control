# 工具面与生命周期

## 24 个工具（20 个 `team_*` + 4 个 `board_*`，`index.js` `buildTools`）

| 工具 | 关键参数 | 语义 |
|---|---|---|
| `team_create` | `name`、`workspace`、`permissionPreset`、`agentPreset`、`maxMembers`、`maxConcurrency`、`failurePolicy`、`maxAttempts` | 建团队 + 团队级默认预设 |
| `team_spawn` | `teamId`、`name`、`prompt`、`role`、`permissionPreset`、`agentPreset`、`agentProvider`、`model`、`reasoningEffort`、`contextMode`、`description` | 拉起真 sub-agent 成员；按成员覆盖预设 |
| `team_member` | `action:"update"\\|"retire"\\|"remove"`、`memberId`、`model`、`agentProvider`、`contextMode`、`reasoningEffort`、`agentPreset`、`permissionPreset`、`role`、`confirm` | 改配置（模型/上下文会重建子会话）/retire/remove 成员 |
| `team_preset` | `action:"list"\|"save"\|"show"`、`id`、`name`、`plugins[]`、`order` | Leader 自建 agentPreset：写固定目录并即时注册 |
| `team_models` | 无 | 列出宿主已启用的 provider/model 路由；每个模型附带 `providerNote`（厂商级备注）与 `note`（单模型备注） |
| `team_status` | `teamId`、`detail:"summary"\|"dag"` | 成员快照（含两个预设）或任务 DAG |
| `team_task` | `teamId`、`subject`、`plan`、`assignee`、`deps[]`、`acceptance`、`priority`、`dispatch` | 建 DAG 节点；`plan` 是给成员的简报 |
| `team_task_get` | `taskId`、`teamId`（可选，校验归属） | 单任务状态（status/attempts/plan）+ 它的 DAG 节点（`dependsOn`/`ready`/`blockers`） |
| `team_send` | `teamId`、`to`（名字/`*`/`lead`）、`message`、`correlationId`、`interrupt`（默认 true） | 投消息（成员 → 子会话；给 lead 只落信箱）；目标在跑时先 `subagents.interrupt` 打断当前回合再投递，`interrupt:false` 退回 step 边界投递 |
| `team_todo` | `teamId`、`taskId`、`items[]`、`by` | 任务清单，落 sidecar，面板可见 |
| `team_report_task` | `teamId`、`taskId`、`status:"done"\|"failed"\|"blocked"`、`summary` | 成员交卷：推进 DAG、释放成员、套用失败策略 |
| `team_dispatch` | `teamId` | 手动泵一次派发器 |
| `team_approve` | `teamId`、`requestId`、`decision:"allow"\|"deny"`、`reason` | Lead 裁决成员审批；返回宿主 `allowed-once` / `rejected` |
| `team_control` | `action:"interrupt"\|"resume"\|"assign"\|"abort"`、`memberId`、`taskId`、`teamId` | 中断（任务转 paused）/恢复/指派/作废任务（aborted，不重试） |
| `team_report` | `teamId` | 导出 Markdown 运行报告（成员/任务/DAG/审批/audit） |
| `team_memory_write` | `teamId`、`key`、`value`、`scope:"member"\|"team"`、`kind`、`title`、`tags[]`、`visibility`、`expectedVersion`、`taskId` | 写一条文件型记忆（按 scope+key upsert 并 bump version） |
| `team_memory_read` | `teamId`、`memoryId` 或 `scope`+`key`、`memberId` | 读一条记忆（含完整 value 与 version） |
| `team_memory_list` | `teamId`、`scope`、`memberId`、`kind`、`tag`、`q`、`limit` | 列记忆元数据（不含 value 正文） |
| `team_memory_share` | `teamId`、`memoryId`、`visibility:"private"\|"team"\|"shared"` | 改记忆可见性（Lead 把成员记忆转给其他成员） |
| `team_memory_delete` | `teamId`、`memoryId` | 永久删除一条记忆 |
| `board_task_create` | `title`、`description`、`workspaceId`、`workspacePath`、`auto`、`needPlan`、`useTeam`、`executionMode`、`gitBranch` | 成员/Lead 在会话里直接建看板任务；`workspaceId` 省略时按 by-session → 唯一工作区推断 |
| `board_task_get` | `taskId`（可选） | 读看板任务；省略 `taskId` 时返回当前会话关联的任务 |
| `board_plan_submit` | `plan`、`summary` | 规划会话提交计划：看板任务 `planning → planned`，same 模式同时绑定执行会话 |
| `board_task_status` | `status:"done"|"failed"|"inprogress"`、`summary` | Lead 会话回报看板任务结果 |

权限与审批不在工具里判定：`permissionPreset` 由插件 `ctx.permissionPresets.set(session, name)` 落到子会话，
成员审批由 `ctx.on('approval/request', …)` 转发给 Lead。

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
2. `ctx.effect(...)` 注册 14 个 `team_*` + 2 个 `board_*` 工具。
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

心跳（`agentHeartbeatMs`）、上下文（`contextReportMs`）、工作区（`workspaceReportMs`）、模型目录（`llmCatalogMs`）、派发保底（`agentDispatchMs`，`agentAutoDispatch` 开关）、强制停止（`forceStopPollMs`，轮询 `interrupted` 成员并调 `subagents.interrupt`）、steer 队列投递（`steerPollMs`，把面板排进 sidecar 的 `kind='steer'` 消息推进成员会话）。

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

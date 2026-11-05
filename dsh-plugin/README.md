# dsh-team-control

把本仓的 **dsh-team sidecar** 暴露为 DSH 模型可调用工具的 Host 插件（bundle）。

- 编排内核仍在 sidecar 进程里（[`../src/`](../src/)），本插件只做**适配 + 生命周期**，不重写调度/事件流。
- 零第三方依赖：只用 Node 内置模块；工具以普通 `ToolDefinition` 对象注册（JSON Schema 参数），不依赖 `defineTool`。
- 13 个工具：`team_create` `team_spawn` `team_preset` `team_models` `team_status` `team_task` `team_send` `team_todo` `team_report_task` `team_dispatch` `team_approve` `team_control` `team_report`。

## 调用顺序写在哪（别让模型自己摸）

- 13 个工具里**只有 `team_create` 标了 `START HERE`**：它的 description 直接给出 5 步顺序、`permissionPreset` 的语义、
  以及 `teamId` 取自 `result.team.id`；`team_spawn` 写明返回的 `member.id` 就是后面 `assignee` 要的值；
  `team_task` 写明简报必须自包含（成员看不到 Lead 的对话）。模型只看工具面就能按序走。
- 完整配方（字段陷阱、拆任务与并发、症状→修法表）在 skill **`dsh-agent-team`**：[`../skills/dsh-agent-team/SKILL.md`](../skills/dsh-agent-team/SKILL.md)。
  本插件启动时把这个目录注册成 skills provider（`name: 'dsh-team'`，rank 600），**装上插件即出现在会话技能目录**，无需 cp；`team_create` 描述末尾也指向它。

## 成员 = 真 DSH sub-agent

`team_spawn` 用 `subagents.startActivation` 拉起一个子会话，成员用自己的模型与工具干活；sidecar 只做任务/DAG/审批/看板：

1. `team_spawn` → 解析并下发权限预设、解析 `agentPreset` → `subagents.startActivation({delivery:'parent', childId, provider, label, request:{prompt, parent, cwd: team.workspace, agentOptions?, agentPreset?}})` → 把子会话 id 作为 `sessionId` `POST /api/agents/register`，成员出现在看板上。
2. 建任务/依赖满足 → 插件调度器（`agentDispatchMs`，默认 1.5s 一跳）调 `POST /api/agents/dispatch` **原子认领**一条 ready 任务 → `subagents.sendMessage(lead, sessionId, [{type:'text', text: 任务简报}])` 把任务发进该成员的信箱。
3. 成员干完 → 自己调 `team_report_task`（精确摘要/成败，`/api/agents/report`），或由 `agent/status` 事件在回合结束时兜底收尾（`/api/agents/status`）。
4. 成员报 `blocked` 时任务退回 `blocked`（**不消耗重试**），阻塞原因进 `blockers` 与 `/api/blockers`。
5. 成员的 session 工具调用由 `tools/execute` 上报为 span；sidecar 用 `member.agent_session_id` 把这些 span 挂到成员节点下。

`team_control`：`interrupt` 先落库 `interrupted` 再把任务退回 `ready`，然后 `subagents.interrupt` 中止成员当前回合；`resume` 重新武装并按需再派发。

## 权限：Leader 按成员分配 DSH 权限预设

插件**不做权限判定**，也不碰文件/进程/网络。每个成员启动时用宿主的 `permissionPresets.set(session, name)` 下发预设：

- `team_create.permissionPreset`：团队默认值（默认 `workspace-write`）。
- `team_spawn.permissionPreset`：成员覆盖；不传则继承团队。
- 返回值里的 `permissionPresetApplied` 表示是否真的写进子会话；宿主没有这个服务或预设名未知时给 `permissionPresetWarning`，不阻断派发。

`agentPreset` 是另一套（组合：工具/skill/MCP + 系统提示词）：团队默认 + 成员覆盖，用宿主 `agentPresets.list()` 校验；
只在 `contextMode: 'fresh'` 时透传给 `startActivation`，`fork` 继承父方组合并返回 `agentPresetWarning`。

内置预设不够用时，`team_preset({action:"save", id, plugins})` 把组合写到 `~/.dsh/team/presets/<id>.json`
（`presetDir` / `DSH_TEAM_PRESET_DIR` 可改）并立刻 `agentPresets.register()`，无需重启；插件启动时会重新加载该目录。
`list` 会标出 `host`/`team` 来源，`show` 可读回文档，`delete` 删团队自建；宿主内置 id 不允许覆盖。
- 预设名在 `team_create` / `team_spawn` 时按宿主 `names` 校验，错误信息带可用预设列表。

## 审批：成员 → Lead 的 `team_approve`

成员触发的宿主审批不会静默失败，而是转发给 Lead：

1. 全局监听 `approval/request`；请求的 agent 不属于任何团队成员 → 交给后面的 handler（`next()`）。
2. 属于成员 → `POST /api/approvals` 镜像一条 pending，并 `subagents.sendMessage` 通知 Lead，文本含 `requestId`、成员、工具、原因与 `team_approve` 调用示例。
3. Lead 调 `team_approve {teamId, requestId, decision: allow|deny, reason?}` → 插件 resolve 为 `allowed-once` / `rejected`，同时把 sidecar 记录改成 allowed/rejected。
4. 超过 `approvalTimeoutMs`（默认 10 分钟）自动拒绝并标记 expired；成员回合被取消时按 cancelled 处理。

## 模型路由（每个成员不同的 provider / model / effort）

目录的**唯一来源**是 Host 进程的 `ctx.llm`：`listProviders()` + `listModels(provider)`。只上报**能列出模型**的 provider。
插件把这份映射快照 `POST /api/llm/catalog` 给 sidecar（30s 节流，`llm/adapters-updated` 事件会重置节流）；
sidecar 只存映射、启用开关和备注，**不代理 LLM 请求、不保存凭据**。

- 面板「模型路由」页：按 provider 分组，逐条启用/停用、写备注；停用项不会出现在 `team_models` 里。
- `team_spawn`：`agentProvider` + `model` 指定 LLM route；`reasoningEffort` 是 adapter 定义的不透明 id。
  实际生效的 route 必须在启用集合里，否则报「模型路由未启用 / 所有模型路由都已停用」。
- 实际生效值写进 `request.agentOptions`，返回值 `agent.route` 与 sidecar 成员记录的 `model` 用真实 model id。

## 安装

```bash
dsh plugin --profile web add dsh-team-control
```

装完重启 DSH，工具面出现 13 个 `team_*` 工具；`autoStart` 会自己拉起 sidecar。
本地开发也可以按绝对路径装：`plugin_manager(action: "install_bundle", target: "<repo>/dsh-plugin")`。
卸载：`dsh plugin --profile web remove dsh-team-control`。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-team
      name: 'dsh-team-control'
      config:
        baseUrl: http://127.0.0.1:4317
        autoStart: true
        reportToolCalls: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:4317` | sidecar 地址；端口从这个 URL 推导 |
| `autoStart` | `true` | sidecar 不可达时，首次工具调用自动拉起 `dsh-team up` |
| `home` | `~/.dsh/team` | 数据目录（`team.db` / `token`）；必须与 sidecar 一致 |
| `sidecarEntry` | `../bin/dsh-team.mjs` | sidecar 入口；默认按包位置推导，无需配置 |
| `startTimeoutMs` | `20000` | 自动拉起的等待上限 |
| `requestTimeoutMs` | `60000` | 单次 API 调用超时 |
| `approvalTimeoutMs` | `600000` | 成员审批等待 Lead 的上限；超时自动拒绝 |
| `reportToolCalls` | `true` | 监听 `tools/execute`，把每次工具调用上报为 `POST /api/spans` 的 span |
| `traceInputMax` | `1200` | 上报参数/结果预览的截断长度（字符） |
| `agentAutoDispatch` | `true` | 调度器自动把 ready 任务派给 idle 成员 |
| `agentDispatchMs` | `1500` | 调度器跳间隔 |
| `steerPollMs` | `1200` | steer 队列投递泵间隔（面板排队消息 → 成员会话） |
| `agentDispatchMax` | `16` | 每跳最多认领的任务数 |
| `agentSettleMs` | `250` | 建任务后的「声明依赖」窗口（sidecar 侧是 200ms） |
| `freshProvider` | `spawn` | `subagents.startActivation` 的 provider（`context: fresh`） |
| `forkProvider` | `fork` | `subagents.startActivation` 的 provider（`context: fork`） |

> 上报采用「会话 → 团队」绑定：任意一次带 `teamId` 的 `team_*` 调用、或 `team_create` 成功后，该会话后续的
> 工具调用都会挂到对应团队；未绑定团队的工具调用直接丢弃。

> 本插件**不导出 `Config` schema**，`Config.listConfigs` 的 `status` 是 `absent`；代码侧已做默认值兜底。

## 生命周期

- 插件**只回收自己拉起的** sidecar 子进程（`ctx.effect` 的 disposer 里 kill）；用户手工起的服务不受影响。
- sidecar 是 DSH Host 的子进程：Host 退出后它可能存活，下次工具调用会用健康检查复用；
  要彻底停：`node bin/dsh-team.mjs down`，或把 `autoStart` 设为 `false`。
- 成员的文件/进程/网络边界完全由 DSH 权限预设与宿主沙箱执行；插件与 sidecar 都不是权限执行点。

## 面板位置

本包只提供**工具面**。界面在配套的 [`dsh-team-control-ui`](../dsh-plugin-ui/)：一个注册在
`settings.plugins.tab` 的 React 页面（设置 → 插件 → dsh-team 控制台），经 Host 同源代理读取
sidecar。独立的 `{baseUrl}/panel` 仍然保留。

## 自测

```bash
node tests/run-all.mjs
node tests/plugin-approval.mjs
```

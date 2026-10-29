# @local/dsh-team-plugin

把本仓的 **dsh-team sidecar** 暴露为 DSH 模型可调用工具的 Host 插件（bundle）。

- 编排内核仍在 sidecar 进程里（[`../src/`](../src/)），本插件只做**适配 + 生命周期**，不重写调度/权限/事件流。
- 零第三方依赖：只用 Node 内置模块；工具以普通 `ToolDefinition` 对象注册（JSON Schema 参数），不依赖 `defineTool`。
- 11 个工具：`team_create` `team_spawn` `team_models` `team_status` `team_task` `team_send` `team_report_task` `team_dispatch` `team_scope` `team_control` `team_report`。

## 调用顺序写在哪（别让模型自己摸）

- 11 个工具里**只有 `team_create` 标了 `START HERE`**：它的 description 直接给出 5 步顺序、`runtime` 的语义与后果
  （不传 `runtime:"agent"` 就是 worker，成员不会思考）、以及 `teamId` 取自 `result.team.id`；`team_spawn` 写明返回的
  `member.id` 就是后面 `assignee` 要的值；`team_task` 写明简报必须自包含（成员看不到 Lead 的对话）。模型只看工具面就能按序走。
- 完整配方（字段陷阱、拆任务与并发、症状→修法表）在 skill **`dsh-agent-team`**：[`../skills/dsh-agent-team/SKILL.md`](../skills/dsh-agent-team/SKILL.md)，
  安装到 `~/.dsh/skills/dsh-agent-team/SKILL.md` 后出现在会话技能目录；`team_create` 描述末尾也指向它。

## 两种成员运行时

`team_create` 的 `runtime` 决定「成员」是什么：

| `runtime` | 成员实体 | 谁执行任务 | sidecar 的角色 |
|---|---|---|---|
| `worker`（默认） | sidecar 拉起的沙箱 Node 进程 | `plan` 的每个 step 是一个经 broker 代理的动作 | 派发 + 四域审批 + 事件真相源 |
| `agent` | **真 DSH sub-agent session**（`subagents.startActivation`） | 成员用自己的模型与工具干活 | 只做任务/DAG/审批/看板（不启动任何进程） |

> 依赖宿主的 `subagents` 服务（`dsh-subagent` bundle，几乎总在）。插件用 `ctx.get('subagents')` 探测而不是
> `inject` 硬依赖：没有它时只有 `runtime: "agent"` 相关调用会报「subagents 服务不可用」，worker 团队照常。

`agent` 运行时的闭环（全部在插件内，无轮询工具调用）：

1. `team_spawn` → `subagents.startActivation({delivery:'parent', childId, provider, label, request:{prompt, parent, cwd: team.workspace, agentOptions?}})` → 把子会话 id 作为 `sessionId` `POST /api/agents/register`，成员出现在看板上并置 `idle`。`agentOptions` 只在显式指定 provider/model/reasoningEffort 时出现（见下节）。
2. 建任务/依赖满足 → 插件调度器（`agentDispatchMs`，默认 1.5s 一跳）调 `POST /api/agents/dispatch` **原子认领**一条 ready 任务 → `subagents.sendMessage(lead, sessionId, [{type:'text', text: 任务简报}])` 把任务发进该成员的信箱。
3. 成员干完 → 自己调 `team_report_task`（精确摘要/成败，`/api/agents/report`），或由 `agent/status` 事件在回合结束时兜底收尾（`/api/agents/status`）。
4. 成员报 `blocked` 时任务退回 `blocked`（**不消耗重试**），阻塞原因进 `blockers` 与 `/api/blockers`。
5. 成员的 session 工具调用由 `tools/execute` 上报为 span；sidecar 用 `member.agent_session_id` 把这些 span 挂到成员节点下，瀑布里就是 `成员 → 工具` 两层。

`team_control`：`agent` 团队的 `interrupt` 调 `subagents.interrupt` 中止当前回合并同步落库 `interrupted`；`resume` 重新武装并按需再派发。

## 模型路由（每个成员不同的 provider / model / effort）

目录的**唯一来源**是 Host 进程的 `ctx.llm`：`listProviders()`（`{id,name}`）+ `listModels(provider)`
（`{provider,id,name,description?,inputModalities?}`），`listConfigurableProviders()` 里未配置的 provider 也以
`source:"dormant"` + `error` 保留。插件把这份映射快照 `POST /api/llm/catalog` 给 sidecar（30s 节流，
`llm/adapters-updated` 事件会重置节流）；sidecar 只存 provider/model 映射、启用开关和备注，**不代理 LLM 请求、
不保存凭据**，所以面板独立打开（`:4317/panel`）也能用。

- 面板「模型路由」页：按 provider 分组，逐条启用/停用、写备注；停用项不会出现在 `team_models` 里。
- `team_models`：只列**启用**的路由（`provider`/`model`/`name`/`description`/`note`/`modalities`），并带一条用法提示。
- `team_spawn`：`agentProvider` + `model` 指定 LLM route（与 subagent 后端的 `provider` 参数无关）；
  `reasoningEffort` 是 adapter 定义的不透明 id。实际生效的 route（显式指定或继承 Lead）必须在启用集合里，
  否则报「模型路由未启用 / 所有模型路由都已停用」；目录里查不到的 route 不拦。
- 实际生效值写进 `request.agentOptions = {provider?, model?, reasoningEffort?}`（只放有值的字段），
  返回值 `agent.route` 与 sidecar 成员记录的 `model` 用的也是真实 model id。
- 继承规则与 DSH 一致：route 变了又没显式给 effort → 丢弃继承的 effort（返回值里是 `null`）；
  route 不变 → 沿用 Lead 的 effort。`model` 在 worker 团队只是展示标签。

## 安装

在 DSH 里用 `plugin_manager` 安装本目录（绝对路径），它会写 profile 的 `dependencies`（`link:`）与 `dsh.profile.bundles`：

```text
plugin_manager(action: "install_bundle", target: "C:\\...\\agent-team-plugin\\dsh-plugin")
```

期望结果：`application: "applied"`、`warnings: []`，随后工具面出现 11 个 `team_*` 工具。
安装后可用 `cordis_inspect_query` 的 `Tool.listTools` / `Config.listConfigs` 复核（无需审批）。
卸载：`plugin_manager(action: "remove_bundle", target: "@local/dsh-team-plugin")`。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-team
      name: '@local/dsh-team-plugin'
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
| `reportToolCalls` | `true` | 监听 Host 的 `tools/execute`，把每次工具调用上报为 `POST /api/spans` 的 span（先 `running` 后 `done/failed`），面板 Trace 瀑布实时展示 |
| `traceInputMax` | `1200` | 上报参数/结果预览的截断长度（字符）；只截断，不脱敏其他字段 |
| `agentAutoDispatch` | `true` | `agent` 团队：调度器自动把 ready 任务派给 idle 成员 |
| `agentDispatchMs` | `1500` | 调度器跳间隔；每次只认领少量任务，避免同时唤醒全部成员 |
| `agentDispatchMax` | `16` | 每跳最多认领的任务数 |
| `agentSettleMs` | `250` | 建任务后的「声明依赖」窗口（sidecar 侧是 200ms） |
| `freshProvider` | `spawn` | `subagents.startActivation` 的 provider（`context: fresh`） |
| `forkProvider` | `fork` | `subagents.startActivation` 的 provider（`context: fork`） |

> 上报采用「会话 → 团队」绑定：任意一次带 `teamId` 的 `team_*` 调用、或 `team_create` 成功后，该会话后续的
> 工具调用都会挂到对应团队；未绑定团队的工具调用直接丢弃（不阻塞、不等待，1.2s 超时静默失败）。

> 本插件**不导出 `Config` schema**，因此 `Config.listConfigs` 对它的 `status` 是 `absent` ——
> 这是「无 schema」而不是「配置未生效」；`dsh --profile <p> --dump-config` 可看到 row 的
> `config: {baseUrl, autoStart}` 已合成。代价是拼错的字段不会被校验，代码侧已做默认值兜底。

## 生命周期

- 插件**只回收自己拉起的** sidecar 子进程（`ctx.effect` 的 disposer 里 kill）；用户手工起的服务不受影响。
- sidecar 是 DSH Host 的子进程：Host 退出后它可能存活，下次工具调用会用健康检查复用；
  要彻底停：`node bin/dsh-team.mjs down`，或把 `autoStart` 设为 `false`。
- 工具不受 DSH 的沙箱审批约束（它们是纯 HTTP 客户端）；真正的权限边界仍由 sidecar 的四域
  PermBroker 执行，且 Worker 进程没有原生 IO 能力（见 [ADR-002](../docs/adr/ADR-002-worker-confinement.md)）。

## 面板位置

本包只提供**工具面**。界面在配套的 [`@local/dsh-team-ui`](../dsh-plugin-ui/)：一个注册在
`settings.plugins.tab` 的 React 页面（设置 → 插件 → dsh-team 控制台），经 Host 同源代理读取
sidecar。独立的 `{baseUrl}/panel` 仍然保留，适合不打开 DSH 时使用。

不把独立面板塞进 iframe 的原因：DSH 插件规范要求 UI 用 React 组件渲染在 Slot 里，
iframe 文档拿不到主题 token / 明暗切换 / `ctx.locale`。

## 自测

```bash
node dsh-plugin/test-adapter.mjs   # 临时 sidecar 上跑完建队→加成员→阻塞→审批→报告→卸载
```

该脚本不依赖演示实例，覆盖注册契约、真实 API 调用、错误文案与卸载清理。

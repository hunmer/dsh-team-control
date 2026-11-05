# dsh-team 实现契约（v2：权限预设 + 审批转发）

> 本文件是 `src/**`、`src/web/**`、`bin/**`、`tests/**` 的**唯一口径**。任何与本文件不符的实现都是 bug。
> 需求来源：`prd/agent-team-plugin-prd.md` v1.0；优先级：C1-C5 > 验收标准 AC-* > 功能描述。

---

## 0. 五条硬约束的**可执行**语义

| # | 约束 | 本实现中的强制点 | 如何被验证 |
|---|---|---|---|
| **C1** | 沙箱只由 DSH permission preset 决定 | sidecar 不做 fs/exec/net/env 判定；团队/成员只存 `permissionPreset` 名（默认 `workspace-write`）。插件在子会话创建后调 `ctx.permissionPresets.set(session, name)`；宿主缺失该服务时返回 `permissionPresetApplied:false` + 警告，成员按宿主默认权限运行。 | `tests/plugin-agent.mjs` 断言 `presets.set` 调用；`tests/ac-15-agent-runtime.mjs` 断言团队/成员预设落库与覆盖 |
| **C2** | `event` 只增不改；`member_state` 能由 event 完全重建 | `append()` 是唯一写入口：同一事务内 `INSERT event`(seq 由 max+1 分配) + upsert `member_state`。`rebuild()` 只读 event 生成投影。`member_state.seq == max(event.seq)` 否则 `stale=1`。 | `tests/ac-*` 含 rebuild 对账：`progress 事件数 == member_state.seq`，逐字段深比较 |
| **C3** | 审批只由宿主产生，sidecar 只镜像 | 成员命中 preset 的 `ask` 策略时，DSH 发 `approval/request`；插件把它转给 Lead 并阻塞等待 `team_approve`，返回宿主 `allowed-once` / `rejected`。sidecar 的 `approval` 表只记录镜像与决策审计，**不参与放行**。 | `tests/plugin-approval.mjs`：allow→`allowed-once`、deny→`rejected`、非成员放行原链路；`tests/ac-17-approval.mjs`：镜像/指标/报告 |
| **C4** | 决策审计必须可回放 | `POST /api/approvals` 幂等登记 pending；`POST /api/approvals/{id}/decide` 写状态 + `approval.request`/`approval.decide` 事件。超时/中断在插件侧也会镜像 `expired`/`cancelled`。 | `tests/ac-17-approval.mjs`：pending→allowed/rejected、metrics、report；`tests/ac-13`：原因/工具名脱敏 |
| **C5** | 中断必须**同步**写状态，禁止残留 `running` | `interruptMember()` 同步事务：`member.status=interrupted` + `agent.interrupt` 事件 + 在途任务转 `paused`（不计 attempts、不触发 failurePolicy、不自动重派）；提交后才通知 Host `subagents.interrupt`。API 返回即已落库。 | `tests/ac-08`：interrupt 返回后立即 GET 必须 `interrupted`（<100ms），任务为 `paused` 且 `attempts` 不变 |

补充：sidecar **不判定**任何权限；它只保存预设名、镜像审批结果。成员是真的 DSH 子会话，进程生命周期归 Host/DSH。

---

## 1. 形态与运行

- 单进程 sidecar，默认监听 `127.0.0.1`，端口默认 `4317`（`--port 0` 取随机端口）。要求 Node ≥ 22.15（`node:sqlite` + 同步 `module.registerHooks`）。
- 数据目录（默认 `~/.dsh/team`，可用 `DSH_TEAM_HOME` 覆盖）：
  ```
  <home>/token              # 兼容保留（首次启动生成，服务端已不校验）
  <home>/team.db            # SQLite（WAL）+ team.db-wal/shm
  <home>/run/sidecar.json   # {pid,port,url,startedAt}
  ```
- 启动横幅：**stdout 第一行必须是单行 JSON**，供测试/CLI 解析：
  ```json
  {"event":"ready","url":"http://127.0.0.1:4317","port":4317,"pid":1234,
   "dataDir":"C:\\...\\team","token":"<token>","tokenFile":"C:\\...\\token","panel":"http://127.0.0.1:4317/panel#token=<token>"}
  ```
  之后 stdout 只输出结构化日志行（`{"ts","level","msg",...}`）。
- 环境变量：`DSH_TEAM_HOME`、`DSH_TEAM_PORT`、`DSH_TEAM_TOKEN`、`DSH_TEAM_WORKSPACE`。
- 鉴权：已移除——`/api/**`（含 SSE）与 `/panel` 均**免 token** 直接访问；sidecar 仅监听 `127.0.0.1`，暴露远端需外层访问控制。`token` 文件与启动横幅字段保留（兼容旧工具），带 `Authorization: Bearer` / `?token=` 的请求也照常接受。

**CLI**（`bin/dsh-team.mjs`，`package.json` 的 `bin.dsh-team`）：

```
dsh-team up [--port N] [--data DIR] [--foreground]
dsh-team down
dsh-team status <team> [--json]
dsh-team dag <team> [--json]
dsh-team logs <member> [-f] [--since N]
dsh-team approvals <team> [--status pending|allowed|rejected] [--json]
dsh-team report <team> [-o run.md]
```
CLI 通过 `<home>/run/sidecar.json` 发现端口，读 `<home>/token` 鉴权；`--url/--token` 可覆盖。

---

## 2. 枚举（唯一真相）

- `member.status`：`queued | provisioning | idle | running | blocked | done | failed | interrupted | retired`
- `task.status`：`pending | ready | running | paused | done | failed | skipped | blocked | aborted`（`paused` 等待 Lead 处置；`aborted` 为不可重试终态）
- `board.task.status`：`todo | planning | planned | inprogress | done | failed`（看板任务，独立于 team 内 DAG 的 `task.status`）
- `approval.status`：`pending | allowed | rejected | cancelled | expired`
- `dep.condition`：`all_success | any_success | on_failure | artifact_exists`
- `phase`（event）：`init | read | write | exec | net | env | msg | wait | verify | interrupt | resume | done | fail | decision | recover`
- `domain`：`fs | exec | net | env`
- `ops`：fs `read|write|delete|rename|list`；exec `spawn`；net `connect`；env `read|write`
- SSE `event`：`member.status | step.append | task.state | task.dispatch | message.delivered | approval.request | approval.decide | span.append | artifact.added | change.added | context.update | board.task`
- 错误码：`E_DENIED | E_UNAUTHORIZED | E_NOT_FOUND | E_CONFLICT | E_VERSION | E_TIMEOUT | E_BAD_REQUEST | E_QUOTA | E_INTERRUPTED | E_CYCLE | E_INVALID_STATE`

---

## 3. REST

统一返回：成功为对象本体（**单资源端点直接返回该对象**，如 `POST /api/teams` 返回 team 本体，不再包一层 `{team}`）；列表端点返回 `{"asOf":"<ISO>","version":<int>,"items":[...]}`。
失败 `{"error":{"code","message","detail"}}` + 对应 4xx/5xx。

### 3.1 团队
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/teams` | `{name, workspace, permissionPreset?, agentPreset?, maxMembers?, maxConcurrency?, failurePolicy?, maxAttempts?, leadSessionId?}` | `{team}`；`maxMembers` 默认 64，`0`=不限；`permissionPreset` 默认 `workspace-write` |
| `GET /api/teams` | `?archived=1` 只列已封存 | `{items:[team]}`；默认排除已封存，并触发一次自动封存扫描 |
| `GET /api/teams/{id}` | — | `{team}` |
| `PATCH /api/teams/{id}` | 任意可改字段 | `{team}` |
| `POST /api/teams/{id}/stop` | `{reason?}` | `{team, stopped:[memberId]}`；中断所有 running/provisioning/blocked 成员、在途任务转 `paused`，团队与成员保留；Host 插件随后真正 `subagents.interrupt` 被中断成员的会话 |
| `POST /api/teams/{id}/archive` | `{}` | `{team}`；先停止活跃成员再写 `archivedAt`（团队从默认列表消失，可在设置中恢复） |
| `POST /api/teams/{id}/restore` | `{}` | `{team}`；清空 `archivedAt`，团队回到默认列表 |
| `DELETE /api/teams/{id}?confirm=1` | `confirm=1` 必填，否则 `400` | `{removed,id,name}`；物理删除团队及其 member/task/dep/event/approval/message/todo/audit/span/artifact/change/context（库无外键，手工级联） |

`team` = `{id,name,workspace,permissionPreset,agentPreset,maxMembers,maxConcurrency,failurePolicy,maxAttempts,createdAt,archivedAt,status,memberCount,runningCount,blockedCount}`
`status` = `running | blocked | idle | empty`（按成员状态聚合：有 running/provisioning → `running`；否则有 blocked → `blocked`；否则有在职成员 → `idle`；否则 `empty`）
团队成员统一是 **真 DSH sub-agent session**（Host 插件通过 `subagents.startActivation` 拉起），sidecar 只做任务/DAG/审批/看板的真相源（§3.8）；不存在 worker 运行时。
`workspace` 必须是已存在目录的绝对路径；所有 fs 相对路径、glob、exec cwd 都以它为根。

### 3.2 成员
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/teams/{id}/members` | `{name,role?,model?,contextMode?,permissionPreset?,agentPreset?}` | `{member}`；超 `maxMembers` → `status=queued`（**不是报错**） |
| `GET /api/teams/{id}/members` | — | `{items:[member]}` |
| `GET /api/members/{id}` | — | `{member}` |
| `PATCH /api/members/{id}` | `{role?,model?,agentProvider?,contextMode?,reasoningEffort?,permissionPreset?,agentPreset?}` | `{member}`；只改元数据并写 `member.update`；`running/provisioning/blocked` → `400`（先 interrupt）。真正换模型/上下文由 Host 插件重建子会话 |
| `DELETE /api/members/{id}?mode=retire\|remove` | `remove` 需 `?confirm=1`，否则 `400` | `{member}`；`retire` 保留历史，`remove` 物理删除 member 及其 state（event 保留） |
| `POST /api/members/{id}/interrupt` | `{reason?}` | `{member,task?,event}` ← **同步落库后返回**（C5）；在途任务转 `paused` |
| `POST /api/members/{id}/resume` | `{}` | `{member}`；从 `max(event.seq)` 的下一步继续 |
| `POST /api/members/{id}/assign` | `{taskId}` | `{member,task}`；仅 `idle` 可接 |

`member` = `{id,teamId,name,role,model,contextMode,agentProvider,reasoningEffort,status,permissionPreset,agentPreset,currentTaskId,step,seq,next,blockers,stale,asOf,pct,agentSessionId,parentSessionId}`
`agentSessionId`：成员对应的 DSH sub-agent SessionId（= `subagents.startActivation` 返回的子会话 id）。trace 用它把该 session 的工具 span 挂到成员节点下（§3.4.1）。
`agentProvider`：成员创建会话时实际使用的 LLM provider；`null` 表示继承 Lead。它只用于重建会话，不改变 DSH 子会话的 subagent provider。
`permissionPreset`：成员生效的 DSH permission preset 名；`null` 表示继承团队值。
`agentPreset`：成员生效的 DSH agent 组合预设 id（决定工具/skill/MCP/系统提示词）；`null` 表示继承团队值，团队也为 `null` 时沿用宿主默认。
`blockers` = `[{kind:"approval"|"dep"|"message"|"manual"|"agent", id?, detail?}]`
`pct` = 已完成 step 数 / 计划 step 总数（无计划则 `null`）。

### 3.3 任务与依赖
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/tasks` | `{teamId, subject, assignee?, plan?, acceptance?, priority?, failurePolicy?, maxAttempts?, deps?}` | `{task}` |
| `GET /api/tasks?team=` | — | `{items:[task]}` |
| `GET /api/tasks/{id}` | — | `{task}` |
| `POST /api/tasks/{id}/abort` | `{reason?}` | `{task,member?,wasRunning}`；置 `aborted` 终态，不计 attempts、不重试；running 任务顺带中断成员 |
| `POST /api/deps` | `{from, to, condition?, artifactPath?}` | `{dep}`；建图时**环检测**，环 → `400 E_CYCLE` |
| `DELETE /api/deps/{id}` | — | `{ok:true}` |
| `GET /api/dag?team=` | — | 见下 |

`plan` = `[{step:"S1", phase:"read", action:"read", target:"a.txt", op?:{...}, expect?:"OK"}]`
`op` 描述 Worker 要做的真实动作，见 §5.2。无 `plan` 的 task 由 assignee 的 `defaultPlan` 生成（`[]` 表示 Worker 只心跳）。

`dag` = `{teamId, asOf, version, nodes:[{taskId,subject,status,assignee,attempts,dependsOn:[taskId],ready:bool,blocked:bool}], edges:[{id,from,to,condition,artifactPath}], ready:[taskId], criticalPath:[taskId]}`

### 3.4 状态与事件
| 方法 路径 | 说明 |
|---|---|
| `GET /api/status?team=&member=` | 全员快照，见下 |
| `GET /api/steps?member=&since=0&limit=200` | `{items:[event]}`，`since` 为 seq 下界（exclusive） |
| `GET /api/blockers?team=` | `{items:[{memberId,kind,id,detail}]}` |
| `GET /api/events?team=&member=&lastEventId=` | **SSE**（§4） |
| `GET /api/events/history?team=&since=` | REST 兜底，同 SSE 载荷 |
| `POST /api/spans` | `{teamId, sessionId?, memberId?, spans:[span]}` → `{ok, items:[span]}`；同 `spanId` 幂等 upsert，提交后广播 `span.append` |
| `GET /api/spans?team=&member=&session=&since=&limit=` | `{items:[span]}`，按 `start_ms` 升序 |
| `GET /api/trace?team=&window=&limit=` | 成员看板聚合树，见 §3.4.1 |
| `GET /api/metrics?team=` | `{eventCount,messageCount,deliveryP50,deliveryP95,conflicts,denials,grants,conflictRate}` |
| `GET /api/verify?team=` | `{ok, asOf, mismatches}`：C2 对账（event 重放 vs `member_state`） |
| `GET /api/reconcile?team=` | `{ok, checked, diffs}`：事件/审计 vs 磁盘实际差异（FR-6.2） |

**建图语义（重要）**：`POST /api/tasks` 支持内联 `deps:[{from,condition,artifactPath}]`，与任务同事务插入（推荐）。若采用「先建任务、后 `POST /api/deps`」的顺序，调度器有 `settleMs=200ms` 建图窗口，并在**派发前重新求值依赖**，因此不会抢跑（见 ADR-005）。每 150ms 还有一次兜底 tick，保证队列在无显式事件时也能推进。

`status` = `{asOf, version, members:[member], staleMembers:[memberId], degraded:bool}`
`event` = `{id,seq,memberId,taskId,teamId,ts,phase,action,target,result,next,status,meta}`

### 3.4.1 Trace 瀑布（成员看板数据源）

`GET /api/trace?team=<id>&window=<分钟>&limit=<行数>` 返回一棵相对时间轴的树，面板直接用 `originMs` 作 `startedAt`、`now` 作当前时钟：

```
root(run:team)                         ← 团队整体
├─ member:<memberId>  kind=subagent    ← 子 Agent（来自 /api/status 的成员视图）
│  └─ step:<memberId>:<stepIndex>      ← Worker 计划步骤（由 event 流聚合：首条 RUNNING 起，末条终态收）
└─ session:<sessionId> kind=agent      ← 无成员归属的 Host 工具调用（dsh-team 插件上报）
   └─ span:<spanId>    kind=tool|llm|agent|subagent
```

- `window`（分钟，`0`/省略 = 全量）：只保留 `cutoff = now - window` 之后的事件与 span；`originMs` 取 `max(cutoff, 最早节点起点)`，旧数据不会把横轴拉爆。响应带回 `windowMs` 与 `cutoffMs` 便于面板回显。
- `root` / 各节点：`{id,name,kind,status,start,end?,detail?,model?,tokensIn?,tokensOut?,cost?,input?,output?,error?,children}`；`start`/`end` 均为**相对 `originMs` 的毫秒数**，运行中的节点省略 `end`。
- `stats` = `{members,steps,spans,nodes,running,failed,durationMs}`；`durationMs` 在运行中随 `asOf` 增长。
- 成员/步骤/工具调用三个来源互不依赖：只跑 Demo Worker 也有步骤瀑布；只接 Host 插件也有工具瀑布。


### 3.5 消息
| 方法 路径 | 请求/说明 |
|---|---|
| `POST /api/messages` | `{teamId?, from, to, kind?, payload, correlationId?, ttlSeconds?}` → `{message}`；`to` 为成员 id、`'*'`（广播）或虚拟收件人 `'lead'`（成员留言给 Lead，只落信箱、面板可回看，不做投递） |
| `GET /api/messages?team=&correlation=&member=&status=` | `{items:[message]}` |
| `POST /api/messages/{id}/ack` | `{state:"read"\|"acked"}` → `{message}` |

`kind='steer'` 是面板「成员引导」用的队列消息：`payload={text, immediate?}`。它和其它消息一样先落信箱 `queued`，由 Host 插件的 steer 泵（`steerPollMs`）推进成员会话：每成员每轮一条，`immediate=true` 排到最前（只是优先投递，不打断当前回合），投递成功后 ack 成 `delivered`；面板用 `state:"acked"` 把消息从队列里撤掉。`ack` 的状态变化都会广播 `message.delivered`（`payload.status` 为实际状态）供面板刷新。

`message` = `{id,teamId,from,to,kind,correlationId,payload,sentAt,deliveredAt,readAt,ackedAt,ttlSeconds,status}`
`status`（派生）：`queued | delivered | read | acked | expired`

### 3.6 权限预设与审批

权限预设名只在 `team_create` / `team_spawn` 透传并落库；真正的沙箱与审批策略由 DSH 的 `ctx.permissionPresets.set(session, name)` 生效（§3.6.1）。

| 方法 路径 | 请求 |
|---|---|
| `POST /api/approvals` | `{id, teamId, memberId?, sessionId?, toolName, reason?}` → `{approval}`；幂等登记 pending |
| `GET /api/approvals?team=&status=` | `{items:[approval]}`；`status` 可为 `pending/allowed/rejected/cancelled/expired` |
| `POST /api/approvals/{id}/decide` | `{decision:"allow"\|"deny"\|"expired"\|"cancelled", decidedBy?, reason?}` → `{approval}` |
| `GET /api/presets` | `{items:[preset], pendingDeletes:[id]}`；`preset = {id,name?,description?,order?,source:"host"\|"team",file?,broken?}` |
| `POST /api/presets/sync` | `{presets:[preset]}` → 目录整体镜像；插件启动/save/delete 后推送 |
| `POST /api/presets/{id}/delete` | 仅 `source:"team"` 可排队；内置预设返回 400；重复请求重置重试计数 |
| `GET /api/presets/{id}` | `{preset, doc}`；`doc` 是同步进来的组合文档（内置预设为 `null`） |
| `POST /api/presets/pending-deletes/{id}/ack` | 插件执行删除后回执：成功删队列；`{error}` 则 `attempts+1` 并保留，插件跳过 `attempts>=5` 的条目 |

`approval` = `{id,teamId,memberId,sessionId,toolName,reason,status,decidedBy,decidedAt,createdAt,updatedAt}`
`reason` / `toolName` 入库前经 `redactor.str()`，敏感值一律 `<redacted>`。

#### 3.6.1 插件侧（Host）

1. `team_create({permissionPreset})` / `team_spawn({permissionPreset})` 解析并校验预设名（默认 `workspace-write`，正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；宿主 `names` 可用时校验）。
2. `startActivation` 返回后立刻 `ctx.permissionPresets.set(sessions.get(childId), preset)`；返回 `permissionPresetApplied`，失败只警告不回滚。
3. `ctx.on('approval/request', handler, {prepend:true})`：只有绑定了成员的 session 才拦截；镜像 `POST /api/approvals`，用 `subagents.sendMessage` 通知 Lead（含 `requestId` 与 `team_approve` 示例），Promise 等待。
4. `team_approve({teamId, requestId, decision, reason})` 只有团队 Lead 可调；`allow` → 宿主 `allowed-once`，`deny` → `rejected`；超时（`approvalTimeoutMs`，默认 600000）→ `rejected` 并镜像 `expired`；`req.signal` abort → `cancelled`。
5. 非成员请求 `return next()`，仍走 DSH 原有审批链路。

#### 3.6.2 agent 组合预设（agentPreset）

`agentPreset` 与 `permissionPreset` 是两套独立服务：前者决定成员**拥有什么**（Cordis 组合里的工具插件、skill 提供方、MCP client、系统提示词），后者决定成员**被允许做什么**（沙箱 + 审批策略）。

- sidecar 只存名字（team/member 各一列），不解释组合内容；成员生效值为 `member.agent_preset || team.agent_preset || null`。
- 插件在 `team_create` / `team_spawn` 用宿主 `ctx.get('agentPresets').list()` 校验 id（不可用时只做正则校验），未知 id 报错并列出可用预设。
- `startActivation.request.agentPreset` 只在 `contextMode:'fresh'`（`spawn` provider）时透传；`fork` 继承父方组合，传了会返回 `agentPresetWarning` 且不生效。
- 成员的系统提示词来自 preset 组合 + 工作区 `AGENTS.md`；`prompt` 只是第一条用户消息。

#### 3.6.3 自建预设（`team_preset`）

内置预设不满足时，Lead 可用 `team_preset` 自建组合预设：

- `team_preset({action:"list"})` → `{dir, presets:[{id,name?,description?,order?,source:"host"|"team",file?,broken?}], errors}`
- `team_preset({action:"show", id})` → `{id, source, file?, doc? | preset?}`（内置预设只读，返回 roster 行）
- `team_preset({action:"save", id, name?, description?, order?, plugins, confirm?})` → `{id, file, registered, broken?, warning?}`；覆盖同名团队预设必须 `confirm:true`
- `team_preset({action:"delete", id})` → `{id, file, removed:true}`；只删团队自建（目录里的 JSON），内置预设报错
- 面板「组合预设」页展示镜像目录（支持按 id/名称/说明搜索、展开查看组合文档）；团队自建可点删除 → 写 `preset_delete` 队列 → 插件 5s 内执行并 ack，失败按次数保留

存储：`<presetDir>/<id>.json`，默认 `~/.dsh/team/presets/`，可用插件配置 `presetDir` 或 `DSH_TEAM_PRESET_DIR` 覆盖；文档是 `PresetDefinition` 的 JSON 形式（JSON 是合法 YAML）。插件启动时扫描该目录并 `agentPresets.register()`，`save` 时立即注册，无需重启 DSH。同名：团队自建覆盖需显式 `confirm:true`（先 unregister 旧定义再注册），宿主内置 id 拒绝覆盖；注册失败只回 `broken`，文件保留。

### 3.7 待办与报告
| 方法 路径 | 请求 |
|---|---|
| `GET /api/todos?team=&member=` | `{items:[todo]}` |
| `POST /api/todos` | `{teamId, memberId?, title, blockedBy?, orderNo?}` |
| `PATCH /api/todos/{id}` | `{title?,status?,blockedBy?,orderNo?}` |
| `GET /api/report?team=&format=md` | `text/markdown` 运行报告（AC-12：含 actor/domain/target/before_hash/after_hash 表） |
| `GET /panel` | HTML 面板 |

### 3.8 子会话成员（agent 运行时）

`agent` 团队的成员是**真 DSH sub-agent session**（由 Host 插件用宿主的 `ctx.get('subagents').startActivation(...)` 拉起，continuable child），sidecar 仍是任务/DAG/审批/看板/审计的唯一真相源；进程生命周期归 Host 与 DSH session。这些端点只被 Host 插件与调试脚本调用。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/agents/register` | `{teamId, name, sessionId?, parentSessionId?, role?, model?, contextMode?, agentProvider?, permissionPreset?, agentPreset?, reasoningEffort?}` | `{member}`；按 `(teamId,name)` **幂等 upsert**，无在途任务时写 `agent.spawn` 并置 `idle`；`parentSessionId` 是 spawn 时的 Lead 会话，供 Host 在无活跃句柄时以 `{kind:'user',parentSessionId}` 中断 |
| `GET /api/agents/ready?team=` | — | `{teamId, idleMembers:[member], readyTasks:[{taskId,subject,assignee,planSize}]}`（调试/校对用） |
| `POST /api/agents/dispatch` | `{teamId}` | `{dispatched:true, task, member}` 或 `{dispatched:false, reason:"concurrency"\|"no_idle_agent"\|"no_ready_task"}` |
| `POST /api/agents/status` | `{sessionId, status, detail?}` | 按 session 路由到成员；未知 session → `{ok:false, reason:"unknown_session"}` |
| `POST /api/agents/report` | `{sessionId, taskId?, status?:"done"\|"failed"\|"blocked", summary?}` | 按 session 路由；`{ok, task, status, summary}` |
| `GET /api/agents/by-session/{sessionId}` | — | `{member}` 或 `{ok:false, reason:"unknown_session"}` |
| `POST /api/members/{id}/agent-status` | `{sessionId?, status, detail?}` | 直连成员的同一逻辑（归属校验：session 必须等于 `agentSessionId`） |

语义：

- **成员配置更新**：`team_member({action:"update"})` 只改 `role/permissionPreset` 时 PATCH 元数据并直接把权限预设落到当前会话；若改 `model/agentProvider/contextMode/agentPreset/reasoningEffort`，插件用新配置 `startActivation` 重建子会话、以同名重新 register，再把调用方显式改的字段 PATCH 回元数据（记 `member.update`，不用解析后的继承值覆盖成员覆盖项），最后 `drainChildren` 旧会话（旧版 subagents 退回 `interrupt`）并清掉旧 session 绑定。
- **成员移除**：`team_member({action:"retire"|"remove"})` 先调 `DELETE /api/members/{id}`（`remove` 必须 `confirm:true`），再释放子会话并清理绑定；运行中的成员必须先 interrupt。
- **interrupt 冻结会话**：Host 插件把被 Lead interrupt 的 session 放进 `heldSessions`，在 `team_control resume` 前忽略它的 `idle`/`turn-error` 回报，避免 DSH 中断后的 idle 把成员改回 idle 并触发重派。
- **停止即终止**：`POST /api/teams/{id}/stop` 只在 sidecar 侧落 `interrupted`/`paused`，真正终止由 Host 插件的 `forceStopPump` 完成——每 `forceStopPollMs`（默认 1000ms）轮询 `/api/status`，对刚转为 `interrupted` 且带 `parentSessionId` 的成员调 `subagents.interrupt(sessionId,{kind:'user',parentSessionId})`，并放入 `heldSessions` 忽略其后续 `idle`/`turn-error`。看板 `POST /api/board/tasks/:id/stop` 会对 `board_task_team` 绑定的每个团队执行同一 `stopTeam`。
- **宿主前提**：成员依赖宿主已挂载 `subagents` 服务（`dsh-subagent` bundle）。插件用 `ctx.get('subagents')` 探测；缺失时 `team_spawn` 返回可读错误（`subagents 服务不可用`），不会静默降级建成员。

- **dispatch 是原子认领**：`evaluate()` 推 readiness → 校验 `maxConcurrency` → 按 `priority,created_at` 找 ready 任务（尊重 `assignee` 预绑与 `settleMs` 建图窗口，派发前重算依赖）→ 找 `idle` 且无在途任务的 agent 成员 → 同事务把任务置 `running` 并写 `task.dispatch` 事件。**不启动任何进程**；随后 Host 用 `subagents.sendMessage(lead, sessionId, content)` 把任务说明发进该成员的信箱。
- `agentStatus` 的 `idle`/`failed` 带在途任务时**兜底收尾**（`onTaskDone`/`onTaskFailed`），保证 agent 忘了显式回报时 DAG 也能推进；`interrupted` 只把在途任务转 `paused`，不会退回派发池。
- `agentReport` 的 `blocked` **不消耗重试**：任务置 `blocked`、成员置 `blocked` 并带 `blockers:[{kind:"agent",detail}]`，Lead 决策后 `dispatch`/`resume` 再发一次。
- 归属校验：成员绑定了 `agentSessionId` 时，`status`/`report` 的 `sessionId` 必须一致，否则 `400`。
- trace：`sessionToMember` 由 `member.agent_session_id` 建立，该 session 的 span 直接挂 `member:<id>` 节点下，不再单独建 `session:` 节点（§3.4.1）。
- 调度器只推进依赖与重试计时；任务认领统一由 `/api/agents/dispatch` 完成，sidecar 不启动任何子进程。

### 3.9 模型路由目录

目录由 Host 插件从 `ctx.llm` 读取后推送，sidecar 只做持久化与开关，**不调用任何 LLM、不保存凭据**。`provider`/`model` 是 DSH 的真实 id；Host 只推送**能列出模型**的 provider（`listProviders` + `listModels` 成功的），空列表与未配置的 provider 不进目录，`source` 目前恒为 `live`。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/llm/catalog` | `{providers:[{id,name,source?,error?}], models:[{provider,model,name,description?,modalities?,efforts?,defaultEffort?}], partial?}` | `{ok, asOf, providers, models, enabled}`；按 `(provider,model)` upsert，**保留既有 enabled/note/allowedEfforts**（`allowedEfforts` 与新声明求交）；`efforts` 省略表示本次未知、保留旧值；`partial` 为真时跳过删除；空 `providers` → 400 |
| `GET /api/llm/catalog` | — | `{asOf, source:"dsh-llm", providers:[{id,name,source,error,models:[route]}], totals}` |
| `GET /api/llm/models?all=` | 默认只返回 `enabled=1`；`all=1` 返回全部 | `{asOf, total, items:[route]}` |
| `PATCH /api/llm/routes` | `{provider, model, enabled?, note?, allowedEfforts?}` | `{route}`；未知 route → 404；`enabled` 非 boolean → 400；`note` 截断到 240 字符；`allowedEfforts` 为 null（不限）或该 route 已声明的 effort id 子集，全选折回 null；未声明 efforts 的 route 或未知 id → 400 |

`route` = `{provider, model, name, description, modalities, contextWindow, source, enabled, note, efforts, defaultEffort, allowedEfforts}`；`efforts` 是适配器声明的 `[{id,name,description?}]`，`allowedEfforts` 为 null 表示不限。

语义：

- 非 `partial` 同步会删除快照中已消失的 provider/model（适配器卸载后不残留启用项）。
- 目录为空（Host 没有 `ctx.llm`，例如尚未同步）时，`team_spawn` 不限制 route，保持向后兼容；一旦有目录，**实际生效的** `(provider,model)` 必须是 `enabled=1`（显式指定与继承 Lead 同一闸门）；目录里查不到的 route 不拦（适配器临时提供的情况）；全停用有可读错误。
- `team_spawn` 的实际 route 落到 `subagents.startActivation` 的 `request.agentOptions`（只传显式字段）；route 变化且未显式给 `reasoningEffort` 时按 DSH 合并规则丢弃继承值。

### 3.10 面板设置（自动封存）

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/settings` | — | `{autoArchive:{enabled,days}}`，默认 `{enabled:true, days:7}` |
| `PATCH /api/settings` | `{autoArchive?:{enabled?,days?}}` | 同 `GET`；`days` 必须是 1–365 的整数，否则 400 |

`autoArchive` 存在 `meta.panel_settings`（全局，不区分团队）。`GET /api/teams`（未带 `archived=1`）会顺带执行一次自动封存扫描：超过 `days` 天没有任何活动（取 team.updated_at / event / task / member 更新时间最大值）且没有 running/blocked 成员的团队，写入 `archivedAt`。

### 3.11 成员产物

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/artifacts` | `{teamId, taskId?, memberId?, items:[{path, label?, source?}]}` | `{items:[artifact]}`，`source` 取 `present`(默认) / `workspace` |
| `GET /api/artifacts?team={id}&task={id}?&limit={n}?` | — | `{asOf, items:[artifact]}`，按 `createdAt` 升序 |

`artifact = {id, teamId, taskId, memberId, path, label, source, createdAt}`。同一团队同一 `path` 只有一条：再次上报覆盖为最新（`taskId`/`label`/`source` 一起更新），因此成员重复交付同一文件不会堆出重复行。

数据来源是 Host 插件：成员调用 `team_report_task` 时，插件读取该成员的 DSH 会话——优先取 `present` 工具声明过的交付文件（`files[].path/description`），其次取 `workspace/changes` 事件记录的改动文件（经 `ctx.workspaceChanges.summary` 拿 summary），再 `POST` 到这里。采集失败不影响任务汇报。前端「实时收件箱」按 `taskId` 分组展示为产物列表。

### 3.12 成员改动（审阅页）

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/changes` | `{teamId, taskId?, memberId?, items:[{path, kind?, diff, added?, deleted?}]}` | `{items:[change]}` |
| `GET /api/changes?team={id}&task={id}?&member={id}?&limit={n}?` | — | `{asOf, version, items:[change]}`，按 `createdAt` 升序，`limit` 1–500 默认 200 |

`change = {id, teamId, taskId, memberId, path, kind, diff, added, deleted, createdAt}`；`kind` 取 `add` / `edit`（其它值一律落为 `edit`）。单条 `diff` 超 2000 行或 400 KB 会被截断并追加省略说明；一次 `POST`最多收 50 条。

数据来源是 Host 插件：成员会话（只要已绑定成员）调用 `write`/`edit`/`apply_patch` 等文件工具时，插件在 `tools/execute` 前后各读一次磁盘算 unified diff，`POST` 到这里。只采集子成员，Lead 自己的改动不进审阅；工具失败或无内容变化不上报。上报失败不影响工具调用。

### 3.13 工作区看板（board）

看板任务以 `workspace_id` 隔离，独立于团队内 DAG 的 `task`。状态机：`todo → planning → planned → inprogress → done | failed`；`planned` 不占 planning 槽位，只等 inprogress 槽位。`auto=1` 的任务才会被 Host 插件 claim；`execution_mode=same` 时首轮执行复用规划会话，`new` 时另建 Lead 会话。任务进入 `done/failed` 后用户再次发消息，状态回到 `inprogress`，并复用已有 `lead_session_id`（不再新建会话）；此时 `resumed=1`，泵只 attach、不重复注入执行 prompt。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/board?workspaceId=&archived=0|1` | — | `{workspace, settings, counts, slots, tasks}` |
| `GET /api/board/live` | — | `{tasks}`，含 planning/planned/inprogress，以及仍有 `lead_session_id` 的 done/failed（供插件重启后继续监听追问） |
| `GET /api/board/by-session/:sessionId` | — | board task 或 `{ok:false,reason}` |
| `GET /api/board/by-team/:teamId` | — | board task 或 `{ok:false,reason}` |
| `GET/PUT /api/board/settings` | `{workspaceId, planningConcurrency?, inprogressConcurrency?, showTaskSessions?, planProvider?, planModel?, planReasoningEffort?, leadProvider?, leadModel?, leadReasoningEffort?, planPermissionPreset?, leadPermissionPreset?, planAgentPreset?, leadAgentPreset?}` | settings（含 Host 上报的只读 `dshWebUrl`） |
| `GET/POST /api/host/web` | POST `{url}`：Host 插件把 DSH Web 的浏览器地址上报给 sidecar | `{url}` |
| `POST /api/board/tasks` | `{workspaceId, title, description?, auto?, executionMode?, priority?, planRoute?, leadRoute?, teamModels?}` | board task |
| `PATCH /api/board/tasks/:id` | 同上字段 | board task |
| `POST /api/board/tasks/:id/start|stop|retry|archive|restore` | `{executionMode?}` / `{reason?}` | board task；`stop` 还会暂停并终止 `board_task_team` 绑定的团队（终态/成员保留） |
| `POST /api/board/tasks/:id/teams` | `{teamId}` | board task（幂等绑定） |
| `POST /api/board/claim` | `{kind:'planning'|'inprogress'}` | `{item:{task,workspace,settings,fence}}` 或 `{item:null}`；内部接口 |
| `POST /api/board/tasks/:id/attach` | `{kind,sessionId,fence}` | board task；写 `planning_session_id` 或 `lead_session_id` |
| `POST /api/board/tasks/:id/release` | `{kind,error}` | board task → failed |
| `POST /api/board/agents/plan` | `{sessionId,plan,summary?}` | board task → planned（same 模式同时写 lead_session_id） |
| `POST /api/board/agents/status` | `{sessionId,status:'done'|'failed'|'inprogress',summary?}` | board task |

`fence` 是 claim 令牌（DB 列 `claim_token`），只出现在 claim 响应里；因全局脱敏规则，任何含 `token` 的字段都会被替换成 `<redacted>`，所以对外叫 `fence`。

Host 插件默认 `boardEnabled=true`（显式 `false` 可关闭），每 `boardDispatchMs` 跑一次泵：`claim planning` → `ctx.agents.create`（cwd=workspace path）→ `attach` → `followup` 投规划 prompt；规划会话调 `board_plan_submit` 后进入 `planned`，泵再 `claim inprogress`。规划会话权限默认 `read-only`，执行默认 `danger-full-access`；规划阶段的审批请求由插件直接拒绝，避免无人值守卡住。规划超时（`boardPlanningTimeoutMs`，默认 30 分钟）自动置 failed。

`showTaskSessions`（默认 `true`）控制插件是否把 `board_task.planning_session_id` / `lead_session_id` 指向的会话通过 `ctx.workspaceRegistry.get(workspaceId).attachSession(sessionId)` 挂进 DSH 工作区会话账本；挂上后看板创建的规划/执行会话会出现在「工作区会话」列表里，关闭则只在看板内可见。attach 失败只告警，不影响任务推进。

重试（`retry`）复用已有团队：任务的 `board_task_team` 绑定、计划与 DAG 成员数据都保留，插件在 `boardLeadPrompt` 里把 `task.teams` 告诉新的 Lead，要求先用 `team_status` 查看既有团队、用 `team_task` 追加剩余工作，不再无条件 `team_create`（仅当原团队被删除或不可用时才新建）。提示词是软约束，因此插件另加硬约束：对「spawn 时任务已有关联团队」的续跑会话，`team_create` 若发现原团队仍存在会直接报错并给出继续步骤，只有显式传 `force:true` 或原团队全部被删除/归档时才允许新建。因此失败重试不会再凭空多出一个团队。

GUI 入口：`dsh-plugin-ui` 把「编排」与「任务看板」注册成两个独立页签（原生右侧栏对应 `dsh-team` / `dsh-team-board`）。看板页路由为 `#/board[/<workspaceId>]`，不渲染编排侧栏、不依赖当前 team；切换工作区只改 `workspaceId` 与 URL。编排页不再包含任务看板页签。看板任务详情里的「关联团队」按钮通过 `postMessage`（`dsh-team:open-team`）让 Host 切到「编排」页签并锁定该 team；独立浏览器页面（非 DSH 环境）没有 Host，改用 `window.open` 在新窗口打开同一面板的 `#/t/<teamId>` 路由。任务有 `lead_session_id` 时，详情里还会显示「执行会话」按钮：`postMessage`（`dsh-team:open-session`）→ Host `uiWorkspace.openSession(sessionId)`，直接打开 Lead 所在的 DSH 会话；独立页面若已拿到 Host 上报的 `dshWebUrl`，改为 `window.open(\`${dshWebUrl}/#dsh-session=<id>\`)`：DSH 内的 `dsh-plugin-ui` 客户端启动时读取 `location.hash` 里的 `dsh-session`，调 `uiWorkspace.openSession(sessionId)` 打开会话，再用 `history.replaceState` 清掉 hash；Host 未上报 `dshWebUrl` 时回退默认地址 `http://127.0.0.1:3080`（`dsh web` 默认端口）。DSH Web 本身没有会话级 URL 路由，这个 hash 约定完全由本插件两端实现。任务详情面板只读展示字段；右上角的编辑按钮仅在任务处于 `todo` 且未封存时可用，点击后打开编辑对话框（标题、描述、执行方式、自动入队、规划/执行模型、团队模型），保存走 `PATCH /api/board/tasks/:id`。

新增工具：`board_plan_submit({plan,summary?})`、`board_task_status({status,summary?})`。`team_create` 在 Lead 会话里创建团队后会自动把 team 绑到该会话对应的 board task；`team_spawn` 在该 task 配了 `teamModels` 时把成员 route 限制在白名单内（未指定 model 取第一条）。

---

## 4. SSE

`GET /api/events?team=...`，`text/event-stream`。帧：

```
id: 42
event: step.append
data: {"id":42,"type":"step.append","teamId":"t_1","memberId":"m_1","taskId":"task_1","ts":"2026-10-28T09:33:25.600Z","payload":{...}}
```

- `id` 取自 `event.id`（自增，全局单调）。断线重连：浏览器 `Last-Event-ID` 请求头或 `?lastEventId=`，服务端从 `event.id > lastEventId` 回放，**不丢事件**。
- 心跳：每 15s 发 `: ping` 注释行。
- 载荷全集：`member.status{status,step,seq,next}`、`step.append{seq,phase,action,target,result,next}`、`task.state{taskId,status,attempts}`、`task.dispatch{taskId,memberId}`、`message.delivered{messageId,to,status}`、`approval.request{requestId,memberId,toolName}`、`approval.decide{requestId,decision,decidedBy}`、`span.append{span}`（Host 工具调用上报后推送，面板据此实时刷新瀑布）、`artifact.added{taskId,memberId,count}`、`change.added{taskId,memberId,count,last}`（成员改动落库后推送，审阅页据此刷新）、`context.update{memberId}`。
- 合成帧（`approval.request` / `approval.decide` / `artifact.added` / `change.added` / `context.update`）：字段在帧顶层，不是 `payload` 内。

---

## 5. Worker 进程（已移除）

v2 删除了 `src/broker.mjs`、`src/policy.mjs`、`src/runner.mjs`、`src/worker/`：sidecar 不再启动子进程，也不再执行 `plan` 里的 `fs.* / exec / net / env` 代理动作。`plan` 退化为给成员的纯文本步骤清单。

## 6. 恢复语义

| 场景 | 行为 |
|---|---|
| `interrupt` | 同步：成员 `status=interrupted` + `agent.interrupt` 事件；在途任务转 `paused`（不计 attempts、不触发重试、不自动重派）。API 返回即已落库 |
| `resume` | 成员置回 `idle` + `agent.resume` 事件；`resumeFrom=null`（没有 worker 步进锚点），`seq` 连续。`paused` 任务需 Lead 显式 `assign` 后才回 `ready` |
| `abort` | 任务置 `aborted` 终态并写 `finished_at`；不计 attempts、不进入 failurePolicy；running 任务顺带中断成员 |
| sidecar 重启 | 启动时 `recoverAll()`：`running` 任务退回 `ready`（保留 attempts），`pending` 审批置 `expired`；输出 `{recovered:n}` 日志。**不静默丢** |
| 成员回合失败 | Host `agent/status=failed` / `team_report_task status=failed` → `onTaskFailed`，按 `maxAttempts` 重试 |
| 重试 | 指数退避 `retryBaseMs * 2^(attempt-1)`，上限 `limits.maxRetries`；超过 → task `failed` |

`event.meta.stepIndex` 对 agent 运行时固定为 `-1`（不再有 worker 步进），仅保留事件结构兼容。

---

## 7. 验收脚本约定

`tests/ac-<NN>-<slug>.mjs`，`node --test` 可跑，亦支持 `node tests/ac-01-*.mjs` 单跑。每个脚本：
1. 在 `os.tmpdir()/dsh-team-ac<NN>-<rand>` 建临时 workspace + data 目录（**不污染仓库**）；
2. 用 `spawn(process.execPath, ['bin/dsh-team.mjs','up','--port','0','--data',...])` 起真实 sidecar，读第一行 JSON 拿端口/token；
3. 只走真实 HTTP/SSE 与真实子进程；**禁止 mock sidecar、禁止 mock crash**；
4. 收尾 `SIGKILL` sidecar + 清理临时目录（失败时保留并打印路径）；
5. 输出 `PASS <id> <detail>` / `FAIL <id> <reason>` 并设置退出码。

`tests/lib/harness.mjs` 提供：`startSidecar()`, `api()`, `sse()`, `sha256()`, `waitFor()`, `mkWorkspace()`, `readDb()`（用 `node:sqlite` 只读校验）, `killSidecar()`。

**例外（AC-15）**：Host 插件（`dsh-plugin/index.js`）跑在 DSH 进程内，AC 脚本无法拉起真 DSH；`tests/ac-15-agent-runtime.mjs` 因此用**假 ctx** 捕获插件注册的工具/事件处理器并直接驱动，而 sidecar 仍是真实进程、真实 HTTP。AC-15 覆盖：`permissionPreset` 落库与成员覆盖、`/api/agents/register` 幂等、dispatch 原子认领、归属校验、`done` 推进依赖、`blocked` 不消耗重试、trace 把 session span 挂到成员节点。

**插件侧脚本（不占 AC 编号）**：`tests/plugin-*.mjs` 与 `tests/panel-contract.mjs`、`tests/routes-smoke.mjs`、`tests/cli-smoke.mjs` 用同一套 harness（真 sidecar + 假 ctx），按被测面命名：

| 脚本 | 覆盖 |
| --- | --- |
| `tests/plugin-agent.mjs` | 插件这一半的 agent 闭环（含权限预设落会话）：`team_spawn` 真调 `subagents.startActivation` 并回注 session、任务简报含 `taskId`/`team_report_task` 指引、成员回报推进任务、未知 session 回报被拒（工具与 `POST /api/members/:id/agent-status` 两处）、`agent/status=idle` 兜底收尾并自动接着派发、`interrupt` 走 `subagents.interrupt` 且任务转 `paused`、团队停止后 force-stop 泵以 `{kind:'user',parentSessionId}` 真正中断成员会话、`team_member` 的 update 重建/drain、retire/remove、`permissionPresets.set` 被调用 |
| `tests/plugin-client.mjs` | 客户端入口注册与工具清单 |
| `tests/plugin-trace.mjs` | Trace 上报链路（session span 挂成员节点） |
| `tests/plugin-approval.mjs` | 审批转发：`approval/request` → 通知 Lead → `team_approve` allow=`allowed-once` / deny=`rejected`、非成员放行原链路、非 Lead 被拒 |
| `tests/db-migration.mjs` | 老库就地迁移：schema v1（`team` 无 `permission_preset`、`member` 无 `agent_session_id`）能补列/补索引/升版本，旧数据保留且默认 `workspace-write`，二次打开幂等 |

`tests/run-all.mjs` 先跑全部 `ac-*.mjs`，再跑上述插件/面板/路由/CLI/迁移脚本，任一失败即非零退出。

---

## 8. 目录与所有权

```
package.json          # type:module, bin.dsh-team, scripts.test
bin/dsh-team.mjs      # CLI 入口（cli-owner）
src/core.mjs          # 组合根：建库、装配、recover
src/db.mjs            # schema + 事务助手
src/eventstore.mjs    # C2
src/scheduler.mjs     # DAG
src/bus.mjs           # 信箱/回执
src/sse.mjs           # SSE hub
src/server.mjs        # HTTP/SSE/静态
src/util.mjs          # 时间/ID/glob/哈希/脱敏
dsh-plugin/**         # Host 插件（team_* 工具、成员调度、权限预设、审批转发、span 上报）
dsh-plugin-ui/**      # 面板挂载到 GUI（better-sidebar 页签/回退）
src/web/**            # 面板（panel-owner）
tests/**              # AC 脚本
docs/adr/**           # ADR
```

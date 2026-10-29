# ADR-009：agent 成员运行时——成员是真 DSH sub-agent，sidecar 降级为状态真相源

- 状态：已接受
- 日期：2026-10-29
- 关联：AC-15 / `docs/CONTRACT.md` §3.8 / ADR-002（worker 约束）/ ADR-008

## 背景

v1 的成员是 sidecar 拉起的**沙箱 Node worker**：每个 `plan` step 是一个经四域 broker 代理的动作，
Worker 进程没有原生 IO 能力（ADR-002）。这套模型把「权限」管得很死，但成员**不是 LLM agent**：
不会自己思考、不会用 DSH 的工具、看板上只有步骤条没有 LLM span。

用户明确要求 **B 方案**：保留现有看板/DAG/trace/审批，只把「成员」换成**真 DSH sub-agent session**
（不安装外部的 `dsh-agent-teams`，因为它会替换整套控制平面）。

## 决策

- `team.runtime ∈ {worker, agent}`（建团后不可变），`member.agent_session_id` 记录成员对应的
  DSH SessionId（`subagents.startActivation` 起出来的子会话 id）。
- `runtime=agent` 时 sidecar **不启动任何子进程**：
  - 成员由 Host 插件调宿主的 `ctx.get('subagents').startActivation({delivery:'parent', childId, provider, label, request:{prompt, parent: caller, cwd: team.workspace}, signal})` 拉起
    （continuable child：有自己的模型/工具/消息信箱，`cwd` 取团队 workspace），
    成功后 `POST /api/agents/register` 幂等登记（按 `(teamId, name)` upsert，重复报到只更新 session）。
  - `provider` 取 `spawn`（`context: fresh`）/ `fork`（`context: fork`），与
    `dsh-experimental-tool-agent-team` 的默认一致；宿主已注册的 provider 名可用 `subagentNames()` 覆盖。
- **派发权留在 sidecar**：`POST /api/agents/dispatch` 在同一事务里「求值依赖 → 查并发 → 挑 idle 成员 →
  任务置 running + 写 `task.dispatch` 事件」，是**原子认领**；Host 调度器只负责把认领结果用
  `subagents.sendMessage(lead, sessionId, [{type:'text', text: 简报}])` 变成一条任务简报发给成员。
  sidecar 仍是唯一真相源，插件可随时重启。
- **回报双通道**：成员主动调 `team_report_task`（精确摘要/成败）；宿主 `agent/status` 事件在回合结束
  时兜底收尾（idle → 若有在途任务则 done，failed → 任务失败），保证「成员忘了回报」不会把 DAG 卡死。
- **blocked ≠ failed**：成员报 `blocked` 时任务置 `blocked` 且**不消耗重试**，阻塞原因进 `blockers`
  与 `/api/blockers`，等 Lead 决策后 `dispatch`/`resume` 再发一次。
- **归属校验**：`status`/`report` 的 `sessionId` 必须等于成员的 `agent_session_id`，否则 400
  （防止成员互相冒名写别人的任务）。
- **trace 合并**：sidecar 用 `member.agent_session_id` 建立 `sessionId → memberId` 映射，
  该 session 的工具 span 直接挂 `member:<id>` 节点下，不再单独建 `session:`（Lead）节点。

## 备选方案与被否决的原因

1. **安装 `dsh-agent-teams`，抛弃 sidecar**：看板/DAG/审批/审计全部要重写，且失去四域审计与 AC 套件；
   用户明确要保留看板 → 否决。
2. **让成员走 sidecar 的 worker 通道**（agent 只做「大脑」，IO 仍走 broker）：需要给 sub-agent 套一层
   代理工具的 shim，模型无法用原生工具，等于把 v1 的痛点搬回来 → 否决。
3. **sidecar 只当事件接收器，派发完全交给插件**：插件重启后认领状态会与 DB 漂移，且并发上限在 sidecar
   之外无法原子判断 → 否决（改为 dispatch 在 sidecar 内原子完成）。

## 后果

- **权限模型分叉**：agent 成员用 DSH 自己的工具策略/审批，不经过 sidecar 四域 broker；因此
  `scope_request`/`grant` 对 agent 团队不生效（`team_scope` 仍可建规则，但成员不会走它）。
  这是有意的取舍：agent 的真实边界是 DSH 的 tool guard。需要 sidecar 审计的场景继续用 `worker`。
- `interrupt` 走 `subagents.interrupt`（中止当前回合）+ sidecar 同步落库 `interrupted`（C5 语义保留）；
  `resume` 重新武装并按需再派发。
- 崩溃恢复：sidecar 重启后 agent 成员的 session 仍活在 DSH 里，插件在 `agent/status` 或下次
  `team_spawn`/注册时重新对齐状态（`register` 幂等）；DSH 重启则成员 session 消失，需重新 `team_spawn`。
- trace 里 agent 成员既有工具 span，也可以后续补 LLM span（`llm/stream` 上报，见 handoff 的
  Subsequent）。
- 新增 4 个 sidecar 端点与 2 个工具（`team_dispatch`、`team_report_task`），AC-15 覆盖。

## 补记（2026-10-29，实现期修正）

初版设计写的是 `ctx.agentTeams.spawnTeammate/sendMessage/interrupt`。真机联调发现：本 profile 的
bundle 列表里**没有 `agent-team` 那一挂**，`ctx.get('agentTeams')` 在运行时是 `undefined`
（`cordis_inspect_query` 报的只是包声明的类型清单，不代表已挂载），`team_spawn` 直接报
「agentTeams 服务不可用」。

改为依赖宿主**必然已挂载**的 `subagents` 服务（`dsh-subagent` bundle，几乎所有 profile 都启用），
语义完全等价且更底层：

| 原调用 | 现调用 |
| --- | --- |
| `agentTeams.spawnTeammate(lead, {...})` | `subagents.startActivation({delivery:'parent', childId, provider, label, request:{prompt, parent, cwd}, signal})` |
| `agentTeams.sendMessage(lead, {target: name, content})` | `subagents.sendMessage(lead, sessionId, content)` |
| `agentTeams.interrupt(...)` | `subagents.interrupt(lead, sessionId, reason)` |

插件的 `spawnTeammate`/`sendMessage` 两个**工具名**保持不变（模型侧接口稳定）。`subagents` 不写进
`inject` 而是 `ctx.get()` 探测：缺失时只影响 agent 团队，worker 团队与插件其它功能照常。
真机验证：`team_spawn` 起出真子会话 → 简报送达 → 成员写文件 → `team_report_task` 回报 → DAG 推进，
同一成员被 `sendMessage` 唤醒复用跑第二个任务（2026-10-29 本机 4317 侧车实测）。

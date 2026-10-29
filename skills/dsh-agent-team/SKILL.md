---
name: dsh-agent-team
description: 用 dsh-team 插件编排「真 sub-agent 成员」团队的最小可用流程：team_create(runtime:"agent") → team_spawn → team_task → 成员 team_report_task → team_status/team_report；含 11 个 team_* 工具的字段清单、按任务难度给成员分配 provider/model/思考强度、简报写法、并发与依赖、agent/worker 两种运行时的区别与常见错法。Use when the user asks to create an agent team, orchestrate teammates, dispatch parallel work to sub-agents, or when a team_* call failed with an unexpected shape (unknown teamId, assignee by name, empty plan, member never reports).
user-invocable: true
version: "1.0.0"
---

# dsh-team：把活派给真 sub-agent 成员的流程

插件提供 11 个工具：`team_create` `team_spawn` `team_models` `team_task` `team_report_task` `team_send` `team_status`
`team_dispatch` `team_control` `team_scope` `team_report`。
**别按名字猜顺序**，按下面 5 步走，一次就能通。

## 0. 先决定运行时（唯一关键决策）

| 用户想要 | runtime | 成员是什么 | 派活方式 |
|---|---|---|---|
| 「建一个 agent 团队 / 让几个 AI 并行干活 / 互相讨论」 | `"agent"` | 真 DSH 子会话：自己的模型、上下文、工具、信箱，会思考会写文件 | `team_task` 的 `subject`+`acceptance` 当**简报**投递给它 |
| 「跑一批固定操作，按步骤来」 | `"worker"`（默认） | 只执行 `plan` 里 proxied op 的沙箱槽，**不会思考** | `team_task.plan` 必须是 `fs.* / exec / net / env / scope / fail / noop` 这类动作 |

**用户说「创建 agent team」就必须显式传 `runtime: "agent"`**。忘了传就是 worker：`team_spawn` 照样成功，
但之后给它 `acceptance` 式的自然语言简报它「跑完 0 步」，看起来像卡住。

## 1. 最小配方（agent 团队，照抄改字段）

```text
team_create({ name: "writer-team", workspace: "C:\\abs\\workdir", runtime: "agent" })
  → 返回 { team, panel }；记住 id = result.team.id（如 team_mvt5atfv1b4fe），后续每次调用都要带

team_spawn({ teamId: result.team.id, name: "writer", prompt:
  "你是 writer-team 的成员。工作目录 <workspace>。\n" +
  "职责：按 Lead 派的任务写文件；完成后必须调用 team_report_task({teamId, taskId, status, summary})。\n" +
  "不要新建团队，不要调用 team_create。" })
  → 返回 { member }；记住 memberId = result.member.id

team_spawn({ teamId, name: "reviewer", prompt: "...同上，职责改成审阅..." })

team_task({ teamId, subject: "写 README 的安装章节",
            acceptance: "README.md 里有 ## 安装 小节，命令块可复制执行",
            assignee: memberId })   // 可省；省了由调度器挑 idle 成员
  → 任务立即派给 idle 成员，简报投进它信箱；返回 { task, dispatched }
```

成员自己会：调工具干活 → `team_report_task` → 任务 `done` → 依赖解锁 → 下一波 `team_task` 自动派发。
**Lead 不要轮询**：`team_status({teamId})` 看一眼快照即可；成员回报后调度自动推进。

## 1.5 按任务难度分配模型（agent 团队）

用户的 DSH 里可能配置了多个 provider/model。**不要默认所有成员都用 Lead 的模型**：先 `team_models({})`
看用户启用了哪些 route（含 `name` / `description` / 用户写的 `note`），再按任务难度选：

| 任务 | 选型建议 |
|---|---|
| 机械改动、批量重命名、找文件/读代码、格式化、跑测试 | 便宜/快的 route（`description`/`note` 里带 fast、cheap、mini 之类） |
| 架构、疑难调试、安全/正确性审阅、跨文件重构 | 强推理 route（reasoner、large、strong 之类） |
| 需要长思考的开放式设计 | 强推理 route + 显式 `reasoningEffort`（只有模型支持时才传） |

```text
team_models({}) → { models: [{provider:"deepseek", model:"deepseek-chat", note:"日常改代码"}, ...] }
team_spawn({ teamId, name:"scout", prompt:"...", agentProvider:"deepseek", model:"deepseek-chat" })
team_spawn({ teamId, name:"architect", prompt:"...", agentProvider:"deepseek", model:"deepseek-reasoner", reasoningEffort:"high" })
```

- `agentProvider` + `model` 必须是 `team_models` 里出现过的启用项；没启用就报错，别自己拼 id。
- 换 route 且不传 `reasoningEffort` → 成员用模型默认值（继承的 effort 被丢弃）；route 不变 → 继承 Lead 的 effort。
- 省略 `agentProvider`/`model` → 完全继承 Lead；但如果 Lead 的 route 已被用户停用，spawn 同样会被拒（换成启用项即可）。worker 团队的 `model` 只是展示标签。
- 用户要加/减可用模型：让他在面板「模型路由」页勾选/写备注，不要改代码。

## 2. 参数清单（最容易错的三处）

- `teamId`：`result.team.id`，**不是团队 name**（用 name 会 `unknown team`）。
- `assignee`：`result.member.id`，**不是** `name`。name 只用于 `team_send({to})` 和展示。
- `team_report_task` 的 `taskId`/`teamId`：成员必须知道才能回报 → 写在 `prompt` 或任务简报里。
  任务 `subject` 不唯一，别拿它当 id。

其他常用参数：`team_spawn({agentProvider, model, reasoningEffort})` 指定成员 LLM route（见 §1.5）；
`team_task({dispatch:false})` 只建不派；`deps:[{from: taskId}]` 声明上游；
`team_send({teamId, to: "writer"|"*", content})` 给成员递话（agent 团队才会真正投递）。

## 3. 拆任务与并发

- 一个 `team_task` = 一个 DAG 节点；`deps` 声明上游后调度器自己解锁，**不要手写 `team_dispatch`**
  （它只在 `team_control` 恢复或批准越界申请后补一次）。
- 并发上限 = 建团时 `maxConcurrency`（默认 8）；成员上限 `maxMembers`（默认 64，超出变 `queued` 不报错）。
- 同一文件别让两个成员同时写：按文件/目录切 owner，或串成 `deps`。
- 失败重试 `maxAttempts`（默认 3）+ `failurePolicy`(`continue`/`abort`)，Lead 只读 `team_status`。

## 4. 常见错法与症状

| 症状 | 原因 | 修法 |
|---|---|---|
| `team_spawn` 报需要 `prompt` | agent 团队必填 | 写清角色 + 工作目录 + 「完成后调 team_report_task」 |
| `team_task` 建完没人接 | 成员全 busy/queued，或 `assignee` 用了 name | 省略 `assignee` 让调度器挑，或 `team_status` 看谁 idle |
| 成员一直 `running` 不 done | 简报没让它调 `team_report_task` | 补 `prompt`；`team_control({action:"interrupt"})` 后重派 |
| 任务 `done` 但产物不对 | 成员看不到 Lead 的对话 | 简报自包含：目标文件、验收标准、不要假设它读过本对话 |
| worker 团队「跑完 0 步」 | 把自然语言当简报给了 worker | 改用 `runtime:"agent"`，或把 `plan` 写成真实 op |
| `team_spawn` 报「模型路由未启用」 | 指定的 provider/model 没在面板启用 | `team_models` 看可用项；让用户在面板「模型路由」页启用 |

## 5. 观察与收尾

- `team_status({teamId, detail:"summary"})`：成员 status/step/pct/next/blockers；`detail:"dag"`：依赖与关键路径。
- DSH 里看：对话右上角「团队成员」条（点 chip → 右侧栏内嵌该成员对话）；侧车面板 `http://127.0.0.1:4317/panel`
  （Trace 瀑布 / DAG / 模型路由 / 审批队列）。
- 收工：`team_report({teamId})` 导出 Markdown（成员、DAG、决策、审计含 before/after 哈希）给用户。
- 越界：成员动了写域外或有风险的域会挂起等 `team_scope({action:"decide"})`；批准是单次授权、带 TTL。

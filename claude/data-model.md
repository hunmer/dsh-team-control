# 数据模型

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 表（`src/db.mjs`，`SCHEMA_VERSION = 19`，共 25 张）

| 表 | 角色 |
|---|---|
| `meta` | 键值（含 `schema_version`） |
| `preset` | agentPreset 目录镜像（Host 插件同步：id/name/description/ord/source/file/broken/`doc_json`） |
| `preset_delete` | 面板删除队列（插件 5s 轮询执行后 ack；`attempts`/`last_error` 记录失败，>=5 次停止重试） |
| `team` | 团队：`workspace`、`max_members`/`max_concurrency`、失败策略、`permission_preset`、`agent_preset`、`lead_session_id`、归档时间 |
| `member` | 成员定义：`role`、`model`、`context_mode`、`agent_provider`、`agent_session_id`、`parent_session_id`、`reasoning_effort`、`permission_preset`、`agent_preset` |
| `member_state` | **状态真相源**（物化视图）：`status`、`seq`、`step`、`stale` |
| `task` | 任务/DAG 节点：`status`、`priority`、`acceptance`、`plan`、`attempts` |
| `dep` | 依赖边：`from`/`to`/`condition` |
| `event` | 只增事件（`seq`、`phase`、`action`、`result`、`meta`） |
| `approval` | 宿主审批镜像：`status`(pending/allowed/rejected/cancelled/expired)、`tool_name`、`reason`、`decided_by` |
| `message` | 持久信箱：`corr_id`、`delivery`(pending/delivered/acked) |
| `todo` | 任务清单（面板可见） |
| `audit` | 审计：`actor`、`domain`、`action`、`target`、`before_sha`、`after_sha` |
| `span` | 工具调用/LLM 调用的 trace 记录（`parent_id`） |
| `artifact` | 产物登记 |
| `member_change` | 文件改动（统一 diff） |
| `context_snapshot` | 上下文占用快照（含 `stats_json`：轮数/步数/token/缓存，schema v17） |
| `workspace` | 工作区定义 |
| `file_state` | 文件基线哈希（供 diff/CAS） |
| `llm_provider` / `llm_route` | 模型目录与启停开关；`llm_provider.note` 是厂商级备注（「这个厂商擅长什么」），`llm_route.note` 是模型级备注 |
| `board_settings` | 每工作区看板并发、默认规划/执行模型、权限预设、agentPreset |
| `board_task` | 看板任务：状态、`auto`、`execution_mode`、路由、计划、两个 sessionId、`claim_token`、`resumed`、`prewalk`（实验性：同会话首次成功实现动作后切执行模型并注入「继续」）、`git_branch`（开始前要切到的分支，空 = 不切）、归档 |
| `board_task_team` | 看板任务 ↔ team 多对多绑定 |
| `board_event` | 看板只增事件（created/claim/attach/planned/done/...） |

## 事件溯源（C2）

```text
append({team, member, type, phase, payload})
  └ 单事务：INSERT event (seq = max(seq)+1) + UPSERT member_state (seq, status, ...)

rebuild()  ── 只读 event 重投影出 member_state
一致性检查 ── member_state.seq !== max(event.seq) ⇒ stale = 1 ⇒ /api/status 带 degraded:true
```

推论：**任何状态变更都要产生 event**；只改 `member_state` 的写会在 `rebuild()` 后消失。

## 枚举

- `member.status`：`queued | provisioning | idle | running | blocked | done | failed | interrupted | retired`
- `task.status`：`pending | ready | running | paused | done | failed | skipped | blocked | aborted`
- `dep.condition`：`all_success | any_success | on_failure | artifact_exists`
- `phase`：`init | read | write | exec | net | env | msg | wait | verify | interrupt | resume | done | fail | decision | recover`
- `domain`：`fs | exec | net | env`
- `ops`：`fs read|write|delete|rename|list`、`exec spawn`、`net connect`、`env read|write`
- `member.delivery`：`pending | delivered | acked`
- `board_task.status`（`src/board.mjs` `BOARD_STATUSES`）：`todo | planning | planned | inprogress | done | failed`

## 看板状态机要点（`src/board.mjs`，ADR-012）

```text
board_task: todo → planning →（board_plan_submit）planned →（claim/start）inprogress →（board_task_status）done | failed
           todo/inprogress --claim 同步模式--> planning/inprogress（same 模式：规划会话即执行会话）
```

- `claim` 发放一次性 `claim_token`；`stopTask` 会联动 `core.stopTeam()` 强制中断成员会话。
- `board_task_team` 记录任务 ↔ team 多对多绑定；`board_event` 只增留痕。
- 迁移示例：`ensureColumn(db,'board_task','resumed',…)`；`meta.schema_version` 就地升版，幂等（`db-migration` 测试覆盖）。

## 状态机要点

```text
member: queued → provisioning → idle → running → (idle | done | failed | interrupted | blocked)
        blocked --grant--> running      interrupted --resume--> idle
        * --retire--> retired
task:   pending → ready → running → (done | failed | skipped | blocked)
        running --lead interrupt--> paused --assign--> ready
        paused --lead abort--> aborted        running --lead abort--> aborted
        failed --on_failure dep--> 下游 ready
```

- 派发前必须**重求值** readiness（ADR-005；`settleMs = 200ms` 窗口允许先建任务后连边）。
- `interrupt()` 在**同一事务**内置 `interrupted` + `event(agent.interrupt)` + 在途任务 `paused`，**提交后**才调 `subagents.interrupt`（C5）；`paused` 不计 attempts、不触发重试。
- `recoverAll()`：租约过期的 `running|provisioning` → `interrupted`，任务退回 `ready`，发送 `phase = recover` 事件。

## 权限求值（C3，`src/policy.mjs` 纯函数）

```text
evaluate(subject, domain, op, target):
  1. 显式 deny 规则命中        → DENY（最高优先，含 team 级 deny 覆盖 member allow）
  2. 未过期且未用尽的 grant    → ALLOW（单次）
  3. 显式 allow 规则命中       → ALLOW（多条取最严合并）
  4. 否则                      → DENY（默认拒绝）
```

最严合并：`maxRuntime` 取 min、`method`/`argv` 取交集、`readOnly` 取 or。
越界 → `E_DENIED` + 建 `scope_request` + member 置 `blocked`；批准时一个事务写 `decision` + `scope_grant` + `event`。

## SQLite 迁移

- 缺列补列：`team.runtime`、`member.agent_session_id`、`member.agent_provider`、`member.parent_session_id`。
- `meta.schema_version` 就地升版，二次打开幂等（`db-migration` 测试覆盖）。

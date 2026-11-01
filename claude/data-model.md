# 数据模型

## 表（`src/db.mjs`，`SCHEMA_VERSION = 7`，共 23 张）

| 表 | 角色 |
|---|---|
| `meta` | 键值（含 `schema_version`） |
| `team` | 团队：`runtime`(worker/agent)、`max_members`、`workspace`、状态、归档时间 |
| `member` | 成员定义：`kind`、`role`、provider/model、`plan`、`agent_session_id`、`retired_at` |
| `member_state` | **状态真相源**（物化视图）：`status`、`seq`、`lease_until`、`stale` |
| `member_runtime` | 运行时细节：pid、端口、启动时间 |
| `task` | 任务/DAG 节点：`status`、`priority`、`acceptance`、`plan`、`attempts` |
| `dep` | 依赖边：`from`/`to`/`condition` |
| `event` | 只增事件（`seq`、`type`、`phase`、`payload`） |
| `policy` | 四域规则：`subject_type`(team/member/role)、`domain`、`effect`、`match`、`constraints` |
| `scope_request` | 越界申请：`status`(pending/approved/denied/expired)、`target`、`risk` |
| `scope_grant` | 单次授权：`expires_at`、`used_at`、`single_use`、`ttl` |
| `decision` | 决策落盘（C4）：`request_id`、`decided_by`、`reason` |
| `message` | 持久信箱：`corr_id`、`delivery`(pending/delivered/acked) |
| `todo` | 任务清单（面板可见） |
| `audit` | 审计：`actor`、`domain`、`action`、`target`、`before_sha`、`after_sha` |
| `span` | 工具调用/LLM 调用的 trace 记录（`parent_id`） |
| `artifact` | 产物登记 |
| `member_change` | 文件改动（统一 diff） |
| `context_snapshot` | 上下文占用快照 |
| `workspace` | 工作区定义 |
| `file_state` | 文件基线哈希（供 diff/CAS） |
| `llm_provider` / `llm_route` | 模型目录与启停开关 |

索引：`idx_member_team`、`idx_task_team`、`idx_dep_to`、`idx_event_team`、`idx_event_member`、`idx_policy_team`、`idx_scope_status`、`idx_grant_member`、`idx_msg_to`、`idx_msg_corr`、`idx_audit_team`、`idx_span_team`、`idx_span_parent`、`idx_artifact_team`、`idx_change_team`、`idx_change_member`、`idx_context_team`、`idx_llm_route_enabled`、`idx_todo_task`、`idx_member_session`。

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
- `task.status`：`pending | ready | running | done | failed | skipped | blocked`
- `dep.condition`：`all_success | any_success | on_failure | artifact_exists`
- `phase`：`init | read | write | exec | net | env | msg | wait | verify | interrupt | resume | done | fail | decision | recover`
- `domain`：`fs | exec | net | env`
- `ops`：`fs read|write|delete|rename|list`、`exec spawn`、`net connect`、`env read|write`
- `member.delivery`：`pending | delivered | acked`
- `scope_request.status`：`pending | approved | denied | expired`

## 状态机要点

```text
member: queued → provisioning → idle → running → (idle | done | failed | interrupted | blocked)
        blocked --grant--> running      interrupted --resume--> idle
        * --retire--> retired
task:   pending → ready → running → (done | failed | skipped | blocked)
        failed --on_failure dep--> 下游 ready
```

- 派发前必须**重求值** readiness（ADR-005；`settleMs = 200ms` 窗口允许先建任务后连边）。
- `interrupt()` 在**同一事务**内置 `interrupted` + `event(phase=interrupt)` + `lease_until = NULL`，**提交后**才发信号/杀进程（C5）。
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

- 缺列补列：`team.runtime`、`member.agent_session_id`。
- `meta.schema_version` 就地升版，二次打开幂等（`db-migration` 测试覆盖）。

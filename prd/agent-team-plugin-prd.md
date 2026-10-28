# DSH Agent Team 编排插件 PRD

| 项 | 值 |
|---|---|
| 文档版本 | **v1.0（已定稿）** |
| 状态 | 冻结，可交付实现 |
| 目标读者 | 后续实现 Agent |
| 形态 | **Sidecar 服务 + Web 面板**，替代现有 Agent Teams |
| 一句话定位 | 把 DSH 现有的「8 人上限 + 只能并行 spawn + 口头协作 + advisory 写域」升级为「可配置上限、DAG 依赖自动驱动、四域强制执行权限、SSE 实时可观测」的独立编排控制平面 |

> v0.2 变更：依据用户决策，锁定架构为 sidecar + Web 面板、权限覆盖四域（fs/exec/net/env）、实时性走 SSE 推送、定位为**替代**现有 Agent Teams（后续将关闭）。
> v1.0 变更：第 11 节 12 项待定全部定稿，PRD 冻结，可直接交付实现。
> 本文所有 P0 需求均由 2026-10-28 的真实多 Agent 实测事故反推得出，证据见附录 A。

---

## 1. 背景与问题

现有 Agent Teams 能力实测暴露 8 个硬伤：

| # | 问题 | 实测证据 |
|---|---|---|
| P-1 | 成员总数硬上限 8，满员即 `Team member limit 8 reached`，且无移除接口 | 第 5 轮 |
| P-2 | 无依赖编排：`spawn` 即刻运行，`blocked_by` 只是标记，不会启动任何人 | 第 4/6 轮 |
| P-3 | 写域仅 advisory：重叠只告警不锁，越界靠自觉 | 第 3 轮 |
| P-4 | 无 step 级可观测接口：Lead 只能靠成员自写文件猜进度 | 第 1 轮 |
| P-5 | 消息在回合边界投递，轮询中的成员收不到 → 决策必须落盘才不卡死 | 第 4 轮 |
| P-6 | interrupt 后 `state=running` 残留，形成僵尸态 | 第 6 轮 |
| P-7 | 并发写靠乐观锁 + 重试，3 路并发即耗尽重试预算 | 第 6 轮 |
| P-8 | 成员「最终审计」是快照，会少报他人的并发写 | 第 6 轮 |

**结论：这不是「给 Agent Teams 加几个工具」，而是替换其编排内核。**

---

## 2. 目标、非目标与架构决策

### 2.1 目标

| ID | 目标 |
|---|---|
| G1 | 成员数量由配置控制，支持动态增减与复用 |
| G2 | 任务以 DAG 声明依赖，依赖满足后**自动**派发，无需 Lead 轮询 |
| G3 | 权限在**执行层强制**（拒绝即失败），覆盖文件/命令/网络/环境变量四域 |
| G4 | 成员状态结构化、**实时**可查询与推送：任意时刻能查到「谁、第几步、卡在哪、下一步」 |
| G5 | 消息可持久化、可离线、可确认，支持点对点/广播/请求-响应 |
| G6 | 中断、崩溃、僵尸可检测并可恢复，恢复锚点为事件流 |

### 2.2 非目标（本期不做）

| ID | 不做 | 原因 |
|---|---|---|
| N1 | 跨机器分布式调度 | 先做好单机，预留扩展点 |
| N2 | 模型路由 / 自动选模型 | 与编排正交 |
| N3 | 通用工作流引擎（任意脚本 DAG） | 只服务 Agent 编排 |
| N4 | 修改 DSH 内核源码 | 通过稳定接口集成 |

### 2.3 架构决策（已定稿）

| ID | 决策 | 理由 |
|---|---|---|
| **AD-1** | **Sidecar 服务 + 独立 Web 面板**，不在 DSH 进程内实现 | 控制平面与 Agent 执行解耦；可独立重启/升级；面板不拖慢会话 |
| **AD-2** | **四域权限统一策略引擎**（fs / exec / net / env） | 只控文件路径不够：命令可绕道读文件、网络可外传数据 |
| **AD-3** | **SSE 推送 + Web 面板**，拉取接口作为兜底 | 现有 `wait_agent` 只能等状态变化，看不到 step；推送是唯一能实时看清「第几步」的方式 |
| **AD-4** | **替代 Agent Teams**，不长期共存 | 用户将关闭 Agent Teams；避免两套编排语义并行造成认知分裂 |

**AD-4 的推论**：插件必须自带完整工具面（编排、消息、权限、查询），不能依赖 `spawn_teammate / send_message / team_task_*` 等现有工具。

---

## 3. 系统架构

```
┌────────────────┐   REST / CLI / SSE   ┌──────────────────────────────┐
│  Lead Agent    │◀────────────────────▶│  dsh-team sidecar            │
│  (DSH 主会话)  │                      │  ├ Scheduler   (DAG 依赖)    │
└────────────────┘                      │  ├ StateStore  (SQLite/WAL)  │
                                        │  ├ PermBroker  (四域策略)    │
┌────────────────┐   RPC (仅代理工具)    │  ├ MessageBus  (信箱/回执)   │
│  Worker × N    │◀────────────────────▶│  ├ SSE Hub     (实时推送)    │
│  (成员进程)    │                      │  └ Web UI      (:PORT)       │
└────────────────┘                      └──────────────────────────────┘
```

### 3.1 组件职责

| 组件 | 职责 |
|---|---|
| **Scheduler** | DAG 求值、依赖就绪判定、任务派发、并发/队列控制、失败策略 |
| **StateStore** | `event` 只增流 + `member_state` 物化视图；崩溃恢复与重放 |
| **PermBroker** | 四域策略求值；越界申请-授权；所有 IO 的唯一出口 |
| **MessageBus** | 持久信箱、投递、回执（delivered/read/acked）、correlation 请求-响应 |
| **SSE Hub** | 事件 → 订阅者推送；断线重连按 `lastEventId` 续传 |
| **Web UI** | 成员看板、DAG 图、时间线、权限矩阵、审批队列、报告导出 |
| **Worker Runner** | 成员进程管理：拉起、心跳租约、优雅中断、回收 |

### 3.2 进程模型与权限强制点

- 每个成员是一个**独立 Worker 进程**（headless agent），由 sidecar 拉起与监管。
- Worker **只挂载 sidecar 提供的代理工具**（`fs.*` / `exec.*` / `net.*` / `env.*`），**禁用原生直连 IO 工具**——这样权限才可能真正强制（P0）。
- 兜底（P1）：Worker 启动时叠加 OS 级沙箱（Windows 上可用 Job Object / 受限令牌 / 目录 ACL），防止绕过代理直写。
- sidecar 为单进程、单机、默认仅监听 `127.0.0.1`，带本地 token 鉴权。

### 3.3 对外接口面

**REST（供 Lead Agent / 外部程序）**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/teams` | 建团队（含策略、配额） |
| POST | `/api/teams/{id}/members` | 加成员（超配额进 queued） |
| DELETE | `/api/members/{id}` | 回收/删除成员 |
| POST | `/api/tasks` `/api/deps` | 建任务与依赖边 |
| GET | `/api/status?team=` | 全员状态（seq/step/next/blockers） |
| GET | `/api/steps?member=&since=` | 事件流增量 |
| GET | `/api/dag?team=` | DAG 与节点状态 |
| POST | `/api/messages` | 发消息（支持 correlationId/ttl） |
| GET | `/api/messages?correlation=` | 查投递与回执 |
| POST | `/api/scope-requests` | 提交越界申请 |
| POST | `/api/scope-requests/{id}/decide` | 批准/驳回（落盘 decision） |
| GET | `/api/todos` · PATCH `/api/todos/{id}` | 待办共享 |
| GET | `/api/events?team=` | **SSE 推送**（`lastEventId` 续传） |
| GET | `/panel` | Web 面板 |

**CLI（供人/脚本）**

```
dsh-team status <team>            # 全员当前步
dsh-team dag <team>               # 依赖图与就绪态
dsh-team logs <member> -f         # 事件流 tail
dsh-team approve <request-id>     # 审批越界申请
dsh-team report <team> -o run.md  # 导出运行报告
dsh-team up / down                # 启停 sidecar
```

**SSE 事件类型**：`member.status` `step.append` `task.state` `message.delivered` `scope.request` `decision` `lease.warn`

---

## 4. 核心概念

| 概念 | 定义 |
|---|---|
| **Team** | 一次编排，含成员集合、DAG、策略 |
| **Member** | 一个 Worker 实例（可复用），有身份、权限、信箱、状态 |
| **Task** | DAG 节点，可指派给 Member |
| **Step** | 一次可观测动作，状态最小单位 |
| **Policy/Grant** | 四域策略；越界时的一次性授权 |
| **Message** | 带 correlationId 的持久消息 |
| **Decision** | 需裁决的持久对象 |
| **Lease** | 心跳租约，僵尸检测依据 |

---

## 5. 数据模型（SQLite + WAL）

```sql
member(id PK, name UNIQUE, role, model, context_mode,
  status,                -- provisioning|idle|running|blocked|done|failed|interrupted|retired|queued
  lease_until, current_task_id, current_step_seq, quota_json, created_at, updated_at)

task(id PK, team_id, subject, assignee, status,
  write_scopes_json, acceptance, attempts, attempted_at, finished_at)

dep(from_task, to_task, condition, artifact_path)
  -- condition: all_success|any_success|on_failure|artifact_exists

event(id INTEGER PK AUTOINCREMENT, team_id, member_id, task_id,
  seq, ts, phase, action, target, result, next, meta_json)
UNIQUE(member_id, seq)   -- seq 连续无空洞

member_state(member_id PK, seq, step, phase, status, last, next,
  blockers_json, as_of)   -- 由 event 可完全重建

-- ===== 四域权限 =====
policy(id PK, subject_type, subject_id, domain,      -- fs|exec|net|env
  matcher,                      -- path glob | cron? 不；exec: argv prefix | net: host:port | env: name glob
  ops,                          -- fs: read,write,delete,rename | exec: spawn | net: connect,listen | env: read,write
  mode,                         -- allow|deny
  constraints_json,             -- 例如 max_runtime、argv 白名单、仅 GET
  expires_at)

scope_request(id PK, member_id, domain, target, reason, diff_size,
  risk, blocked_step, fallback, status, decision_id, created_at)

scope_grant(id PK, request_id, domain, matcher, ops,
  single_use DEFAULT 1, expires_at, granted_by, used_at)

message(id PK, team_id, from_member, to_member, kind,
  correlation_id, payload, sent_at, delivered_at, read_at, acked_at,
  ttl_seconds, status)

todo(id PK, team_id, member_id, title, status, order_no, blocked_by_json, t, u)

decision(id PK, subject, kind, options_json, chosen, decided_by,
  decided_at, ttl_seconds, evidence)

audit(id INTEGER PK, ts, actor, domain, action, target,
  before_hash, after_hash, detail_json)
```

**硬约束**

- `event` 只增不改，`member_state` 可完全重建。
- 任一写入必须先过 PermBroker，拒绝时同时写 `event(FAIL)` + `audit`。
- `member_state.seq` 必须等于该成员最大 `event.seq`，否则标记 `stale=true`。

---

## 6. 功能需求

### FR-1 成员与生命周期（P0）

| ID | 需求 |
|---|---|
| FR-1.1 | 上限由 `maxMembers` 配置（默认 64，`0`=不限），**禁止硬编码**；超出进 `queued` 而非报错 |
| FR-1.2 | 支持 `spawn` / `retire`（回收保留历史）/ `remove`（彻底删除，需确认） |
| FR-1.3 | 成员可复用：`assign(memberId, taskId)` 把 idle 成员接新任务 |
| FR-1.4 | 状态机：`queued→provisioning→idle→running→blocked/idle/done/failed`；`retired` 终态 |
| FR-1.5 | 心跳租约：running 每 ≤15s 续租；超时 2 周期 → `suspected_dead` + SSE `lease.warn` |
| FR-1.6 | `interrupt` 优雅终止：**同步**写 status=`interrupted` + event，不留僵尸 running |

**验收**：spawn 32 个不报错；`maxMembers=4` 时第 5 个进 queued；interrupt 后 100ms 内 status 更新。

### FR-2 依赖编排（P0）

| ID | 需求 |
|---|---|
| FR-2.1 | DAG 声明依赖，支持 `all_success` / `any_success` / `on_failure` / `artifact_exists(path)` |
| FR-2.2 | 依赖满足后**自动**置 `ready` 并唤醒 assignee，**不得要求 Lead 轮询** |
| FR-2.3 | fan-out / fan-in（join 节点） |
| FR-2.4 | 并发控制：全局与每成员 `maxConcurrency`，队列按优先级 + FIFO |
| FR-2.5 | 失败策略：`retry(n, backoff)` / `skip` / `abort_team` / `continue` |
| FR-2.6 | 建图时环检测；运行时循环上限保护 |

**验收**：A→B→C，A 完成 1s 内 B 自动启动，全程无人工干预。

### FR-3 四域权限（P0）

统一策略对象：`subject + domain + matcher + ops + mode + constraints`。

| 域 | matcher | ops | 约束示例 | 默认 |
|---|---|---|---|---|
| **fs** | 路径 glob | read / write / delete / rename | 只读目录、禁止 `.git/**` | 工作区读允许，写默认拒绝 |
| **exec** | argv 前缀 / 命令名 | spawn | 参数白名单、最大运行时长、cwd | 默认拒绝 |
| **net** | host:port / 域名 | connect / listen | 仅 GET、禁内网段、域名白名单 | 默认拒绝 |
| **env** | 变量名 glob | read / write | 敏感变量只给句柄不给值 | 默认拒绝读取密钥 |

| ID | 需求 |
|---|---|
| FR-3.1 | 策略按 `member` / `role` / `task` 维度授予，交叉生效（取最严） |
| FR-3.2 | **默认拒绝**；deny 优先于 allow；未匹配任何 allow 的写/执行/连接/读密钥一律失败 |
| FR-3.3 | 强制点在 Worker 代理层（唯一 IO 出口），不是提示（P-3） |
| FR-3.4 | 越界流程：`blocked` → `scope_request` → `decision` → `scope_grant`（单次 + TTL + 精确匹配） |
| FR-3.5 | 授权可追溯：event 记 `grant_id`，audit 记 before/after hash |
| FR-3.6 | 同路径并发写：版本校验 + 可选路径租约；冲突按退避重试（上限可配） |
| FR-3.7 | 策略变更立即生效，并对已运行成员热更新 |
| FR-3.8 | 敏感 env 值不得出现在日志/事件/面板中（只显示 `<redacted>`） |

**验收**：四域各自造一次越界，全部硬失败且目标无副作用；批准后单次成功、二次再拒。

### FR-4 消息与信箱（P0）

| ID | 需求 |
|---|---|
| FR-4.1 | `send(from,to,payload,kind,correlationId?,ttl?)`，持久化，离线保留 |
| FR-4.2 | 投递：目标 running 时下一个 step 边界注入；idle 时自动唤醒；永不丢 |
| FR-4.3 | 回执三态 `delivered/read/acked`，可按 correlationId 查询 |
| FR-4.4 | 广播（topic 订阅）与 request/response（超时 + 重试） |
| FR-4.5 | **决策类必须落盘为 `decision`**，消息只是通知（P-5） |
| FR-4.6 | 投递延迟可观测，暴露 p95 |

**验收**：长任务中收到消息 ≤1 个 step 内送达并 ack；idle 成员被消息拉起。

### FR-5 状态与待办共享（P0，核心差异化）

| ID | 需求 |
|---|---|
| FR-5.1 | 每动作产出结构化 event（phase/action/target/result/next），粒度=一次可观测动作 |
| FR-5.2 | 查询：`status(member)` `steps(member, sinceSeq)` `todos(filter)` `blockers(team)` `dag(team)` |
| FR-5.3 | 每次查询返回 `as_of` + `version`，明确是快照（P-8） |
| FR-5.4 | **SSE 推送**：事件产生即推送，p95 < 500ms；断线按 `lastEventId` 续传 |
| FR-5.5 | `member_state.seq == max(event.seq)`，否则 `stale=true` 并告警（P-4） |
| FR-5.6 | 待办：成员可增删改查，全员可查「谁在做什么、卡在哪」 |
| FR-5.7 | 进度估算：按 task 的 step 总数或 acceptance 项数给百分比（可选） |

**查询返回示例**

```json
{ "member": "lab-alpha", "task": "task-3", "status": "running",
  "step": "S5", "seq": 16, "as_of": "2026-10-28T09:33:25.600Z",
  "last": "edit config/shared.json", "next": "read 校验",
  "blockers": [], "stale": false }
```

### FR-6 恢复与容错（P1）

| ID | 需求 |
|---|---|
| FR-6.1 | `resume(member)`：从最后 `event.seq` 的下一步继续，禁止重复单元（P-6） |
| FR-6.2 | 崩溃后 `reconcile()`：事件流 vs 磁盘实际，输出差异报告 |
| FR-6.3 | 重试统一：最多 N 次 + 指数退避 + 上限（P-7） |
| FR-6.4 | 僵尸检测：租约过期 → 标记 + SSE 告警 + 可配自动接管 |
| FR-6.5 | sidecar 重启后从 SQLite 恢复，任务进 `ready`/`blocked`，不静默丢 |

### FR-7 Web 面板（P0，AD-1/AD-3）

| ID | 需求 |
|---|---|
| FR-7.1 | **成员看板**：卡片式，实时显示 status/step/seq/next/blockers/心跳 |
| FR-7.2 | **DAG 视图**：节点状态着色、依赖边、关键路径、就绪/阻塞高亮 |
| FR-7.3 | **时间线**：事件流实时滚动，可按成员/phase 过滤，支持暂停与回放 |
| FR-7.4 | **权限矩阵**：成员 × 四域 × 生效规则，可编辑（带确认） |
| FR-7.5 | **审批队列**：scope 申请、危险命令、超预算动作，一键批准/驳回 + 理由 |
| FR-7.6 | **消息视图**：信箱、投递状态、请求-响应配对 |
| FR-7.7 | **报告导出**：一键生成 Markdown run 报告 |
| FR-7.8 | 面板数据全部来自 SSE，断线自动重连，刷新不丢视图状态 |

### FR-8 审计（P2）

| ID | 需求 |
|---|---|
| FR-8.1 | event/audit 不可变，支持按 run 重放 |
| FR-8.2 | 每次写/执行/连接记录 actor、域、目标、before/after hash |
| FR-8.3 | 统计：耗时、重试、消息量、冲突、越界次数 |

---

## 7. 关键流程

### 7.1 依赖自动触发
```
A(done) → Scheduler 检查 dep(all_success) → task B: ready
→ 唤醒 lab-beta → 写 event(S1 start) → SSE(member.status)
Lead 全程不参与轮询
```

### 7.2 越界申请（四域通用）
```
member 请求 fs.write config/x.json → PermBroker 拒绝（默认拒绝）
→ status=blocked, blockers=[scope_request:001] → SSE(scope.request)
Lead/人: decision(APPROVED) + scope_grant(path, single_use, ttl)
→ member 重试 → grant 命中 → 写入 → audit(before/after hash) → grant 置 used
```

### 7.3 运行中查询步骤
```
Lead: GET /api/status → 一次拿到全员 seq/step/next/blockers
Web: SSE step.append → 时间线实时追加“lab-alpha | S5 | edit config | OK”
```

### 7.4 中断恢复
```
interrupt(lab-alpha) → 同步置 status=interrupted + event(phase=interrupt) → SSE
resume(lab-alpha) → 读 max(event.seq) → next=step+1 → 注入恢复指令 → status=running
```

---

## 8. 验收标准（实现完成必须逐条演示）

| ID | 场景 | 通过标准 |
|---|---|---|
| AC-1 | 同时启动 32 个成员 | 无上限错误，全部完成；`maxMembers=4` 时第 5 个进 queued |
| AC-2 | DAG：A → (B1‖B2) → C | A 完成 1s 内 B1/B2 自动启动；C 等两者成功才启动；无人为轮询 |
| AC-3 | 四域越界（fs/exec/net/env 各一次） | 全部硬失败、目标无副作用、产生 scope_request |
| AC-4 | 批准后单次写入 | 成功；同路径二次写入重新要求申请 |
| AC-5 | 三人并发写同一文件 | 零丢更新；退避重试收敛；最终含三方内容 |
| AC-6 | 运行中查状态 | 返回 step/seq/next/blockers，延迟 < 1s |
| AC-7 | 长任务中收消息 | ≤1 step 内送达并 ack；idle 成员被消息拉起 |
| AC-8 | interrupt → resume | seq 连续无重复；无僵尸 running |
| AC-9 | kill sidecar 后重启 | 状态完整恢复，无静默丢失 |
| AC-10 | SSE 实时性 | step 产生到面板显示 p95 < 500ms；断线重连续传不丢事件 |
| AC-11 | 权限矩阵热更新 | 面板改规则后，运行中成员立即按新规则被拒/放行 |
| AC-12 | 审计还原 | 报告可还原“谁在何时改了哪个文件、hash 前后值” |
| AC-13 | 敏感 env | 面板/事件/日志中一律 `<redacted>` |

---

## 9. 迁移与切换（AD-4）

| 步骤 | 动作 | 验收 |
|---|---|---|
| S1 | sidecar 独立运行，与现有 Agent Teams 并行灰度 | 同一任务两套跑，结果一致 |
| S2 | Lead 默认改用 `dsh-team` 工具面 | 不再调用 `spawn_teammate` 等 |
| S3 | 关闭 DSH Agent Teams | 全流程仅依赖 sidecar |
| S4 | 移除兼容兜底 | 迁移完成 |

> 兼容工具面建议：`team.spawn / team.send / team.status / team.task / team.scope / team.todo`，
> 语义与旧工具接近但**不依赖其实现**，迁移时 Lead 侧提示词只需替换工具名。

---

## 10. 里程碑

| 阶段 | 范围 | 产出 |
|---|---|---|
| M1（可用） | FR-1、FR-2、FR-5、FR-4 基础、SSE | 无上限 + DAG 自动派发 + 实时状态 + 点对点消息 |
| M2（可控） | FR-3 四域、FR-6 | 强制权限 + 申请审批 + 中断恢复 + 僵尸检测 |
| M3（好用） | FR-7、FR-8 | Web 面板 + 审批队列 + 审计报告 |

---

## 11. 已定稿决策（v1.0 冻结）

| # | 决策项 | 定稿结论 |
|---|---|---|
| D-1 | 形态 | Sidecar 服务 + 独立 Web 面板 |
| D-2 | 权限范围 | 四域：fs / exec / net / env，全部可配置 |
| D-3 | 实时性 | SSE 推送 + Web 面板；REST 拉取作兜底 |
| D-4 | 与 Agent Teams 关系 | 替代；并行灰度后关闭旧机制 |
| D-5 | 审批人 | Lead 可批 + 保留人工审批入口 |
| D-6 | 自动批准 | 允许（如小 diff 自动过），决策记为 `auto` |
| D-7 | 成员复用 | 可复用工位，但按任务隔离上下文，不保留对话记忆 |
| D-8 | 单任务失败默认策略 | `continue`（其他分支继续），团队级可改 `abort` |
| D-9 | 面板位置 | 独立端口，可选 iframe 嵌入 DSH GUI |
| D-10 | 成本统计 | M3 纳入面板 |
| D-11 | sidecar 鉴权 | 本地 token（`~/.dsh/team/token`） |
| D-12 | 团队定义 | 支持 YAML 导入 / 导出 |

**变更控制**：以上为 v1.0 冻结范围。实现中若发现需求冲突，取实现成本更低的方案，但必须写一份 ADR 记录偏离原因，不得静默改需求。

---

## 附录 A：需求来源（实测事故 → 需求映射）

| 事故 | 轮次 | 对策 |
|---|---|---|
| 第 9 个成员 spawn 报 `limit 8` | 5 | FR-1.1 |
| `blocked_by` 不启动任何成员 | 4/6 | FR-2.2 |
| 写域 overlap 只告警不阻断 | 3 | FR-3.2/3.3 |
| Lead 无法知道成员在第几步 | 1/4 | FR-5.1/5.2/5.4 |
| 只发消息不落盘，成员空等 240s | 4 | FR-4.5 |
| interrupt 后 `state=running` 僵尸 | 6 | FR-1.6/FR-6.1 |
| 3 路并发把「重试一次」打满 | 6 | FR-3.6/FR-6.3 |
| 成员审计快照少报并发写 | 6 | FR-5.3 |

## 附录 B：术语对照（现有 → 新）

| 现有 | 新（sidecar） |
|---|---|
| `spawn_teammate` | `POST /api/teams/{id}/members` |
| `send_message` | `POST /api/messages`（持久、回执、离线） |
| `wait_agent` | `GET /api/events`（SSE，不阻塞轮询） |
| `team_task_*` | `POST /api/tasks` + `/api/deps`（DAG 自动触发） |
| `list_agents` | `GET /api/status`（含 step/seq/blockers） |
| 无 | `policy` / `scope_request` / `scope_grant`（四域权限） |
| 无 | `todo`（待办共享） |
| 无 | Web 面板 + 报告导出 |

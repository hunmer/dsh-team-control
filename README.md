# dsh-team — Agent 编排控制平面

> 把「8 人上限 + 只能并行 spawn + 口头协作 + advisory 写域」升级为**可配置上限、DAG 依赖自动驱动、四域强制执行权限、SSE 实时可观测**的独立 sidecar。
> 实现依据：`prd/agent-team-plugin-prd.md` v1.0（冻结）→ `prd/implementation-brief.md`。实现契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

```
Lead Agent ──REST/CLI/SSE──▶ dsh-team sidecar
                             ├ Scheduler   DAG 依赖求值 + 自动派发
                             ├ StateStore  event 只增流 + member_state 物化
                             ├ PermBroker  四域唯一 IO 出口
                             ├ MessageBus  持久信箱 + 三态回执
                             ├ SSE Hub     lastEventId 断线续传
                             └ Web UI      成员看板 / DAG / 时间线 / 审批
Worker × N ◀──stdio NDJSON RPC（只有代理工具）──┘
```

## 5 分钟跑通

要求 **Node.js ≥ 22.15**（`node:sqlite` 需 ≥22.5，Worker 的同步 `module.registerHooks` 需 ≥22.15；实测 v24.22）。**零依赖、零构建**，不需要 `npm install`。

```bash
node --version            # 应 ≥ v22.15
node demo/run-demo.mjs    # 3 成员 + DAG + 一次越界审批 + 一次 interrupt/resume
node tests/run-all.mjs    # 13 条 AC 全量验收
```

Demo 会打印每一步时间线，最后校验 4 个产物文件与事件流一致性。

补充检查（非 AC，覆盖 AC 未触及的路径）：

```bash
node tests/routes-smoke.mjs    # 48 个 REST 路由，禁止 500
node tests/panel-contract.mjs  # 面板实际消费的 17 项数据契约
node tests/cli-smoke.mjs       # status/dag/logs/approve/report/up/down
```

### 手动起服务

```bash
node bin/dsh-team.mjs up --port 4317 --data ~/.dsh/team
# stdout 第一行是 {event:'ready', url, port, token, panel}
open "http://127.0.0.1:4317/panel#token=<token>"   # 面板（token 在 hash 里，页面自取后抹除）
node bin/dsh-team.mjs status <team>                # 全员当前步
node bin/dsh-team.mjs down
```

## 五条硬约束怎么落地（优先级高于任何功能需求）

| # | 约束 | 实现位置 | 证据 |
|---|---|---|---|
| **C1** | Worker 只挂代理工具，禁用原生直连 IO | Worker 以 `node --permission --allow-fs-read=<bundle>` 启动（**无** `--allow-fs-write`/`--allow-child-process`/`--allow-worker`/`--allow-addons`）；bundle 首个动作 `module.registerHooks` 锁死模块解析；并中和 `fetch`/`WebSocket`/`process.binding`/`_linkedBinding`/`dlopen`/`getBuiltinModule`/`report`/`kill`。全部 IO 只能走 stdio RPC → [`src/broker.mjs`](src/broker.mjs) | `tests/ac-03-perm.mjs` 让 Worker 真试 `import('node:fs')`/`fetch`/`getBuiltinModule`/`binding`，全部 BLOCKED，目标文件 hash 不变 |
| **C2** | `event` 只增不改；`member_state` 可由 event 完全重建 | [`src/eventstore.mjs`](src/eventstore.mjs)：唯一写入口 `append()` 在同事务内分配 seq + 插 event + upsert 投影；`rebuild()` 只读 event 重放。租约/pid 刻意放在 `member_runtime`，不污染可重建状态 | 每次 `append` 后 `/api/verify` 全量对账：`progress 事件数 == member_state.seq`，逐字段深比较 |
| **C3** | 默认拒绝；deny 优先；多规则取最严 | [`src/policy.mjs`](src/policy.mjs) 纯函数求值：显式 deny → 有效 grant → 显式 allow → 默认拒绝；多条 allow 合并取最严（`maxRuntimeMs` 取 min、`methods` 取交集、`readOnly` 生效） | `tests/ac-03` 四域越界全硬失败；`tests/ac-04` 批准单次、二次再拒；`tests/ac-11` 热更新立即生效 |
| **C4** | 决策必须落盘为 `decision`；消息只作通知 | [`src/broker.mjs`](src/broker.mjs) `decide()` 在**一个事务**写 `decision` + `scope_grant` + `event`，提交后才唤醒等待者/推 SSE。Worker 的 `scope.request` RPC 是**阻塞长轮询**（不是消息轮询） | `tests/ac-04` 查 `decision` 表与 `grant.used_at`；Worker 无空等 |
| **C5** | 中断必须同步写状态，禁止残留 `running` | [`src/runner.mjs`](src/runner.mjs) `interrupt()`：同步事务写 `status=interrupted` + `event(interrupt)` + 清租约，**提交后**才发控制帧/信号 | `tests/ac-08`：interrupt 返回后立即 GET 必须 `interrupted`（实测 2–6ms） |

> 兜底（P1，未启用）：Windows Job Object / 受限令牌。当前 C1 由 Node 权限模型 + 模块白名单提供**进程内**强制；net 域无内核门（Node 24 尚无 `--allow-net`），由模块白名单 + 全局中和承担，见 [ADR-002](docs/adr/ADR-002-worker-confinement.md)。

## 核心机制

### 事件流是唯一真相
每次可观测动作一条 `event`（`seq` 每成员连续、`UNIQUE(member_id,seq)`），`member_state` 是它的物化视图。**任何状态变更都必须经由 `append()`**，因此崩溃恢复、审计、面板、resume 锚点全部来自同一根主轴。

### DAG 自动派发
依赖满足 → 调度器立即求值 → `ready` → 唤醒 assignee 启动 Worker。Lead **不需要轮询**。
支持 `all_success` / `any_success` / `on_failure` / `artifact_exists(path)`；建图时环检测；失败策略 `retry(n,backoff)` / `skip` / `abort_team` / `continue`。

### 四域权限 = 一个策略对象
`subject(member|role|task|team) + domain(fs|exec|net|env) + matcher + ops + mode + constraints`。
越界流程：`blocked` → `scope_request` → `decision`（落盘）→ `scope_grant`（单次 + TTL + 精确匹配）→ 重试命中 → `audit` 记 before/after hash。

### 并发写
`fs.write` 带 `expectVersion`（DB 内 `file_state.version` 乐观锁），冲突返回 `E_VERSION`，Worker 指数退避重试（上限可配）。`fs.append` 是内置的「读-改-CAS 写」原语，三人抢写零丢更新（`tests/ac-05` 重复 20 轮）。

## CLI

```
dsh-team up [--port N] [--data DIR]
dsh-team down
dsh-team status <team> [--json]
dsh-team dag <team> [--json]
dsh-team logs <member> [-f] [--since N]
dsh-team approve <request-id> [--deny] [--reason TEXT] [--ttl SEC]
dsh-team report <team> [-o run.md]
```

## 交付物

| 交付物 | 位置 |
|---|---|
| sidecar 可执行体 | `bin/dsh-team.mjs`（`dsh-team up`，默认 `127.0.0.1:4317`） |
| Web 面板 | `src/web/`（`/panel`；成员看板/DAG/时间线/权限矩阵/审批/消息/报告） |
| CLI | `bin/dsh-team.mjs`（六个子命令） |
| 测试套件 | `tests/ac-*.mjs` + `tests/run-all.mjs`（覆盖 AC-1 ~ AC-13） |
| 文档 | 本文件 + [`docs/CONTRACT.md`](docs/CONTRACT.md) + [`docs/adr/`](docs/adr/) |
| Demo | `demo/run-demo.mjs` |

## 验收矩阵

| AC | 场景 | 脚本 |
|---|---|---|
| AC-1 | 32 成员并发、上限可配、queued 晋升 | `tests/ac-01-members.mjs` |
| AC-2 | A→(B1‖B2)→C 自动派发（1s 内） | `tests/ac-02-dag.mjs` |
| AC-3 | 四域越界硬失败 + 无副作用 + scope_request | `tests/ac-03-perm.mjs` |
| AC-4 | 批准后单次写、二次再拒 | `tests/ac-04-grant.mjs` |
| AC-5 | 三人并发写零丢更新（20 轮） | `tests/ac-05-concurrent.mjs` |
| AC-6 | 运行中查 step/seq/next/blockers（<1s） | `tests/ac-06-status.mjs` |
| AC-7 | 消息 ≤1 step 送达 + idle 唤醒 | `tests/ac-07-message.mjs` |
| AC-8 | interrupt → resume，seq 连续、无僵尸 | `tests/ac-08-interrupt-resume.mjs` |
| AC-9 | SIGKILL 后重启完整恢复 | `tests/ac-09-crash-recovery.mjs` |
| AC-10 | SSE p95 < 500ms + 断线续传 | `tests/ac-10-sse.mjs` |
| AC-11 | 权限矩阵热更新 | `tests/ac-11-hotpolicy.mjs` |
| AC-12 | 审计还原 hash 前后值 | `tests/ac-12-audit.mjs` |
| AC-13 | 敏感 env 一律 `<redacted>` | `tests/ac-13-redact.mjs` |

## 目录

```
bin/dsh-team.mjs      CLI 入口（up/down/status/dag/logs/approve/report）
src/core.mjs          组合根 + 业务查询 + 报告
src/db.mjs            SQLite schema / 事务 / 轻量迁移
src/eventstore.mjs    C2：append / rebuild / verify
src/policy.mjs        C3：纯求值器
src/broker.mjs        四域唯一 IO 出口 + 审计 + grant + CAS
src/scheduler.mjs     DAG 求值 / 派发 / 并发 / 失败策略 / 环检测
src/runner.mjs        子进程 / 租约 / 同步中断（C5）/ 恢复
src/bus.mjs           持久信箱 / 回执 / request-response
src/sse.mjs           SSE hub / lastEventId 续传
src/server.mjs        REST + SSE + 静态面板 + token 鉴权
src/worker/worker.mjs 受限 Worker（单文件，仅 import node:module）
src/util.mjs          ID/时间/哈希/glob/脱敏/错误
src/web/              面板（panel.html / app.js / app.css）
docs/CONTRACT.md      实现契约（API/SSE/RPC/不变量）
docs/adr/             每条偏离一份 ADR
tests/                AC 脚本 + harness
demo/run-demo.mjs     可复现演示
```

## 运维

- 数据目录默认 `~/.dsh/team`（`--data` / `DSH_TEAM_HOME` 覆盖）：`team.db`（WAL）、`token`、`run/sidecar.json`、`workers/<member>/`。
- 鉴权：所有 `/api/**` 需 `Authorization: Bearer <token>`；SSE 允许 `?token=`（EventSource 不能带 header）。`/panel` 静态资源公开。
- 端口默认 `4317`，仅监听 `127.0.0.1`；`--port 0` 取随机端口（测试用）。
- 崩溃安全：`SIGKILL` 后重启自动 `recover()` —— `running` 任务回 `ready`、成员置 `interrupted`、写 `recover` 事件，不静默丢。

## 已知取舍

见 [`docs/adr/`](docs/adr/)：Node 24 无 net 权限门（ADR-002）、member.status 单点存放以保 C2（ADR-003）、并发写用 CAS 而非路径租约（ADR-004）、建任务 settle 窗口与派发前重求值（ADR-005）、topic 订阅与 YAML 导入导出延后（ADR-006）、SSE 合成帧语义（ADR-007）。

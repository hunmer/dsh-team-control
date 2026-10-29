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
                             └ Web UI      Trace 瀑布（成员看板）/ DAG / 时间线 / 审批
Worker × N ◀──stdio NDJSON RPC（只有代理工具）──┘        ← runtime=worker
DSH sub-agent × N ◀──subagents.startActivation / sendMessage── dsh-plugin ┘  ← runtime=agent
```

## 5 分钟跑通

要求 **Node.js ≥ 22.15**（`node:sqlite` 需 ≥22.5，Worker 的同步 `module.registerHooks` 需 ≥22.15；实测 v24.22）。**零依赖、零构建**，不需要 `npm install`。

```bash
node --version            # 应 ≥ v22.15
node demo/run-demo.mjs    # 3 成员 + DAG + 一次越界审批 + 一次 interrupt/resume
node tests/run-all.mjs    # 15 条 AC + 插件/面板/路由/CLI 脚本全量验收
```

Demo 会打印每一步时间线，最后校验 4 个产物文件与事件流一致性。

补充检查（非 AC，覆盖 AC 未触及的路径）：

```bash
node tests/routes-smoke.mjs    # 48 个 REST 路由，禁止 500
node tests/panel-contract.mjs  # 面板实际消费的 17 项数据契约
node tests/cli-smoke.mjs       # status/dag/logs/approve/report/up/down
node tests/plugin-agent.mjs    # Host 插件这一半的 agent 闭环（spawn/简报/回报/idle 兜底/interrupt）
node tests/plugin-client.mjs   # 客户端入口注册与 11 个 team_* 工具清单
node tests/plugin-trace.mjs    # session span 挂到成员节点的 Trace 链路
node tests/db-migration.mjs    # 老库（schema v1）就地补列/补索引，不重建表
```

### 手动起服务

```bash
node bin/dsh-team.mjs up --port 4317 --data ~/.dsh/team
# stdout 第一行是 {event:'ready', url, port, token, panel}
open "http://127.0.0.1:4317/panel"                    # 面板（API 免 token，仅监听回环）
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

## 作为 DSH 插件安装

sidecar 本身是独立进程；要让**模型直接调用**它，用 [`dsh-plugin/`](dsh-plugin/) 这个 Host bundle
（11 个 `team_*` 工具 + 服务生命周期 + agent 成员调度，零第三方依赖）。安装后工具面对本 profile 的所有会话生效。

```text
plugin_manager(action: "install_bundle", target: "C:\\...\\agent-team-plugin\\dsh-plugin-ui")
```

期望 `application: "applied"`、`warnings: []`；用 `cordis_inspect_query` 复核（无需审批）。

| bundle | 作用 | 卸载 target |
|---|---|---|
| [`dsh-plugin/`](dsh-plugin/) | 11 个 `team_*` 工具 + sidecar 生命周期 + agent 成员调度 | `@local/dsh-team-plugin` |
| [`dsh-plugin-ui/`](dsh-plugin-ui/) | 「编排」看板：优先注册成 **dsh-better-sidebar 页签**，未装时回退 **左侧栏入口 + 右侧栏 Tab**（均嵌入 sidecar 自带 Web 面板） | `@local/dsh-team-ui` |
| [`skills/dsh-agent-team/`](skills/dsh-agent-team/) | 给模型看的完整配方 skill（调用顺序、字段陷阱、并发/依赖、症状→修法）；复制到 `~/.dsh/skills/` 即进会话技能目录 | — |

- 工具 bundle：`autoStart: true` 时 sidecar 未运行会在**首次工具调用**自动拉起，并作为 DSH Host 的子进程；
  插件卸载时只回收自己拉起的进程。配置见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。
- **两种成员运行时**（`team_create` 的 `runtime`）：
  `worker`（默认）由 sidecar 拉起沙箱 Node 进程，每个 `plan` step 走四域 broker；
  `agent` 则由插件调宿主的 `subagents.startActivation` 拉起**真 DSH sub-agent session**，成员用自己的模型和工具干活，
  sidecar 只做任务/DAG/审批/看板（`POST /api/agents/*`，见 [CONTRACT §3.8](docs/CONTRACT.md)）。
  agent 团队不启动任何 worker 进程，任务派发走「插件调度器原子认领 + `subagents.sendMessage` 简报」，
  成员以 `team_report_task` 回报，`agent/status` 事件做兜底收尾；成员的 session 工具调用自动挂到看板成员节点下。
  **验证状态**：sidecar 侧与插件工具逻辑由 `tests/ac-15-agent-runtime.mjs`、`tests/plugin-agent.mjs`（真 sidecar + 假 ctx）
  覆盖；**真机整链已跑通**（2026-10-29，4317 侧车）：`team_create(runtime:"agent")` → `team_spawn`（真子会话
  `subagents.startActivation`）→ `team_task` → 简报进成员信箱 → 成员写文件 → `team_report_task` → DAG 推进；
  同一成员被再次 `sendMessage` 唤醒复用跑第二个任务。宿主插件改动仍需**重启 DSH**（或禁用/启用一次
  `include:dsh-team`）才生效——运行中的进程缓存了旧模块。
- **成员可用不同模型**（`team_spawn` 的 `agentProvider` / `model` / `reasoningEffort`）：目录的唯一来源是 Host 的
  `ctx.llm`（`listProviders` + `listModels`，含未配置的 dormant provider），插件只把映射快照同步给 sidecar；
  面板「模型路由」页勾选启用、写备注，`team_models` 只返回启用子集。`team_spawn` 把 route 写进
  `subagents.startActivation` 的 `request.agentOptions`，并且只接受已启用的 route（显式指定和继承 Lead 都过同一道闸门；
  目录里查不到的 route 不拦）。不传则继承 Lead。
  换 provider/model 且未显式传 `reasoningEffort` 时，DSH 会丢弃继承的 effort（本插件按同一规则在返回值里置空）。
  sidecar 只存 provider/model 映射与开关，**不内置 LLM 客户端、不保存任何凭据**。
- **模型怎么学会用法**：调用顺序写在工具描述里（`team_create` 的 `START HERE …`、`team_spawn` 返回的 `member.id`、
  `team_task` 的简报要自包含），完整配方在 skill [`skills/dsh-agent-team/SKILL.md`](skills/dsh-agent-team/SKILL.md)
  （安装到 `~/.dsh/skills/` 后进会话技能目录），覆盖字段陷阱、并发/依赖、症状→修法表。
- UI bundle：优先把「编排」看板注册成 **dsh-better-sidebar 的页签**（`ctx.betterSidebar.registerTab`，
  id `dsh-team:panel`，order 30，单例）；`dsh-better-sidebar` 晚于本插件加载时用
  `ctx.inject(['betterSidebar'], …)` 等它就绪再切过去，并撤掉自己的入口。
  未装时回退：左侧边栏底部「编排 / Team」按钮（`sidebar.footer.action`）→ 点击
  `ctx.sidebarRight.openTab('dsh-team')` 在**右侧栏**打开 Tab（与文件/终端同机制），再没有就退到中央面板。
  两种承载里的内容都是 iframe 加载 sidecar 自带的 `/panel`（与 `:4317/panel` 完全一致：
  7 视图 + SSE + 消息 + 报告导出）；DSH 原生渲染的「精简版」已移除。
  浏览器只访问同源 `/dsh-team-api/**` 与 `/panel/**`，
  由 Host 侧代理注入 sidecar token（token 不出 Host）；两条前缀路由**仅接受回环地址**。
  配置见 [`dsh-plugin-ui/README.md`](dsh-plugin-ui/README.md)。
- **会话右上角成员条**：`conversation.session.header.utilities`（id `dsh-team:members`）列出当前会话派出的
  团队成员（`parentId = 本会话` 且 `origin = 'subagent'`），运行中的排前面；点 chip 用 DSH 内置
  `subagentchat` 页在**右侧栏**打开该成员的完整对话
  （`ctx.sidebarRight.openResource('dsh-resource://subagentchat/session/<child>?parent=<parent>', { kind:'subagentchat', preferNewPane:true })`），
  与 better-sidebar 的「侧边对话」同一机制。详见 [`dsh-plugin-ui/README.md`](dsh-plugin-ui/README.md)，
  测试 `tests/ui-member-strip.mjs`。
- 独立面板 `{baseUrl}/panel` 仍然保留（单文件、零依赖、SSE 实时），适合不打开 DSH 时使用。
- **成员看板已换成 Trace 瀑布**（`src/web-ui/src/components/trace-waterfall/`，源自 affectui-trace-waterfall）：
  Worker 步骤由 event 流聚合，Agent 工具调用由 `dsh-plugin/` 在 Host 侧监听 `tools/execute` 上报
  `POST /api/spans`（`reportToolCalls` 默认开启，可配 `traceInputMax`），写入即广播 SSE `span.append`，
  面板去抖刷新。默认只看**近 30 分钟**（标题栏可切 5 分钟 ~ 全部历史），避免长期闲置团队的横轴被拉爆。
  **宿主插件改动需重启一次 DSH 才生效**（运行中的进程缓存了旧模块）。
- **面板主页已 affectui 化**（`src/web-ui/src/affectui/` 复制自 affectui-agent-run，见
  [`docs/adr/ADR-010-panel-affectui-home.md`](docs/adr/ADR-010-panel-affectui-home.md)）：横向 Tabs 换成
  affectui 左侧竖导航（「主页」+ 7 个业务视图，带成员/待审/未读徽标），主页整屏渲染 `AgentRun`，
  TopBar 移到窗口顶栏并新增亮/暗切换；默认首屏是主页，旧的业务视图选择仍从 sessionStorage 恢复。
  团队切换下拉在左侧栏顶部；主页右栏的审批卡接的是真实 `scopeRequests`（Approve/Deny 直接落盘并刷新
  审批队列），运行时间线首期仍用内置 demo 数据；侧栏演示用的 Draft/DiffCard 区块已移除。
  主页的标准控件统一用仓库 coss 组件（Stop run / Run again / Run options / 审批卡按钮 / 侧栏折叠 /
  团队选择），并把 affectui 的全局 `button` reset 收窄成 `button:not([data-slot="button"])`——它是
  无 layer 规则，原本会盖掉 Tailwind utilities，使 `.ui-as` 里的 coss 按钮和团队选择器失去边框与背景。
- **迁移已完成**：`@deepseek-ai/dsh-experimental-agent-team-profile` 已从本 profile 的 bundles 移除，
  工具面里不再有 `spawn_teammate / wait_agent / team_task_*`（`send_message / list_agents / interrupt_agent`
  仍存在，属 subagent 体系，与 Agent Teams 无关）。

## 交付物

| 交付物 | 位置 |
|---|---|
| sidecar 可执行体 | `bin/dsh-team.mjs`（`dsh-team up`，默认 `127.0.0.1:4317`） |
| Web 面板 | `src/web/`（`/panel`；affectui 侧栏导航 + 主页 `AgentRun`，业务视图：**成员看板 = Trace 瀑布**/DAG/时间线/权限矩阵/审批/消息/报告；亮·暗主题） |
| CLI | `bin/dsh-team.mjs`（六个子命令） |
| 测试套件 | `tests/ac-*.mjs` + `tests/run-all.mjs`（覆盖 AC-1 ~ AC-15，含 agent 运行时 `tests/ac-15-agent-runtime.mjs`、插件侧 agent 闭环 `tests/plugin-agent.mjs`、模型路由目录 `tests/llm-catalog.mjs` 与插件路由分配 `tests/plugin-models.mjs`、Trace 上报链路 `tests/plugin-trace.mjs` 与客户端入口注册 `tests/plugin-client.mjs`） |
| 文档 | 本文件 + [`docs/CONTRACT.md`](docs/CONTRACT.md) + [`docs/adr/`](docs/adr/) |
| Demo | `demo/run-demo.mjs`、`demo/seed.mjs`（给运行中实例灌可交互演示数据） |
| DSH 插件（工具） | `dsh-plugin/`（Host bundle：11 个 `team_*` 工具 + sidecar 生命周期 + agent 成员调度） |
| DSH 插件（界面） | `dsh-plugin-ui/`（dsh-better-sidebar 页签；未装时回退左下角「编排」入口 + 右侧栏 Tab；iframe 嵌入 sidecar 自带 Web 面板） |

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
| AC-14 | Trace 瀑布：span 幂等上报 + SSE `span.append` + 步骤/工具聚合成树 + 时间窗 | `tests/ac-14-trace.mjs` |
| AC-15 | Agent 运行时：`runtime` 落库、`/api/agents/register` 幂等、dispatch 原子认领 + 并发拒绝、归属校验、done 推进依赖、blocked 不消耗重试、`agent/status` idle 兜底、trace 挂成员节点；worker 团队回归 | `tests/ac-15-agent-runtime.mjs` |

插件侧的 agent 闭环另有 `tests/plugin-agent.mjs`（不占 AC 编号）：`team_spawn` 真调 `subagents.startActivation` 并回注 session、任务简报带 `taskId` 与 `team_report_task` 指引、成员回报推进任务、未知 session 回报被拒、`agent/status=idle` 兜底并自动续派、`interrupt` 走 `subagents.interrupt` 且任务回 `ready`，以及 worker 团队不受影响。模型路由另有 `tests/llm-catalog.mjs`（目录同步/启用停用/备注/清理）与 `tests/plugin-models.mjs`（`ctx.llm` → `team_models` → `agentOptions`、route 继承与清空、停用拦截）。

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
src/server.mjs        REST + SSE + 静态面板（免 token，仅回环监听）
src/worker/worker.mjs 受限 Worker（单文件，仅 import node:module）
src/util.mjs          ID/时间/哈希/glob/脱敏/错误
src/web/              面板构建产物（panel.html + assets/，源码在 src/web-ui/，coss ui / React）
docs/CONTRACT.md      实现契约（API/SSE/RPC/不变量）
docs/adr/             每条偏离一份 ADR
tests/                AC 脚本 + harness
demo/run-demo.mjs     可复现演示
```

## 运维

- 数据目录默认 `~/.dsh/team`（`--data` / `DSH_TEAM_HOME` 覆盖）：`team.db`（WAL）、`token`、`run/sidecar.json`、`workers/<member>/`。
- 鉴权：已移除——`/api/**` 与 `/panel` 均**免 token** 直接访问；sidecar 仅监听 `127.0.0.1`，如需暴露远端请在外层自行加访问控制。`<home>/token` 仍会生成（兼容旧工具），但服务端不再校验。
- 端口默认 `4317`，仅监听 `127.0.0.1`；`--port 0` 取随机端口（测试用）。
- 崩溃安全：`SIGKILL` 后重启自动 `recover()` —— `running` 任务回 `ready`、成员置 `interrupted`、写 `recover` 事件，不静默丢。

## 已知取舍

见 [`docs/adr/`](docs/adr/)：Node 24 无 net 权限门（ADR-002）、member.status 单点存放以保 C2（ADR-003）、并发写用 CAS 而非路径租约（ADR-004）、建任务 settle 窗口与派发前重求值（ADR-005）、topic 订阅与 YAML 导入导出延后（ADR-006）、SSE 合成帧语义（ADR-007）、面板进 GUI 用设置页 Slot + Host 同源代理而非 iframe（ADR-008）。

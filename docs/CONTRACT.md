# dsh-team 实现契约（v1，冻结）

> 本文件是 `src/**`、`src/web/**`、`bin/**`、`tests/**` 的**唯一口径**。任何与本文件不符的实现都是 bug。
> 需求来源：`prd/agent-team-plugin-prd.md` v1.0；优先级：C1-C5 > 验收标准 AC-* > 功能描述。

---

## 0. 五条硬约束的**可执行**语义

| # | 约束 | 本实现中的强制点 | 如何被验证 |
|---|---|---|---|
| **C1** | Worker 只挂代理工具，禁用原生直连 IO | Worker 进程以 `node --permission --allow-fs-read=<bundleDir>` 启动（无 `--allow-fs-write` / `--allow-child-process` / `--allow-worker` / `--allow-addons`）；bundle 内首个动作调 `module.registerHooks`，`resolve` 白名单仅 `node:module`，其余 specifier 一律 `ERR_ACCESS_DENIED`；随后中和 `fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest`/`process.binding`/`process._linkedBinding`/`process.dlopen`。**全部 IO 只能走 stdio NDJSON RPC。** | `tests/ac-03-*.mjs` 让 Worker 真试 `import('node:fs')`、`fetch`、`createRequire`、`process.binding`，四种全 BLOCKED 且目标文件 hash 不变 |
| **C2** | `event` 只增不改；`member_state` 能由 event 完全重建 | `append()` 是唯一写入口：同一事务内 `INSERT event`(seq 由 max+1 分配) + upsert `member_state`。`rebuild()` 只读 event 生成投影。`member_state.seq == max(event.seq)` 否则 `stale=1`。 | `tests/ac-*` 含 rebuild 对账：`progress 事件数 == member_state.seq`，逐字段深比较 |
| **C3** | 默认拒绝；deny 优先；多规则取最严 | 求值顺序固定为 **显式 deny 规则 > 未过期未使用的 grant > 显式 allow 规则 > 默认拒绝**；多条 allow 用"最严合并"（`maxRuntime` 取 min、method 取交集、`argv` 取交集、`readOnly` 取 or）。 | `tests/ac-03` 四域越界；`tests/ac-04` 批准单次、二次再拒；`tests/ac-11` 热更新立即生效 |
| **C4** | 决策必须落盘为 `decision`；消息只作通知 | `POST /scope-requests/{id}/decide` 在**一个事务**里写 `decision` + `scope_grant` + `event`，提交后才发消息/SSE。Worker 的 `scope.request` RPC **阻塞等待**该决策（长轮询，非消息驱动），决策提交即返回。 | `tests/ac-04`：决策前后各查一次 `decision` 表；Worker 无轮询、无 240s 空等 |
| **C5** | 中断必须**同步**写状态，禁止残留 `running` | `interrupt()` 同步事务：`member.status=interrupted` + `event(phase=interrupt)` + `lease_until=NULL`，**提交后才**发信号/杀进程。API 返回即已落库。 | `tests/ac-08`：interrupt 返回后立即 GET 必须 `interrupted`（<100ms），进程可能还没死 |

补充：Worker 自身**不判定**自己的权限；所有 IO 决策都在 sidecar 进程内完成。Worker 崩溃/被杀不会留下 `running`（租约超时 → `suspected_dead`，见 §6）。

---

## 1. 形态与运行

- 单进程 sidecar，默认监听 `127.0.0.1`，端口默认 `4317`（`--port 0` 取随机端口）。要求 Node ≥ 22.15（`node:sqlite` + 同步 `module.registerHooks`）。
- 数据目录（默认 `~/.dsh/team`，可用 `DSH_TEAM_HOME` 覆盖）：
  ```
  <home>/token              # 兼容保留（首次启动生成，服务端已不校验）
  <home>/team.db            # SQLite（WAL）+ team.db-wal/shm
  <home>/run/sidecar.json   # {pid,port,url,startedAt}
  <home>/workers/<member>/  # 该成员 worker bundle 副本 + cwd
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
dsh-team approve <request-id> [--deny] [--reason TEXT] [--ttl SEC]
dsh-team report <team> [-o run.md]
```
CLI 通过 `<home>/run/sidecar.json` 发现端口，读 `<home>/token` 鉴权；`--url/--token` 可覆盖。

---

## 2. 枚举（唯一真相）

- `member.status`：`queued | provisioning | idle | running | blocked | done | failed | interrupted | retired`
- `task.status`：`pending | ready | running | done | failed | skipped | blocked`
- `dep.condition`：`all_success | any_success | on_failure | artifact_exists`
- `phase`（event）：`init | read | write | exec | net | env | msg | wait | verify | interrupt | resume | done | fail | decision | recover`
- `domain`：`fs | exec | net | env`
- `ops`：fs `read|write|delete|rename|list`；exec `spawn`；net `connect`；env `read|write`
- SSE `event`：`member.status | step.append | task.state | message.delivered | scope.request | decision | lease.warn`（**仅这 7 种**）
- 错误码：`E_DENIED | E_UNAUTHORIZED | E_NOT_FOUND | E_CONFLICT | E_VERSION | E_TIMEOUT | E_BAD_REQUEST | E_QUOTA | E_INTERRUPTED | E_CYCLE | E_INVALID_STATE`

---

## 3. REST

统一返回：成功为对象本体（**单资源端点直接返回该对象**，如 `POST /api/teams` 返回 team 本体，不再包一层 `{team}`）；列表端点返回 `{"asOf":"<ISO>","version":<int>,"items":[...]}`。
失败 `{"error":{"code","message","detail"}}` + 对应 4xx/5xx。

### 3.1 团队
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/teams` | `{name, workspace, maxMembers?, maxConcurrency?, failurePolicy?, maxAttempts?}` | `{team}`；`maxMembers` 默认 64，`0`=不限 |
| `GET /api/teams` | — | `{items:[team]}` |
| `GET /api/teams/{id}` | — | `{team}` |
| `PATCH /api/teams/{id}` | 任意可改字段 | `{team}` |

`team` = `{id,name,workspace,maxMembers,maxConcurrency,failurePolicy,maxAttempts,createdAt}`
`workspace` 必须是已存在目录的绝对路径；所有 fs 相对路径、glob、exec cwd 都以它为根。

### 3.2 成员
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/teams/{id}/members` | `{name,role?,model?,contextMode?}` | `{member}`；超 `maxMembers` → `status=queued`（**不是报错**） |
| `GET /api/teams/{id}/members` | — | `{items:[member]}` |
| `GET /api/members/{id}` | — | `{member}` |
| `DELETE /api/members/{id}?mode=retire\|remove` | `remove` 需 `?confirm=1`，否则 `400` | `{member}`；`retire` 保留历史，`remove` 物理删除 member 及其 state（event 保留） |
| `POST /api/members/{id}/interrupt` | `{reason?}` | `{member}` ← **同步落库后返回**（C5） |
| `POST /api/members/{id}/resume` | `{}` | `{member}`；从 `max(event.seq)` 的下一步继续 |
| `POST /api/members/{id}/assign` | `{taskId}` | `{member,task}`；仅 `idle` 可接 |

`member` = `{id,teamId,name,role,model,contextMode,status,leaseUntil,currentTaskId,step,seq,next,blockers,stale,asOf,pct}`
`blockers` = `[{kind:"scope_request"|"dep"|"message"|"manual", id?, detail?}]`
`pct` = 已完成 step 数 / 计划 step 总数（无计划则 `null`）。

### 3.3 任务与依赖
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/tasks` | `{teamId, subject, assignee?, plan?, writeScopes?, acceptance?, priority?, failurePolicy?, maxAttempts?, deps?}` | `{task}` |
| `GET /api/tasks?team=` | — | `{items:[task]}` |
| `GET /api/tasks/{id}` | — | `{task}` |
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
| `POST /api/messages` | `{teamId?, from, to, kind?, payload, correlationId?, ttlSeconds?}` → `{message}` |
| `GET /api/messages?team=&correlation=&member=&status=` | `{items:[message]}` |
| `POST /api/messages/{id}/ack` | `{state:"read"\|"acked"}` → `{message}` |

`message` = `{id,teamId,from,to,kind,correlationId,payload,sentAt,deliveredAt,readAt,ackedAt,ttlSeconds,status}`
`status`（派生）：`queued | delivered | read | acked | expired`

### 3.6 权限与审批
| 方法 路径 | 请求 |
|---|---|
| `POST /api/policies` | `{teamId?, subjectType:"member"\|"role"\|"task", subjectId, domain, matcher, ops:[], mode:"allow"\|"deny", constraints?, expiresAt?}` → `{policy}` |
| `GET /api/policies?team=` | `{items:[policy]}` |
| `DELETE /api/policies/{id}` | `{ok:true}` |
| `GET /api/permission-matrix?team=` | `{items:[{memberId,name,role,fs:{read,write,...},exec,net,env}]}` 生效规则摘要（含来源 policy/grant） |
| `POST /api/scope-requests` | `{memberId, domain, target, reason, diffSize?, risk?, blockedStep?, fallback?}` → `{scopeRequest}` |
| `GET /api/scope-requests?team=&status=` | `{items:[scopeRequest]}` |
| `POST /api/scope-requests/{id}/decide` | `{decision:"approved"\|"denied", decidedBy, reason?, ttlSeconds?, singleUse?}` → `{scopeRequest,decision,grant}`（C4：事务落盘） |

`scopeRequest` = `{id,memberId,teamId,domain,target,reason,diffSize,risk,blockedStep,fallback,status,decisionId,grantId,createdAt}`
`grant` = `{id,requestId,domain,matcher,ops,singleUse,expiresAt,grantedBy,usedAt}`
自动批准（D-6）：`team.autoApprove = {maxDiffSize, domains[]}`（PATCH team 设置），命中则 `decision.decidedBy="auto"`。

### 3.7 待办与报告
| 方法 路径 | 请求 |
|---|---|
| `GET /api/todos?team=&member=` | `{items:[todo]}` |
| `POST /api/todos` | `{teamId, memberId?, title, blockedBy?, orderNo?}` |
| `PATCH /api/todos/{id}` | `{title?,status?,blockedBy?,orderNo?}` |
| `GET /api/report?team=&format=md` | `text/markdown` 运行报告（AC-12：含 actor/domain/target/before_hash/after_hash 表） |
| `GET /panel` | HTML 面板 |

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
- 载荷全集：`member.status{status,step,seq,next}`、`step.append{seq,phase,action,target,result,next}`、`task.state{taskId,status,attempts}`、`message.delivered{messageId,to,status}`、`scope.request{requestId,domain,target,memberId}`、`decision{requestId,decision,decidedBy,grantId}`、`lease.warn{memberId,leaseUntil,missed}`、`span.append{span}`（Host 工具调用上报后推送，面板据此实时刷新瀑布）。

---

## 5. Worker 进程

### 5.1 启动
```
node --permission --allow-fs-read=<home>/workers/<memberId> \
     <home>/workers/<memberId>/worker.mjs --member=<memberId> --team=<teamId>
```
- 环境只给投影后的 `env`（见 §5.3）+ `DSH_TEAM_WORKER=1`。**不传 token、不传 sidecar 端口。**
- stdout 仅 NDJSON RPC；stderr 仅日志（sidecar 逐行捕获、脱敏、转 event `phase=msg`? 不：转结构化日志行，不污染事件流）。
- 生命周期：`bootstrap` → 逐步 `step.begin` → 每步一个或若干 `event.append` → `task.done` / `task.fail`。空闲时每 5s `ping`。

### 5.2 RPC（worker → sidecar，stdout 一行一帧；sidecar → worker stdin 一行一帧）
请求 `{"id":1,"op":"fs.write","args":{...}}`；响应 `{"id":1,"ok":true,"data":{...}}` / `{"id":1,"ok":false,"error":{"code":"E_DENIED","message":"..."}}`

| op | args | data |
|---|---|---|
| `bootstrap` | `{}` | `{member,task:{id,subject,plan,writeScopes,acceptance},resumeFrom,env,limits:{maxRetries,retryBaseMs,leaseMs}}` |
| `step.begin` | `{index,step}` | `{resumeFrom,pending:[message],interrupted:false}` ← **消息注入点**，≤1 step 送达 |
| `event.append` | `{phase,action,target,result,next,status?,blockers?,step?}` | `{seq}` |
| `fs.read` | `{path}` | `{content,version,hash,size}` |
| `fs.write` | `{path,content,expectVersion?,encoding?}` | `{version,hash,bytes}`；版本不符 → `E_VERSION` + `data.currentVersion/currentHash` |
| `fs.delete` | `{path}` | `{deleted:true}` |
| `fs.rename` | `{from,to}` | `{ok:true}` |
| `fs.list` | `{path}` | `{entries:[{name,type,size}]}` |
| `exec.run` | `{argv:[],cwd?,timeoutMs?,stdin?}` | `{exitCode,stdout,stderr,durationMs}` |
| `net.fetch` | `{url,method?,headers?,body?}` | `{status,headers,body,bytes}` |
| `env.read` | `{name}` | `{value}` 或 `{handle:"dsh-env-handle:<id>",redacted:true}` |
| `env.list` | `{}` | `{names:[]}` |
| `msg.poll` | `{since?}` | `{messages:[]}` |
| `msg.send` | `{to,kind?,payload,correlationId?,ttlSeconds?}` | `{message}` |
| `msg.request` | `{to,payload,timeoutMs?,retries?,retryDelayMs?}` | `{correlationId,response,attempts,elapsedMs,timeout}`（FR-4.4 请求-响应，持久化 + 超时重试） |
| `msg.ack` | `{id,state:"read"\|"acked"}` | `{message}` |
| `scope.request` | `{domain,target,reason,diffSize?,risk?,blockedStep?,fallback?,timeoutMs?}` | **阻塞**至决策：`{status:"approved"\|"denied"\|"expired",decisionId,grantId?}` |
| `task.done` | `{result?}` | `{ok:true}` |
| `task.fail` | `{error,retryable?}` | `{ok:true,retry?:bool,attempts?}` |
| `ping` | `{}` | `{leaseUntil}` |

控制帧（sidecar → worker，非响应）：`{"type":"control","action":"interrupt"}` → Worker 完成当前动作后退出（超时 `SIGTERM`）。

### 5.3 四域语义

| 域 | 规则 |
|---|---|
| **fs** | 相对路径以 `team.workspace` 为根；拒绝 `..` 逃逸；`version` 为 DB 内 `file_state.version`（不存在=0）；`fs.write` 原子写（tmp+rename）并 `version+1`；`expectVersion` 不符 → `E_VERSION`（Worker 退避重试，上限 `limits.maxRetries`） |
| **exec** | 无 shell：`spawn(argv[0], argv.slice(1))`；`cwd` 默认 workspace 且必须在 workspace 内；超时 kill；stdout/stderr 截断 64KB 后入库 |
| **net** | 仅 sidecar 代发 `fetch`；默认拒绝；按 `host:port` 匹配；`connect` op |
| **env** | Worker 只拿到投影后的环境（`envPolicy`）；敏感名（策略 `sensitive:true` 或名匹配 `/SECRET|TOKEN|KEY|PASS(WD)?|CREDENTIAL/i`）返回 handle，**值永不出 sidecar** |

**敏感值脱敏**是全局不变量：任何 `event`/`audit`/`message`/SSE/日志/报告中出现过的敏感值都必须替换为 `<redacted>`（FR-3.8 / AC-13）。

---

## 6. 恢复语义

| 场景 | 行为 |
|---|---|
| `interrupt` | 同步：`status=interrupted` + `event(phase=interrupt)` + `lease_until=NULL`；再发控制帧，2s 未退出则 `kill` |
| `resume` | 读 `max(event.seq)` → 取该事件 `meta.stepIndex` → `resumeFrom=stepIndex+1`；新 worker 进程；`seq` 连续；已完成单元不重做 |
| 租约 | running/blocked 每 ≤15s 续租；`now > lease_until + 2*leaseMs` → `suspected_dead`（status=`interrupted`）+ `event(phase=recover)` + SSE `lease.warn` |
| sidecar 重启 | 启动时 `recover()`：所有 `running|provisioning` 且租约过期 → `interrupted` + event；对应 task → `ready`（保留 attempts）；输出 `{recovered:n}` 日志。**不静默丢** |
| Worker 崩溃 | 租约超时由巡检处理（同上）；`task.fail(retryable=true)` → 按 `maxAttempts` 重试 |
| 重试 | 指数退避 `retryBaseMs * 2^(attempt-1)`，上限 `limits.maxRetries`；超过 → task `failed` |

`event.meta` 必须带 `stepIndex`（若该 event 属于某个 plan step），保证 resume 锚点精确。

---

## 7. 验收脚本约定

`tests/ac-<NN>-<slug>.mjs`，`node --test` 可跑，亦支持 `node tests/ac-01-*.mjs` 单跑。每个脚本：
1. 在 `os.tmpdir()/dsh-team-ac<NN>-<rand>` 建临时 workspace + data 目录（**不污染仓库**）；
2. 用 `spawn(process.execPath, ['bin/dsh-team.mjs','up','--port','0','--data',...])` 起真实 sidecar，读第一行 JSON 拿端口/token；
3. 只走真实 HTTP/SSE 与真实子进程；**禁止 mock sidecar、禁止 mock crash**；
4. 收尾 `SIGKILL` sidecar + 清理临时目录（失败时保留并打印路径）；
5. 输出 `PASS <id> <detail>` / `FAIL <id> <reason>` 并设置退出码。

`tests/lib/harness.mjs` 提供：`startSidecar()`, `api()`, `sse()`, `sha256()`, `waitFor()`, `mkWorkspace()`, `readDb()`（用 `node:sqlite` 只读校验）, `killSidecar()`。

---

## 8. 目录与所有权

```
package.json          # type:module, bin.dsh-team, scripts.test
bin/dsh-team.mjs      # CLI 入口（cli-owner）
src/core.mjs          # 组合根：建库、装配、recover
src/db.mjs            # schema + 事务助手
src/eventstore.mjs    # C2
src/policy.mjs        # C3 纯求值
src/broker.mjs        # 四域唯一 IO 出口 + audit + grant
src/scheduler.mjs     # DAG
src/runner.mjs        # 进程/租约/中断/恢复（C1/C5）
src/bus.mjs           # 信箱/回执
src/sse.mjs           # SSE hub
src/server.mjs        # HTTP/SSE/静态
src/util.mjs          # 时间/ID/glob/哈希/脱敏
src/worker/worker.mjs # 受限 Worker（单文件，零 import 除 node:module）
src/web/**            # 面板（panel-owner）
tests/**              # AC 脚本
docs/adr/**           # ADR
```

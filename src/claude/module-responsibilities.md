# src/ 模块职责

## 12 个内核模块

### `util.mjs`（152 行）— 地基
导出：`ApiError`、`ERR`（`E_DENIED/E_UNAUTHORIZED/E_NOT_FOUND/E_CONFLICT/E_VERSION/E_TIMEOUT/E_BAD_REQUEST/E_QUOTA/E_INTERRUPTED/E_CYCLE/E_INVALID_STATE`）、`now/nowIso`、`newId`、`clamp/p95/percentile/backoffMs`、`sha256`、`toPosix`、`resolveInWorkspace`（防路径越界）、`globToRegExp/matchGlob`、`isSensitiveName`、`REDACTED='<redacted>'`、`createRedactor/redactor`、`arr/int/bool/parseJson/json/sleep/truncate`、`PrioQueue`。
**改动注意**：`ERR` 是 HTTP 错误码的唯一来源，新增码要同步 `docs/CONTRACT.md`。

### `db.mjs`（310 行）— 持久化
`schema v7`（`SCHEMA_VERSION = 7`）、23 张表、20 个索引；`openDb/closeDb/q/tx`。
迁移策略：缺列补列（`team.runtime`、`member.agent_session_id`），`meta.schema_version` 就地升版，二次打开幂等。

### `eventstore.mjs`（202 行）— 事件溯源（C2）
`append({team,member,type,phase,payload})` 在**同一事务**内 `INSERT event`（`seq = max+1`）+ upsert `member_state`；`rebuild()` 只读 event 重投影；`tail()` 供 SSE 回放。
**这是唯一允许改 `member_state` 的入口。**

### `policy.mjs`（184 行）— 权限求值（C3，纯函数）
`normalizeTarget`、`matchTarget`、`subjectMatches`、`mergeConstraints`、`isExpired`、`evaluate`、`isGrantUsable`、`matrixSummary`。
顺序：显式 deny > 未过期未用 grant > 显式 allow > 默认拒绝；多条 allow 取最严（`maxRuntime` min、`method`/`argv` 交集、`readOnly` or）。**无 db、无 fs、无网络**。

### `broker.mjs`（531 行）— 四域唯一 IO 出口（C1/C4）
`authorize`、`audit`、`buildEnvProjection`、`envRead/envList`、`resolveHandles`、`fileState`、`fsRead/fsWrite/fsDelete/fsRename/fsList`、`execRun`、`netFetch`、`scopeRequest`、`decide`、`releasePending`、`matrix`、`redactText`。
每次执行前后算 SHA-256 写 `audit`；`decide()` 一个事务写 `decision + scope_grant + event`。

### `scheduler.mjs`（474 行）— DAG 与派发
`createTask/addDep/removeDep/findCycle/depsOf/depSatisfied/readiness/evaluate/pickIdleMember/startTask/onTaskDone/onTaskFailed/abortTeam/emitTaskState/wake/dag/criticalPath/version/recover/shutdown`。
常量 `settleMs = 200`、`tickMs = 150`（ADR-005）。`runtime === 'agent'` 时跳过 worker 派发循环。

### `runner.mjs`（384 行）— worker 进程与租约
拉起受限进程、续租、`interrupt()`（C5：**先提交事务再杀进程**）、崩溃恢复、日志落 `home/workers/<member>/`。

### `bus.mjs`（174 行）— 持久信箱
`pending → delivered → acked` 三态；`corrId` 关联请求-响应；投递失败不丢消息。

### `sse.mjs`（111 行）— SSE Hub
广播基础 7 帧 + 合成 4 帧；`lastEventId` 续传时从 `event` 表回放缺口。

### `llm.mjs`（209 行）— 模型目录
只持久化 provider/route 与启停开关，**不发任何 LLM 请求**；供 `team_models` 与面板 Models 视图读取。

### `server.mjs`（285 行）— HTTP
`createRoutes(core)` + `startServer({home, port=4317, host='127.0.0.1', leaseMs=15000, log})` → `{server, core, token, port, url, home, close}`；静态托管 `PANEL_DIR = ./web/`（no-cache、越界 403）。

### `core.mjs`（1632 行）— 组合根
装配全部组件 + `recoverAll()`。对外暴露的 `core.*` 方法即路由层可用的**全部能力面**；新增能力先加 `core` 再挂路由。

## `worker/worker.mjs`（318 行）— 受限 Worker

- 单文件，唯一允许的 import 是 `node:module`。
- 首行 `module.registerHooks({ resolve })`，白名单只有 `node:module`。
- 中和：`fetch`、`WebSocket`、`EventSource`、`XMLHttpRequest`、`process.binding`、`process._linkedBinding`、`process.dlopen`。
- 启动参数：`node --permission --allow-fs-read=<bundleDir>`（无 fs-write / child-process / worker / addons）。
- 全部 IO 走 stdio NDJSON：请求 `{id, op, args}`，响应 `{id, ok, result}` 或 `{id, ok:false, error}`。
- `scope.request` 是**长轮询阻塞**：等到 `decide()` 落盘才返回。

## 模块不该越界的事

| 模块 | 不该做 |
|---|---|
| `server.mjs` | 不写业务判定；只做参数校验 + 调 `core` + 序列化 |
| `scheduler.mjs` | 不直接写 `member_state`（走 eventstore）；不自己起进程（走 runner） |
| `runner.mjs` | 不判定权限（走 broker）；不决定派发（走 scheduler） |
| `broker.mjs` | 不决定任务状态；只做 authorize/执行/audit |
| `policy.mjs` | 不碰 db、不碰 fs |
| `core.mjs` | 不被其他模块 import |

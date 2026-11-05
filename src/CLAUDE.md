# src/ · 编排内核

## 项目简单介绍

`src/` 是 dsh-team 的 sidecar 内核：一个零依赖 Node ESM 进程，持有 SQLite（WAL，schema v14）、事件流、审批镜像、DAG 调度、持久信箱、SSE Hub 和 HTTP 服务。它不认识 LLM，不保存任何 API Key，只做「谁在跑、卡在哪个审批、做到哪、留下什么证据」。

`core.mjs` 是唯一的组合根，把 `db / eventstore / scheduler / bus / sse / llm` 装配起来并暴露给 `server.mjs` 的路由层；成员是 Host 侧的 sub-agent，sidecar 不管理任何子进程。除 `web/`（面板静态产物）外，本目录没有子模块再分层。

## 约定的规则

- **状态只能通过 `EventStore.append()` 改**：它在一个事务里写 `event` 并 upsert `member_state`。直写状态表会让 `/api/status` 变成 `degraded:true`。
- **本仓库不做 IO 代理**：成员的文件 / exec / net / env 由 DSH 权限预设与宿主沙箱执行；sidecar 只镜像审批（`approval` 表）供 Lead 决策与审计。
- 审批只镜像不判定：DSH 宿主已经决定 allow/deny，`approval` 表记录 requestId、工具、原因与决策人，供 Lead/面板/报告回放。
- 跨表写必须同一个 `tx(db, fn)`；跨模块流程（如审批决策 + 事件）必须原子。
- 时间/ID/哈希/脱敏只用 `util.mjs` 的实现（`now/nowIso/newId/sha256/redactor`）。
- 别在 stdout 打日志：stdout 第一行是给 CLI 和测试解析的 ready JSON，日志走 `log()` 回调 / `home/logs`。
- 调度常量 `settleMs=200`、`tickMs=150` 是竞态窗口的一部分（ADR-005），改之前看契约。

## 文件索引

| 文件 | 用途 | 何时阅读 |
|---|---|---|
| [架构与数据流](claude/overview.md) | 模块依赖方向、一次派发的完整时序 | 改跨模块流程 |
| [模块职责](claude/module-responsibilities.md) | 9 个 `.mjs` 各自边界与导出面 | 判断改动落点 |
| [审批镜像与权限预设](claude/public-interfaces.md) | approval 三端点、预设继承、转发流程 | 改审批或预设 |
| [常见问题](claude/faq.md) | 内核侧症状定位 | 排查状态/派发/权限异常 |

## 子目录索引

| 路径 | 职责 | 文档 |
|---|---|---|
| `src/*.mjs` | 10 个内核模块（含 `board.mjs` 看板状态机） | [模块职责](claude/module-responsibilities.md) |
| `src/scheduler.mjs` | 依赖推进与重试计时，不启动进程 | [模块职责](claude/module-responsibilities.md) |
| `src/web/` | 面板构建产物，被 `server.mjs` 静态托管 | [../src/web-ui/CLAUDE.md](../src/web-ui/CLAUDE.md) |
| `src/web-ui/` | 面板源码（独立子模块） | [../src/web-ui/CLAUDE.md](../src/web-ui/CLAUDE.md) |

## 扫描状态

- 更新时间：2026-11-05（增量）
- 已扫描：全部 10 个 `*.mjs`（含 `board.mjs` 看板状态机）的导出面与关键函数签名；`web/` 仅看 `panel.html` 引用。
- 未逐行：`core.mjs` 与 `scheduler.mjs` 的内部实现细节，仅按导出面与契约核对。
- 下一步：若要改调度时序，优先精读 `scheduler.mjs` 的 `evaluate/readiness/onTaskDone` 与 `core.mjs` 的 `dispatchAgentTask`。

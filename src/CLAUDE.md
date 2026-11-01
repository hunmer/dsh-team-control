# src/ · 编排内核

## 项目简单介绍

`src/` 是 dsh-team 的 sidecar 内核：一个零依赖 Node ESM 进程，持有 SQLite（WAL，schema v7）、事件流、四域权限求值与执行、DAG 调度、Worker 进程管理、持久信箱、SSE Hub 和 HTTP 服务。它不认识 LLM，不保存任何 API Key，只做「谁在跑、能不能做、做到哪、留下什么证据」。

`core.mjs` 是唯一的组合根（1632 行），把 `db / eventstore / broker / scheduler / runner / bus / sse / llm` 装配起来并暴露给 `server.mjs` 的路由层；`worker/worker.mjs` 是唯一被 `node --permission` 拉起的受限进程。除 `web/`（面板静态产物）外，本目录没有子模块再分层。

## 约定的规则

- **状态只能通过 `EventStore.append()` 改**：它在一个事务里写 `event` 并 upsert `member_state`。直写状态表会让 `/api/status` 变成 `degraded:true`。
- **IO 只能通过 `broker.mjs`**：fs / exec / net / env 四域全部经过 `authorize → 执行 → audit`。任何模块直接 `fs.writeFile` 都是破坏 C1。
- `policy.mjs` 保持**纯函数、无 IO、无 db**，便于单测与复算矩阵。
- 跨表写必须同一个 `tx(db, fn)`；跨模块流程（如审批）的 decision + grant + event 必须原子。
- 时间/ID/哈希/脱敏只用 `util.mjs` 的实现（`now/nowIso/newId/sha256/redactor`）。
- 别在 stdout 打日志：stdout 第一行是给 CLI 和测试解析的 ready JSON，日志走 `log()` 回调 / `home/logs`。
- 调度常量 `settleMs=200`、`tickMs=150` 是竞态窗口的一部分（ADR-005），改之前看契约。

## 文件索引

| 文件 | 用途 | 何时阅读 |
|---|---|---|
| [架构与数据流](claude/overview.md) | 模块依赖方向、一次派发的完整时序 | 改跨模块流程 |
| [模块职责](claude/module-responsibilities.md) | 12 个 `.mjs` 各自边界与导出面 | 判断改动落点 |
| [broker 与权限](claude/public-interfaces.md) | 四域 op 语义、求值顺序、审计字段 | 改权限或加 op |
| [常见问题](claude/faq.md) | 内核侧症状定位 | 排查状态/派发/权限异常 |

## 子目录索引

| 路径 | 职责 | 文档 |
|---|---|---|
| `src/*.mjs` | 12 个内核模块（见上表） | [模块职责](claude/module-responsibilities.md) |
| `src/worker/worker.mjs` | 受限 Worker：单文件、仅 `import node:module`、stdio NDJSON | [模块职责](claude/module-responsibilities.md) |
| `src/web/` | 面板构建产物，被 `server.mjs` 静态托管 | [../src/web-ui/CLAUDE.md](../src/web-ui/CLAUDE.md) |
| `src/web-ui/` | 面板源码（独立子模块） | [../src/web-ui/CLAUDE.md](../src/web-ui/CLAUDE.md) |

## 扫描状态

- 更新时间：2026-11-01
- 已扫描：全部 12 个 `*.mjs` 的导出面与关键函数签名；`worker/worker.mjs` 的权限与中和逻辑；`web/` 仅看 `panel.html` 引用。
- 未逐行：`core.mjs`（1632 行）与 `broker.mjs`（531 行）的内部实现细节，仅按导出面与契约核对。
- 下一步：若要改调度时序，优先精读 `scheduler.mjs` 的 `evaluate/readiness/pickIdleMember` 与 `runner.mjs` 的租约续期。

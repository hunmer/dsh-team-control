# ADR-001：运行时与存储选型（Node 24 + 内置 node:sqlite，零依赖零构建）

- 状态：已接受
- 日期：2026-10-28
- 关联：M1 骨架、C2、全部交付物

## 背景

PRD 要求 SQLite + WAL、sidecar 一条命令启动、CLI 与测试可直接运行。实现语言未被 PRD 限定（brief 只要求「一条命令启动」）。候选：

1. Node + `better-sqlite3`（需原生编译/网络安装）
2. Node + 内置 `node:sqlite`（Node ≥22.5，`DatabaseSync`）
3. Python + sqlite3（需额外进程/虚拟环境）

## 决策

采用 **Node 24 + 内置 `node:sqlite`**，代码为纯 ESM JavaScript（`.mjs`），**零第三方依赖、无构建步骤**。Worker 为单文件 `.mjs`，可被 `--permission` 直接加载。

实测（本机 Node v24.22.0）：WAL 下 200 次插入 4ms（≈50k/s）；`UNIQUE(member_id,seq)` 违规抛 `ERR_SQLITE_ERROR / errcode 2067`；无 ExperimentalWarning。

## 后果

- ✅ `dsh-team up` 一条命令即可跑；CI/评测机不需要 `npm install`；离线可用。
- ✅ 单进程同步 SQLite 与「单 sidecar 进程串行化所有写入」的架构天然契合，避免多进程写锁竞争。
- ⚠️ 放弃 TypeScript 静态类型；用 JSDoc + 结构化模块边界 + 13 条真实进程 AC 补偿。
- ⚠️ 依赖 Node ≥22.5；已在 `package.json.engines` 声明。
- ⚠️ `DatabaseSync` 是同步 API：长查询会阻塞事件循环。当前所有查询都有索引且有 LIMIT，实测 `/api/status` < 10ms。

## 替代方案为何未选

- `better-sqlite3`：原生编译在评测机/离网环境易失败，违背「一条命令启动」。
- Python：与 Node 生态（SSE/面板/测试 harness）割裂，且需要额外运行时。


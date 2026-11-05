# 架构总览

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 形态：一个 sidecar + 两个 Host/Client 插件 + 一个面板

```text
Lead Agent ──REST / CLI / SSE──▶ dsh-team sidecar (127.0.0.1:4317)
                                  ├ Scheduler   DAG 求值 + 自动派发
                                  ├ EventStore  event 只增 + member_state 物化
                                  ├ PermBroker  四域唯一 IO 出口 + audit
                                  ├ MessageBus  持久信箱 + 三态回执
                                  ├ SSE Hub     lastEventId 断线续传
                                  └ Web UI      面板 /panel（Trace 瀑布 / DAG / 审批）
Worker × N    ◀──stdio NDJSON RPC────┘   runtime=worker：沙箱 Node 进程，只能走 broker
DSH agent × N ◀──subagents.startActivation / sendMessage── dsh-plugin/  runtime=agent：真子会话
```

四层职责划得很硬：

1. **sidecar（`src/` + `bin/`）** 是编排内核，也是**唯一真相源**：进程、SQLite（WAL）、四域权限、事件流、调度、SSE、HTTP。它不认识 LLM，不持有凭据。
2. **Host 插件（`dsh-plugin/`）** 只做「适配 + 生命周期」：把 sidecar 暴露成 14 个 `team_*` + 2 个 `board_*` 工具；把成员拉成真 DSH 子会话；把工具调用/文件改动/token 用量/上下文占用上报成 span/change/context。
3. **Client 插件（`dsh-plugin-ui/`）** 只把 sidecar 自带面板挂进 DSH GUI（better-sidebar 页签或侧栏回退），用 Host 同源代理转发 `/dsh-team-api/*`，浏览器拿不到 sidecar token。
4. **面板前端（`src/web-ui/`）** 是 sidecar 托管的那份 UI 的源码，`npm run build` 输出到 `src/web/`。

## 三条主轴（改代码前必须理解）

### 主轴 1：状态只有一份，事件是本体

所有变更写 `event`（只增，`seq` 由 `max+1` 在同一事务内分配），`member_state` 是它的物化视图。`rebuild()` 只读 event 重投影；`member_state.seq == max(event.seq)` 否则 `stale=1`，`GET /api/status` 会带 `degraded:true`。sidecar 重启时 `recover()` 把所有租约过期的 `running|provisioning` 收敛成 `interrupted` 并把任务退回 `ready`，**不静默丢**。

推论：写状态必须走 `EventStore.append()`，不要直接 UPDATE `member_state`。

### 主轴 2：四域决策只在一个出口

Worker 进程以 `node --permission --allow-fs-read=<bundleDir>` 启动（无写/子进程/worker/addon 权限），bundle 首个动作调 `module.registerHooks`，`resolve` 白名单只有 `node:module`，并中和 `fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest`/`process.binding`/`process._linkedBinding`/`process.dlopen`。**全部 IO 只能走 stdio NDJSON RPC 到 `broker.mjs`。**

求值顺序固定：**显式 deny 规则 > 未过期未使用的 grant > 显式 allow 规则 > 默认拒绝**；多条 allow 用「最严合并」（`maxRuntime` 取 min、method/argv 取交集、`readOnly` 取 or）。越界 → `blocked` + `scope_request` → 一次事务写 `decision` + `scope_grant` + `event` → 单次 grant → 重试 → `audit` 记前后 SHA-256。

### 主轴 3：两种运行时，sidecar 只对 worker 管进程

`runtime:"worker"`：sidecar 派发、拉进程、租约、中断、崩溃恢复全包。
`runtime:"agent"`：成员是 `subagents.startActivation` 起的真子会话，进程生命周期归 Host 与 DSH。sidecar 的 `dispatchAgentTask` 只做**原子认领**（同事务把 task 置 `running` 并写 `task.dispatch`，不启动任何进程），随后 Host 用 `subagents.sendMessage` 把任务简报投进成员信箱。调度器在 `runtime === "agent"` 时**跳过 worker 派发循环**——否则会给 agent 团队拉起沙箱 worker。

## 关键设计取舍（详见 `docs/adr/`）

| 取舍 | 结论 | 理由 |
|---|---|---|
| 运行时与存储（ADR-001） | Node 24 + 内置 `node:sqlite`，零依赖零构建 | 避免原生模块编译与 profile 依赖解析 |
| C1 强制点（ADR-002） | Node 权限模型 + 模块白名单 + 全局中和 | 无 net 权限门是已知边界 |
| 状态单一来源（ADR-003） | `member_state` 为唯一状态源，租约移出 | 避免双写不一致 |
| 并发写（ADR-004） | CAS + 退避重试，不做路径租约 | 实现简单、冲突可观测 |
| 调度竞态（ADR-005） | 建任务 `settleMs=200ms` 窗口 + 派发前重求值 | 允许「先建任务后连边」 |
| 广播与 YAML（ADR-006） | 广播/请求-响应最小实现；topic 订阅与 YAML 导入导出延后 | 范围裁剪，记 backlog |
| SSE（ADR-007） | 合成帧 + `lastEventId` 续传 | 面板要即时反应，又要不丢事件 |
| 面板进 GUI（ADR-008） | 设置页 Slot + Host 同源代理，**不用 iframe 直连** | 浏览器拿不到 token |
| agent 运行时（ADR-009） | 成员降级为 sidecar 的状态客户端 | 复用 DSH 自己的子会话能力 |
| 面板首页（ADR-010） | 单一 AppShell 侧栏替代横向 Tabs | affectui 化 |
| 会话头部团队卡（ADR-011） | AgentFindings 移植成 header 胶囊 + overlay | 不占侧栏 |
| 工作区看板（ADR-012） | `src/board.mjs` 状态机 + `/api/board/**` + `board_*` 工具 | 面板/看板与团队编排复用同一 sidecar |

## 已知限制（写进 README 与 ADR）

- Node 无 `net` 权限门，worker 的 net 限制靠「进程内没有可用 fetch」实现，不是内核级。
- 状态单点存放（单个 SQLite 文件）；并发写用 CAS，不做分布式。
- sidecar 默认免鉴权且只监听回环；远程访问必须自己套反向代理与鉴权。
- 不内置 LLM 客户端、不保存 API Key；敏感 env 输出一律 `<redacted>`。

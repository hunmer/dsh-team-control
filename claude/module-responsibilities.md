# 模块职责

## 分层与所有权

| 层 | 目录 | 拥有什么 | 不拥有什么 |
|---|---|---|---|
| 契约层 | `docs/` | 接口/状态机/五条硬约束的**唯一口径** | 不写实现细节 |
| 需求层 | `prd/` | FR/AC/里程碑/决策记录 | 不写当前实现状态 |
| 编排内核 | `src/` | 进程、DB、事件流、权限、调度、SSE、HTTP | 不管 LLM、不管宿主会话 |
| 入口 | `bin/dsh-team.mjs` | CLI 解析、sidecar 发现、进程信号 | 不含业务逻辑 |
| 宿主适配 | `dsh-plugin/` | 工具面、agent 运行时、上报管线、技能注册 | 不做权限判定 |
| GUI 挂载 | `dsh-plugin-ui/` | 页签/侧栏入口、同源代理、sidecar 拉起 | 不渲染面板内容 |
| 面板源码 | `src/web-ui/` | 视图、状态管理、样式 | 不直连 sidecar 数据库 |
| 面板产物 | `src/web/` | 被 sidecar 静态托管的 `panel.html` + assets | 不手改 |
| 验收 | `tests/` | AC 脚本、harness、回归 | 不 mock sidecar |
| 演示 | `demo/` | 可跑的多成员剧本 | 不承载产品逻辑 |
| 技能 | `skills/dsh-agent-team/` | 给模型的调用配方 | 不重复工具 schema |

## `src/` 内部职责（按依赖方向）

```text
util.mjs  ◀── 全部模块（错误/ID/时间/glob/脱敏/队列）
db.mjs    ◀── 全部持久化（schema v7 + q/tx）
   ├─ eventstore.mjs   事件溯源（append/rebuild/tail）
   ├─ policy.mjs       纯函数求值（无 IO）
   ├─ broker.mjs       四域唯一 IO 出口 + audit + grant
   ├─ runner.mjs       worker 进程 / 租约 / 中断 / 恢复
   ├─ scheduler.mjs    DAG / 派发 / 关键路径
   ├─ bus.mjs          持久信箱 / 三态回执
   ├─ sse.mjs          SSE Hub / lastEventId
   ├─ llm.mjs          模型目录（只存不调）
   └─ server.mjs       HTTP 路由 + 静态托管
        └─ core.mjs    组合根，装配以上全部 + recoverAll
worker/worker.mjs  ◀── 被 runner 以受限模式拉起，只走 stdio NDJSON
web/               ◀── 被 server.mjs 静态托管
web-ui/            ◀── 源码，构建进 web/
```

## 修改落点速查

- 加/改 REST 接口 → `src/server.mjs`（`createRoutes`）+ `docs/CONTRACT.md`。
- 加状态或事件类型 → `src/db.mjs`（表/迁移）+ `src/eventstore.mjs` + 契约。
- 改权限语义 → `src/policy.mjs`（纯求值）+ `src/broker.mjs`（执行与审计）。
- 改派发时机 → `src/scheduler.mjs`（注意 `settleMs`/`tickMs` 与 ADR-005）。
- 改成员生命周期 → `src/runner.mjs`（worker）或 `dsh-plugin/index.js`（agent）。
- 改工具参数/描述 → `dsh-plugin/index.js` 的 `buildTools`，并同步 `skills/dsh-agent-team/SKILL.md`、`README.md`。
- 改面板 → `src/web-ui/src/**`，再 `npm run build`。
- 改挂载方式 → `dsh-plugin-ui/`。
- 加验收 → `tests/*.mjs`，会被 `run-all.mjs` 自动拾取。

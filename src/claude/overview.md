# src/ 架构与数据流

## 依赖方向（无环）

```text
util.mjs ──────────────── 所有模块的地基（错误/ID/时间/glob/哈希/脱敏/队列）
db.mjs ────────────────── schema v7 + q/tx/openDb/closeDb
  ├ eventstore.mjs ────── append / rebuild / tail（C2）
  ├ policy.mjs ────────── 纯求值，零 IO（C3）
  ├ broker.mjs ────────── 四域唯一 IO 出口 + audit + grant（C1/C3/C4）
  ├ runner.mjs ────────── worker 进程 / 租约 / interrupt / recover（C5）
  ├ scheduler.mjs ─────── DAG / readiness / 派发 / 关键路径（ADR-005）
  ├ bus.mjs ───────────── 持久信箱 + pending/delivered/acked
  ├ sse.mjs ───────────── 事件广播 + lastEventId 续传
  ├ llm.mjs ───────────── 模型目录（只持久化与开关）
  └ server.mjs ────────── HTTP 路由 + 静态托管
       └ core.mjs ─────── 组合根：装配以上 + recoverAll()
worker/worker.mjs ─────── 被 runner 以受限模式拉起，只走 stdio NDJSON
```

`core.mjs` 不允许被上面任何模块 import（避免环）；它只 import 它们。

## 一次 worker 任务派发的时序

```text
1. POST /api/tasks            → scheduler.createTask()：插 task + event(task.create)
2. settleMs(200ms) 窗口      → 允许同批次 POST /api/deps 连边，避免「还没连边就被派发」
3. scheduler.evaluate()       → readiness() 判依赖 → pickIdleMember() 选空闲成员
4. **派发前重求值**            → 依赖可能在上一步之后才满足，必须重算（ADR-005）
5. runner.start(member,task)  → 单事务：task→running + member→running + 租约 + event(task.dispatch)
6. spawn 受限 worker          → node --permission --allow-fs-read=<bundleDir>
7. worker 逐步请求            → stdio NDJSON → broker.authorize() → 执行 → audit(前后 sha256)
8. 越界                       → E_DENIED + scope_request + member→blocked + SSE(scope.request)
9. 批准                       → 单事务 decision + scope_grant + event；worker 长轮询返回 → 重试
10. 完成                      → onTaskDone()：task→done + event + 下游 readiness 重算 + 派发
11. 租约                       → 定期续期；过期未收敛的由 recoverAll() 置 interrupted
```

## 一次 agent 任务派发的差异

```text
1-4 同上
5'. dispatchAgentTask()  → 只做**原子认领**：task→running + event(task.dispatch)，不启动进程
6'. Host 插件            → subagents.sendMessage(agentSessionId, 简报)
7'. 成员干活               → 走它自己的工具；结果回 POST /api/members/{id}/agent-report
8'. scheduler 跳过 worker 派发循环（runtime === 'agent'）
```

## 恢复（`recoverAll()`）

```text
启动时一次：
  - 租约过期且状态为 running|provisioning 的成员 → interrupted + event(phase=recover)
  - 它们名下 running 的任务 → 退回 ready
  - 未决 scope_request → 保留（不自动批准），SSE 重放给面板
  - 若 member_state.seq 与 max(event.seq) 不一致 → 标记 stale
```

## SSE 帧

基础 7 种：`member.status`、`step.append`、`task.state`、`message.delivered`、`scope.request`、`decision`、`lease.warn`。
合成 4 种（由上述事件派生，供面板直接消费）：`span.append`、`artifact.added`、`change.added`、`context.update`。
所有帧带 `seq`，客户端用 `lastEventId` 续传，服务端从 `event` 表回放缺口。

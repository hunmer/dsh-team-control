# ADR-007：SSE 合成帧与续传语义

- 状态：已接受
- 日期：2026-10-28
- 关联：FR-5.4 / AC-10

## 背景

PRD 规定 SSE 事件类型含 `task.state` 与 `message.delivered`，但这两类并非某个成员的「可观测动作」，没有自然归属的 `event` 行；而断线续传依赖 `id: <event.id>` 单调递增。

## 决策

- **有事件行的类型**（`step.append` / `member.status` / `scope.request` / `decision` / `lease.warn`）：`id` 直接取 `event.id`，回放用 `WHERE event.id > lastEventId`，**保证不丢**。
- **合成帧**（`task.state` / `message.delivered`）：`id` 取当前团队最大 `event.id`（不推进事件序），作为「瞬态通知」。断线重连时不回放这类帧；其权威数据由 REST 兜底（`/api/dag`、`/api/messages`）。

## 后果

- ✅ 所有状态变更类事件（step/status/审批/租约/决策）续传零丢失，AC-10 用「重连后 id 无缺口 + 与 history 对齐」验证。
- ⚠️ `task.state` / `message.delivered` 在断线窗口内可能被跳过；面板重连后会额外拉一次 `/api/dag` 与 `/api/messages` 做对账（见 `src/web/app.js`）。
- ⚠️ 若未来要求这两类也可回放，最小改动是把它们写成真实 `event` 行（`phase='task'` / `phase='msg',action='deliver'`），代价是成员事件流出现非执行类条目。


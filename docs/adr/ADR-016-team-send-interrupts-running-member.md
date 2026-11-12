# ADR-016：team_send 对运行中的成员先打断再投递

- 状态：已接受
- 日期：2026-11-12
- 关联：`dsh-plugin/index.js`（`team_send`）/ `skills/dsh-agent-team/SKILL.md` / `tests/plugin-agent.mjs` / PRD FR-4.2

## 背景

DSH 的 `subagents.sendMessage` 走 `delivery:"steer"`，消息进入成员会话的 inbox 后由 `agent.steer()`
在**最近的一个 step 边界**取用；成员正在跑长回合时，Lead 的纠正要等这一轮结束才生效，实际表现为
「消息发不进去 / 成员继续按旧指令跑」。PRD FR-4.2 当初写的正是「running 时下一个 step 边界注入」，
但现在 Lead 明确需要「立刻改口」。

## 决策

- `team_send` 在投递前判断目标是否在跑（`agentStatusBySession` 本地状态、sidecar `agentStatus`、
  成员 `status` 任一为 `running`），在跑则先调 `subagents.interrupt(sid,{kind:'ancestor',agent:caller})`
  打断当前回合，再 `sendMessage` 把消息插进去；返回体带 `interrupted:[name]`。
- 参数 `interrupt`（默认 `true`）保留旧行为：`interrupt:false` 时不打断，仍按 step 边界投递。
- 打断失败只记 `interruptErrors[]` 并继续投递，消息不能因为打断失败而丢。
- 不动 sidecar 成员状态、不调 `/api/members/:id/interrupt`（那是 `team_control interrupt` 的语义：
  冻结会话并把在途任务转 `paused`）。这里只是同一会话换指令，任务应继续。

## 权衡

- 打断会让成员丢掉当前 step 的成果（未落盘的推理），换取指令即时生效；不想打断的调用方显式传
  `interrupt:false`。此时消息仍然**不会丢**：DSH 的 steer 落在持久 inbox 的 `next-step`，下一个 step
  边界被 `inbox.claim` 取走，回合收尾时 `turn()` 还会因 `hasPending` 为真继续开一轮（idle 则 `wakeDriver`
  直接开新回合，会话被回收则 `coldResume`），投递失败也会抛错而不是静默丢弃。但“读到”不等于“来得及时”：
  当前 step 可能是几分钟的构建/测试，成员也可能在这一步里就 `team_report_task` 交卷，消息到得太晚就
  只剩“补一句”的作用。要立刻改道就用默认的 `interrupt:true`。
- 打断后 DSH 会短时报一次 `idle`，插件按 `agentIdleSettleMs`（默认 12s）延迟上报；紧随其后的新回合
  会把它取消并重新报 `running`，因此 sidecar 不会误把任务判 `done`。
- 目标已是 idle 时不调 `interrupt`（对空闲会话是 no-op），直接投递并唤醒。

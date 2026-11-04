# ADR-012：工作区看板——Host 调度、sidecar 原子 claim、同会话执行

- 状态：已接受
- 日期：2026-11-04
- 关联：`docs/board-plan.md` / `docs/CONTRACT.md` §3.13 / `tests/ac-18-board.mjs` / `tests/plugin-board.mjs`

## 背景

用户要按工作区管理任务：列 `todo/planning/inprogress/done/failed`，任务可绑定多个 team；调度器自动把
`todo` 送进规划，规划完成后在执行槽位空闲时自动起 Lead 会话并调 agent team 干活。关键约束是
**不能要求用户先手动开一个会话**——会话必须由插件自动创建。

## 决策

- **调度器放 Host 插件，sidecar 只做状态真相源**。sidecar 是纯 Node 进程，没有 `ctx.agents`；只有
  Host 插件能用 `ctx.agents.create` 建根会话。sidecar 负责状态机、并发计数、`claim`/`attach` 原子认领，
  插件负责 `claim → create → attach → followup`。
- **独立 `board_task`，不复用 team 内 DAG `task`**。两者语义不同（看板任务是用户工作项，DAG 任务是
  团队内部节点）；新增 `board_settings/board_task/board_task_team/board_event` 四表，schema v12。
- **默认同会话执行**。规划与执行默认是同一个 DSH 会话：`submitPlan` 时把 `lead_session_id` 写成规划
  会话；用户点「在新的会话执行」才在 inprogress 阶段另建 Lead。这样规划上下文不丢，也避免会话膨胀。
- **`auto` 默认关**。用户显式点「开始执行」或打开 auto 才入队，避免新建任务立即消耗模型额度。
- **三维等待**：内部 6 态，UI 只显示 `Waiting(todo/planned/failed) / Progress(planning/inprogress) /
  Done`；`planned` 不占 planning 槽位。
- **claim fence**：claim 返回一次性 `fence`（DB 列 `claim_token`），attach 必须带对；对外不叫
  `claimToken`，否则会被全局脱敏规则替换成 `<redacted>`。
- **无人值守权限**：规划默认 `read-only` + 审批自动拒绝；执行默认 `danger-full-access`（never），
  避免审批挂起。规划会话超时（默认 30 分钟）自动 failed。
- **事件驱动回翻**：Lead 置 done 后，用户在同一个会话再发消息，插件监听 `session/event` 的
  `user/message` 把任务翻回 inprogress；sidecar 只允许从 done/failed 回翻，插件重启后仍有效。

## 备选方案与被否决的原因

1. **sidecar 直接起会话**：没有 `ctx.agents`，需要自建 LLM loop/工具执行，等于重写 DSH 运行时 → 否决。
2. **规划阶段不建会话，直接 `ctx.llm.stream`**：省一个会话，但规划看不到文件、不能用工具，质量不足；
   保留为后续可选模式（`docs/board-plan.md` §3.7），默认仍走规划会话。
3. **复用现有 `task` 表加列**：会污染成员 DAG 的枚举、依赖与派发逻辑，迁移风险高 → 否决。
4. **用 `queued` 布尔而不是 `auto`**：用户明确要「是否进入队列」的开关，且默认不进入；
   `auto` 语义更贴近「自动入队」，`start` 动作也复用它。

## 后果

- 插件默认开启 `boardEnabled`；只有 `auto=1` 或用户点「开始执行」的任务才入队，显式 `false` 可关闭。
- 多 Host / 插件重载时，靠 sidecar 的 claim fence 与 `planningTimeout` 对账；同会话执行要求规划会话
  仍 live，否则 release 为 failed，用户可 retry。
- 两个新工具进入全局工具表，`plugin-trace` 的工具计数从 13 变 15。

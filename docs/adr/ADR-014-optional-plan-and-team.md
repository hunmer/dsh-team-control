# ADR-014：看板任务可选跳过规划与团队

- 状态：已接受
- 日期：2026-11-06
- 关联：`docs/CONTRACT.md` §3.13 / `tests/plugin-board-flags.mjs` / `src/web-ui/src/views/tasks/dialogs.tsx`

## 背景

原看板任务固定走 `todo → planning → planned → inprogress`，执行阶段固定按 Agent Team 编排
（要求先加载 `dsh-agent-team`、产出「团队与成员建议」、用 `team_task` 派发）。实际使用中两类需求变多：

1. 小改动不需要单独规划一轮，直接执行更省时省额度；
2. 单人就能完成的任务不需要建团队，但执行提示词仍在要求建队、加载团队技能，模型容易照着做。

另外 same 模式（规划与会话同一个）在执行阶段会把 `planMd` 全文再注入一次，而它已经在上文里，
纯属重复上下文。

## 决策

- **新增两个任务级布尔开关**，持久化在 `board_task.need_plan` / `board_task.use_team`
  （schema v16，默认都为 `1`，兼容旧数据与旧 API 调用）：
  - `need_plan=1`：保持 `todo → planning → planned → inprogress`；
    `need_plan=0`：跳过 planning，`todo` 在 inprogress 槽位空出后直接被 claim 执行。
  - `use_team=1`：规划/执行提示词保持原团队编排内容；`use_team=0`：提示词改为单人执行，
    明确禁止 `team_create` / `team_spawn` / `team_task`，也不再要求加载 `dsh-agent-team` 技能。
- **claim 条件集中写在 sidecar**：planning 只 claim `need_plan=1` 的 `todo`；inprogress 接受
  `status='planned'`，或 `need_plan=0 AND status='todo' AND auto=1`。插件不新增分支，只按
  claim 到的 `status` 决定投规划还是执行 prompt。
- **同会话执行不再重复计划**：`boardLeadPrompt(task, true)` 只发「现在开始执行『标题』。计划就在
  同一会话的上文里」+ 收尾状态规则，不注入 `description` 与 `planMd`。新会话执行（`executionMode=new`
  或 `need_plan=0` 的首轮）仍注入任务描述；`need_plan=1` 时再带「已确认的计划」。
- **团队模型白名单随 `use_team=0` 失效**：`teamModels` 仍可保留在任务上，但单人提示词不使用它；
  新建/编辑对话框在关闭团队时隐藏该选项，提交时写 `teamModels: null`。不选任何模型同样表示不限制，
  因此不再需要单独的「限制团队模型」开关。
- **UI 默认值**：新建任务默认 `needPlan=false`（用户要求默认不开启规划）、`useTeam=true`；
  草稿 localStorage 一并记住这两个值；编辑对话框只在 `todo` 且未封存时可改。

## 影响

- 旧任务读取时缺列走默认 `true/true`，行为与升级前一致；`ac-18` 的默认 API 任务断言不变。
- 免规划任务没有 `planning_session_id`，插件在 `use_team=0` 时也不建团队，任务完成后仍可受
  「用户追问 → done 翻回 inprogress」逻辑管理。
- 新增验收：`tests/plugin-board-flags.mjs` 覆盖免规划直接执行、单人规划、单人执行、同会话不重复
  计划、新会话注入计划五条路径。

# 变更记录（本套索引）

> 只记录索引/文档的生成与更新，不记录产品 Changelog。倒序，最多 5 条。

## 2026-11-26 · v0.3.1 成员报告完成自动打勾 todo / 规划会话绑定放宽与启动自检 / 看板两处修复

- `agentReport` 报 `done` 后自动把该任务下未打勾的 todo 统一置 `done` 并发 `task.todo` 事件（复用 `setTaskTodos`，保留 `started_at`/`done_at`；`failed`/`blocked` 不动清单）。`docs/CONTRACT.md` §3.8 同步；`tests/todo-plan.mjs` 加两条断言。
- `submitPlan` 改为按 `planning_session_id` 查任务、**不按状态过滤**，`planned`/`inprogress` 重复提交幂等、`done` 原样返回；真 404 带 `detail.hint`。§3.11 同步；`tests/ac-18-board.mjs` 加重复提交与旧会话 404 断言。
- 新增 `Board.repairStaleBindings()`：sidecar 启动时解绑 `todo`/`done`/已归档任务上残留的 `planning_session_id`（不动 `lead_session_id`，`failed` 保留以支持 ADR-015 复活），并写 info 日志。§3.13 同步；新增 `tests/board-stale-binding.mjs`。
- 三个包（cli / plugin / ui）统一升 0.3.1；plugin 对 cli 的依赖改 `^0.3.1`。

## 2026-11-18 · v0.3.0 工具名统一 dsh_team_* 前缀

- 24 个工具改名且不保留旧名：`team_*` → `dsh_team_*`，`board_*` → `dsh_team_board_*`（如 `team_create` → `dsh_team_create`、`board_task_create` → `dsh_team_board_task_create`）。插件描述、sidecar 提示词、面板、`skills/dsh-agent-team/SKILL.md`、tests 与活跃文档同步；三个包（cli / plugin / ui）统一升 0.3.0。

## 2026-11-18 · dsh_team_board_task_create 支持计划/执行/团队模型路由

- `dsh_team_board_task_create` 新增 `planRoute`、`leadRoute`、`teamModels[]`、`prewalk` 四个入参：路由接受 `{provider?,model,reasoningEffort?}` 或 `"provider/model"`，缺 `model` 直接报错，建卡前用 `assertRouteEnabled` 预校验启用状态；省略时跟随看板工作区设置。
- `dsh_team_board_task_get` 输出补 `planRoute`/`leadRoute`/`teamModels`/`prewalk`；`tests/plugin-board-agent-tools.mjs` 覆盖字符串归一化、白名单落库、读回与非法路由报错。
- 文档同步：`docs/CONTRACT.md`、`claude/public-interfaces.md`、`dsh-plugin/claude/public-interfaces.md`、`skills/dsh-agent-team/SKILL.md`。

## 2026-11-15 · schema v21 / 停止团队与停止看板任务都停会话 / 新任务归属判断

- schema v21：`board_task.stop_requested_at`；看板停止任务时 `boardPump` 按时间戳取消 Lead/规划会话的当前回合（solo 任务没有团队也能停），`live` 额外带出规划期停止的任务。面板任务详情显示「已于 … 停止」。
- schema v20：`team.stop_requested_at`；`POST /api/teams/:id/stop` 记录停止时间，`GET /api/status` 增加 `teams`（`id`/`leadSessionId`/`stopRequestedAt`），Host 插件 `forceStopPump` 按时间戳去重后对 Lead 会话 `agent.cancel({kind:'user'})`。新增 `tests/plugin-stop-lead.mjs`。
- `boardLeadRules` 增加「新任务归属判断」：交付物/验收不同或需独立分支 → `dsh_team_board_task_create`，用户明说建卡/单开会话时禁止 `dsh_team_task`；`dsh_team_task` 与 `dsh_team_board_task_create` 描述互斥，`SKILL.md` 补 3.1 节。
- `dsh_team_board_task_create` 对未注册 `workspaceId` 先按 `workspacePath` 改挂，改挂不了直接报错不落库；`src/board.mjs` 服务端同样按路径兜底。

## 2026-11-13 · 厂商备注 / git 分支 / agent 侧任务工具

- schema v19：`llm_provider.note`（厂商级备注，与 `llm_route.note` 分表，目录同步只更新 name/source/error 不覆盖）、`board_task.git_branch`；新增 `PATCH /api/llm/providers`，`GET /api/llm/catalog` 的 provider 带 `note`；`dsh_team_models` 每个模型附带 `providerNote`。面板模型路由页在厂商分组头加厂商备注输入（例如 gpt 适合逻辑处理 / claude 适合做设计）。
- 看板任务可指定 git 分支：`gitBranch: ''` 自动生成 `task/<任务短号>`；插件在 spawn 会话前 `rev-parse --is-inside-work-tree` → 已在目标分支跳过 → 存在则 checkout，否则 `checkout -b`，并把「git 分支：xxx（已切好）」注入规划/执行 prompt；非 git 仓库、无 git 或切换失败只告警降级，不阻断任务。新建/编辑对话框加「开始前切到独立 git 分支」开关 + 分支名，TaskPanel 展示分支。
- 插件新增 3 个工具（共 20 个 `team_*` + 4 个 `board_*`）：`dsh_team_task_get`（单任务状态 + DAG 节点）、`dsh_team_board_task_create`（成员/Lead 直接在会话里建看板任务，workspaceId 可反查）、`dsh_team_board_task_get`（按 id 或当前会话取看板任务）。
- 文档：`docs/CONTRACT.md`、`claude/public-interfaces.md`、`claude/data-model.md`、根 `CLAUDE.md`、`skills/dsh-agent-team/SKILL.md` 同步；新增测试 `tests/llm-provider-note.mjs`、`tests/board-git-branch.mjs`、`tests/plugin-board-agent-tools.mjs`。

## 2026-11-11 · 构建产物与历史清理

- 删除未引用的 `src/web/legacy/`（旧 vanilla 面板备份），更新 `src/web-ui/README.md` 与 `src/web-ui/claude/dependencies-and-config.md`。
- 用 `git filter-repo` 从历史中剔除旧 `src/web/assets` 构建产物，再重新提交当前两份资产；最终 tree 除 `legacy` 删除外与清理前一致。

## 2026-11-11 · 构建产物清理

- 新增 `src/web-ui/scripts/prune-assets.mjs` 并挂到 `postbuild`：构建后只保留 `panel.html` 当前引用的产物，同时同步 `.gitignore` 白名单，防止旧 hash 再次堆积。
- 删除 35 个历史构建产物（约 35 MB）；`dsh-team-control-cli` 的 npm 包从 11.4 MB 降到约 0.6 MB。

## 2026-11-11 · 面板指标与任务重置

- 面板：`agent-steering` 底部展示轮数/步数、tok/s、token 总量、缓存命中、上下文占用（数据来自 `sessionStats` + `tokenUsage` 投影→`context_snapshot.stats_json`）；`app-shell` 窄屏隐藏侧栏与 trigger；`Timeline` 去掉内部滚动；任务菜单新增仅 failed/done 可用的「重置」（`POST /api/board/tasks/:id/reset`）。
- 索引：`claude/public-interfaces.md`、`claude/data-model.md`（schema v17 + `stats_json`）、`claude/dependencies-and-config.md`、`claude/entrypoints.md`、`claude/testing-and-quality.md`、根 `CLAUDE.md` 资产 hash 同步；全量 `npm test` 33/33。

## 2026-11-05 · 深挖（第二阶段）

- `dsh-plugin/claude/overview.md`：新增「关键内存态」（leadByTeam/heldSessions 等）与「逐工具实现速查」（16 个工具的 sidecar 端点、route 合并、审批/冻结机制）两大节；`public-interfaces.md` 工具表补齐 board 两工具、标题改 16 个工具。
- `src/web-ui/claude/overview.md`：视图表按实际重写（Board.tsx=Trace 瀑布、BoardPage/TasksView=工作区看板），TAB_NAMES 修正为实际 8 个；新增手写路由与 `lib/board.ts` 看板 API 两节；store.tsx 深读（SSE 帧/去抖/轮询/Trace 分页/竞态约定）。
- `src/web-ui/CLAUDE.md`、`dsh-plugin/CLAUDE.md`：扫描状态更新为"含深读"；剩余未逐行仅 `views/Home.tsx` 与 `tasks/TasksView.tsx` 内部。

## 2026-11-05 · 增量更新（对应 v0.2.0）

- 根 [`CLAUDE.md`](../CLAUDE.md)：资产 hash 更新（`app-BWq-9mG2.js`/`panel-l54G6Q6n.css`）、schema v9→v14、ADR 11→12、扫描状态刷新。
- `claude/data-model.md`：schema v12→v14；新增看板状态机小节（`BOARD_STATUSES`、claim/stopTask 联动）。
- `claude/file-map.md`：目录树整体重写（删 policy/broker/runner/worker，新增 `src/board.mjs`；`dsh-plugin/index.js` 3484 行 16 工具；tests 31 脚本；ADR-012）。
- `claude/module-responsibilities.md` / `claude/entrypoints.md` / `claude/overview.md` / `claude/public-interfaces.md` / `claude/conventions.md`：清理 v2 已移除的 worker/broker 残留描述，补 `/api/board/**` 路由与 ADR-012，CLI `approve`→`approvals`。
- `src/CLAUDE.md`、`dsh-plugin/CLAUDE.md`：版本号与扫描状态同步。


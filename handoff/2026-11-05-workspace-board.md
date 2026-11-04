# Handoff — 工作区任务看板（2026-11-05）

## 1. 交接目标

让新会话可以继续完成「工作区任务看板」：每个 workspace 一个看板，任务可绑定多个 Agent Team；Host 插件自动 claim 任务并创建 DSH 会话，规划完成后进入执行，Lead 调 `team_*` 工具安排成员；看板有独立 GUI 入口与 `#/board[/<workspaceId>]` 路由。

需求原始口径见 [docs/board-plan.md](../docs/board-plan.md)，实现契约见 [docs/CONTRACT.md](../docs/CONTRACT.md) §3.13，决策记录见 [docs/adr/ADR-012-workspace-board.md](../docs/adr/ADR-012-workspace-board.md)。本文件只记录当前状态、接入点和下一步，不重复 schema/接口细节。

## 2. 已完成

### 2.1 sidecar 后端

- `src/board.mjs`：`Board` 类，负责 workspace 设置、任务 CRUD、并发槽位、原子 claim、attach/release、plan submit、状态机、team 绑定、SSE `board.task`。
- `src/db.mjs`：schema 升到 v12，新增 `board_settings` / `board_task` / `board_task_team` / `board_event`；`board_task.resumed` 用于区分「首次执行」与「完成后用户追问」。
- `src/core.mjs`：组合根挂 `this.board`。
- `src/server.mjs`：新增 `/api/board/**` 路由，含 tasks、claim、attach/release、by-session、by-team、settings、agents/plan、agents/status。
- 状态机：`todo → planning → planned → inprogress → done | failed`；`planned` 不占 planning 槽位，只等 inprogress 槽位。
- claim 的 fencing 字段 API 叫 `fence`（DB 列仍是 `claim_token`），因为全局 redactor 会把含 `token` 的字段替换成 `<redacted>`。

### 2.2 Host 插件（`dsh-plugin/index.js`）

- 新增配置：`boardEnabled`（默认 **true**；显式 `false` 可关闭）、`boardDispatchMs`、`boardIdleGraceMs`、`boardPlanningTimeoutMs`。
- `boardPump`：claim planning/inprogress → `ctx.get('agents').create` → attach → `followup`；规划权限 `read-only`，执行权限 `danger-full-access`。
- 规划阶段审批请求由插件直接 reject，避免无人值守挂起。
- 新工具：`board_plan_submit`、`board_task_status`。
- `team_create` 自动把 team 绑到当前会话对应的 board task；`team_spawn` 在该任务配置了 `teamModels` 时校验白名单。
- 同会话执行：`sameSession = kind==='inprogress' && task.leadSessionId`；`resumed=1` 时只 attach、不重复投执行 prompt。
- 重启对账：`boardPump` 读 `/api/board/live`，接管仍存活的会话；找不到 live agent 则把任务置 failed。

### 2.3 GUI

- `dsh-plugin-ui/client.js` 注册两个独立入口：「编排」与「看板」；better-sidebar 与原生右侧栏都有对应入口。
- 看板 iframe 打开 `/dsh-team-api/panel?api=/dsh-team-api&embed=1#/board`，不继承 team。
- `src/web-ui/src/views/BoardPage.tsx`：独立页面外壳，含工作区切换与主题切换。
- `src/web-ui/src/views/Tasks.tsx`：三列 Waiting（todo/planned/failed）、Progress（planning/inprogress）、Done（done）；新建/详情/设置/封存箱/auto 切换/手动状态操作；详情里的「关联团队」按钮通过 `dsh-team:open-team` 消息让 Host 打开对应团队的编排页。
- `src/web-ui/src/store.tsx`：`page: 'panel' | 'board'`，路由 `#/board` / `#/board/<ws>`；board 启动只加载 workspaces，不选 team、不连 SSE。
- 编排侧栏已移除 `tasks` 页签。
- 新建任务的模型下拉已改为请求 `/api/llm/catalog`（此前误用不存在的 `/api/models`，会提示“模型目录尚未加载”）。

## 3. 当前验证状态

- `npm test`：**30/30 通过**。
- `tests/ac-18-board.mjs`：sidecar 看板状态机/并发/claim/attach/archive/team 绑定通过。
- `tests/plugin-board.mjs`：假 Host ctx 的自动建会话、同会话执行、done→inprogress 不重复投 prompt 通过。
- `tests/plugin-client.mjs`：两个 GUI 入口、两个 iframe、原生 tab/slot 注册通过。
- 实际 DSH GUI（`http://127.0.0.1:3080`）已验证：右侧栏「开始」页出现「编排」「看板」；点「看板」加载 `#/board` 独立页面；`#/w/<ws>` 回到编排并确认无「任务看板」页签。
- 实际 sidecar 4317 已重启并确认 `/api/board/live`、`/api/llm/catalog` 返回 200。
- 最新前端产物：`src/web/assets/app-Ceg_U6d_.js`、`src/web/assets/panel-Da0ztJ8f.css`；`src/web/panel.html` 与 `.gitignore` 白名单已同步。

## 4. 真实端到端结果（2026-11-05 00:25）

- 已在 `/Users/Zhuanz/Documents/story` 用任务 `bt_mw2boe4z1daah` 跑通：todo → planning → planned → inprogress → done。
- 规划与执行复用同一会话 `session-15a1df6e-a88d-4ae8-8f46-07907738ba02`；Lead 创建团队 `team_mw2bu51b3a1xi`，成员写完 `/Users/Zhuanz/Documents/story/story.md`，随后调用 `board_task_status done`。
- 触发方式：`dsh-plugin/index.js` 默认改为 `boardEnabled: c.boardEnabled !== false`；并在 `/Users/Zhuanz/.dsh/profiles/web/cordis.patch.yml` 追加 `- id: dsh-team` 的 `boardEnabled: true` 覆盖。DSH 配置监听热加载后，旧进程无需重启即开始 claim。

1. `boardEnabled` 已默认 true，并在当前 profile 显式开启；其他机器/其他 profile 若仍是旧进程，需要重启 DSH Web 或触发热加载。
2. 规划/执行的真实审批路径只做了代码级验证，尚未故意制造一次 `approval/request` 验证自动拒绝。
3. 规划会话在 `same` 模式下会持续保留为 Lead 会话；`new` 模式的规划会话会在提交后 5s dispose。
4. 看板是 iframe 内的 `#/board`，浏览器顶层 URL 仍是 DSH 页面；如果要求宿主级顶层路由，需要 DSH 提供页面路由扩展点，目前插件只能做到独立入口 + iframe 内页面路由。
5. `src/web-ui/tsconfig.tsbuildinfo` 是构建产生的已跟踪变更，可按需要还原/忽略。
6. 当前改动未提交 git；不要执行 commit/reset/checkout，除非用户明确要求。

## 5. 建议下一步

1. 在真实 GUI 新建任务，勾选 auto 或点「开始执行」，确认：
   - 任务从 todo → planning；
   - DSH 侧栏出现 workspace 下的 planning 会话；
   - 规划会话调 `board_plan_submit` 后任务变 planned，再被 claim 为 inprogress；
   - 执行会话调 `team_create` / `team_spawn` 后任务绑定 team；
   - `board_task_status done` 后任务进 Done；
   - 在 Done 任务会话里再发用户消息，任务回 inprogress 且不重复注入执行 prompt。
2. 用真实会话验证权限：规划 `read-only` 审批应被自动拒绝；执行 `danger-full-access` 不挂起。
3. 已实测任务详情「关联团队」：点击后右侧栏切到「编排」并带 `team=<id>`；独立浏览器页面会提示改用侧栏。
4. 小屏（≤720px）已改为每个分类一行、卡片水平布局：左侧标题/描述/状态，右侧操作，更新时间独占一行；桌面端保持三列。截图 `/tmp/dsh-board-mobile6.png`。
5. 如果 UI 还要继续打磨，优先补：workspace 元数据为空时的展示、失败原因可复制、移动端卡片操作区进一步收窄。

## 6. 关键文件

- 计划/契约：[docs/board-plan.md](../docs/board-plan.md)、[docs/CONTRACT.md](../docs/CONTRACT.md)、[docs/adr/ADR-012-workspace-board.md](../docs/adr/ADR-012-workspace-board.md)
- 后端：[src/board.mjs](../src/board.mjs)、[src/db.mjs](../src/db.mjs)、[src/server.mjs](../src/server.mjs)、[src/core.mjs](../src/core.mjs)
- Host 插件：[dsh-plugin/index.js](../dsh-plugin/index.js)
- GUI 入口：[dsh-plugin-ui/client.js](../dsh-plugin-ui/client.js)
- 前端页面：[src/web-ui/src/views/BoardPage.tsx](../src/web-ui/src/views/BoardPage.tsx)、[src/web-ui/src/views/Tasks.tsx](../src/web-ui/src/views/Tasks.tsx)、[src/web-ui/src/lib/board.ts](../src/web-ui/src/lib/board.ts)、[src/web-ui/src/store.tsx](../src/web-ui/src/store.tsx)
- 测试：[tests/ac-18-board.mjs](../tests/ac-18-board.mjs)、[tests/plugin-board.mjs](../tests/plugin-board.mjs)、[tests/plugin-client.mjs](../tests/plugin-client.mjs)

## 7. 常用命令

```bash
cd /Users/Zhuanz/Documents/dsh-agent-team-plugin

npm test
node tests/ac-18-board.mjs
node tests/plugin-board.mjs
node tests/plugin-client.mjs

cd src/web-ui && npm run build

# 本地独立看板（验证 UI 用）
node bin/dsh-team.mjs up --data /tmp/dsh-board-ui3 --port 4488
# 打开 http://127.0.0.1:4488/panel#/board
```

## 8. 建议使用的 skills

- `dsh-agent-team`：真实跑通 Lead + `team_create` / `team_spawn` / `board_*` 的工具调用流程。
- `cordis-plugin-development`：如果需要调整 DSH 插件入口、slot 或 better-sidebar 注册。
- `ego-browser`：继续做 GUI 端到端验收与截图。
- `debug-issue`：真实调度出现 claim / attach / 会话状态异常时排查。

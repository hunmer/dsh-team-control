# Handoff: 工作区任务看板（重试复用团队 / 工作区会话开关 / DSH 会话深链）

**Created:** 2026-11-05 11:51 (Asia/Shanghai)
**Branch:** `master`（HEAD `f9e6267`）
**Repo:** `C:\Users\Administrator\Documents\deepseek-harness\agent-team-plugin`
**本次提交：** `7d6e231` feat(board) → `0fbcf98` chore(web-ui) → `f9e6267` fix(web-ui)
**工作树：** 干净

---

## Summary

本轮把「工作区任务看板」从『能跑』补到『可连续运营』，解决五个实际问题：

1. **失败任务重试会新建团队** → 改为在已有团队上继续（提示词软约束 + 插件硬约束）。
2. **看板创建的规划/执行会话从不进入 DSH「工作区会话」列表** → 新增 `showTaskSessions` 开关（默认开），插件把会话 `attachSession` 进工作区账本。
3. **任务详情无法从独立浏览器页面打开 Lead 会话** → 新增「执行会话」按钮；内嵌走 postMessage，独立页面走 DSH Web 深链。
4. **DSH Web 没有会话级 URL 路由** → 用 `#dsh-session=<id>` 约定打通插件两端（Host 上报地址 + 客户端接管 hash）。
5. **面板表单体验** → 模型路由用 coss Select（分组 + 模型头像）；团队模型多选按 provider 分组，每个已选模型可单独指定 effort。

结论：全部改动已合并进 `master`，`npm test` 30/30、`panel-contract` 17/17、`tsc -b` 0、面板构建成功。**唯一未做的是真实浏览器点击验证**（见「已知限制」）。

---

## Work Completed

### 1. 重试复用已有团队（`7d6e231`）

根因两条，缺一不可：

- `src/board.mjs:311` `retryTask()` 把任务打回 `todo`/`planned`，并**清空 `planning_session_id` / `lead_session_id`** → 必然重新起 Lead 会话。
- `dsh-plugin/index.js` `boardLeadPrompt()` 规则 1 **无条件要求 `team_create`** → 新 Lead 必建新团队。

改动：

- `boardLeadPrompt(task)` 读取 `task.teams`：有团队时规则改为「不要 `team_create`：先 `team_status` 查看既有团队，用 `team_task` 在原团队追加剩余工作；仅团队被删/不可用时才新建」。
- 新增 `guardBoardTeamReuse(s, sessionId, force)`：对「spawn 时任务已有关联团队」的续跑会话，`team_create` 若发现原团队仍存在（`!archivedAt`）直接抛错并给出继续步骤；`team_create` 参数新增 `force?: boolean` 作为显式逃生口。
- `spawnBoardSession` 在 sameSession / 新建两个分支都记录 `reusedRun: hadTeams`，供上面的守卫判断。

### 2. `showTaskSessions` 开关（`7d6e231`）

- `src/db.mjs`：`SCHEMA_VERSION` 12→13；`board_settings` 增 `show_task_sessions INTEGER NOT NULL DEFAULT 1`，并对老库 `ensureColumn` 补列。
- `src/board.mjs`：`DEFAULT_SETTINGS.showTaskSessions: true`，`settingsFromRow` 缺省按 true，`saveSettings` 持久化。
- `dsh-plugin/index.js`：新增 `attachBoardSessionToWorkspace(ctx, task, sessionId)` → `ctx.get('workspaceRegistry').get(task.workspaceId).attachSession(sessionId)`；在规划/执行会话 `attach` 后调用，受开关控制，失败只告警。
- 前端：`BoardSettings.showTaskSessions`；`SettingsDialog` 增加 Switch「在工作区会话里显示任务会话」。

> 机制说明：DSH 的工作区会话列表只认 `Workspace.attachSession` 的会话账本；插件用 `agents.create(meta.cwd)` 起的会话不入账本，所以之前「只有一个 kanban 入口」。`workspace.id` 直接来自 DSH `WorkspaceId`（`src/core.mjs` 的 `reportWorkspaces`），因此可用 `task.workspaceId` 直接 `registry.get(id)`。

### 3. 「执行会话」按钮 + DSH Web 深链（`7d6e231` + `f9e6267`）

- `src/web-ui/src/views/tasks/shared.ts`：`openDshSession(sessionId, webUrl?)` →
  - 内嵌：`postMessage({type:'dsh-team:open-session'})` → `dsh-plugin-ui/client.js` → `uiWorkspace.openSession(sessionId)`；
  - 独立页面：`window.open('${base}/#dsh-session=<id>')`；
  - `base` 取 `settings.dshWebUrl`，缺失时回退 `DEFAULT_DSH_WEB_URL = 'http://127.0.0.1:3080'`（`f9e6267`）。
- `dsh-plugin-ui/client.js`：启动时解析 `location.hash` 里的 `dsh-session`，等 `uiWorkspace` 就绪（250ms × 40 次重试）后调 `openSession`，并 `history.replaceState` 清 hash。
- Host 上报地址：`dsh-plugin/index.js` 读 `ctx.get('webServer')` 的 host/port/tls → `POST /api/host/web`（启动时 + 每 60s）。
- sidecar：`src/server.mjs` 新增 `GET/POST /api/host/web`；`src/board.mjs` 的 `hostWebUrl()/reportHostWeb()` 存 meta（只接受 http(s)、拒绝 `javascript:`）；`/api/board/settings` 与 `GET /api/board` 返回只读 `dshWebUrl`。
- `TaskPanel.tsx`：有 `leadSessionId` 时显示「执行会话 / 打开会话」，成功提示区分「已在 DSH 中打开」/「已在新窗口打开」；只有弹窗被拦截才报错。

> DSH Web 侧已核实：前端 shell（`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`）没有 `pushState`/URL 解析，`uiWorkspace.openSession` 只写内存 store，服务端也没有「打开某会话」RPC。因此深链只能由本插件两端自定义 hash 约定实现。

### 4. 面板 UI（`0fbcf98`）

- `views/tasks/fields.tsx`：模型路由改 coss `Select`，按 provider 分组（`SelectGroup`/`SelectGroupLabel`/`SelectSeparator`），选项与触发器带 `ModelAvatar`；空值用 `\u0000__default__` 哨兵。
- `views/tasks/dialogs.tsx`：团队模型多选改 coss 多选 `Combobox`（`items` = 分组数组 + `ComboboxGroup/ComboboxCollection`，搜索按叶子过滤、空组自动丢弃）；已选行右侧新增 `EffortSelect`（coss 单选 `Select`，「跟随默认」+ 该模型 efforts）；提交时只发送目录仍声明的 effort。
- `views/tasks/shared.ts` / `TasksView.tsx`：`ModelOption` 带 `efforts/defaultEffort`，扁平化目录时按 `allowedEfforts` 过滤。
- 其余：`DevInspector`、`vite.config.ts`、`package.json`、样式微调随本次一并提交。

---

## Verification

| 项 | 结果 |
|---|---|
| `npm test` | **30/30 通过**（含 ac-18-board、plugin-board、plugin-client、db-migration） |
| `node tests/panel-contract.mjs` | 17/17 |
| `node tests/ac-18-board.mjs` | ok（含 `showTaskSessions` 默认 true、可关可开、`dshWebUrl` 上报后透出） |
| `node tests/plugin-client.mjs` | ALL PASS |
| `cd src/web-ui && npx tsc -b` | exit 0 |
| `npm run build` | 成功，产物 `src/web/assets/app-CLWApnVC.js`（1,226,433 B）、`panel-Jf5BYIfE.css` |
| 临时 sidecar 4399 实测 | `POST /api/host/web` → `GET` 回读、`settings.dshWebUrl` 透出、非法 URL 返回 400 |
| 运行中 sidecar 4317 | 静态资源已是新 bundle（`/panel` 引用 `app-CLWApnVC.js`）；**接口/插件仍是旧代码，需重启 DSH** |

---

## 已知限制 / 待办

1. **运行环境是旧代码**：4317 上的 sidecar 由旧版 Host 插件拉起，`/api/host/web` 目前 404；DSH Host 里的 `dsh-plugin`、`dsh-plugin-ui` 也还是旧 bundle。重启 DSH 后新插件会重新拉起 sidecar，`dshWebUrl` 才会自动出现（在此之前靠默认 `127.0.0.1:3080` 兜底）。
2. **深链依赖 302 跳转保留 URL fragment**：`dsh web` 的 token 跳转若发生在某些反向代理后面可能丢 `#`；届时可改用 `?dsh-session=` 或由 sidecar 做一次 302 注入。
3. **`reusedRun` 是进程内标记**：DSH 重启后 `boardSessions` 重建会丢失，硬约束回落到提示词约束（软约束）。
4. **未做真实浏览器点击验证**：`openSession` 对不存在/已归档的会话 id 目前静默失败；`TaskPanel` 只处理「弹窗被拦截」。
5. **历史构建产物未清理**：`src/web/assets/` 仍跟踪多份旧 hash 的 bundle（历史遗留），仅在 `.gitignore` 里白名单当前两份。

## 建议的下一步

- 在真实浏览器里跑一遍「独立面板 → 执行会话 → 3080 定位」与「内嵌 → 执行会话」两条链路。
- 若确认 fragment 方案稳定，可把深链格式固化进 `docs/CONTRACT.md` 的公开接口章节（当前已写语义，未给示例 URL）。
- 清理旧构建产物或加一个 `npm run clean:assets`。

---

## 验收步骤（最短路径）

1. 重启 DSH（插件与 sidecar 一起换新），确认浏览器已登录 `http://127.0.0.1:3080`。
2. `curl -H "Authorization: Bearer $(cat C:\Users\Administrator\.dsh\team\token)" http://127.0.0.1:4317/api/host/web` → 应返回 `{"url":"http://127.0.0.1:3080"}`。
3. 独立面板 `http://127.0.0.1:4317/panel#token=<token>` → 看板 → 任意有 `lead_session_id` 的任务 →「执行会话」→ 新标签页自动定位到该会话。
4. 看板设置开关「在工作区会话里显示任务会话」→ DSH 侧栏「工作区会话」里规划/执行会话随开关出现或消失。
5. 把一个任务置为 `failed` 后点重试：新 Lead 应先 `team_status` 复用原团队；若强行 `team_create` 会收到「本任务已关联团队…」错误，传 `force: true` 才允许并行新建。

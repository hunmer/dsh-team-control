# 交接：全新环境建团队做实测 + 报错排查手册

> 写于 2026-10-30（五版）。给下一个接手的 agent：**在一台干净机器上从零装起**，跳过静态自检，直接建一个团队跑端到端；遇到报错先按 §5 收集信息，再对照 §6 的「可能原因」定位。

## 1. 目标与边界

- 仓库：`C:\Users\Administrator\Documents\deepseek-harness\agent-team-plugin`（dsh-team 插件：host 插件 + 客户端 UI + sidecar 内核 + DSH 面板）。
- 任务：验证这一版能建团队、按依赖派发、成员回报、UI 正确；**不是重构**。
- 审批策略是 `never`：不要请求提权，不要 `sandbox_permissions`。
- 输出中文；改动尽量小；不要动 §4 末尾列出的「别人并发改过的文件」。

## 2. 全新环境：从零装起（按顺序做）

### 2.1 前置

- **Node.js ≥ 22.15**（`node --version`；sidecar 用 `node:sqlite` 与 `module.registerHooks`，实测 v24.22）。
- **DSH 已安装并能打开 Web GUI**（`http://127.0.0.1:3080`）。GUI 打不开就先修 DSH，不要继续。
- Git + pnpm（DSH profile 用 pnpm 管理插件）。

### 2.2 拉代码

```bash
git clone <repo> agent-team-plugin
cd agent-team-plugin
node tests/run-all.mjs        # 先确认「通过 29/29」，此时不需要任何依赖
```

sidecar 本体**零依赖、零构建**，不需要 `npm install`。

### 2.3 构建面板（只有 `src/web-ui` 需要依赖）

```bash
cd src/web-ui
npm install
npm run build                 # 产物被 sidecar 直接 serve，构建后不用重启 sidecar
```

### 2.4 启动 sidecar

```bash
node bin/dsh-team.mjs up --port 4317 --data ~/.dsh/team
# stdout 第一行是 {"event":"ready", url, port, token, panel}
curl http://127.0.0.1:4317/api/status      # 期望 200
```

- 也可以不手动起：插件配置里 `autoStart: true`，第一次调 `team_*` 会自动拉起（但**第一次调用会慢几秒**，别误判为卡死）。
- 重启用 `node bin/dsh-team.mjs down` 再 `up`；数据在 `--data` 目录，换目录就是全新库。

### 2.5 让 DSH 加载两个插件

DSH profile 目录：`~/.dsh/profiles/web`（Windows：`C:\Users\<用户>\.dsh\profiles\web`）。在它的 `package.json` 的 `dependencies` 里加两条 link：

```json
{
  "dependencies": {
    "@local/dsh-team-plugin": "link:<绝对路径>/agent-team-plugin/dsh-plugin",
    "@local/dsh-team-ui": "link:<绝对路径>/agent-team-plugin/dsh-plugin-ui"
  }
}
```

然后 `cd ~/.dsh/profiles/web && pnpm install` 完成 link，**重启 dsh web**。

两个包各自带 `cordis.patch.yml`，DSH 会自动把 `dsh-team`（工具）与 `dsh-team-ui`（面板页）插进组合树，不需要手改 `cordis.yml`。

- 只改 `dsh-plugin/` / `dsh-plugin-ui/` 的 JS：**必须重启 dsh web** 才生效（profile 是 `link:`，没有构建缓存）。
- 只改 `src/web-ui/`：`npm run build` 即可，刷新页面就行。

### 2.6 自检（30 秒）

```bash
curl http://127.0.0.1:4317/api/status                 # 200
curl -s http://127.0.0.1:4317/panel | head -c 120     # 返回 HTML，bundle 名是新的
node tests/run-all.mjs                                # 通过 29/29
```

再进 GUI：右侧栏能打开编排页、顶栏右侧有「队列」按钮，即为就绪。

## 3. 这一版新增/已修（2026-10-30 四版，测试前先知道）

| 能力 | 位置 | 说明 |
|---|---|---|
| 消息回执闭环 | `dsh-plugin/index.js`（`markDelivered`，派发与 `team_send` 成功后触发）、`src/bus.mjs` `ack()` | 状态 `queued → delivered → acked` 只升不降；面板【消息与回执】不再永远显示 queued |
| 审阅（成员改动 diff） | 采集 `dsh-plugin/index.js`（`tools/execute` 包装 write/edit 前后读盘）、落库 `src/core.mjs` `addChanges/listChanges` + 表 `member_change`、接口 `GET/POST /api/changes`、页面 `src/web-ui/src/views/Review.tsx` | 只读展示 unified diff，不做写操作；缺 taskId 时按成员当前 running 任务补；每行带成员头像（`ModelAvatar`） |
| 审阅采集错路径（四版修复） | `dsh-plugin/index.js` `rememberMember()` / `reportFileChange()` | spawn 时把 `team.workspace` 记成成员会话 cwd；成员用**相对路径** write/edit 时也能解析到真实文件（此前会退回宿主进程 cwd → 读不到 → 静默跳过，审阅页少一条）。回归用例：`tests/plugin-changes.mjs` ⑧ |
| 审阅页窄屏 | `src/web-ui/src/views/Review.tsx` | 窄屏（`lg` 以下）改**上下布局**：上面一行可横向滚动的成员改动卡片，下面 diff；宽屏仍是左列表右 diff |
| 成员队列入口 | `src/web-ui/src/components/TopBar.tsx` + `agent-queue/agent-queue-dock.tsx` | 右下浮窗已移除；改为顶栏右侧「队列」按钮 + `Popover`（必须 `modal={false}`，否则内嵌菜单第一次点击被焦点陷阱吞掉）。**不再支持拖拽** |
| 运行操作菜单 | `src/web-ui/src/components/TeamRunMenu.tsx` | 从 TopBar 迁到队列弹层 header 右上角（停止 / 封存 / 删除 / 停止并删除）；弹层内 X 关闭 |
| 团队校验卡（右上浮层） | `dsh-plugin-ui/client.js` | 发现行改「标题 / 成员·位置」两行（修叠字）；计划列表改成 web-ui PlanSteps 风格（状态图标 + 计划进度条 + 完成删除线）；**成员行右侧只显示计划进度 `完成/总数`**，原有严重度徽标与标题右侧统计已移除 |
| 团队校验卡（四版精简） | `dsh-plugin-ui/client.js` `AgentFindings` | **删除「最新发现」区块**（连成员筛选 chip、点击展开成员对话一并移除；严重/警告计数仍显示在胶囊上）；**成员计划全部常驻展开**，不再点选成员折叠，成员行不再是按钮 |
| DAG 运行卡片流光（四版修复） | `src/web-ui/src/components/agent-tree/agent-tree-css.ts` | 原 `.ui-agtc__beam{z-index:-1}` 被卡片不透明背景压住，只剩 1.5px 细边、看起来「卡着不动」；改为 `z-index:1` + 环形遮罩（`mask-composite: exclude`），光带只在边框内绕卡片旋转，并给 `[data-status="running"]` 加淡光 |
| 成员用量排行单位（四版） | `src/web-ui/src/lib/format.ts` `fmtTokens()` | ≥1M 显示 `1.2M`（此前 1e6 会显示成 `1000k`） |
| 收件箱产物跳审阅（四版） | `src/web-ui/src/components/agent-inbox.tsx`、`src/web-ui/src/store.tsx`（`reviewFocus` / `focusReview`）、`src/web-ui/src/views/{Home,Review}.tsx` | 点卡片里的产物文件名 → 切到「审阅」并自动选中该文件（路径按大小写/斜杠/相对全路径/basename 兜底匹配）；卡片新增【查看对话】按钮，复用 `member-info.tsx` 的 `openMemberConversation()`（worker 成员无会话时 toast 提示） |
| 审批队列收进顶栏（四版） | `src/web-ui/src/views/Approvals.tsx`（抽出 `ApprovalsPanel`）、`src/web-ui/src/components/TopBar.tsx`、`src/web-ui/src/shell.tsx` | 导航里的「审批队列」页签移除；改为顶栏铃铛按钮 + 红点计数 + `Popover modal={false}` 内嵌审批列表。旧 hash `#/approvals` 仍能渲染整页（`TAB_NAMES` 保留） |

## 4. 直接建团队（端到端）

1. `team_create({ name: "handoff-test", runtime: "agent", workspace: "<仓库绝对路径>/team-e2e-<MMDD>" })`
   - 记下 `team.id`，后续所有 `team_*` 调用都要带 `teamId`。
   - **产物目录约定**：测试产物一律落在仓库根的 `team-e2e-<MMDD>/`（如 `team-e2e-1030/`），该目录已被 `.gitignore` 的 `team-e2e-*/` 忽略，**不要提交**；同一个目录可以放多轮（`v2/`、`v3/` 子目录）。
2. `team_models()` → 用列出的路由 `team_spawn` 三次（例如 minimax、glm、再一个 minimax）。
   - `prompt` 必须自包含（成员看不到 Lead 的对话）：写清 teamId、工作目录、任务，以及「结束必须调用 `team_report_task`」。
3. 建带前置依赖的 DAG：
   - `team_task({ teamId, subject: "01 大纲", plan: [], acceptance: "输出 01-outline.md", dispatch: false })`
   - `team_task({ teamId, subject: "02 正文", plan: [], deps: [{ from: <01 taskId>, condition: "all_success" }], acceptance: "输出 02-novel.md" })`
   - `team_task({ teamId, subject: "03 评审", plan: [], deps: [{ from: <02 taskId>, condition: "all_success" }], acceptance: "输出 03-review.md" })`
   - `team_dispatch({ teamId })` 放第一波。
4. 观测：`team_status({ teamId, detail: "dag" })` —— 01 先 running；02/03 等上游 done 才 ready；成员各自 `team_report_task` 后逐个 done。
5. 产物：`team-e2e-<MMDD>/` 下 3 个 md 存在，02 明显长于 01。

### UI 抽查（GUI）

- 编排页在**右侧栏**（不是底部工作台）；顶栏右侧有「队列」按钮（连接状态右边）。
- 点「队列」弹出面板：header 右上角是运行操作菜单，**一次点击**就能展开四项（停止 / 封存 / 删除 / 停止并删除）；点外部、✕、Esc 都能关闭。
- **团队校验**里每个成员的计划直接列在卡片上（无需点成员行）：状态图标（转圈/对勾/叉/虚线圈）+ 顶部「计划 ▬ 1/4」进度条 + 完成项删除线，计数 `done/total`。
- 成员行右侧只显示计划进度 `完成/总数`（如 `5/5`），**没有**严重度图标和数字；标题「团队校验」右侧为空；卡片里**没有**「最新发现」区块。
- 团队校验卡每个成员行最右侧有**对话按钮**（气泡图标）：点它在本会话右侧栏打开该成员的对话；worker 成员没有 DSH 会话，不显示按钮。
- 顶栏审批铃铛的弹层**分页**：每页 4 条，底部有「第 x / y 页」与上一页/下一页（不足 5 条时不显示分页条）。
- 成员干活期间行保持 running 色，不出现「跑着跑着变灰」。
- 【消息与回执】：Lead→成员的提问，成员收工约 10–15 秒后变**绿色双向箭头**、胶囊「已回复」，悬浮可见「消息 / 回复」两条正文。
- 切 DSH 深/浅色，编排面板跟着变；单独打开 `http://127.0.0.1:4317/panel` 时仍保留自己的明暗按钮。
- **审阅**页（右侧栏）有内容：成员 write/edit 过的文件按任务分组列出（带成员头像），点开显示带 `+/-` 行的 unified diff；没有成员改动时显示空态而不是报错。
- 窗口拉窄（`lg` 以下）后审阅页变成上下布局：上面一行卡片可左右滚动，下面 diff 不被压扁。
- 【消息与回执】里，Lead 派发任务或 `team_send` 之后，对应消息应从 queued 变 delivered（成员回工后再变 acked/已回复）。
- **依赖 DAG** 页：running 卡片有光带**绕卡片边框旋转**（不是静止细边），done 卡片没有光带；`prefers-reduced-motion` 下动画停止属预期。
- **审批队列**不在左侧导航里：顶栏连接胶囊右侧有铃铛按钮，有待审批时带红点数字；点一下弹出审批列表（`Popover` 不能吞掉首次点击），可直接批准/驳回；无待审批时弹出空态。
- **实时收件箱**卡片：产物文件名可点，点击后切到「审阅」并自动选中该文件；卡片上的【查看对话】能唤起该成员的 DSH 对话（worker 成员无会话时提示而不是静默）。
- **用量页**「成员用量排行」：token 数 ≥1M 时显示 `1.2M` 这类单位，不再出现 `1000k`。

### 不要动的文件（别人并发改动）

`src/web-ui/src/components/{JsonViewer.tsx, Overlays.tsx, agent-queue/agent-queue-dock.tsx, context-map/*, fan-out-grid/*, member-info.tsx, trace-waterfall/*}`、`src/web-ui/src/views/Context.tsx`、`src/web/panel.html`、`src/web-ui/tsconfig.tsbuildinfo`。

> 其中 `src/web-ui/src/components/agent-queue/agent-queue-dock.tsx` 本版已经改过（顶栏按钮 + 弹层 header 菜单），不是不能改，而是**改前先读当前文件**，不要覆盖别人未提交的改动。
>
> 四版补充：`.gitignore`（新增 `team-e2e-*/`）与 `src/web/panel.html`（`npm run build` 产物）本次由本任务改动；`panel.html` 每次 build 都会被重写，别把它当手写文件。
>
> 五版补充：只动了 `dsh-plugin-ui/client.js`（成员行对话按钮 + 清理「最新发现」遗留的死 CSS/死函数/死字典键）与 `src/web-ui` 的 `TopBar.tsx`/`Approvals.tsx`（审批弹层分页），行为对旧版兼容；没有新增路由。

## 5. 遇到报错：先收集这三样

1. **原始报错文本**（整行，含 `dsh-team API <code> on <method> <path>: ...`）。
2. `team_status({ teamId, detail: "dag" })` 快照（谁卡在 ready/running）。
3. sidecar 状态：`curl http://127.0.0.1:4317/api/status`；面板 `http://127.0.0.1:4317/panel` 是否可开。

然后对照 §6 找最接近的一条，按「诊断」动作确认，不要盲改代码。

## 6. 可能原因清单

### 建团队 / 派发

| 症状 | 可能原因 | 诊断动作 |
|---|---|---|
| `team_create` 报 `dsh-team API ... on POST /api/teams` 或连接失败 | sidecar 没起 / 端口被占 / profile 没 link 本插件 | `curl http://127.0.0.1:4317/api/status`；查 dsh web 启动日志里插件是否加载 |
| `team_spawn` 报模型/路由未知 | 该 provider/model 没在 `team_models()` 里启用 | 先 `team_models()`，只用返回的组合 |
| 派发失败：`sendMessage failed: subagent "..." belongs to another parent session` | 历史 bug 复现：`leadByTeam` 被成员会话覆盖（成员调 `team_task`/`team_dispatch`/`team_report_task` 时写脏） | 看 `dsh-plugin/index.js` 里 `memberOfCaller` 守卫（约 174 行）与三处调用点是否都带 `!memberOfCaller(...)` |
| 任务一直 `ready` 不派发 | ①`dispatch:false` 建完忘了 `team_dispatch`；②`deps` 的 `condition:"all_success"` 因上游 failed 永不满足；③`assignee` 传了名字而不是成员 id（`m_...`） | `team_status(detail:"dag")` 看依赖边与上游状态；检查 assignee |
| `team_task` 报 `E_BAD_REQUEST team required` | 直接调 `/api/todos` 时缺 `team` 参数（`/api/tasks/:id/todos` 不受影响） | 补 `team=<teamId>` |

### 成员行为

| 症状 | 可能原因 | 诊断动作 |
|---|---|---|
| 成员接受任务后永不回报，任务卡 running | 简报里没写「结束必须 `team_report_task`」；或成员只建了 plan 就停 | 看成员会话最后输出；`team_status` 里 member.step/last |
| 成员报 `belongs to another parent` 后不断重试 | 同「派发」那条，属同一根因 | 同上 |
| 成员明明在跑，UI 却灰显（done） | DSH 把 `maintenance`（压缩/整理）当 idle；旧版本会立刻落库 | 确认 host 已重启到含 `phaseKind === 'maintenance'` 守卫 + `agentIdleSettleMs`（12s）+ 心跳（15s）的版本 |
| 团队成员 idle 后下游迟迟不开始 | idle 有 12s 稳定窗口，属预期；超过 20s 才算异常 | 等 15s 再看 `team_status` |

### 面板 / UI

| 症状 | 可能原因 | 诊断动作 |
|---|---|---|
| 编排面板打不开或白屏 | `src/web-ui` 没 build / build 产物没被引用 | `cd src/web-ui && npm run build`；`curl http://127.0.0.1:4317/panel \| head -c 200` 看 bundle 名是否新 |
| 队列弹层里的运行菜单第一次点击只聚焦、要第二次才展开 | `Popover` 少了 `modal={false}`，焦点陷阱吞掉首次点击 | 看 `agent-queue-dock.tsx` 的 `<Popover modal={false} ...>` |
| UI 看着像旧版（没有队列按钮 / 成员行右侧是徽标 / 发现区叠字 / 审阅页窄屏仍两栏 / 左侧还有「审批队列」/ 用量显示 1000k） | 改了 `dsh-plugin*` 没重启 dsh web，或改了 `src/web-ui` 没重新 build | 重启 dsh web；`cd src/web-ui && npm run build` 后强刷 |
| 顶栏找不到「审批队列」页签 | 四版起审批队列收进顶栏铃铛按钮（`Popover`），左侧导航不再有该项；旧地址 `#/approvals` 仍可整页打开 | 点顶栏铃铛；或直接访问 `#/approvals` |
| 团队校验里点成员行没反应 | 四版起计划**常驻展开**，成员行不再是折叠按钮 | 无需处理（有需要看历史版本请 `git log -p dsh-plugin-ui/client.js`） |
| 团队校验成员行右侧没有对话按钮 | ①该成员是 worker 运行时（没有 `agentSessionId`，本就不显示）；②面板是旧 bundle；③host 客户端插件没重启 | 看 `GET /api/teams/<id>` 里成员有无 `agentSessionId`；重启 dsh web 后强刷 |
| 审批弹层一次列出几十条、要滚很久 | 五版前不分页（全量渲染）；或面板旧 bundle | 重新 build；弹层底部应出现「第 x / y 页」分页条 |
| DAG 里 running 卡片只有一圈细边、不转 | 面板是旧 bundle（`z-index:-1` 旧实现），或浏览器处于 `prefers-reduced-motion: reduce` | `cd src/web-ui && npm run build` 后强刷；确认系统没开「减少动画」 |
| 建团队后仍在底部工作台打开 | 旧版本；或 `sidebarRight.openTab` 抛错后回落到 `betterSidebar`（其结果永远落底部） | 确认 host/客户端插件已重启；看浏览器控制台里的 openTab 报错 |
| 团队校验没有 plan | ①成员没用 `team_todo` 也没用内置 `todo_write`；②`mirrorTodos` 拿不到 `currentTaskId`（任务还没派到）；③面板是旧 bundle | 看 `GET /api/todos?team=<id>` 是否有数据；确认成员确实执行过 `todo_write` |
| 审阅页为空 | ①成员这轮没写过文件；②host 未重启（采集钩子不生效）；③`GET /api/changes?team=<id>` 本身为空 | `curl 'http://127.0.0.1:4317/api/changes?team=<id>'`；确认成员用 `write`/`edit` 而不是只在会话里贴代码 |
| 审阅页少了某个成员写的文件（尤其成员用相对路径 `xxx/file.md`） | 四版前：插件拿不到会话 cwd，相对路径按宿主进程 cwd 解析 → 文件不存在 → 静默跳过 | 已修（`rememberMember` 记 `team.workspace`）；仍缺就查 `dsh-plugin/index.js` `reportFileChange` 是否拿到 `binding.cwd`，以及成员是否把文件写到了嵌套目录（如 `v2/team-e2e-x/v2/`） |
| 点收件箱里的产物没跳到审阅 | 面板旧 bundle；或该条 change 还没落库（`/api/changes` 里没有这个 path） | 重新 build 后强刷；`curl /api/changes?team=<id>` 对照路径（匹配按全路径/相对路径/basename 兜底） |
| 消息一直 queued | host 未重启到含 `markDelivered` 的版本；或该消息是旧版本写的（不回填） | 重启 dsh web 后新建消息再看；旧消息保持原状属预期 |
| todo 勾完了 plan 不完成 | 镜像只在 `todo_write` 成功 + 收工前触发；`todo_write` 失败（`isError`）不镜像 | 看成员那次 `todo_write` 是否报错；等收工再看一次 |
| 消息与回执只有单向，没有成员回复 | ①成员这一轮是纯工具步骤（没有 text 正文）；②还没过 12s 收工窗口；③host 未重启 | 等 15s 刷新；看成员最后一条助手消息是否有文字 |
| 箭头不是绿色 / 没配对 | 回复没落库（同上）；或 `pairMessages` 没匹配上（from/to 方向、sentAt 顺序） | 看 `GET /api/messages?team=<id>` 里是否有 `from=成员, to=lead, kind=response` |
| 面板不跟随 DSH 深浅色 | ①面板是独立窗口打开（无 `window.parent`，回退本地主题属预期）；②DSH 版本没有 `--dsw-alias-bg-base`；③面板旧 bundle | 在 DSH 内打开编排页看；`curl /panel` 确认 bundle 新 |
| 直接访问 `http://127.0.0.1:3080/` 返回 401 | 预期行为（面板与 `/dsh-team-api/*` 才免鉴权） | 无需处理 |

### 工具/环境

| 症状 | 可能原因 | 诊断动作 |
|---|---|---|
| `node tests/run-all.mjs` 长时间无输出 | 某个脚本没退出 | `job_kill` 后加 `--only plugin-` 缩小范围；单跑 `.tmp` 下可疑脚本 |
| fake ctx 测试里监听器互相覆盖 | `handlers` 是「事件名 → 数组」，`agent/status`、`tools/execute` 都有两个监听器 | 用 `ctx.emit(name, ...)`，别假设单值 |

## 7. 验收标准

- 全新环境按 §2 装完，`node tests/run-all.mjs` 通过 **29/29**。
- §4 的 DAG 按依赖顺序执行（01→02→03），三个 md 产物存在。
- §4 的 UI 抽查全部符合（含：顶栏队列按钮、弹层 header 菜单一次点开、成员行右侧计划进度、标题右侧无统计、审阅页头像与窄屏上下布局、消息回执推进、卡片无叠字、DAG 流光、顶栏审批铃铛、收件箱产物跳审阅、用量 M 单位、团队校验计划常驻展开且无「最新发现」、成员行对话按钮、审批弹层分页）。
- 测试产物只出现在仓库根的 `team-e2e-<MMDD>/`，`git status` 里看不到它们（已被 `.gitignore` 忽略）。
- 全程没有未解释的报错；若有报错但最终成功，也要在最终汇报里写清原因（对照 §6）。
- 发现问题时记录：复现步骤、期望/实际、相关文件行号、`team_status` 快照；不要顺手重构。

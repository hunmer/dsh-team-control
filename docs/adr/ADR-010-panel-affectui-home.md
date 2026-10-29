# ADR-010：面板主页 affectui 化——单一 AppShell 侧栏替代横向 Tabs

- 状态：已接受
- 日期：2026-10-29
- 关联：`docs/web-ui-affectui-home-prd.md`（FR-1~FR-7 / AC-1~AC-7）/ ADR-008（面板嵌在 GUI）

## 背景

面板（`src/web-ui`）原本是「sticky 顶栏 + 横向 Tabs」的布局：7 个业务视图（成员看板、依赖 DAG、
时间线、模型路由、权限矩阵、审批队列、消息）平铺在顶部，默认落在 `board`。PRD 要求把它改成
affectui `AgentRun` 的观感——左侧竖向导航 + 主区运行时间线 + 右侧审批面板——并让「主页」成为首屏。

affectui 素材（`default-workspace/affectui-agent-run/src`）是独立 demo：`AgentRun` 内部自带
`AppShell` 与一套 demo 导航（Home/Chat/Runs/Projects…）、演示用侧栏底部（news / Getting started /
Alex Morgan 用户菜单）。PRD 要求**原样复制**这些文件（FR-1），因此所有适配必须发生在
`src/affectui/` 之外。

## 决策

### D1（PRD 建议 C）：全局只挂一个 affectui `AppShell`

- `src/shell.tsx` 是唯一的导航配置源：`TAB_LABELS`（8 个中文标签）、`TAB_ICONS`、`TAB_ORDER`、
  `buildNav(badges)`、`tabFromLabel(label)`，并导出 `ShellChrome`（`nav` / `groups` / `active` /
  `onNavigate` / `header`）。
- 业务视图：`<AppShell {...chrome}><Banner/><main className="flex-1 space-y-4 p-4">…</main></AppShell>`，
  侧栏只有一个、折叠状态在 7 个视图之间保持。
- 主页：`<AgentRun>` 自己会渲染 `AppShell`（`agent-run.tsx:420`）。利用它把未解构的 props
  `{...rest}` **展开在 `nav/groups/active` 之后**这一点，从外部注入同一份 `ShellChrome`：

  ```ts
  const AgentRunShell = AgentRun as unknown as ComponentType<AgentRunProps & ShellChrome>;
  ```

  `AgentRunProps` 本身没有 `nav/groups/active/header`，但 `rest` 会把它们透传给内部 `AppShell`；
  用变量 spread（而不是字面量）绕开 TS 的 excess property 检查。
  > 后续修订（见文末）：用户要求把真实审批接入右栏并移除 Draft，`agent-run.tsx` / `app-shell.tsx`
  > 因此有了受控的最小改动，FR-1 的「逐字节等价」不再适用于这两个文件。
- `nav` 项是原生 `<button>`（`aria-current="page"` + `onClick`），键盘 Tab/Enter 可达，满足 FR-3.1。
- `groups: []`（真值）用于压掉 `AppShell` 默认的 Projects 分组，否则会出现 demo 项目列表。

### D2：`TabName` 增加 `'home'`，但持久化白名单不动

- `store.tsx`：`TabName = (typeof TAB_NAMES)[number] | 'home'`，`TAB_NAMES` 仍是 7 个业务视图。
- `initialState.tab = 'home'`；`loadUiState()` 默认也是 `'home'`，仅当 sessionStorage 里的值命中
  `TAB_NAMES` 才恢复——于是旧用户的 7 个业务视图能原地恢复，而 `home` 写入后不会被「恢复」，
  但默认值本身就是 home，所以刷新不会白屏、也不会回退 board（FR-4）。
- `setTab('home')` 仍走原 `setTab`（不触发额外的数据刷新），视图切换与懒加载逻辑不变（FR-3.4）。

### D3：侧栏即 AppShell 侧栏，TopBar 迁到 header bar

- 删除 `App.tsx` 的横向 `TabsList`；`TopBar` 从 `App.tsx` 抽到
  `src/components/TopBar.tsx`，作为 `chrome.header.actions` 渲染在 affectui 的 48px bar 右侧；
  `header.title` 是当前视图中文标签（FR-3.3）。
- TopBar 保留原有五项能力（团队选择、连接徽章、快照时间、刷新快照、导出报告），并按 48px 高度收紧：
  选择器 `w-44 lg:w-52`、快照 `hidden xl:block`，避免 bar 的 `overflow:hidden` 裁掉按钮（AC-4）。
  > 后续修订：团队选择已移到左侧栏顶部（`TeamSelect` + AppShell 的 `sidebarTop` 插槽），
  > 顶栏只剩连接徽章 / 快照 / 刷新 / 导出 / 主题。
- 侧栏徽标沿用 `App.tsx` 原来的 `useMemo`（成员数 / 待审数 / 未读数）→ `buildNav`，数据源不变（FR-5）。
- affectui 的 demo 侧栏装饰（工作区切换、news、Getting started、用户菜单、bar 里的死 Search 按钮）
  用 `src/index.css` 的外部选择器隐藏；**不删改 vendor JSX**，逐字节等价仍成立（FR-1/AC-6）。

### 主题（FR-6 / AC-5）

affectui 组件自带 `:where(.dark, [data-theme="dark"])` 覆盖，而面板此前从未切换主题（永远浅色）。
新增 `src/theme.ts`：localStorage `dsh-team.panel.theme.v1`，默认 light（与现状一致，不跟随系统），
`applyTheme` 同时设置 `documentElement.classList` / `dataset.theme` / `style.colorScheme`，
让 Tailwind 的 `.dark` 与 affectui 的 `[data-theme="dark"]` 同步。`panel.html` 在首帧前内联读取一次，
避免深色用户看到浅色闪屏。TopBar 右端提供 Sun/Moon 切换。

### `.panel-coss`：coss 变量恢复层

affectui `.ui-as` 重新定义了 `--muted`、`--accent`、`--card`（例如 `--muted:#737373`、`--accent:#4469fc`），
而 coss 主题的 `--color-*` 是 `var(--*)` 的间接映射；于是放进 shell 里的 coss 组件会被染色——实测
`bg-muted` 的 `<code>` 背景变成 `rgb(115,115,115)`，与 `text-muted-foreground` 同色不可读。
在承载 coss 组件的两个容器（TopBar 根节点、业务视图内容）上加 `.panel-coss`，按亮/暗两套把
`--card/--muted/--accent` 恢复成 coss 的取值。这是两个设计系统同页共存时唯一需要显式隔离的地方。

## 备选方案

1. **保留横向 Tabs，只把 board 换成 home**：不满足 FR-3.1（移除横向页签）/ FR-3.2（左侧竖导航）。
2. **直接改 `src/affectui/app-shell.tsx`**（删 demo 侧栏、改 nav 类型）：违反 FR-1「原样复制」，
   也失去 AC-6 的「逐字节等价 / 只允许 import 差异」依据 → 否决。
3. **每个视图各自渲染 `AppShell`**（无全局壳，主页单独一个）：切换视图时侧栏整棵重挂载，折叠状态
   丢失；且 home 自带壳会与业务壳形成两套代码路径 → 否决。
4. **用 Tailwind 基类重置 `.ui-as-*` 盒模型**：PRD 明确列为风险（会破坏 affectui 的内部尺寸），
   只用最小外部选择器隐藏 demo 装饰 → 否决。

## 后续修订：真实审批接入、移除 Draft、团队选择移到侧栏

用户后续要求：「移除 Draft 组件，接入数据到审批组件，切换团队的 select 移动到左侧栏顶部」。
这**显式覆盖了 FR-1 的逐字节约束**，因此对 `src/affectui/` 做三处受控改动（其余 16 个文件仍与源一致）：

1. `app-shell.tsx`：`AppShellProps` 新增 `sidebarTop?: React.ReactNode`，在 `<aside class="ui-as-side">`
   的第一个子节点渲染它（先于 `ui-as-side__head`）。用于放置侧栏顶部的团队切换器。
2. `agent-run.tsx`：
   - 删除 Demo 的 Draft：`AgentRunDraftDef`、`draft` prop、`DRAFT` 常量、`DiffCard` 引用与右栏
     「Draft」区块。DiffCard 只服务这处静态演示；真实数据接入后它没有数据源。
   - 删除「步骤级审批」整套演示机制（`AgentRunApprovalDef`、`StepDef.approval`、`"ask"` 事件、
     `askedSteps`/`decisions`/`pendingAsk`、feed 里的 Review 按钮、第 4 步的 `approval`）。原因：审批
     现在来自真实的 `scopeRequests`，步骤级 demo 审批会与右栏真实卡片重复，且 demo run 会永久停在
     「waiting」而右栏没有对应卡片可点。
   - 新增 `AgentRunApprovalRequest { id, title, description, risk?, label?, details?, status? }` 与
     `approvals` / `onApproveRequest` / `onDenyRequest` props；右栏 header 的计数改为 `approvals.length`，
     卡片循环改为 `approvals.map(...)`，`status` 默认 `pending`。空态仍是 `QuietState`。
3. 新增 `src/components/TeamSelect.tsx`（团队下拉，复用 store 的 `teams`/`teamId`/`selectTeam`），
   通过 `ShellChrome.sidebarTop` → `AppShell.sidebarTop` 渲染在侧栏顶部；`TopBar` 移除该 Select，
   `src/index.css` 用 `.ui-side-team` 把它对齐到原工作区切换器的 28px 行高。
4. `store.tsx` 新增 `decideScope(id, decision)`：`POST /api/scope-requests/{id}/decide`，body
   `{decision, decidedBy:'panel', singleUse:true, ttlSeconds:300}`（批准时），成功后
   `Promise.all([refreshAll(), refreshPermissions()])`。App 侧把 `scopeRequests` 映射成
   `AgentRunApprovalRequest[]`，并在决策前用与「审批队列」一致的 `window.confirm` 文案二次确认。
5. 顺带修正 store 的 SSE 合成帧解析：`decision` / `scope.request` 的字段在 **frame 顶层**
   （不在 `payload` 内，且 `decision` 值是 `APPROVED`/`DENIED` 大写），原来的 toast 会显示
   「决策落盘：? request=?」。现在按 `frame.x ?? payload.x` 读取并归一化大小写，决策 toast 形如
   「决策落盘：lab-alpha 的申请已批准」；App 侧不再重复弹成功 toast（失败才弹）。

## 后续修订二：主页控件统一到 coss

用户要求「主页的有些组件，如 button、select 没有使用 coss 的组件？如有 coss 有则优先使用」。主页里
只剩两个真实缺口，且**都不是「没用 coss」，而是被 affectui 的全局按钮 reset 剥掉了样式**：

1. `agent-run.tsx`：Stop run / Run again 原本是 affectui 自带的 `Button`（与 coss 两套实现），
   Run options 与右侧面板 toggle 是原生 `<button class="ui-as-icon-btn">`。
2. `approval-card.tsx`：Edit / Deny / Approve 是原生 `<button class="ui-ap__btn">`。
3. `app-shell.tsx`：header 模式的侧栏折叠按钮是 `ui-as-icon-btn`。侧栏团队选择 `TeamSelect`
   本来就是 coss `Select`，但同样被 reset 剥成了「无边框纯文本」——用户看到的「select 不像 coss」
   就是它。

改动：三处按钮统一换成 `@/components/ui/button`（icon-only 用 `variant="ghost" size="icon-sm"`，
Stop run 用 `secondary`，Approve 用默认 primary，Deny 用 `outline`），并加 `panel-coss` 以恢复
coss 变量；`src/affectui/button.tsx` 因此在 home 里不再被引用（仍保留文件，业务视图不受影响）。

根因与修复：`app-shell-css.ts` 里的 `:where(.ui-as) button { background:none; font:inherit; … }`
是**无 layer 规则**，优先级高于 Tailwind v4 的 `@layer utilities`，所以 coss Button 的
`bg-primary/h-8/rounded-lg` 全部失效。把选择器收窄为
`:where(.ui-as) button:not([data-slot="button"])`（coss Button 渲染时带 `data-slot="button"`），
`focus-visible` 同理排除，问题消失；计算样式实测 Stop run 恢复 `bg oklab(0 0 0 / 0.04)`、h=28px。

副作用与取舍：该 reset 同样作用于业务视图里的 coss 按钮，收窄后它们也恢复完整样式（例如权限矩阵
每行的「删除」变成红色 destructive 药丸、模型路由的「刷新」有了边框、团队选择器有了输入框外观）。
这正是 coss 的预期形态，且用户反馈的「select 不像 coss」也由此修复，因此保留全局修复而不是只给
home 打补丁；已逐视图目视确认布局无溢出。

## 后果

- **AC-6 实测（已按后续修订更新）**：`src/affectui/` 18 个文件中 **14 个**与源 `diff -q` **零差异**；
  有差异的 4 个是 `app-shell.tsx`（新增 `sidebarTop` 插槽）、`agent-run.tsx`（删 Draft / 删步骤级
  审批 / 接真实审批 props）、`approval-card.tsx`（按钮换 coss）、`app-shell-css.ts`（按钮 reset 收窄），
  差异均记录在上两节。`verbatimModuleSyntax` 下无需 `import type` 改写。
- `npm run build`（`tsc -b && vite build`）通过，产物写入 `src/web`（`panel.html` + hashed css/js，
  仅剩 Vite 的 >500kB chunk 警告）。
- 浏览器实测：首屏 home 三要素齐全；侧栏 8 项、active/`aria-current`/徽标正确；折叠/展开可用；
  刷新后停留当前业务视图（home 刷新后回 home）；刷新快照更新快照时间并 toast；深色/浅色切换在
  home 与业务视图均无割裂；控制台无 error/warn。
- 审批实测：真实 pending `scopeRequest` 出现在主页右栏（标题/成员/domain/target/fallback/风险徽标），
  Approve 后卡片消失、侧栏「审批队列」徽标 1→0、SSE toast 文案正确；Draft 区块不再出现。
- **已知限制**：主页的运行时间线仍是 AgentRun 的英文 demo 数据（FR-8 后续接成员轨迹 / 团队 details），
  只有审批卡接了真实数据；Inter 未引入（落系统字体）；<900px 时 affectui 侧栏变抽屉、不做移动端
  专属布局；`src/components/ui/tabs.tsx` 已无人引用但保留；`src/affectui/diff-card.tsx` 保留未删。
- **回退方式**：`store.tsx` 默认值改回 `'board'` 并删掉 App 的 home 分支即可回到旧布局；
  `src/affectui/` 是纯新增目录，删除不影响其它视图。

## 后续修订（2026-10-29）：主页改为 Plan / Activity / AgentInbox 组合，三者全接真实数据

用户要求：「在主页增加 `affectui-agent-inbox` 组件展示，并接入真实的数据；不要删掉已有的 Plan 和
Activity，它们也要接真实数据」。此前 home 整屏是 `AgentRun`（上一条修订后只剩审批卡是真实的），
本修订取代「主页由 AgentRun 承载」这一形态：

1. **主页不再用 `AgentRun`**。`agent-run.tsx` 声明了 `children` 但从不渲染，且内部自带 `AppShell`，
   无法在其中插入 AgentInbox，也无法避免双壳。现在 `src/App.tsx` 的 home 分支与其它视图走同一条
   `AppShell` 路径，内容由新建的 `src/web-ui/src/views/Home.tsx` 组合：
   - 左列上：`PlanSteps`（vendored）渲染任务级计划清单；
   - 左列下：Activity，按当前任务过滤真实事件流（`/api/events/history`），每条用 `ToolCall`
     呈现 phase/action/target，可展开 Result/Next；
   - 右列：`AgentInbox`（`src/affectui/agent-inbox.tsx` 原样复制），展示真实任务卡与审批。
   `AgentRun` 不再被引用（文件保留，回退时可用）。
2. **计划清单的数据源是 sidecar 的 `todo` 表，不是 `task.plan_json`**。`task.plan_json` 是 worker
   运行时可执行的步骤，改写会破坏调度；`todo` 本来就是人工待办表，此前只缺三件事：`task_id` 关联、
   agent 可调用的工具、面板 UI。本次补齐：
   - `src/db.mjs`：`todo.task_id` 列 + `idx_todo_task` 索引（迁移）；
   - `src/core.mjs`：`setTaskTodos(taskId, items, { by })` 整体替换、`listTodos({ taskId })` 过滤；
     事件 `phase=step, action=task.todo, target="done/total done"` 用于 SSE 刷新。事件流按成员分片，
     **未派发任务写入时跳过事件**（归属不到成员，不能因此 400），任务被派发时由 `task.state` 触发刷新；
   - `src/server.mjs`：`POST /api/tasks/:id/todos`、`GET /api/todos?task=`；
   - `dsh-plugin/index.js`：新增 `team_todo(teamId, taskId, items[{title,status,blockedBy?}], by?)`，
     与内置 `todo_write`（只在会话内、落不到面板）区分，`by` 记录写入者（默认 `lead`）。
3. **收件箱的四个动作全部接真实数据**（组件在任一回调缺失时会本地假动作，因此必须全传）：
   `waiting`（来自 pending scopeRequest）→ Approve/Reject 走 `decideScope`；`failed`（DAG 失败节点）
   → Retry 以原 subject/acceptance/writeScopes/deps 克隆一个新任务（sidecar 没有原地重试路由）；
   `running`/`done` → Open 切换 Plan/Activity 跟随的任务。
4. **状态映射**：`todo.status` → PlanSteps 为 open/blocked → pending、active → active、done → done、
   skipped → skipped（blocked 不是失败，不渲染红色失败态，阻塞原因放 detail）；卡片 lane 由任务
   status + 未决审批推导，`needs` = 该任务有 pending 审批或任务 failed。
5. **测试**：新增 `tests/todo-plan.mjs`（task_id 关联、未派发可写、整体替换、校验、事件进度），
   `tests/routes-smoke.mjs` 增补新路由。`node tests/run-all.mjs` 26/26 通过。
6. **文案与空态**：主页不再输出说明性长段文字。空态统一改用 vendored coss `Empty`
   （`src/web-ui/src/components/ui/empty.tsx`，图标 + 一句标题，必要时一行说明）：
   主页 Plan/Activity 局部空态、`components/Bits.tsx` 的共享 `EmptyState`（Board/DAG/审批/消息/
   模型/权限/时间线全部复用）都走同一套。收件箱去掉了多余的内部 crumb 与每 lane 的英文
   「Nothing here」，改为「暂无」；卡片头部只留标题与 Board/List 切换。
7. **已知限制**：`src/web/` 存的是构建产物，仍留有历史 hashed 资源；inbox 卡片状态文案与 Plan
   「Done in …」来自 vendored 组件的英文/相对时间文案，未做 i18n。

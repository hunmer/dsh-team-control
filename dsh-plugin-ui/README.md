# dsh-team-control-ui

在 **DSH Web UI** 里查看 dsh-team 编排现场的 Client UI 插件（Host half + Client half）。

## 位置

**首选：注册成 `dsh-better-sidebar` 的页签**（id `dsh-team:panel`，order 30，单例）。
装了 `dsh-better-sidebar` 时，入口出现在它的页签列表与 DSH 原生右侧栏的 guide 胶囊里，
**不再占用** `sidebar.footer.action`。`dsh-better-sidebar` 晚于本插件加载时，
用 `ctx.inject(['betterSidebar'], …)` 等它就绪，注册成功后自动撤掉自己的回退入口。

没装时自动回退（两条路径都保留）：
- 有 `sidebarRight` / `sidebarRightTabs`：左侧边栏底部「编排 / Team」按钮
  （`sidebar.footer.action`）→ `ctx.sidebarRight.openTab('dsh-team')` 打开/聚焦右侧栏 Tab；
- 两者都没有：中央面板（`main`）+ `sidebar.panellist` 图标入口。

实现：
- better-sidebar：`ctx.betterSidebar.registerTab({ id:'dsh-team:panel', title, description, icon, order:30, single:true, component })`；
  服务不可用时 `ctx.inject(['betterSidebar'], cb)` 等它可用（cordis 会在服务变化时重跑）。
- 回退 Tab：`ctx.sidebarRightTabs.register({ id:'dsh-team', kind:'dsh-team', priority:'extension' })` +
  内容槽 `sidebar.right.pane.tab`（key = 类型 `id`）+ 入口 `sidebar.footer.action`。

> `betterSidebar` 由 `dsh-better-sidebar` 通过 `ctx.provide('betterSidebar', …)` 发布；
> `sidebarRight` / `sidebarRightTabs` 由 `@deepseek-ai/dsh-client-ui-sidebar-right` 通过
> `ctx.reflect.provide` 提供，**不在** `cordis_inspect_query` 的 Service 目录里；
> 契约见各包 `lib/types/client/service.d.ts` 与 `tab-registry.d.ts`。

页签 / Tab 内嵌 sidecar 自带 Web 面板（iframe），**不再提供** DSH 原生渲染的「精简版」。
面板内容与 `http://127.0.0.1:4317/panel` 完全一致：成员看板（Trace 瀑布）/ 依赖 DAG / 时间线 /
权限矩阵 / 审批队列 / 消息 / 报告导出，SSE 实时。

iframe 走同源代理：`/dsh-team-api/panel?api=/dsh-team-api&embed=1`，
面板据此把所有请求前缀到 `/dsh-team-api/api/**`、SSE 到 `/dsh-team-api/api/events`，
`panel.html` 里的绝对资源 `/panel/assets/*` 由 Host 的另一条 `/panel` 前缀路由转发。

## 会话输入框：团队卡片（affectui AgentFindings 移植）

除了左侧入口，本插件还会在会话输入框「权限控件右侧」挂一个**团队卡片入口**。它只认「本会话派出去的团队成员」
（`sessions` 里 `parentId = 本会话` 且 `origin = 'subagent'` 的会话），普通子代理会话不会出现。
没有团队时组件返回 `null`，不会在输入框工具行留空白。

两个 slot 各管一半：

| slot | id / order | 内容 |
|---|---|---|
| `conversation.input.left`（输入框权限控件右侧） | `dsh-team:members` / 5 | 胶囊按钮：团队名 + 「运行中 n/m」+ 严重/警告计数 |
| `shell.overlay`（frame-wide 浮层） | `dsh-team:findings` / 30 | 展开后的 `AgentFindings` 卡片（成员进度 + 最新发现，按钮下方放不下时翻到按钮上方） |

- 有成员在跑时首次自动展开；用户点过胶囊或关闭按钮后不再自动改动（`pinned`），
  否则 4s 一次的轮询会把用户手动展开的卡片又收回去。
- 轮询 `GET /dsh-team-api/api/status` + `/teams` → 用 `member.agentSessionId` 反查团队，
  再取 `/tasks?team=` 与 `/events/history?team=&limit=40` 合成卡片数据（4s 一次）。
- 发现条目 = 成员 blocker + 事件流：`FAIL*` 记为严重、`DENIED`/`CONFLICT` 记为警告、其余为提示，
  最新在前；点条目用 DSH **内置**的 `subagentchat` 页把该成员对话开在右侧栏：

```text
ctx.sidebarRight.openResource('dsh-resource://subagentchat/session/<childSessionId>?parent=<parentSessionId>&mode=continuable',
  { kind: 'subagentchat', preferNewPane: true })
```

- 地址优先由 `ctx.sessions.subagentAddress(childSessionId)` 解析，拿不到时退化为
  `{ parent: 当前会话, mode: 'continuable' }`；没有 `sidebarRight` 服务时退回
  `ctx.uiWorkspace.openSession(address)`。
- 抗抖动：连续 3 次拿不到快照才收起入口，单次失败只把胶囊标成虚线（`data-dsh-team-stale`）；
  轮询请求带递增 token，**旧请求的迟到响应不会覆盖新状态**（否则会出现卡片闪一下就消失）。
- 卡片视觉与 `affectui/agent-findings` 一致（CSS 内联进 `client.js`，类名 `ui-afc__*`）。
- **浮层贴着胶囊按钮弹出**：卡片虽然挂在 `shell.overlay`（全局浮层），但用
  `data-dsh-team-pill` 取按钮的 `getBoundingClientRect()`，定位到按钮正下方
  （`top = bottom + 8`、`right = 视口宽 - 按钮右边`），并在 `resize`/`scroll` 时重算；
  卡片高度上限也按按钮下方剩余空间算（`--dsht-dock-max`）。量不到按钮时才退回 CSS 兜底位置。
- **样式只在 `apply()` 里注入一次**（`ensureStyles()` → `<head>` 里的 `#dsh-team-ui-styles`），
  不随组件树渲染 `<style>`：否则团队面板页签没挂载时胶囊/浮层会完全没样式，卡片里还会多出一段
  固定文本。样式节点用 `getElementById` 去重，热替换不会叠加。
- **配色绑定宿主主题 token**，不靠 `.dark` / `[data-theme]` 类名：`.dsht-afc-dock .ui-afc`
  把 `--ui-afc-card` 映射到 `--dsw-alias-bg-overlay`、文字用 `--dsw-alias-label-primary/secondary`、
  描边用 `--dsw-alias-border-l1/l2`、严重/警告用 `--dsw-alias-state-error-primary/state-warn-primary`，
  其余层次用 `color-mix()` 从这些 token 派生。亮暗切换由宿主变量即时生效，卡片里没有硬编码色值。
- 文案统一走 `localizer(t)`：宿主字典缺 key 时 `t` 会把 key 原样返回（界面上就是一行永远不变的
  `status_xxx`），这层兜底成本地 `DICT.zh/en` 并自己补 `{var}` 插值；未知成员状态收敛到
  `status_unknown`（本地文案「未知状态」），且未知状态不再被当成「已完成」（不会出现 1/1 全绿）。
- **磨砂玻璃背景**：卡片底色是 `color-mix(… --dsw-alias-bg-overlay 72%, transparent)` 配
  `backdrop-filter: blur(24px) saturate(170%)`，标题条 `blur(14px)`；`@supports not` 里退回
  不透明底色，宿主不支持 `backdrop-filter` 时仍可读。

这与 `dsh-better-sidebar` 的「侧边对话」是同一套机制：better-sidebar 打开子代理对话时也是
`openResource(subagentChatAddress(address), { kind: 'subagentchat' })`，只是它的入口在它自己的
侧栏里；本插件把入口搬到了**当前对话输入框的权限控件右侧**，并只筛团队成员。

## 数据路径（为什么需要 Host 代理）

浏览器无法安全直连 sidecar：

| 问题 | 处理 |
|---|---|
| `:3080` → `:4317` 跨源 | Host 注册同源前缀路由 `/dsh-team-api/**`（数据）与 `/panel/**`（面板本体+静态资源） |
| sidecar token 不能下发浏览器 | 代理在 Host 侧注入 `Authorization: Bearer <token>`；网页版因此不需要 hash token（`?embed=1`） |
| 需要实时流 | `/dsh-team-api/api/events` 透传 sidecar 的 SSE |

信任模型：该前缀路由与 DSH Web UI 一样只监听本机回环地址；代理**只接受回环来源**
（`127.0.0.1 / ::1`，否则 403 `E_LOCAL_ONLY`），并且 **sidecar token 不出 Host**。
若把 DSH 暴露到远端，这条路由不会跟随鉴权链，回环限制会挡住它；如仍要远程使用，
请在外层加访问控制而不是放宽这里。

## 安装 / 卸载

```text
plugin_manager(action: "install_bundle", target: "C:\\...\\agent-team-plugin\\dsh-plugin-ui")
dsh plugin --profile web remove dsh-team-control-ui
```

配置（`cordis.patch.yml`）：`baseUrl`、`home`、`autoStart`、`startTimeoutMs`。
`autoStart: true` 时若 sidecar 未运行，页面第一次请求会自动拉起它。

## 自测

```bash
node dsh-plugin-ui/test-host.mjs    # Host half：路由注册 + 同源代理 + SSE 透传 + 503 错误路径
node tests/plugin-client.mjs        # Client half：better-sidebar 页签 / 回退入口 / 晚到切换（假宿主）
node tests/ui-member-strip.mjs      # 输入框团队卡片：子会话筛选 / 计数 / 浮层卡片 / 轮询乱序保护
```

## 已知限制

- 面板是 iframe，不继承 DSH 主题（沿用面板自带的深浅色与配色）。
- 视觉渲染需在浏览器里人工确认；已验证 JS 语法、Slot 注册、同源代理与数据契约。
- 权限矩阵为只读展示；编辑规则仍走 `team_scope` 工具或独立面板。

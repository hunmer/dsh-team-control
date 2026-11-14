# dsh-team-control-ui

在 **DSH Web UI** 里查看 dsh-team 编排现场的 Client UI 插件（Host half + Client half）。

## 位置

**左侧栏始终有两个入口**：「编排」`id=dsh-team`（order 20）与「任务看板」`id=dsh-team-board`
（order 21），各自对应一个中央主面板（`main` keyed slot，点击时由 sidebar 调 `layout.selectPanel`）。
这两个入口**与右侧栏页签 / better-sidebar 页签并存**，装没装扩展都始终注册。

团队创建时**自动把「编排」页推到右侧栏一次**（每会话一次，用户收起后不再打扰）；聊天框上方
常驻一条团队进度条，成员横向铺开，点成员 chip 才弹出该成员的详情浮层（团队 id 仍在后台解析好，
点开就是本会话的团队）。

同时还会注册（都是并存关系，不替代左侧栏入口）：
- 原生右侧栏 Tab：`sidebarRightTabs.register({ id:'dsh-team' | 'dsh-team-board', kind, priority:'extension' })`
  + 内容槽 `sidebar.right.pane.tab`（key = 类型 `id`）；
- 装了 `dsh-better-sidebar` 时额外注册 `dsh-team:panel`（order 30）与 `dsh-team:board`（order 31）页签，
  服务晚到时用 `ctx.inject(['betterSidebar'], …)` 补注册。

实现：
- 左侧栏：`main` 槽注册 `key='dsh-team' / 'dsh-team-board'`，`sidebar.panellist` 槽用同一个 id
  注册图标行（label 由字典 `side_nav` / `board_nav` 给出）；
- better-sidebar：`ctx.betterSidebar.registerTab({ id:'dsh-team:panel', title, description, icon, order:30, single:true, component })`；
  服务不可用时 `ctx.inject(['betterSidebar'], cb)` 等它可用（cordis 会在服务变化时重跑）。

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

## 聊天框上方：团队进度条 + 成员详情浮层（affectui AgentFindings 移植）

除了左侧入口，本插件还会在聊天框**上方**挂一条团队进度条（宽度随内容自适应，最宽 80%）。它只认「本会话派出去的团队成员」
（`sessions` 里 `parentId = 本会话` 且 `origin = 'subagent'` 的会话），普通子代理会话不会出现。
没有团队时组件返回 `null`，不会在 composer 上方留空白。

容器与浮层各管一半：

| slot | id / order | 内容 |
|---|---|---|
| `conversation.input.dock`（composer 卡片上方） | `dsh-team:members` / 40 | 自适应宽度（最宽 80%）进度条：团队名 + 状态点/运行中数量（完整 n/m 见 tooltip）+ 严重计数 + 成员 chip 横向铺开 + 右侧打开面板/停止 |
| `shell.overlay`（frame-wide 浮层） | `dsh-team:findings` / 30 | 点成员 chip 后弹出的单成员详情（`AgentFindings` 成员行 + 常驻展开的步骤清单），贴着被点开的 chip 定位 |

- 进度条在团队存在时常驻，不占聊天记录空间；4s 一次的轮询只刷新数据，不改用户点开的成员。
- 每个成员一个 chip：模型品牌图标（识别不出品牌时回退成员名首字母）、名字、
  Todo 进度（有步骤清单用 `done/total`，否则百分比）；状态红点
  （running 蓝色呼吸 / failed 红 / done 绿 / idle 灰）压在模型图标的右下角。
  红点同时参考 DSH 会话的实时运行状态：手动给已停止成员发消息也会立即亮成运行中，
  不需要等下一轮快照。chip 不再画迷你进度条。
- 点 chip 弹出该成员详情，再点同一个收起；点另一个直接切换（`pinned` 保证轮询不弹开）；Esc 也可收起。
- 进度条右侧两个动作：打开面板（新窗口）、停止团队（二次确认弹窗）。
- 轮询 `GET /dsh-team-api/api/status` + `/teams` → 用 `member.agentSessionId` 反查团队，
  再取 `/tasks?team=` 与 `/events/history?team=&limit=40` 合成卡片数据（4s 一次）。
- 严重计数来自成员 blocker + 事件流：`FAIL*` 记为严重，在标题旁显示；警告不再单独标记；
  点成员行右侧的消息图标用 DSH **内置**的 `subagentchat` 页把该成员对话开在右侧栏，
  并同时收起成员详情浮层：

```text
ctx.sidebarRight.openResource('dsh-resource://subagentchat/session/<childSessionId>?parent=<parentSessionId>&mode=continuable',
  { kind: 'subagentchat', preferNewPane: true })
```

- 地址优先由 `ctx.sessions.subagentAddress(childSessionId)` 解析，拿不到时退化为
  `{ parent: 当前会话, mode: 'continuable' }`；没有 `sidebarRight` 服务时退回
  `ctx.uiWorkspace.openSession(address)`。
- 抗抖动：连续 3 次拿不到快照才收起进度条，单次失败只把进度条标成虚线（`data-dsh-team-stale`）；
  轮询请求带递增 token，**旧请求的迟到响应不会覆盖新状态**（否则会出现卡片闪一下就消失）。
- 成员详情视觉与 `affectui/agent-findings` 一致（CSS 内联进 `client.js`，类名 `ui-afc__*`）。
- **浮层贴着被点开的成员 chip 弹出**：卡片虽然挂在 `shell.overlay`（全局浮层），但用
  `data-dsh-team-chip="<teamId>:<memberId>"` 取 chip 的 `getBoundingClientRect()`，定位到 chip
  正下方（`top = bottom + 8`、`right = 视口宽 - chip 右边`），并在 `resize`/`scroll` 时重算；
  卡片高度上限也按 chip 下方剩余空间算（`--dsht-dock-max`）。量不到 chip 时退回整个进度条
  （`data-dsh-team-bar`），再量不到才用 CSS 兜底位置。
- **样式只在 `apply()` 里注入一次**（`ensureStyles()` → `<head>` 里的 `#dsh-team-ui-styles`），
  不随组件树渲染 `<style>`：否则团队面板页签没挂载时进度条/浮层会完全没样式，卡片里还会多出一段
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
侧栏里；本插件把入口放在了**当前聊天框上方的团队进度条里**，并只筛团队成员。

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

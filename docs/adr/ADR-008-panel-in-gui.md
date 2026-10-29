# ADR-008：面板进 DSH GUI 的方式（设置页 Slot + Host 同源代理，不用 iframe）

- 状态：已接受
- 日期：2026-10-28
- 关联：FR-7 / AC-10 / D-9 / AD-1

## 背景

PRD D-9 写的是「独立端口，可选 iframe 嵌入 DSH GUI」。实现时发现两个硬约束：

1. **DSH 插件规范禁止 Host 提供 HTML 再 iframe 嵌入**：iframe 文档拿不到 host 的
   主题 token、明暗切换和 `ctx.locale`，视觉上必然与宿主割裂。UI 必须用 React 组件
   渲染在 Slot 里。
2. **浏览器不能直连 sidecar**：`:3080` → `:4317` 跨源会被 CORS 拦；更关键的是
   sidecar token（D-11）不应下发到浏览器。

## 决策

- 新增独立 bundle [`dsh-plugin-ui`](../dsh-plugin-ui/)，与工具 bundle 解耦：
  - **Client half** 在**右侧边栏**注册一个 Tab 类型：
    `ctx.sidebarRightTabs.register({ id: 'dsh-team', kind: 'dsh-team', priority: 'extension' })`，
    内容槽 `sidebar.right.pane.tab`（key = 类型 `id`）。入口是**左侧边栏底部按钮**
    （`sidebar.footer.action`）→ 点击调 `ctx.sidebarRight.openTab('dsh-team')` 打开右侧栏 Tab，
    与「文件 / 终端 / 指南」等内置 Tab 同机制。
  - 这两个服务由 `@deepseek-ai/dsh-client-ui-sidebar-right` 通过 `ctx.reflect.provide` 提供
    （`sidebarRight` / `sidebarRightTabs`），不在 inspect 的 Service 目录里；服务不可用时
    自动回退到中央面板（`main` + `sidebar.panellist`）。
  - **Tab 内默认「网页版」**：iframe 直接加载 sidecar 自带面板 `/panel`，内容与
    `:4317/panel` **完全一致**（7 视图 + SSE + 消息 + 报告导出），单一实现、零漂移。
    2026-10-29 更新：用户要求移除 DSH 原生渲染的「精简版」，该分支与 5 个视图已从
    `dsh-plugin-ui/client.js` 删除，Tab 内只保留 iframe。
  - **Host half** 在 DSH 的 `webServer` 上注册两条同源前缀路由：
    `/dsh-team-api/**`（透传到 sidecar 根，即数据与 SSE）与 `/panel/**`（面板本体与静态资源，
    因为 `panel.html` 用绝对 `/panel/app.js|css` 引用）；代理在 Host 侧注入
    `Authorization: Bearer <token>`，浏览器永远拿不到 token。
  - 两条路由**只接受回环来源**（非 `127.0.0.1/::1` 返回 403 `E_LOCAL_ONLY`），
    因为 `webServer` 的路由不在 DSH 自身 `/api` 鉴权链上。
  - 面板本体为此加了同源嵌入模式：`?api=<base>&embed=1` 时所有请求/SSE 前缀到该 base，
    且不再要求 hash token（token 由 Host 注入）。
- 独立端口面板 `{baseUrl}/panel` **保留**：不带参数时行为不变，适合不开 DSH 时使用。

### 承载方式的演进（为什么最终是右侧栏 Tab）

1. `settings.plugins.tab`：入口埋在「设置 → 插件」里，用户实测找不到。
2. `shell.overlay` 抽屉：能显示但**浮在应用之上**，被否。
3. `main` 中央面板：正式扩展点（与 Plugins/Schedules 同级），但用户要的是**侧边栏**。
4. `sidebar.right.pane.tab`：一开始判为不可行（它只是内容槽，Tab 记录归 sidebar-right 包）。
   实际上该包暴露了 `sidebarRight`（`openTab/close/openTabIn`）与 `sidebarRightTabs`
   （`register` 类型）两个服务——契约在 `lib/types/client/service.d.ts` 与
   `tab-registry.d.ts`。注册类型 + 内容槽 + `openTab(kind)` 即可，无需自己创建 Tab 记录。

### 关于 iframe 的取舍（有意偏离插件规范建议）

插件规范建议 UI 用 React 组件渲染在 Slot 里，不要 Host 提供 HTML + iframe（拿不到主题 token）。
最初因此用 React 重写，但实测出现**双实现漂移**（视图数量、轮询 vs SSE、消息/报告缺失），
用户明确要求「直接用 web 的页面」。最终取「iframe 复用同一份页面」：
- 收益：内容 100% 一致、只有一份 UI 实现、SSE 实时性保留、token 不下发。
- 代价：iframe 不继承 DSH 主题/locale，沿用面板自有配色；跨文档交互（如跳转会话）不可用。
- 2026-10-29：按用户要求移除「精简版」兜底，UI 只保留 iframe 一份实现。

## 后果

- ✅ 面板在**右侧栏 Tab** 内停靠，与文件/终端等内置 Tab 同机制；浏览器永远看不到 sidecar token。
- ⚠️ iframe 不继承 DSH 主题（沿用面板配色）；这是单实现换来的已知代价（「精简版」已移除）。
- ✅ 工具与界面分成两个可用独立安装/卸载的 bundle，互不影响。
- ⚠️ 视觉渲染未能在本环境用浏览器验证（无浏览器控制）：已验证 JS 语法、Slot 注册
  （`Slots.listSubTree` 出现 `id: dsh-team, active: true`）、同源代理与全部数据端点、
  无外部 import、无字面色值。**不能据此声称视觉正确**。
- ⚠️ `webServer` 路由不继承 DSH 鉴权：靠回环限制兜底。若将来 DSH 以反向代理远程暴露，
  需在外层拒绝 `/dsh-team-api`（或卸载该 bundle）。
- ⚠️ 权限矩阵只读；编辑规则仍走 `team_scope` 工具或独立面板。

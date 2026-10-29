# @local/dsh-team-ui

在 **DSH Web UI** 里查看 dsh-team 编排现场的 Client UI 插件（Host half + Client half）。

## 位置

**右侧边栏的 Tab**（与「文件 / 终端 / 指南」同一种承载方式）。入口是**左侧边栏底部的
「编排 / Team」按钮**（`sidebar.footer.action`）；点击调 `ctx.sidebarRight.openTab('dsh-team')`
打开/聚焦该 Tab。关闭就是普通 Tab 的关闭。

实现：
- Tab 类型：`ctx.sidebarRightTabs.register({ id:'dsh-team', kind:'dsh-team', priority:'extension' })`
- Tab 内容：`sidebar.right.pane.tab`（key = 类型 `id`）
- 服务不可用时自动回退到中央面板（`main` + `sidebar.panellist`）

> 这两个服务由 `@deepseek-ai/dsh-client-ui-sidebar-right` 通过 `ctx.reflect.provide` 提供
> （`sidebarRight` / `sidebarRightTabs`），**不在** `cordis_inspect_query` 的 Service 目录里；
> 契约见该包 `lib/types/client/service.d.ts` 与 `tab-registry.d.ts`。

右侧栏 Tab 内嵌 sidecar 自带 Web 面板（iframe），**不再提供** DSH 原生渲染的「精简版」。
面板内容与 `http://127.0.0.1:4317/panel` 完全一致：成员看板（Trace 瀑布）/ 依赖 DAG / 时间线 /
权限矩阵 / 审批队列 / 消息 / 报告导出，SSE 实时。

iframe 走同源代理：`/dsh-team-api/panel?api=/dsh-team-api&embed=1`，
面板据此把所有请求前缀到 `/dsh-team-api/api/**`、SSE 到 `/dsh-team-api/api/events`，
`panel.html` 里的绝对资源 `/panel/assets/*` 由 Host 的另一条 `/panel` 前缀路由转发。

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
plugin_manager(action: "remove_bundle", target: "@local/dsh-team-ui")
```

配置（`cordis.patch.yml`）：`baseUrl`、`home`、`autoStart`、`startTimeoutMs`。
`autoStart: true` 时若 sidecar 未运行，页面第一次请求会自动拉起它。

## 自测

```bash
node dsh-plugin-ui/test-host.mjs   # 路由注册 + 同源代理 + SSE 透传 + 503 错误路径
```

## 已知限制

- 面板是 iframe，不继承 DSH 主题（沿用面板自带的深浅色与配色）。
- 视觉渲染需在浏览器里人工确认；已验证 JS 语法、Slot 注册、同源代理与数据契约。
- 权限矩阵为只读展示；编辑规则仍走 `team_scope` 工具或独立面板。

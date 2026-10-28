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
  - **Client half** 在**左侧边栏底部**（`sidebar.footer.action`，Settings 旁）注册「编排 / Team」
    入口按钮；点击后在 `shell.overlay` 里滑出右侧抽屉，承载 5 个视图：成员看板 / DAG /
    事件时间线 / 权限矩阵 / 越界审批。
  - **Host half** 在 DSH 的 `webServer` 上注册同源前缀路由 `/dsh-team-api/**`，
    代理到 sidecar 并在 Host 侧注入 `Authorization: Bearer <token>`；SSE 直接透传。
  - 该路由**只接受回环来源**（非 `127.0.0.1/::1` 返回 403 `E_LOCAL_ONLY`），
    因为 `webServer` 的路由不在 DSH 自身 `/api` 鉴权链上。
- 独立端口面板 `{baseUrl}/panel` **保留**：它是零依赖单文件实现，适合不开 DSH 时使用。

### 为什么不是右侧栏 Tab、也不是设置页

- 客户端没有「创建右侧栏 Tab」的公开接口：`sidebar.right.pane.tab` 只接收「Tab 类型为 kind 的
  内容」，而 Tab 记录归 `dsh-better-sidebar` 所有，插件无法自行创建。
- 先试过 `settings.plugins.tab`，但入口埋在「设置 → 插件」里，用户实测反馈找不到。
- 因此用**侧边栏入口 + overlay 抽屉**：入口在侧边栏一眼可见，面板覆盖在应用之上但可关闭；
  `shell.overlay` 本身就是「frame-wide floating layer」，且层本身穿透、抽屉自己接管 pointer events。

## 后果

- ✅ 面板真正嵌进 GUI，跟随主题/明暗/locale；浏览器永远看不到 sidecar token。
- ✅ 工具与界面分成两个可用独立安装/卸载的 bundle，互不影响。
- ⚠️ 视觉渲染未能在本环境用浏览器验证（无浏览器控制）：已验证 JS 语法、Slot 注册
  （`Slots.listSubTree` 出现 `id: dsh-team, active: true`）、同源代理与全部数据端点、
  无外部 import、无字面色值。**不能据此声称视觉正确**。
- ⚠️ `webServer` 路由不继承 DSH 鉴权：靠回环限制兜底。若将来 DSH 以反向代理远程暴露，
  需在外层拒绝 `/dsh-team-api`（或卸载该 bundle）。
- ⚠️ 时间线暂用 2s 轮询；Host 代理已支持 SSE，后续可换 `EventSource` 获得真正推送。
- ⚠️ 权限矩阵只读；编辑规则仍走 `team_scope` 工具或独立面板。

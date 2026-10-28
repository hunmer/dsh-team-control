# @local/dsh-team-ui

在 **DSH Web UI** 里查看 dsh-team 编排现场的 Client UI 插件（Host half + Client half）。

## 位置

**左侧边栏底部、Settings 旁边的「编排 / Team」按钮**（`sidebar.footer.action`）。
点击后在右侧滑出抽屉面板（`shell.overlay`，Esc 或 ✕ 关闭），不遮挡左侧会话列表。
侧边栏展开时显示图标 + 文字，56px 轨道态只显示图标。

> 为什么不是右侧栏 Tab：客户端没有「创建右侧栏 Tab」的公开接口——`sidebar.right.pane.tab`
> 只接收「Tab 类型为 kind 的内容」，Tab 记录归 `dsh-better-sidebar` 所有；而 `settings.plugins.tab`
> 又埋在设置里不好找。因此用「侧边栏入口 + frame-wide 浮层抽屉」：入口在侧边栏，面板覆盖在
> 应用之上但可关，符合 Slot 规范（overlay 本身穿透，抽屉自己接管 pointer events）。

5 个视图：成员看板 / DAG / 事件时间线 / 权限矩阵 / 越界审批。数据每 2s 刷新，可手动刷新。

## 数据路径（为什么需要 Host 代理）

浏览器无法安全直连 sidecar：

| 问题 | 处理 |
|---|---|
| `:3080` → `:4317` 跨源 | Host 注册同源前缀路由 `/dsh-team-api/**` |
| sidecar token 不能下发浏览器 | 代理在 Host 侧注入 `Authorization: Bearer <token>` |
| 需要实时流 | `/dsh-team-api/events` 透传 sidecar 的 SSE |

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

- 时间线用 2s 轮询（不是 SSE 订阅）：Host 代理已支持 SSE，下一版可切换为 `EventSource`。
- 视觉渲染无法在本环境用浏览器验证；已验证 JS 语法、Slot 注册、同源代理与数据契约。
- 权限矩阵为只读展示；编辑规则仍走 `team_scope` 工具或独立面板。

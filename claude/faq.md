# FAQ

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

**Q：`npm start` 后没有输出，也没端口？**
sidecar 的 ready 横幅是 **stdout 第一行单行 JSON**。若前面有任何 `console.log`（含第三方警告），解析就失败。看 `home/logs/`，并用 `node bin/dsh-team.mjs up --foreground` 前台复现。

**Q：`team_*` 工具全部报连接失败？**
1. `cat ~/.dsh/team/run/sidecar.json` 看 pid 是否还活着；2. `node bin/dsh-team.mjs down` 再 `up`；3. 检查插件 `baseUrl` 与 sidecar 实际端口（`DSH_TEAM_PORT`/`--port`）是否一致；4. `autoStart:false` 时没人拉起它。

**Q：`runner up` 报 `E_DENIED`，但策略里明明有 allow？**
求值顺序是 **显式 deny > 未用 grant > 显式 allow > 默认拒绝**。检查是否有 team 级 deny 覆盖、`match` 目标是否 normalize 过（`normalizeTarget`/`matchTarget`）、`expires_at` 是否已过。用 `GET /api/permission-matrix` 看合并结果。

**Q：成员一直 `running`，任务不往下走？**
先看租约：`member_state.lease_until`。租约过期但没被收敛说明进程被强杀且没走 `interrupt()`；重启 sidecar 会让 `recoverAll()` 置 `interrupted` 并把任务退回 `ready`。若租约新鲜，就是成员真的还在干——看 `GET /api/steps?member=` 和 `logs`。

**Q：`/api/status` 返回 `degraded:true`？**
`member_state.seq` 与 `max(event.seq)` 不一致，说明有人绕过 `EventStore.append()` 直接改了状态表。跑 `rebuild()` 重投影，并修掉直写点（违反 C2）。

**Q：`/panel` 打开是 `panel not built yet`？**
`src/web/panel.html` 不存在。`cd src/web-ui && npm install && npm run build`。构建产物只提交被 `panel.html` 引用的两个 assets。

**Q：GUI 里页签没出现？**
`client.js` 注册顺序是 better-sidebar 页签 → `sidebarRightTabs` + `sidebar.footer.action` → main panel。宿主版本没有 better-sidebar 会走回退分支；若全无，检查 `package.json` 的 `dsh.client.inject` 与 `dsh.bundle.patch`，以及 Host half 是否 `inject(['webServer'])` 成功。

**Q：面板请求 401/拿不到 token？**
浏览器**永远不该**有 token。iframe 用 `?api=/dsh-team-api`，由 `dsh-plugin-ui` 的 `proxyHandler` 补 Authorization。若直连 sidecar 并使用 `/api`，服务端当前不校验 token，401 说明你对面的不是这个版本。

**Q：`agent` 团队被派了 worker 进程？**
`runtime !== 'agent'` 才会走 worker 派发循环。检查 `team.runtime` 是否真的写成 `agent`，以及迁移是否补上 `team.runtime` 列（`db-migration` 测试覆盖）。

**Q：`interrupt` 之后还有 `running` 残留？**
违反 C5。`interrupt()` 必须同步写 `member.status=interrupted` + `agent.interrupt` 事件 + 在途任务 `paused`，**提交后**才调 `subagents.interrupt`。若在事务里杀了会话，就会出现「已死但状态还在跑」。

**Q：`npm test` 里某条 AC 偶发失败？**
AC 全部是真实子进程 + 真实端口。失败时脚本**保留临时目录并打印路径**，进那个目录看 `team.db`（`sqlite3 team.db '.tables'`）与 `logs/`。抖动多半是 `waitFor` 超时太短。

**Q：能新增 npm 依赖吗？**
后端不能（ADR-001：零依赖是为了不冲击宿主 profile 解析）。面板侧依赖走 `src/web-ui/package.json`，但 `components/ui/` 是 coss 同步产物，手改会被覆盖。

**Q：怎么快速看整体在干什么？**
`npm run demo`（3 成员 + DAG + 审批 + 中断恢复），或 `node bin/dsh-team.mjs status <teamId>` / 打开 `/panel` 的 Timeline 视图。

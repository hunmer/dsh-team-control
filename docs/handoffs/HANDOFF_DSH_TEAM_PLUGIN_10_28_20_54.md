# Handoff: dsh-team 编排插件（sidecar + 两个 DSH 插件）

**Created:** 2026-10-28 20:54 (Asia/Shanghai)
**Branch:** `master`（commit `865a0ff fix`，`2b878dc init`）
**Repo:** `C:\Users\Administrator\Documents\deepseek-harness\agent-team-plugin`
**Git 状态：** 7 改 + 1 删 + 1 未跟踪（`git status`）：

```
 M README.md
 M docs/adr/ADR-008-panel-in-gui.md
 M dsh-plugin-ui/README.md
 M dsh-plugin-ui/client.js
 M dsh-plugin-ui/index.js
 M dsh-plugin-ui/test-host.mjs
 M src/web/app.js
 D _sse-check.mjs            # 顺手清理的遗留探针（已跟踪，随提交生效）
?? docs/handoffs/            # 本 handoff
```

---

## Summary

按冻结的 PRD v1.0 完成了 dsh-team 编排 sidecar（Node 24 + `node:sqlite`，零依赖）与两套 DSH 插件：工具面（8 个 `team_*` 工具）和界面（右侧栏 Tab）。AC-1~AC-13 全绿（13/13），旧 Agent Teams 已关闭。服务当前在跑（DSH Host 拉起），演示团队里有一条待审批可供点验。剩余工作主要是浏览器端视觉核验、几个已知缺陷的收尾，以及决定是否让 sidecar 脱离插件生命周期。

---

## Work Completed

### Changes Made

- [x] sidecar M1：`event` 只增流 + `member_state` 物化（C2）、DAG 调度、WorkerRunner、MessageBus、REST + SSE
- [x] sidecar M2：四域 PermBroker（C1/C3）、`scope_request → decision → 单次 grant`（C4）、interrupt 同步落库（C5）、崩溃恢复、僵尸检测
- [x] sidecar M3：`src/web/` 独立面板（7 视图 + SSE）、CLI 六子命令、审计报告导出
- [x] 测试：`tests/ac-*.mjs` 13 条 + `tests/lib/harness.mjs`；另有 `routes-smoke`、`panel-contract`、`cli-smoke`
- [x] 文档：`README.md`、`docs/CONTRACT.md`、`docs/adr/ADR-001..008`
- [x] Demo：`demo/run-demo.mjs`（3 成员 + DAG + 审批 + interrupt/resume）、`demo/seed.mjs`（给运行实例灌数据，幂等）
- [x] DSH 工具插件 `@local/dsh-team-plugin`（`dsh-plugin/`）：8 工具 + autoStart + sidecar 生命周期
- [x] DSH UI 插件 `@local/dsh-team-ui`（`dsh-plugin-ui/`）：Host 同源代理 + 右侧栏 Tab
- [x] AD-4 迁移：`@deepseek-ai/dsh-experimental-agent-team-profile` 已从 `web` profile 的 bundles 移除
- [x] UI 承载方式演进完成：settings 页 → overlay 抽屉 → 中央 `main` 面板 → **右侧栏 Tab**（当前）

### Key Decisions

| Decision | Rationale | Alternatives |
|---|---|---|
| 零依赖 + 纯 ESM JS（Node ≥22.15） | 离线/无构建，`node:sqlite` 足够快 | better-sqlite3（需编译）、TypeScript（需构建） |
| Worker 进程级强制（`--permission` + `module.registerHooks` + 全局中和） | Node 24 无 net 权限门，必须靠模块白名单兜 net | OS 沙箱（P1，未做） |
| `member.status` 只存 `member_state`（事件可重建） | C2；租约放 `member_runtime` 避免污染投影 | PRD 原表结构（会漂移） |
| 并发写 CAS + 退避重试，无路径租约 | 零丢更新已达成，租约成本高 | 路径租约（ADR-004 记录） |
| 建任务 settle 200ms + 派发前重求值 | 修 Demo 实测的「B1 比 A 早 243ms 启动」竞态 | 内联 deps（已支持） |
| UI 复用 `src/web/` 面板（iframe）而非重写 | 单一实现、7 视图/SSE 不漂移 | React 重写（保留为「精简版」） |
| Tab 用 `sidebarRightTabs.register` + `sidebarRight.openTab` | 与 Files/Terminal 同机制，真正停在右侧栏 | overlay（浮层，已否）、`main` 中央页（非侧边栏） |

---

## Files Affected

### Created（本会话）

- `src/{db,eventstore,policy,broker,scheduler,runner,bus,sse,server,core,util}.mjs`、`src/worker/worker.mjs`、`bin/dsh-team.mjs`
- `src/web/{panel.html,app.js,app.css,dev-mock.mjs}`
- `tests/`（harness + 13 AC + 3 补充套件）、`demo/{run-demo,seed}.mjs`
- `docs/CONTRACT.md`、`docs/adr/ADR-001..008`
- `dsh-plugin/{package.json,cordis.patch.yml,index.js,locale/*,icon.svg,README.md,test-adapter.mjs}`
- `dsh-plugin-ui/{package.json,cordis.patch.yml,index.js,client.js,locale/*,icon.svg,README.md,test-host.mjs}`

### Modified（未提交）

- `src/web/app.js` — 新增同源嵌入模式（`?api=&embed=1`，`API_BASE/EMBEDDED/apiUrl`），5 处 fetch/SSE 前缀
- `dsh-plugin-ui/index.js` — 同一 handler 注册两条前缀路由 `/dsh-team-api` 与 `/panel`；透明代理 + 仅回环来源
- `dsh-plugin-ui/client.js` — 右侧栏 Tab（类型注册 + 内容槽 + 入口按钮），`TeamView` 网页版/精简版切换
- `dsh-plugin-ui/test-host.mjs` — 覆盖两条路由、面板静态资源、白名单 404、SSE、503
- `README.md` / `dsh-plugin-ui/README.md` / `docs/adr/ADR-008-panel-in-gui.md` — 同步当前承载方式

### Read (Reference)

- `prd/*`（需求冻结源）、DSH checkout `/node_modules/@deepseek-ai/*`（插件 API 契约）
- `@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/{service,tab-registry}.d.ts`（**关键**：openTab/register 契约）

---

## Technical Context

### Architecture

```
DSH Host (web profile)
├─ @local/dsh-team-plugin   → 8 个 team_* 工具 → sidecar REST（autoStart 子进程）
└─ @local/dsh-team-ui
   ├─ Host：webServer 前缀路由 /dsh-team-api/**、/panel/**（注入 token，仅回环）
   └─ Client：sidebarRightTabs.register({id:'dsh-team',kind:'dsh-team'})
               + sidebar.right.pane.tab[key=dsh-team] → TeamView
               + sidebar.footer.action 按钮 → openTab('dsh-team')
sidecar 127.0.0.1:4317（node:sqlite WAL）
└─ Worker × N（node --permission，仅 stdio RPC，无原生 IO）
```

### DSH 插件 API 关键事实（下次省探索）

- Host 插件：`export function apply(ctx, config)`；工具用**普通 ToolDefinition**（JSON Schema 参数）注册即可，不必 import `defineTool` → bundle 可零依赖。
- `webServer.register({ kind:'prefix', path, handler })`；重复路径会抛错。
- Client 插件格式：`window.__ModuleLoader__.load({ id: 包名, factory(require){ const React=require('react'); return { inject:[...], apply(ctx){...} } } })`；`package.json` 需 `dsh.client` + `./client` export。
- Slot 查询：`cordis_inspect_query` client `Slots.listSubTree`（`root` 指定具体槽）。
- **右侧栏 Tab**：服务 `sidebarRight`（`openTab/close/openTabIn`）与 `sidebarRightTabs`（`register`）由 `dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide` 提供，**不在** inspect Service 目录；Tab 类型 `id` 就是 `sidebar.right.pane.tab` 的 key。
- 中央面板：`main`（keyed）+ `sidebar.panellist`（icon，id 同名）→ `layout.selectPanel`。
- 主题 token：只有 `--dsw-alias-*` / `--dsw-specific-*` 可用。

### Dependencies / Configuration

- 无 npm 依赖；Node ≥22.15（`node:sqlite` + 同步 `registerHooks`）。
- 数据目录 `~/.dsh/team`：`team.db`、`token`、`run/sidecar.json`、`workers/`、`demo-workspace/`。
- profile：`web`（`C:\Users\Administrator\.dsh\profiles\web`），bundles 里已有两个 `@local/*`。

---

## Things to Know

### Gotchas

- **插件热重载会杀掉 sidecar**：sidecar 是工具插件 `ctx.effect` 里 spawn 的子进程，插件重载 → 子进程被 kill → 下次请求由 UI 插件自动重启 → `recover()` 把 running 标 interrupted、pending scope 置 expired。演示数据因此被冲掉多次。
- **PowerShell 5.1 发 UTF-8 JSON 会乱码**：REST 灌数据一律用 Node（`demo/seed.mjs`）。
- `pct` 是 0..1 比例（面板与契约），不是 0..100。
- AC-10 允许 ≤25ms 的跨进程时钟负抖动（否则偶发 -1ms 误判）。
- 面板静态资源是绝对 `/panel/app.js|css`，所以 Host 必须额外映射根 `/panel`，否则 iframe 内 404。
- `panel.html` 的 `?api=/dsh-team-api` 会让所有请求变成 `/dsh-team-api/api/**`；Host 是**透明**代理（remainder 原样转发）。
- `retire` 成员**不会**解绑其 pending/ready 任务 → 任务可能永久停留（未修）。
- 插件规范不建议 iframe（拿不到主题）；这是按用户要求的有意取舍，已记 ADR-008。

### Known Issues

1. **iframe 不继承 DSH 主题**（网页版沿用面板深色配色）；可切「精简版」或做 `postMessage` token 桥接。
2. **sidecar 生命周期绑定插件**（见上）——可改 `detached:true, unref()` 让它脱离插件卸载。
3. `retire` 后任务不解绑（见上）。
4. **视觉渲染未做浏览器验证**（环境无浏览器控制）：只验证了 Slot 注册、数据链路、语法、样式合规。
5. `_sse-check.mjs` 已删除（git 中为删除状态，随下次提交生效）。
6. Host 侧 loopback 守卫与透明代理是**上次 bundle 重载后**才生效的；若之后没再重载则需重启 DSH 才会加载最新 Host 模块（client 改动走 HMR）。

---

## Current State

### What's Working

- sidecar：`127.0.0.1:4317`（当前 pid 18700，由 DSH Host 拉起），`/api/health` 200
- 演示团队 `team_mvs2vbxf1f3x6`「演示团队」：`lab-eta` **blocked**，1 条待审批 `config/main-panel-demo.json`
- DSH：`team_*` 工具全在；`spawn_teammate/wait_agent/team_task_*` 已消失；`send_message/list_agents/interrupt_agent` 属 subagent，仍在
- UI：`sidebarRightTabs`/`sidebar.right.pane.tab` 已注册 `dsh-team`；`sidebar.footer.action` 有入口；`main`/`panellist` 无重复入口
- 路由：`/panel`、`/panel/app.js`、`/dsh-team-api/api/teams`、`/dsh-team-api/api/events`(SSE) 全 200

### What's Not Working / Unverified

- 右侧栏 Tab 的**实际点击与渲染**未在浏览器验证（`openTab` 已在按钮里 try/catch）
- 窄栏下网页版布局是否可用未验证

### Tests

- [x] AC 套件：`node tests/run-all.mjs` → **13/13**（AC-5 20 轮并发零丢更新；AC-8 interrupt 2–6ms；AC-10 p95 2–7ms）
- [x] 适配层：`node dsh-plugin/test-adapter.mjs` 12/12；`node dsh-plugin-ui/test-host.mjs` 9/9
- [x] 补充：`routes-smoke` 48/48、`panel-contract` 17/17、`cli-smoke` 全 PASS
- [ ] 浏览器端手工验证：未做

---

## Next Steps

### Immediate (Start Here)

1. **刷新页面验证右侧栏 Tab**：点左下角「编排」→ 右侧栏应出现 Tab（标题「编排」）；确认 7 视图与 SSE 正常；在「审批」里批准 `config/main-panel-demo.json`，应看到 decision → grant → 写入 → 回 idle。
2. **提交当前改动**（`git add -A && git commit`，包含 `_sse-check.mjs` 的删除与 `docs/handoffs/`）。
3. **决定 sidecar 生命周期**：把 `dsh-plugin/index.js` 与 `dsh-plugin-ui/index.js` 的 `spawn` 改成 `detached:true` + `child.unref()`（并去掉卸载时的 kill），避免插件重载杀掉正在跑的团队；同步更新 README/ADR。

### Subsequent

- 窄栏响应式：给 `src/web` 增加窄屏媒体查询，或在右侧栏默认用精简版。
- `postMessage` 主题桥：把 `--dsw-*` 计算值注入 iframe，使网页版跟随明暗。
- 修 `retire` 解绑任务：`removeMember` retire 分支里 `UPDATE task SET assignee=NULL WHERE assignee=? AND status IN ('pending','ready')`。
- 精简版补齐：消息视图、报告导出、SSE（当前 2s 轮询）。
- PRD 未做项：YAML 团队导入导出（D-12，ADR-006 记为 backlog）、权限矩阵编辑（当前只读）。

### Blocked On

- 浏览器控制（视觉核验）；否则只能做契约级验证。

---

## Related Resources

### Documentation

- `README.md`（5 分钟跑通 / 验收矩阵 / 插件安装）
- `docs/CONTRACT.md`（REST/SSE/RPC/不变量，冻结口径）
- `docs/adr/ADR-001..008`（ADR-002 Worker 强制点、ADR-005 调度竞态、ADR-008 UI 承载演进）
- `dsh-plugin/README.md`、`dsh-plugin-ui/README.md`
- `.team/20261028-1945-plugin/`（teammate 证据：`test-m1`/`test-sec` 的 progress/summary）

### Commands to Run

```powershell
cd C:\Users\Administrator\Documents\deepseek-harness\agent-team-plugin
node tests/run-all.mjs                    # 13 AC
node demo/run-demo.mjs                    # 可复现 demo（独立临时实例）
node demo/seed.mjs                        # 给运行中的 4317 灌演示数据（幂等）
node bin/dsh-team.mjs status team_mvs2vbxf1f3x6
node bin/dsh-team.mjs approve <requestId>
node bin/dsh-team.mjs down                # 停 sidecar（下次工具/页面请求会再自动拉起）
node dsh-plugin/test-adapter.mjs          # 工具适配层
node dsh-plugin-ui/test-host.mjs          # Host 代理层
# 重装插件（改 Host 模块后需要重新加载；UI 改动通常 HMR）
# plugin_manager(action:"install_bundle", target:"C:\\...\\agent-team-plugin\\dsh-plugin-ui")
```

### Search Queries

- `grep -n "sidebarRightTabs\|openTab" dsh-plugin-ui/client.js` — 右侧栏注册点
- `grep -n "API_BASE\|EMBEDDED" src/web/app.js` — 面板同源模式
- `grep -n "dsh-team-api\|'/panel'" dsh-plugin-ui/index.js` — 代理路由
- `grep -rn "detached\|unref" dsh-plugin/index.js dsh-plugin-ui/index.js` — 生命周期改造点

---

## Open Questions

- [ ] sidecar 应该随 DSH 退出而退出，还是作为常驻服务独立管理？（影响 autoStart 与卸载语义）
- [ ] 右侧栏窄宽度下，网页版是否可接受？还是默认精简版？
- [ ] 是否继续做主题桥（`postMessage`）让 iframe 跟随明暗？

---

## Session Notes

- 本会话使用了 3 个 teammate：`panel-owner`（面板，收尾阶段停滞，被 interrupt 后由我接管核验并代写交接）、`test-m1`（AC-1/2/6/7/10）、`test-sec`（AC-3/4/5/11/13）。teammate 报出并被我修复的真实 bug：queued 永不晋升、wake worker `plan=[]`、消息 payload 未脱敏。
- 我另外修了：依赖抢跑（-243ms）、`pct` 单位、租约超时幽灵审批、阻塞 RPC 饿死心跳、AC-10 时钟抖动、`/api/health` 401、面板 UTF-8。
- 当前时间约 20:54，若读数距离过久：先 `GET /api/health`，不通则任一 `team_*` 工具或页面请求会自动拉起 sidecar。

---

_本 handoff 由会话上下文整理生成；新会话可直接以此为初始上下文。_

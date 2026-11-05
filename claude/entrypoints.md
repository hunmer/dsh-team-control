# 入口与启动

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 1. sidecar：`bin/dsh-team.mjs up`

```text
node bin/dsh-team.mjs up [--port N] [--data DIR] [--foreground]
  ├ 解析全局 --url/--token/--data
  ├ 确定 home：--data > DSH_TEAM_HOME > ~/.dsh/team
  ├ mkdir home / home/run / home/workers
  ├ startServer({home, port, host:'127.0.0.1'})   src/server.mjs
  │    ├ openDb(home/team.db)  SQLite WAL + migrate（schema v7，幂等）
  │    ├ createCore(...)       src/core.mjs 组合根 + recoverAll()
  │    └ http.createServer(createRoutes(core))
  ├ 写 home/run/sidecar.json {pid,port,url,startedAt}
  ├ stdout 第一行打印单行 JSON：
  │    {"event":"ready","url":…,"port":…,"pid":…,"dataDir":…,"token":…,"tokenFile":…,"panel":…}
  └ 非 --foreground 时父进程 detach 退出，子进程继续跑（日志在 home/logs）
```

`port=0` 表示随机端口——测试全靠它。启动横幅是**第一行**且是单行 JSON，任何多余 `console.log` 都会破坏 `startSidecar()` 的解析。

`down` 读 `run/sidecar.json` 的 `pid` 后 `process.kill`，不查 HTTP。
`discover()` 顺序：`--url` > `run/sidecar.json` > 默认 `http://127.0.0.1:4317`。

## 2. `createCore` 装配顺序（`src/core.mjs`）

```text
openDb → EventStore(db) → Bus(db, events)
→ Scheduler({db, events, bus, settleMs:200, tickMs:150})
→ SSE Hub → LlmCatalog(db) → Board(db, …)
→ recoverAll()  // 收敛遗留 running/provisioning、过期租约
```

`core` 上暴露的方法就是 `server.mjs` 路由能用的全部能力面：`teams/members/tasks/events/...`。新增能力先加 `core`，再在 `createRoutes` 里挂。

## 3. Worker 启动（已移除）

`src/runner.mjs` / `src/worker/worker.mjs` 已随 v2 删除（ADR-009）；成员一律是 Host 侧 sub-agent，进程生命周期归 DSH 宿主。

## 4. Host 插件启动（`dsh-plugin/index.js`）

```text
apply(ctx, config)
  ├ resolveConfig(config) → baseUrl/port/home/autoStart/entry/...
  ├ ctx.effect(...) 注册 19 个 team_* + 2 个 board_* 工具
  ├ ctx.inject(['skills']) 注册 skills provider（rank 600，读 skills/ 目录）
  ├ ensureSidecar()：autoStart 时 spawn `bin/dsh-team.mjs up`，等 ready 行（startTimeoutMs 20s）
  ├ 事件钩子：
  │    tools/execute        → span + 文件改动 diff（changes.js）+ todo 镜像
  │    llm/stream           → token 用量与费用（pricing.js）
  │    llm/adapters-updated → 重同步模型目录
  │    agent/status         → running/idle 回写（idle 有 settle 窗口）
  │    session/event        → assistant/message 正文、turn/end error
  └ 泵：心跳 / 上下文 / 工作区 / 模型目录 / 派发保底
```

`autoStart:false` 时不拉进程，直接对 `baseUrl` 发请求——测试与外部托管场景用。

## 5. GUI 插件启动（`dsh-plugin-ui/index.js` + `client.js`）

```text
Host half (index.js, inject:['webServer'])
  apply(ctx, config) → resolveConfig → ensureSidecar()（可选）
  ctx.webServer 挂 /dsh-team-api/* → proxyHandler 转发到 baseUrl
  代理时读 home/token 补 Authorization（浏览器看不到）

Client half (client.js)
  window.__ModuleLoader__.load({id:'dsh-team-control-ui', factory(require){…}})
  只 require('react')，注册顺序：
    1) better-sidebar 页签 `dsh-team:panel`（order 30, single）
    2) 回退 sidebarRightTabs + sidebar.footer.action
    3) 回退 main panel
  面板内容 = <iframe src="{proxy}/panel?api=/dsh-team-api&embed=1">
```

`dsh-plugin-ui/package.json` 的 `dsh.bundle.patch` 与 `dsh.client{platform:web,immediately:true}` 决定这段 client 代码何时注入。

## 6. 面板前端启动（`src/web-ui/`）

```text
panel.html（首帧前读 localStorage `dsh-team.panel.theme.v1` 上暗色 class）
 → src/main.tsx：applyDshTheme(readDshTheme()) → <PanelProvider><App/>
 → App.tsx：usePanel() + AppShell + SidebarMenu + 10 个视图
 → store.tsx：REST 首屏快照 → SSE /api/events 增量（lastEventId 续传）
```

开发时 `vite` 起在 5183，`/api` 代理到 4317；构建产物 `base:/panel/`、`outDir: ../web`。

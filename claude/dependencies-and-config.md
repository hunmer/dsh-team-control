# 依赖与配置

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 运行时依赖

| 依赖 | 版本 | 用途 | 风险 |
|---|---|---|---|
| Node | `>= 22.15`（实测 24.22） | `node:sqlite`、`module.registerHooks`、`node --permission` | 低于 22.15 直接崩 |
| `node:sqlite` | 内置 | SQLite WAL，schema v7 | 实验性 API，Node 升级可能变签名 |
| 系统 `sqlite3` CLI | 可选 | 测试里 `readDb()` 读库校验 | 缺失时相关断言跳过 |

后端**零 npm 依赖**（`dsh-plugin/package.json` 只声明 `dsh-team-control-cli ^0.1.1` 作为自引用 CLI 包）。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_TEAM_HOME` | `~/.dsh/team` | 数据目录（db / run / workers / token） |
| `DSH_TEAM_PORT` | `4317` | 监听端口，`0` = 随机 |
| `DSH_TEAM_TOKEN` | 自动生成 | 仅写入 `home/token`；**服务端已不校验** |
| `DSH_TEAM_WORKSPACE` | 当前目录 | 默认工作区根 |

## 数据目录布局

```text
~/.dsh/team/
  token             兼容保留（服务端不校验）
  team.db           SQLite（WAL）+ team.db-wal / team.db-shm
  run/sidecar.json  {pid, port, url, startedAt}
  workers/<member>/ 受限 worker bundle + 工作区
```

## 插件 config（`dsh-plugin`）

`resolveConfig()` 识别的键：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:4317` | sidecar 地址 |
| `port` | — | 覆盖端口（autoStart 时生效） |
| `home` | `~/.dsh/team` | 数据目录 |
| `autoStart` | `true` | 自动拉起 sidecar |
| `entry` | 内置 bin 路径 | 自定义 sidecar 入口 |
| `startTimeoutMs` | `20000` | 等 ready 行超时 |
| `requestTimeoutMs` | `60000` | 普通 HTTP 超时 |
| `reportToolCalls` | `true` | 工具调用 → span |
| `reportChanges` | `true` | 文件改动 → member_change |
| `reportLlmCalls` | `true` | token 用量 → 费用 |
| `reportContext` | `true` | 上下文占用上报 |
| `pricingTables` | 内置 | 覆盖计价表 |
| `traceInputMax` | `1200` | trace 里入参最大字符 |
| `agentAutoDispatch` | `true` | agent 团队自动派发 |
| `agentIdleSettleMs` | — | idle 判定窗口 |
| `agentHeartbeatMs` | — | 心跳间隔 |
| `agentDispatchMs` | — | 派发保底泵间隔 |
| `contextReportMs` | — | 上下文泵间隔 |
| `workspaceReportMs` | — | 工作区泵间隔 |
| `llmCatalogMs` | — | 模型目录刷新间隔 |

## 配置补丁文件

- `dsh-plugin/cordis.patch.yml`：`insert: id: dsh-team / name: dsh-team-control / config: {baseUrl: http://127.0.0.1:4317, autoStart: true}`
- `dsh-plugin-ui/cordis.patch.yml`：`insert: id: dsh-team-ui / name: dsh-team-control-ui / config: {baseUrl, autoStart: true}`
- `dsh-plugin-ui/package.json`：`dsh.bundle.patch`（补丁入口）+ `dsh.client{platform:web, immediately:true, inject:['@deepseek-ai/dsh-client-ui-settings-plugins']}`

## 面板前端依赖（`src/web-ui/package.json`）

React 19 + Tailwind v4 + Vite 6 + coss ui。coss 是 copy-paste registry（`https://coss.com/ui/r/{name}.json`），`scripts/sync-coss.mjs` 把组件抓进 `src/components/ui/` 并重写 `@/registry/default/*` 别名——**不要在 `components/ui/` 里手改**，会被下次同步覆盖。

- `vite.config.ts`：`base: '/panel/'`、`outDir: '../web'`、dev `port 5183`、`/api` → `http://127.0.0.1:4317`、alias `@` → `./src`
- `tsconfig`：ES2022、`strict`、`noEmit`、`verbatimModuleSyntax`、paths `@/*` → `./src/*`

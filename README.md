# dsh-team-control

[![node](https://img.shields.io/badge/node-%E2%89%A522.15-brightgreen)](#安装) [![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](#安装) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**一句话**：给 DeepSeek Harness 的 Agent Team 加一个独立 sidecar——成员上限可配、DAG 依赖自动派发、`fs/exec/net/env` 四域强制执行权限、事件流可回放、SSE 实时面板。

## 截图

<p align="center">
  <img src="screenshots/screenshot_1.png" width="49%" />
  <img src="screenshots/screenshot_2.png" width="49%" />
  <img src="screenshots/screenshot_3.png" width="49%" />
  <img src="screenshots/screenshot_4.png" width="49%" />
  <img src="screenshots/screenshot_5.png" width="49%" />
</p>

## 安装

要求 **Node.js ≥ 22.15**（`node:sqlite` ≥22.5、Worker 的 `module.registerHooks` ≥22.15；实测 v24.22）。**零依赖、零构建**，不需要 `npm install`。

### 1. 装插件（`dsh plugin`）

```bash
# 本地源码（推荐：sidecar 能被插件自动拉起）
git clone https://github.com/hunmer/dsh-team-control.git ~/dsh-team-control
dsh plugin --profile web add "$HOME/dsh-team-control/dsh-plugin"
dsh plugin --profile web add "$HOME/dsh-team-control/dsh-plugin-ui"   # 可选：GUI 看板
```

```bash
# GitHub 源码（免 clone；本仓库无构建脚本，不需要 allowBuilds 授权）
dsh plugin --profile web add "github:hunmer/dsh-team-control#path:/dsh-plugin"
dsh plugin --profile web add "github:hunmer/dsh-team-control#path:/dsh-plugin-ui"
```

```bash
# npm 包（预构建，装完即用；sidecar 以依赖 dsh-team-control-cli 一起装）
dsh plugin --profile web add dsh-team-control
dsh plugin --profile web add dsh-team-control-ui   # 可选：GUI 看板
```

装完**重启 DSH**（或到 设置 → 插件 里禁用/启用一次），`team_*` 工具与「编排」面板才会出现。卸载：
`dsh plugin --profile web remove dsh-team-control`（UI 包同理）。

### 2. sidecar（**不用手动做**）

装完插件即可用：`autoStart` 默认开启，**首次调用 `team_*` 工具时插件自己拉起 sidecar**（本地安装走同级 `bin/`，npm 安装走依赖 `dsh-team-control-cli`），随后自动读 `~/.dsh/team/token` 鉴权。下面这些只在你想脱离插件、单独开面板时才需要：

```bash


```bash
npx -y dsh-team-control-cli up --port 4317
# 或本地克隆：node ~/dsh-team-control/bin/dsh-team.mjs up --port 4317
# stdout 首行：{event:'ready', url, port, token, panel}
```

- 面板：<http://127.0.0.1:4317/panel>
- 数据目录默认 `~/.dsh/team`（`--data` / `DSH_TEAM_HOME` 覆盖）
- 停止：`npx -y dsh-team-control-cli down`

### 3. 技能（**随插件自动注册**）

插件启动时把仓库 `skills/` 注册成 skills provider（npm 安装读 `dsh-team-control-cli` 里的同一份文件），会话技能目录里直接出现 `dsh-agent-team`，**不用重启、也不用 cp**。
只有在不装插件、又想让别的会话读这份用法时，才需要手动装：

```bash
mkdir -p ~/.dsh/skills && cp -r ~/dsh-team-control/skills/dsh-agent-team ~/.dsh/skills/
```

### 4. 验证

```bash
cd ~/dsh-team-control
node demo/run-demo.mjs     # 3 成员 + DAG + 一次越界审批 + 一次 interrupt/resume
node tests/run-all.mjs     # AC-1 ~ AC-15 与插件/面板/路由/CLI 全量验收
```

## 架构

```
Lead Agent ──REST / CLI / SSE──▶ dsh-team sidecar (127.0.0.1:4317)
                                  ├ Scheduler   DAG 求值 + 自动派发
                                  ├ EventStore  event 只增流 + 状态物化
                                  ├ PermBroker  四域唯一 IO 出口 + 审计
                                  ├ MessageBus  持久信箱 + 三态回执
                                  ├ SSE Hub     lastEventId 断线续传
                                  └ Web UI      面板 /panel（Trace 瀑布 / DAG / 审批）

Worker × N    ◀──stdio NDJSON RPC────────────────┘  runtime=worker：沙箱 Node 进程，只能走 broker
DSH agent × N ◀──subagents.startActivation / sendMessage── dsh-plugin/  runtime=agent：真子会话
```

- 状态只有一根主轴：所有变更写 `event`，`member_state` 是它的物化视图，崩溃后可完整重建。
- 越界即 `blocked` → `scope_request` → 落盘 `decision` → 单次 `grant` → 重试 → `audit` 记前后 hash。
- 契约：[`docs/CONTRACT.md`](docs/CONTRACT.md)；每条偏离一份 [`docs/adr/`](docs/adr/)。

## 文件地图

| 路径 | 作用 |
|---|---|
| `bin/dsh-team.mjs` | CLI：`up` / `down` / `status` / `dag` / `logs` / `approve` / `report` |
| `src/core.mjs` | 组合根、业务查询、报告导出 |
| `src/db.mjs` | SQLite schema / 事务 / 轻量迁移 |
| `src/eventstore.mjs` | 事件流 `append` / `rebuild` / `verify` |
| `src/policy.mjs` | 四域策略纯求值器（默认拒绝、deny 优先） |
| `src/broker.mjs` | 四域唯一 IO 出口：grant、审计、CAS 写 |
| `src/scheduler.mjs` | DAG 求值、派发、并发上限、失败策略、环检测 |
| `src/runner.mjs` | Worker 子进程、租约、同步中断、崩溃恢复 |
| `src/bus.mjs` | 持久信箱与回执 |
| `src/sse.mjs` | SSE hub 与断线续传 |
| `src/server.mjs` | REST + SSE + 静态面板（仅回环监听） |
| `src/worker/worker.mjs` | 受限 Worker（单文件，仅 `import node:module`） |
| `src/web/` | 面板构建产物（`panel.html` + `assets/`） |
| `src/web-ui/` | 面板源码（React + coss ui，含 Trace 瀑布） |
| `dsh-plugin/` | DSH Host bundle：11 个 `team_*` 工具 + sidecar 生命周期 + agent 成员调度 |
| `dsh-plugin-ui/` | GUI 看板 bundle：better-sidebar 页签 / 侧栏入口 |
| `skills/dsh-agent-team/` | 给模型看的调用配方 skill |
| `tests/` | `ac-*.mjs` 验收脚本 + harness + `run-all.mjs` |
| `demo/` | `run-demo.mjs` 可复现演示、`seed.mjs` 灌演示数据 |
| `docs/` | `CONTRACT.md` 实现契约、`adr/` 决策记录、`handoffs/` 交接 |
| `prd/` | 需求文档与实现摘要 |

## 声明

- **许可**：MIT，见 [`LICENSE`](LICENSE)。
- **本地优先**：sidecar 只监听 `127.0.0.1`，`/api/**` 与 `/panel` 免 token，因此不要把端口直接暴露到公网；需要远程访问请自行套反向代理与鉴权。
- **不碰凭据**：不内置 LLM 客户端、不保存任何 API Key；敏感 env 输出一律 `<redacted>`。
- **非官方**：本项目为个人项目，与 DeepSeek 官方无隶属或背书关系。
- **取舍**：Node 无 net 权限门、状态单点存放、并发写用 CAS 等已知限制与理由见 [`docs/adr/`](docs/adr/)。

# 对外接口

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 1. REST（`src/server.mjs`，前缀 `/api`）

返回约定：单资源直接返回对象本体；列表返回 `{asOf, version, items}`；错误 `{error:{code,message,detail}}`，`code` 取 `ERR.*`。

**健康/设置**
- `GET /api/health`
- `GET|PATCH /api/settings`

**团队**
- `POST|GET /api/teams`
- `GET /api/teams/by-lead/{leadId}`
- `GET|PATCH|DELETE /api/teams/{id}`
- `POST /api/teams/{id}/stop|archive|restore`

**成员**
- `POST|GET /api/teams/{id}/members`
- `GET|DELETE /api/members/{id}`
- `POST /api/members/{id}/interrupt|resume|assign`

**agent 运行时专用**
- `POST /api/agents/register`、`GET /api/agents/ready`
- `POST /api/agents/dispatch|status|report`
- `GET /api/agents/by-session/{sessionId}`
- `POST /api/members/{id}/agent-status`、`POST /api/members/{id}/agent-report`

**任务与 DAG**
- `POST|GET /api/tasks`、`GET /api/tasks/{id}`
- `POST /api/deps`、`DELETE /api/deps/{id}`
- `GET /api/dag`

**可观测/产物**
- `GET|POST /api/artifacts`、`GET|POST /api/changes`
- `GET|POST /api/contexts`、`GET|POST /api/workspaces`
- `GET /api/status`、`GET /api/steps`、`GET /api/blockers`、`GET /api/metrics`
- `GET /api/events/history`、`POST|GET /api/spans`、`GET /api/trace`
- `GET /api/verify`、`GET /api/reconcile`、`GET /api/audit`、`GET /api/report`

**消息**
- `POST|GET /api/messages`、`POST /api/messages/{id}/ack`

**审批镜像**
- `POST|GET /api/approvals`、`POST /api/approvals/{id}/decide`

**组合预设目录**
- `GET /api/presets`、`POST /api/presets/sync`、`POST /api/presets/{id}/delete`
- `GET /api/presets/pending-deletes`、`POST /api/presets/pending-deletes/{id}/ack`

**待办**
- `GET /api/todos`、`POST /api/tasks/{id}/todos`、`POST /api/todos`、`PATCH /api/todos/{id}`

**模型目录**
- `POST|GET /api/llm/catalog`、`GET /api/llm/models`、`PATCH /api/llm/routes`

**SSE**
- `GET /api/events`（支持 `lastEventId` 续传；7 种基础帧 + 4 种合成帧）

**静态**
- `GET /`、`/panel`、`/panel/*` → `PANEL_DIR = ./web/`，no-cache，路径越界 403，缺 `panel.html` 时返回纯文本 `panel not built yet (src/web/panel.html missing)`

## 2. CLI（`bin/dsh-team.mjs`）

| 命令 | 作用 |
|---|---|
| `up [--port N] [--data DIR] [--foreground]` | 起 sidecar，第一行 JSON 报 ready |
| `down` | 按 `run/sidecar.json` 的 pid 杀进程 |
| `status <team> [--json]` | 团队看板摘要 |
| `dag <team> [--json]` | DAG 与关键路径 |
| `logs <member> [-f] [--since N]` | 成员日志（`-f` 跟随） |
| `approvals <team> [--status pending\|allowed\|rejected] [--json]` | 查审批镜像（只读） |
| `report <team> [-o run.md]` | 导出运行报告 |

全局：`--url`、`--token`、`--data`。

## 3. 插件工具（`dsh-plugin/index.js` `buildTools`，共 15 个（13 个 `team_*` + 2 个 `board_*`））

| 工具 | 作用 |
|---|---|
| `team_create` | 建团队，`permissionPreset`、`agentPreset`、`maxMembers`、`workspace` |
| `team_spawn` | 拉起 sub-agent 成员，`permissionPreset`/`agentPreset` 按成员覆盖 |
| `team_preset` | 自建 agentPreset：`list`/`save`/`show`，写 `presetDir` 并即时注册 |
| `team_models` | 列出可用 provider/model 路由 |
| `team_status` | `detail:"summary"`（成员）/`"dag"`（任务图） |
| `team_task` | 建任务（DAG 节点），`plan` 是给成员的简报 |
| `team_send` | 给成员/广播投消息 |
| `team_todo` | 设置任务清单（落 sidecar，面板可见） |
| `team_report_task` | 成员报告任务结果（done/failed/blocked） |
| `team_dispatch` | 手动泵一次派发器 |
| `team_approve` | Lead 裁决成员审批（allow/deny），转成宿主 outcome |
| `team_control` | interrupt/resume/assign |
| `team_report` | 导出 Markdown 运行报告（含审批与 audit） |
| `board_plan_submit` | 规划会话提交计划，任务 `planning → planned`（same 模式同时绑定执行会话） |
| `board_task_status` | Lead 会话回报看板任务 `done`/`failed`/`inprogress` |

## 4. Host 同源代理（`dsh-plugin-ui/index.js`）

- `/dsh-team-api/*` → `{baseUrl}/*`，自动补 `Authorization`（读 `home/token`）。
- 浏览器因此不接触 token；iframe 用 `?api=/dsh-team-api&embed=1`。

## 5. 进程内 RPC（worker ↔ sidecar）

标准输入输出 NDJSON，一行一帧。请求 `{id, op, args}`，响应 `{id, ok, result}` 或 `{id, ok:false, error:{code,message,detail}}`。
op 覆盖面 = `broker.mjs` 的公开方法：`fs.read/fs.write/fs.delete/fs.rename/fs.list`、`exec.spawn`、`net.connect`、`env.read/env.write`、`scope.request`、`msg.*`、`step.append`。

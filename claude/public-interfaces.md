# 对外接口

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

**权限**
- `POST|GET /api/policies`、`DELETE /api/policies/{id}`、`GET /api/permission-matrix`
- `POST|GET /api/scope-requests`、`POST /api/scope-requests/{id}/decide`

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
| `approve <request-id> [--deny] [--reason TEXT] [--ttl SEC]` | 审批越界请求 |
| `report <team> [-o run.md]` | 导出运行报告 |

全局：`--url`、`--token`、`--data`。

## 3. 插件工具（`dsh-plugin/index.js` `buildTools`，共 12 个）

| 工具 | 行号 | 作用 |
|---|---|---|
| `team_create` | :1030 | 建团队，`runtime:"worker"\|"agent"`、`maxMembers`、`workspace` |
| `team_spawn` | :1068 | 加成员，可按 `agentProvider`/`model`/`reasoningEffort` 路由 |
| `team_models` | :1179 | 列出可用 provider/model 路由 |
| `team_status` | :1219 | `detail:"summary"`（成员）/`"dag"`（任务图） |
| `team_task` | :1267 | 建任务（DAG 节点），`plan` 对 worker 是代理动作、对 agent 是简报 |
| `team_send` | :1326 | 给成员/广播投消息 |
| `team_todo` | :1395 | 设置任务清单（落 sidecar，面板可见） |
| `team_report_task` | :1433 | 成员报告任务结果（done/failed/blocked） |
| `team_dispatch` | :1471 | 手动泵一次派发器 |
| `team_scope` | :1487 | 四域越界请求的 list/request/decide |
| `team_control` | :1557 | interrupt/resume/assign |
| `team_report` | :1600 | 导出 Markdown 运行报告（含 audit 前后哈希） |

> README 与 `skills/dsh-agent-team/SKILL.md` 仍写「11 个」——`team_todo` 是后加的，改文档时一并修正。

## 4. Host 同源代理（`dsh-plugin-ui/index.js`）

- `/dsh-team-api/*` → `{baseUrl}/*`，自动补 `Authorization`（读 `home/token`）。
- 浏览器因此不接触 token；iframe 用 `?api=/dsh-team-api&embed=1`。

## 5. 进程内 RPC（worker ↔ sidecar）

标准输入输出 NDJSON，一行一帧。请求 `{id, op, args}`，响应 `{id, ok, result}` 或 `{id, ok:false, error:{code,message,detail}}`。
op 覆盖面 = `broker.mjs` 的公开方法：`fs.read/fs.write/fs.delete/fs.rename/fs.list`、`exec.spawn`、`net.connect`、`env.read/env.write`、`scope.request`、`msg.*`、`step.append`。

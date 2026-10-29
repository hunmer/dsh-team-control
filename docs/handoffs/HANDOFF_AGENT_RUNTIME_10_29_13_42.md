# Handoff: dsh-team 成员改真 sub-agent（B 方案）

**Created:** 2026-10-29 13:42 (Asia/Shanghai)
**Branch:** master
**Repo:** `C:\Users\Administrator\Documents\deepseek-harness\agent-team-plugin`
**Session duration:** 约 2 小时（前 3 个任务已交付，第 4 个刚开始）

> **⚠ 阅读顺序（2026-10-29 15:00 更新）**：下面的 Summary / Work Completed 是**开工前**的调研状态。
> 实际执行结果见文末两节：
> **「执行结果（14:10）」** B 方案 7 步落地 → **「执行结果补记（14:20）」** `agentTeams` 未挂载、改用 `subagents` + 真机整链跑通 →
> **「执行结果补记 2（15:00）」** 会话右上角团队成员条（AC-16）+ `skills/dsh-agent-team` 与工具描述重写。
> 当前状态：**B 方案已完成并真机验证**，`node tests/run-all.mjs` **23/23 PASS**；只剩「用户在真实页面确认成员条是否出现」这一项待验证。

---

## Summary

上一轮已交付四个功能（Trace 瀑布看板、工具调用上报、移除「精简版」、入口注册到 dsh-better-sidebar），全部测试通过。用户随后提出核心质疑：dsh-team 的「成员」其实是沙箱 Node worker，不是 LLM agent，所以看起来始终是单 agent 在操作（参考 NanmiCoder/dsh-agent-teams）。用户已选择 **B 方案**：把成员运行时换成真正的 DSH sub-agent session，保留现有 sidecar 看板 / DAG / trace / 审批。**目前只完成了调研与设计，尚未改一行 B 方案代码。**

---

## Work Completed

### 已交付的功能（本会话）

- [x] 成员看板换成 `TraceWaterfall`（源自 `default-workspace/affectui-trace-waterfall/src`），支持时间窗（近 30 分钟 / 全部历史）、SLOWEST 标记、空态。
- [x] 宿主插件 `dsh-plugin/index.js` 通过 `ctx.on('tools/execute', ...)` 把每次工具调用上报到 sidecar `/api/spans`，面板实时出现 `Lead · <session>` 节点。
- [x] sidecar 新增 `span` 表、`/api/spans`（POST/GET）、`/api/trace`（树形 + window 过滤）、SSE `span.append`。
- [x] 删除 `dsh-plugin-ui/client.js` 里的「精简版」原生渲染（679 行 → 156 行），只保留 iframe。
- [x] 「编排」入口改为优先注册到 `dsh-better-sidebar`（`registerTab`，id `dsh-team:panel`），未安装时回退左下角入口 + 右侧栏 Tab。
- [x] 测试：`node tests/run-all.mjs` 14/14；`routes-smoke` 48/48；`panel-contract` 17/17；`plugin-trace`、`plugin-client`、`test-host` 全 PASS。
- [x] e2e 演示：HTTP 建团（`team_mvt2yg801h9rx`）+ 真 `team_*` 工具建团跑 Fibonacci（`team_mvt3xyur2lp3t`），越界审批链路验证通过。

### Key Decisions

| Decision | Rationale | Alternatives |
| --- | --- | --- |
| 保留 sidecar 作为状态/UI 存储，Host 插件负责 agent 生命周期 | sidecar 是独立进程，无法创建 DSH agent；UI/DAG/trace 已基于 sidecar 数据 | 让 sidecar 反向调用 Host（需要 HTTP 回调通道，复杂且脆弱） |
| 成员 agent 用原生 `ctx.agentTeams.spawnTeammate` | 宿主自带服务，成员是 continuable 子 session，有独立模型/工具/消息信箱 | 用 `ctx.agents.create` 手写协议（工作量大） |
| 默认 `runtime: 'worker'`，agent 团队显式开启 | 不破坏 14 个 AC 与现有 demo | 直接把默认改 agent（会破坏全部测试） |
| 任务完成优先用显式回报工具，`agent/status` idle 作兜底 | 模型可能忘记回报，但 idle 是可靠信号 | 只靠 idle（拿不到摘要） |

---

## Files Affected

### Modified（当前未提交）

- `src/core.mjs` — `createTeam`(54)、`teamView`(86)、`addMember`(136)、`memberView`(160)、`appendSpans`(368)、`listSpans`(426)、`trace`(445)。
- `src/scheduler.mjs` — `createTask`(46)、`evaluate`(181)、`startTask`(255)、`dag`(375)。
- `src/server.mjs` — 路由表 `createRoutes`(54–143)。
- `src/db.mjs` — schema（team 13、member 24、span 141）、迁移 `ensureColumn`(185)、`SCHEMA_VERSION = 2`(6)。
- `src/web-ui/src/views/Board.tsx` — Trace 看板视图（含时间窗下拉、空态）。
- `src/web-ui/src/store.tsx` — `trace` 状态、`refreshTrace`、`span.append` / `step.append` 触发刷新。
- `src/components/trace-waterfall/*` — 从 affectui 项目拷入的组件（未改动）。
- `src/web/panel.html`、`src/web/assets/app-BXpY_StI.js`（新 hash）。
- `dsh-plugin-ui/client.js` — better-sidebar 注册 + 回退分支（210 行）。
- `tests/ac-14-trace.mjs`、`tests/plugin-client.mjs`（新增）。
- `README.md`、`docs/adr/ADR-008-panel-in-gui.md`、`dsh-plugin-ui/README.md`、`.gitignore`（`.tmp/`）。

### Read（参考）

- `dsh-plugin/index.js`：`inject`(18)、config(38)、`team_create`(179)、`team_spawn`(212)、`team_task`(285)、session→team 绑定(485)、`traceToolCall`(519)、`ctx.on('tools/execute')`(573-574)。
- `C:\Users\Administrator\.dsh\profiles\web\package.json`：`@local/dsh-team-plugin`、`@local/dsh-team-ui` 是 profile bundle。
- `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml`（91 行）——没有 dsh-team 配置项，插件走 bundle 默认值。

---

## Technical Context

### 宿主版本与位置

- DSH `0.2.1-rc.2`（`dsh --version`），与 dsh-agent-teams 推荐宿主一致。
- sidecar 当前 pid **14360**，监听 `http://127.0.0.1:4317`，数据目录 `C:\Users\Administrator\.dsh\team`。
- 面板：`http://127.0.0.1:4317/panel?team=<id>`；经 DSH 代理 `http://127.0.0.1:3080/dsh-team-api/panel`。

### 原生 `agentTeams` 服务契约（已从 inspect 取得，直接可用）

```ts
interface SpawnTeammateRequest {
  name: string; description: string; prompt: ContentBlock[];
  context: 'fresh' | 'fork'; provider: string; signal: AbortSignal;
}
interface TeamMemberView { id: SessionId; name: string; role: 'lead'|'teammate';
  status: 'running'|'inactive'|'provisioning'|'failed';
  description?: string; provider?: string; context?: 'fresh'|'fork'; model?: string; diagnostics: string[] }
async spawnTeammate(caller: Agent, req): Promise<{ member: TeamMemberView }>
async sendMessage(caller: Agent, { target: string; content: ContentBlock[]; signal }): Promise<{ messageId }>
async createTask(caller, { subject; description; blockedBy?; writeScopes? }): Promise<TeamTaskView>
async updateTask(caller, { taskId; expectedRevision; action: 'claim'|'release'|'complete'|'reopen'|'reassign'|... })
listMembers(agent): TeamMemberView[]
waitForChange(caller, timeoutMs, signal): Promise<{ timedOut: boolean }>
interrupt(caller, targetName)
```

### 可用生命周期事件（`ctx.on(...)`）

- `'agent/status'(agent, { status: 'idle' | 'running' })` —— 成员回合结束的可靠信号。
- `'agent/error'(agent, { turn, step, error })`。
- `'subagent/start'` / `'subagent/end'`。
- `'tools/execute'`（已用于工具 span 上报）。

### B 方案建议的最小闭环（改动点）

1. **db.mjs**：`ensureColumn(db,'team','runtime',"TEXT NOT NULL DEFAULT 'worker'")`；`ensureColumn(db,'member','agent_session_id','TEXT')`。`teamView` 暴露 `runtime`，`memberView` 暴露 `agentSessionId`。
2. **core.mjs**：
   - `createTeam({ runtime })` 写入并返回；`addMember({ agentSessionId })`。
   - 新增 `POST /api/agents`：`{ teamId, name, role, sessionId, status, model }` → upsert 成员 + 事件 `agent.spawn`。
   - 新增 `POST /api/agents/:memberId/status`、`POST /api/agents/:memberId/report`（完成 sidecar 任务、写事件、广播）。
   - `GET /api/agents/ready?team=`：返回 `ready` 任务 + 对应 idle 成员（供 Host 调度器取）。
   - `trace()` 第 2 步按 `member.agent_session_id` 把该 session 的 span 挂到 `member:<id>` 节点（当前只按 `parentId`/`memberId` 挂）。
3. **scheduler.mjs**：`evaluate()` 里保留「pending→ready」的依赖推进，但 `runtime === 'agent'` 时**跳过 startTask 派发循环**（否则会给 agent 团队拉起 worker）。
4. **dsh-plugin/index.js**：
   - `team_create` 透传 `runtime`。
   - `team_spawn`：agent 团队时取 `exec.agent`（或 `ctx.agents.currentInitiator()`）调 `ctx.agentTeams.spawnTeammate`，把 `member.id`（SessionId）作为 `sessionId` POST 给 sidecar。
   - `team_task`：agent 团队建任务后由 Host 调度器（setInterval ~1.5s）取 ready 任务 → `agentTeams.sendMessage(lead, { target: <memberName>, content: [{type:'text', text: 任务说明}], signal })` → 标记 running。
   - 监听 `agent/status`：成员 idle 且有在途任务 → 完成（兜底）；同时新增全局工具 `team_report_task`（成员可调用，`exec.agent.id` 校验归属）写精确摘要。
   - 需要 `signal`：用 `AbortSignal.timeout(ms)`。
5. **provider 字段**：`SpawnTeammateRequest.provider` 的确切语义还未核实（是 provider id 还是路由 id）。建议先在 DSH checkout 搜 `spawnTeammate(`、`SpawnTeammateRequest` 的实现/调用，再决定取值（`ctx.agentDefaultModel.currentSelection().provider` 是候选）。

---

## Things to Know

### Gotchas

- **worker op 参数必须嵌套在 `args` 下**：`{ kind:'fs.write', args:{ path, content } }`；平铺会得到 `FAIL:E_BAD_REQUEST path required`。
- **直接改 sidecar SQLite 删事件会破坏 seq 连续性**，触发 `degraded=true`；必须同步 renumber + `member_state.seq`。
- **Windows 构建**：`vite build` 会因 esbuild 临时文件 `Access is denied` 失败。必须先 `$env:TEMP=(Resolve-Path src/web-ui/.tmp).Path; $env:TMP=$env:TEMP`，再 `npx tsc -b; npx vite build`。
- **宿主插件与 client bundle 都要求重启 DSH** 才生效（模块图 immutable 缓存）；改 `src/` 后需重启 sidecar（`bin/dsh-team.mjs down/up`）。
- 面板是静态文件，新构建产物 hash 变化后 `src/web/panel.html` 要指向新文件，旧 hash 要删。
- 团队成员若通过 HTTP 建团，`POST /api/teams` 返回 team 对象本身；插件层再包 `{team, panel}`。

### Assumptions

- `agentTeams.spawnTeammate` 在 `tools/execute` 的异步上下文里可调用（Lead agent 是 live 的）。
- 成员 sub-agent 会继承全局工具集（含本插件 `team_*`），因此可以用 `team_report_task` 回报。

### Known Issues

- 运行中的 DSH 进程仍加载旧宿主插件模块；`tools/execute` 上报已在重启后验证生效（turn 6）。
- dsh-team 成员的 trace 目前只有步骤条，没有 LLM span（B 方案要补）。

---

## Current State

### What's Working

- Trace 瀑布看板（成员/步骤/工具调用/session 节点、时间窗、空态）已上线并通过浏览器实测；SSE 实时刷新正常。
- 8 个 `team_*` 工具经插件 → sidecar 全链路可用；越界审批、DAG、审计正常。
- 14/14 AC、48/48 routes、17/17 panel contract、plugin-client/plugin-trace 全绿。

### What's Not Working

- 成员不是 LLM agent（本 handoff 的任务）。
- `team_scope` 审批对 agent 成员尚不适用（agent 用 DSH 工具策略，不走 op broker）。

### Tests

- [x] Unit：`node tests/run-all.mjs` 14/14
- [x] Integration：routes-smoke 48/48、cli-smoke PASS
- [x] Manual：面板瀑布 / 时间窗 / SSE 实测截图通过

---

## Next Steps

### Immediate (Start Here)

1. 在 DSH checkout 里确认 `SpawnTeammateRequest.provider` 的语义与可用值（搜 `spawnTeammate`、`SpawnTeammateRequest`），并写一个最小探针：用 `ctx.agentTeams.spawnTeammate` 起一个成员、发一条消息、观察 `agent/status`。
2. `src/db.mjs` 加 `team.runtime`、`member.agent_session_id` 两列 + 迁移；`core.mjs` 的 create/add/view 透传。
3. `src/scheduler.mjs`：agent runtime 跳过 worker 派发（保留 readiness 推进）。
4. `src/server.mjs` + `core.mjs`：`POST /api/agents`、`/api/agents/:id/status`、`/api/agents/:id/report`、`GET /api/agents/ready`。
5. `dsh-plugin/index.js`：`team_create` 透传 runtime；`team_spawn` 调 `spawnTeammate` 并把 sessionId 回写；`team_task` 走 Host 调度器发消息；`agent/status` 监听 + 兜底完成；新增 `team_report_task` 工具。
6. 打通一个任务：成员真跑模型 → 任务 done → DAG/trace 出现成员节点与工具 span。
7. 更新 `docs/CONTRACT.md`、`README.md`、`dsh-plugin/README.md`，补 agent runtime 的测试（新 AC-15）。

### Subsequent

- LLM span（model/tokens/耗时）通过 `llm/stream` 或 `agent/request` 上报。
- 权限：agent 团队的 DSH 工具策略（替代 op broker 审批）。
- 恢复：sidecar 重启后 agent 成员的 `interrupt`/resume 策略。

### Blocked On

- 无阻塞；只差 `provider` 语义确认。

---

## Related Resources

### Documentation

- `docs/CONTRACT.md`（§3.4.1 Trace 瀑布、`/api/spans`、SSE `span.append`）
- `docs/adr/ADR-008-panel-in-gui.md`
- 参考实现：https://github.com/NanmiCoder/dsh-agent-teams（captain + continuable sub-agent，状态存 `<workspace>/.agent-teams/`）

### Commands

```bash
# 全量测试
node tests/run-all.mjs
node tests/routes-smoke.mjs
node tests/panel-contract.mjs

# 重建面板（Windows 需先改 TEMP）
cd src/web-ui
# PowerShell: $env:TEMP=(Resolve-Path .tmp).Path; $env:TMP=$env:TEMP
npx tsc -b && npx vite build

# sidecar 生命周期
node bin/dsh-team.mjs down
node bin/dsh-team.mjs up --port 4317 --data %USERPROFILE%\.dsh\team
curl http://127.0.0.1:4317/api/health
```

### Search Queries

- `spawnTeammate` — 找 DSH 内部实现与调用方（确认 provider 语义）。
- `agent/status` — 成员 idle/running 事件用法。
- `agent_session_id` — B 方案新增列。
- `runtime === 'agent'` — 调度器跳过点。

---

## Open Questions

> 现状：第一条（`provider` 语义）已解答——`provider` 是 subagent 提供者名（`'spawn'`/`'fork'`），详见 ADR-009 与文末补记。
> 其余三条仍开放（成员工具继承、idle 兜底摘要来源、越界审批是否必要）。

- [ ] `provider` 该传 provider id（如 `comfly`）还是路由名？成员模型如何指定（`spawnTeammate` 请求里没有 model 字段）？
- [ ] 成员 sub-agent 是否默认继承全部全局工具？`team_*` 会出现在成员工具清单里吗？
- [ ] 成员回合结束但未显式回报时，任务摘要从哪里取（最后一条 assistant 消息 / session log）？
- [ ] agent 团队的「越界审批」是否还需要？还是完全交给 DSH 的 approval/tool guard？

---

## Session Notes

- 用户明确选了 **B**（保留看板，把成员改成真 sub-agent），不是安装 dsh-agent-teams。
- 之前我用「真实 Agent 团队」命名过一个 worker 团队，属于误称；答复时已澄清。
- 面板截图与最终答复都已发给用户；本轮用户直接要 handoff，去新会话继续。
- 旧 handoff：`docs/handoffs/HANDOFF_DSH_TEAM_PLUGIN_10_28_20_54.md`（2026-10-28，架构部分仍有效）。

---

## 执行结果（2026-10-29 14:10，本 handoff 的落地记录）

B 方案已按上面 7 步全部落地：

| 层 | 改动 |
| --- | --- |
| `src/db.mjs` | `SCHEMA_VERSION=3`；`team.runtime`、`member.agent_session_id` 走 `ensureColumn` 轻量迁移；`idx_member_session` 移到迁移之后建（否则 v1 老库启动即报 `no such column: agent_session_id`） |
| `src/core.mjs` | `createTeam({runtime})`、`addMember({agentSessionId})`、`registerAgent/agentStatus/agentReportBySession/agentReady/dispatchAgentTask/pickIdleAgent/assertSessionOwner`；`trace()` 按 session 挂成员节点 |
| `src/scheduler.mjs` | `evaluate()` 在 `runtime==='agent'` 时只推进 pending→ready，跳过 worker 派发 |
| `src/server.mjs` | `POST /api/agents`、`POST /api/agents/dispatch`、`POST /api/agents/:memberId/status`、`POST /api/agents/:memberId/report`、`GET /api/agents/ready` |
| `dsh-plugin/index.js` | `team_create` 透传 `runtime`；`team_spawn` 真调 `ctx.agentTeams.spawnTeammate` 并回注 session；`team_task` 自动 dispatch + `sendMessage` 简报；`team_report_task`（归属校验）；`team_dispatch` 手动补派；`agent/status` idle 兜底并续派；`team_control interrupt` 走 `agentTeams.interrupt` |
| 文档 | `docs/CONTRACT.md` §3.8 + §7 测试约定；`README.md` 运行时/验证状态；`dsh-plugin/README.md`；新增 `docs/adr/ADR-009-agent-member-runtime.md` |
| 测试 | 新增 `tests/ac-15-agent-runtime.mjs`、`tests/plugin-agent.mjs`、`tests/db-migration.mjs`、`tests/plugin-client.mjs`；`tests/run-all.mjs` 纳入非 AC 脚本 |

**验证**：`node tests/run-all.mjs` → **22/22 PASS**；`node demo/run-demo.mjs` 全绿（DAG/interrupt/resume/审批/事件重建）。

**已知边界**：运行中的 DSH Host 缓存旧插件模块，「真模型成员跑完一个任务」的整链需重启 DSH 后验证一次（重启后按 `team_create(runtime:"agent") → team_spawn → team_task` 走一遍，看板应出现成员会话节点 + 工具 span）。`~/.dsh/team` 的 v1 库已在本次执行中自动迁移到 v3（4 个旧团队默认 `runtime=worker`，数据保留）。

**provider 结论**：`SpawnTeammateRequest.provider` 是 **subagent 提供者名**（`'spawn'` / `'fork'`），不是模型 provider id；默认按 `context` 选（`fresh→spawn`、`fork→fork`），可用配置 `freshProvider`/`forkProvider` 覆写（详见 ADR-009）。

## 执行结果补记（2026-10-29 14:20，真机联调后的实现修正）

重启 DSH 后按上面流程跑真机，`team_spawn` 立刻报 **「agentTeams 服务不可用」**：本 profile 的 bundle 列表里没有
`@deepseek-ai/dsh-experimental-agent-team-profile`（README 里已记录它被移除），所以 `ctx.agentTeams` 在宿主
运行时是 `undefined`；`cordis_inspect_query` 返回的 `agentTeams` 方法表只是**包声明的类型清单**，不代表该服务已挂载。

改用宿主**必然已挂载**的 `subagents` 服务（`dsh-subagent` bundle），语义等价且更底层：

| 原设计 | 现实现 |
| --- | --- |
| `agentTeams.spawnTeammate(lead, {name, description, prompt, context, provider})` | `subagents.startActivation({delivery:'parent', childId, provider, label, request:{prompt, parent: caller, cwd: team.workspace}, signal})` |
| `agentTeams.sendMessage(lead, {target: name, content})` | `subagents.sendMessage(lead, sessionId, content, {signal})` |
| `agentTeams.interrupt(...)` | `subagents.interrupt(lead, sessionId, reason)` |

`spawnTeammate`/`sendMessage` 两个**工具名**不变（模型侧接口稳定）；`subagents` 用 `ctx.get('subagents')` 探测而非
`inject` 硬依赖，缺失时只有 agent 团队报可读错误。`tests/plugin-agent.mjs` 的假 ctx 已改为 mock `subagents`（`startActivation/sendMessage/interrupt/list`）。

**真机验证（2026-10-29 本机 4317 侧车，团队 `team_mvt5atfv1b4fe`）**：
`team_create(runtime:"agent")` → `team_spawn`（子会话 `72f49840-f57d-4778-b0fa-0ade28ed8cb1`）→ `team_task` →
简报进成员信箱 → 成员用 `pwsh` 写出 `hello.txt` → `team_report_task` 回报 `done` → 任务 5.6s 内 `done`、成员回 `idle`；
第二次 `team_task` 唤醒**同一成员复用**追加第二行，同样 `done`；`GET /api/trace` 出现 `agent → subagent` 节点树
（86 spans、12 条挂在成员节点下）。**一句话：真 sub-agent 成员的整链已跑通。**

**注意（插件热更新）**：改 `dsh-plugin/index.js` 后，运行中的 Host 不会重新 `import`（缓存旧模块）。
不必重启 DSH 的等效操作：`plugin_manager(action:"set_plugin", target:"include:dsh-team", enabled:false)` 再 `enabled:true`
——本会话正是用这一招让新代码生效并完成上述真机验证。

## 执行结果补记 2（2026-10-29 15:00，成员对话可观测 + 模型易用性）

本轮两件事：① 用户问「怎么把成员的对话开到 DSH 独立面板」，落地成**会话右上角团队成员条**（AC-16）；
② 用户反馈「AI 建团队总要先摸索」，落地成**工具描述重写 + 新 skill**。

### 1. 会话右上角「团队成员」条（AC-16）

内置机制（不需要自研面板）：DSH 自带 `subagentchat` 资源 + 右侧栏：

```js
const url = `dsh-resource://subagentchat/session/${child}?parent=${parent}&mode=${mode}`;
ctx.sidebarRight.openResource(url, { kind: 'subagentchat', preferNewPane: true });
```

- 地址优先 `ctx.sessions.subagentAddress(childSessionId)`（返回 `{parentSessionId, childSessionId, mode}`），
  拿不到就手拼 `mode:'continuable'`；没有 `sidebarRight` 时回退 `uiWorkspace.openSession(childSessionId)`。
- 组件挂在 slot `conversation.session.header.utilities`（右对齐、session 作用域），props 带 `{sessionId, useSessions}`。
  用 `useSessions(s => s.byId)` 过滤 `parentId === sessionId && origin === 'subagent'`，running 优先、`updatedAt` 倒序。
- 成员名与 sidecar 状态来自 `/api/teams` + `/api/teams/:id/members`（15s 缓存、并发去重、失败静默降级，不阻塞对话头）。

实现位置（`dsh-plugin-ui/client.js`）：`DICT` 6 个键（`members_title/members_running/members_idle/members_open/members_empty/members_running_count`）、
CSS `.dsht-members/.dsht-chip/.dsht-dot(.is-running)/@keyframes dsht-pulse`、`loadMembers()`、`memberAsideUrl()`、
`openMemberAside()`、`memberStrip()`，以及**独立的第二个 effect** `ctx.effect(..., 'dsh-team-ui.member-strip()')`
（必须排在 entry effect 之后，`tests/plugin-client.mjs` 断言 `effects.length === 2` 且每个 disposer 可调用）。

测试：新增 `tests/ui-member-strip.mjs`（vm 里跑真实 `client.js`，stub React + ctx），覆盖注册点/slot id/order、
只数本会话的 agent 子会话、running 排最前、点击 URL 与 `{kind:'subagentchat', preferNewPane:true}`、`subagentAddress` 优先、
无 `sidebarRight` 回退、空态返回 `null`。`node tests/run-all.mjs` → **23/23 PASS**。

**未完成**：真机 UI 未亲眼确认。CDP 里唯一页面是 affectui；开 `http://127.0.0.1:3080` 被
`dsh web authentication required` 拒绝（cookie 由 `dsh web` 打印的 launch token 现场签名，外部拿不到），
只能请用户刷新页面看右上角是否出现 chip。若没出现：用 `cordis_inspect_query` 查 slot
`conversation.session.header.utilities` 是否被 `dsh-team-ui` 注册（预期 id `dsh-team:members`、order 5）。

### 2. 模型易用性：工具描述 + skill

摸索的三个真实原因：`runtime` 默认 `worker`（成员不会思考，给自然语言任务会「跑完 0 步」）；
id 藏在 `result.team.id` / `result.member.id`；工具名本身没有顺序语义。

- 重写 3 个**常驻**描述（杠杆最大，每次都在上下文里）：`dsh-plugin/index.js:342` `team_create`（`START HERE` + 五步顺序 +
  `runtime` 两种取值的后果 + 显式「用户说 create an agent team 就传 `runtime:"agent"`」+ 末尾指向 skill）、
  `:379` `team_spawn`（返回的 `member.id` 就是后面 `assignee` 要的值）、`:519` `team_task`（简报必须自包含，成员看不到 Lead 对话）。
- 新 skill：[`skills/dsh-agent-team/SKILL.md`](../../skills/dsh-agent-team/SKILL.md)（10 个工具清单、agent/worker 决策表、
  最小配方含取 id 写法、字段陷阱、拆任务/并发/依赖、症状→修法表、观察与收尾）。
  已复制到 `~/.dsh/skills/dsh-agent-team/SKILL.md`，**会话技能目录即时刷新**，无需重启。
- 文档：`dsh-plugin/README.md` 新增「调用顺序写在哪（别让模型自己摸）」；根 `README.md` 目录表加 `skills/` 行 +
  「模型怎么学会用法」要点。

### 3. 经验（下次直接复用）

- 插件热更新：`plugin_manager(set_plugin, target:"include:dsh-team", enabled:false)` → `true`；客户端 bundle 由
  `dsh-client-modules` 按 **mtime** 取，刷新页面即生效。
- **不要重启 DSH**：用户明确说过会中断当前会话（m00894）；等效用上面的禁用/启用。
- 本机 CDP 无法自行登录 DSH Web（launch token 现场随机），UI 类改动只能请用户刷新确认。

### 4. 待办

- [ ] 用户确认右上角成员条出现；未出现则排查 slot 注册（见上）。
- [ ] worker 运行时成员没有 DSH 会话，故不显示 chip；若希望也展示，需要改成「只读状态 chip（不可点）」。
- [ ] 往后改 `team_*` 工具面时，同步 `skills/dsh-agent-team/SKILL.md`，否则 skill 会悄悄过期。

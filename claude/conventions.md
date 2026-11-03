# 开发约定

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 常用命令

| 目的 | 命令 |
|---|---|
| 起 sidecar（前台） | `npm start` → `node bin/dsh-team.mjs up` |
| 起 sidecar（后台） | `node bin/dsh-team.mjs up --port 0 --data /tmp/x`（前台会阻塞，脚本里读第一行 JSON） |
| 停 sidecar | `node bin/dsh-team.mjs down` |
| 团队看板 | `node bin/dsh-team.mjs status <teamId> [--json]` |
| DAG | `node bin/dsh-team.mjs dag <teamId> [--json]` |
| 成员日志 | `node bin/dsh-team.mjs logs <memberId> [-f] [--since N]` |
| 审批越界 | `node bin/dsh-team.mjs approve <requestId> [--deny] [--reason TEXT] [--ttl SEC]` |
| 导出报告 | `node bin/dsh-team.mjs report <teamId> -o run.md` |
| 全量测试 | `npm test` → `node tests/run-all.mjs` |
| 单条验收 | `node tests/run-all.mjs --only ac-05` |
| 演示 | `npm run demo` → `node demo/run-demo.mjs` |
| 面板开发 | `cd src/web-ui && npm run dev`（5183，`/api` 代理到 4317） |
| 面板构建 | `cd src/web-ui && npm run build`（输出到 `src/web/`） |
| 类型检查 | `cd src/web-ui && npx tsc -b` |

## 代码风格

- ESM only（`type: module`），`import` 必须带 `.mjs` 扩展名。
- 参数校验集中在 `src/util.mjs` 的 `arr/int/bool/parseJson`，不要各写各的。
- 抛错统一 `ApiError` + `ERR.*` 常量（`src/util.mjs`）；HTTP 层只负责把它转成 `{error:{code,message,detail}}`。
- 时间一律走 `now()/nowIso()`；ID 走 `newId(prefix)`；哈希走 `sha256()`；路径走 `toPosix()` + `resolveInWorkspace()`（防越界）。
- 脱敏只走 `redactor()/createRedactor()`；命中 `isSensitiveName()` 的键输出 `REDACTED = '<redacted>'`。
- 事务包 `tx(db, fn)`；跨表写必须同一个事务（见 C4）。
- 面板侧：`@/` 别名指向 `src/web-ui/src`，组件用 coss ui（`components/ui/`），不引入其他 UI 库。

## 禁止事项

- 不新增后端第三方依赖（见 ADR-001）。
- 不直接 `UPDATE member_state`，改状态走 `EventStore.append()`（见 C2）。
- 不在 `broker.mjs` 之外做文件/exec/net/env IO（见 C1）。
- 不手改 `src/web/assets/*`；不把 `src/web-ui/node_modules` 带进提交。
- 不把 sidecar 绑到 `0.0.0.0`（默认免鉴权）。
- 不在日志/事件/报告里打印 token、API Key、敏感 env 明文。
- 不执行破坏性 git 操作（`reset --hard`、`checkout .`、强推）。

## 兼容性提醒

- Node **>= 22.15**，依赖 `node:sqlite`（WAL）与 `module.registerHooks`；低版本直接起不来。
- `node --permission` 的参数形态随 Node 版本变过；worker 启动参数只在 24.x 验证过。
- 换行必须 LF（`.gitattributes`）；`bin/*.mjs` 混 CRLF 会让 `npm pack`/安装失败。
- 面板 iframe 嵌入时 API 前缀是 `/dsh-team-api`（Host 代理），直接访问 sidecar 时是同源 `/api`；`src/lib/api.ts` 用 `?api=` 参数区分。
- `src/web/` 只提交 `panel.html` + 引用的那两个 assets；其余是构建垃圾。

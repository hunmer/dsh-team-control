# broker 与权限接口

## 四域 op 语义

| domain | op | 参数要点 | 越界目标形态 |
|---|---|---|---|
| `fs` | `read` / `write` / `delete` / `rename` / `list` | `path`（相对 workspace，经 `resolveInWorkspace` 归一） | `path` glob |
| `exec` | `spawn` | `argv[]`、`cwd`、`timeoutMs` | argv 前缀 / 命令名 |
| `net` | `connect` | `url`、`method`、`headers`、`body` | `host:port` |
| `env` | `read` / `write` | `name` | 变量名 |

`authorize(subject, {domain, op, target, args})` → `{allow, reason, grant?}`；被拒抛 `E_DENIED` 并携带 requestId。

## 求值顺序（`policy.evaluate`）

```text
1. 显式 deny 规则命中        → DENY        // 最高优先；team 级 deny 覆盖 member 级 allow
2. 未过期且未用尽的 grant    → ALLOW       // 单次授权，用完即失效
3. 显式 allow 规则命中       → ALLOW       // 多条合并取「最严」
4. 无命中                    → DENY        // 默认拒绝
```

最严合并（`mergeConstraints`）：`maxRuntime` 取 **min**、`method` 与 `argv` 取**交集**、`readOnly` 取 **or**（任一要求只读即只读）。

目标匹配：`normalizeTarget()` 先归一（POSIX 分隔符、去 `./`、绝对路径转 workspace 相对），再 `matchTarget()` 按 glob 比对；主体匹配 `subjectMatches()` 支持 `team | member | role` 三种 `subject_type`。

矩阵展示：`matrixSummary()` 供 `GET /api/permission-matrix`，把「规则 + grant + 默认」压成每格的最终效果。

## 越界申请闭环（C4）

```text
broker.fsWrite(...) → authorize 拒 → E_DENIED
  → 同事务：scope_request(pending) + member→blocked + event(scope.request) + SSE
  → worker 侧 scope.request 长轮询阻塞

decide(requestId, {decision, decidedBy, reason, ttlSeconds, singleUse})
  → 一个事务：decision + scope_grant + event
  → grant 生效（默认 singleUse=true，TTL 有限）
  → worker 长轮询返回，重试原 op → 成功 → audit 记 before/after sha256
```

**关键**：决策必须落盘为 `decision` 行；消息/SSE 只是通知，不是真相。进程重启后凭 `decision` + `scope_grant` 仍可复算。

## 审计字段（`audit` 表）

`actor`（team/member）、`domain`、`action`、`target`、`before_sha`、`after_sha`、时间戳。
`team_report` 工具导出的 Markdown 报告里的 audit 表就是这张表的投影（含完整前后哈希），可用来自证「谁改了哪个文件」。

## 脱敏

`redactText()` / `redactor()`：命中 `isSensitiveName()` 的键（token/secret/password/key 等）与明文值统一输出 `REDACTED = '<redacted>'`。
**这是全局不变量**：event payload、audit detail、message body、SSE 帧、日志、报告都必须过一遍。

# ADR-015：审批降噪、运行中热改权限与规划失败复活

- 状态：已接受
- 日期：2026-11-11
- 关联：`docs/CONTRACT.md` C3 / §3.6.1 / `tests/plugin-approval.mjs` / `tests/plugin-agent.mjs` / `tests/ac-18-board.mjs`

## 背景

三个实际使用中的问题：

1. 规划会话被用户手动停止后，idle 宽限（`boardIdleGraceMs`）把任务判 `failed`；用户继续会话时
   `user/message` 又把任务翻成 `inprogress`，而 `submitPlan` 只认 `planning`，提交计划报 404。
2. `team_approve` 噪声大：审批几乎全部来自成员跑 `npm test`、`git status` 这类普通命令时的沙箱升级，
   Lead 被反复打断。
3. 成员运行中想调整权限，`team_member` 直接要求先 `interrupt`，打断正在进行的回合。

## 决策

- **规划失败可复活**：`submitPlan` 按 `planning_session_id` 找 `status IN ('planning','failed')` 且未封存的
  任务；复活成功时事件带 `recoveredFrom:'failed'`。看板会话在 `planning` 阶段收到 `user/message` 不再
  上报 `inprogress`，避免把 `failed` 提前翻走。
- **低风险命令自动放行**：插件在 `tools/pre-execute` 按 `callId` 缓存成员工具入参（5 分钟 TTL、上限 500），
  审批到来时若工具名像 shell、参数含字符串 `command`，且命令满足「程序白名单 + 无管道/重定向/命令替换 +
  不命中敏感规则」，直接返回 `allowed-once`，并镜像 `decidedBy:"auto"`，不通知 Lead。
  判定是启发式，宁可漏放行（转 Lead）也不误放行；配置键 `autoApproveLowRisk`（默认 `true`）与
  `sensitiveCommandPatterns`（追加正则，默认 `[]`）。
- **运行中热改权限**：`team_member({action:"update"})` 在成员 `running/provisioning/blocked` 时允许只改
  `role` / `permissionPreset`；sidecar 放行 hot-only PATCH，插件对 live session 直接
  `permissionPresets.set`。换模型/上下文/组合仍要求先 `interrupt`。

## 权衡

- 自动放行依赖 `pre-execute` 能拿到参数；拿不到、工具名不像 shell、命令含管道/重定向时一律退回人工审批。
- 白名单里的解释器（node/python 等）带 `-e/-c` 视为任意代码执行，不自动放行；`npm install` 等仍会放行，
  因为其脚本执行属于常规开发路径，且命令本身不命中敏感规则。
- 热改权限只对 DSH 预设服务可用的宿主生效；服务缺失时返回既有 warning，不阻断任务。

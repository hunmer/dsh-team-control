# src/ 常见问题

**任务建好了但一直 `pending`，不派发**
`readiness()` 判依赖 → 依赖没满足就一直等；检查 `dep` 表是否真的有边、`condition` 是否写错（`all_success` 要求**全部**上游 done）。另：`settleMs=200ms` 的 settle 窗口内不派发，属正常。

**依赖都满足了还是不动**
`pickIdleMember()` 找不到空成员：上限打满、全员 `running|blocked`、或 `retired`。看 `GET /api/blockers`。

**`E_CYCLE`**
`addDep` 前会 `findCycle`；报错说明新边形成环。DAG 必须无环。

**worker 活了但不发请求**
bundle 首行 `module.registerHooks` 白名单只有 `node:module`——若 worker 代码试图 `import` 别的东西，会在启动期就失败。看 `home/workers/<member>/` 的 stderr。

**`process.binding is not a function` 之类**
说明有人在 worker 里绕过了中和层。worker 里唯一合法的 IO 是 stdio NDJSON。

**`interrupt` 后成员还是 `running`**
C5 被破坏：`interrupt()` 必须是「事务提交 → 再 `kill`」。若在事务内杀进程，`member_state` 的 `interrupted` 写不进去。

**`/api/reconcile` 和 `/api/verify` 做什么**
`verify` 查 `member_state.seq == max(event.seq)` 与租约一致性；`reconcile` 在发现漂移时给出修复建议（不自动改）。`/api/status` 的 `degraded` 就是 `verify` 的结论。

**`llm.mjs` 会去调模型吗**
不会。它只存 provider/route 与启停开关，`GET /api/llm/models` 读它。真正的模型调用发生在 DSH 宿主侧（`dsh-plugin` 记 token 用量）。

**改了 `settleMs` 之后测试大面积挂**
`ac-05` 及派发相关用例依赖这个窗口。先看 ADR-005，再一起调 `tickMs`。

**日志在哪里**
`log()` 回调进 `home/logs/`；worker 自己的输出在 `home/workers/<member>/`。**不要往 stdout 打**，会破坏 ready JSON。

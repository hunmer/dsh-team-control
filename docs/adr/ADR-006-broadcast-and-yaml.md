# ADR-006：广播/请求-响应的最小实现；topic 订阅与 YAML 导入导出延后

- 状态：已接受（范围裁剪，记 backlog）
- 日期：2026-10-28
- 关联：FR-4.4 / D-12

## 背景

FR-4.4 要求「广播（topic 订阅）与 request/response（超时 + 重试）」；D-12 要求「团队定义支持 YAML 导入/导出」。

## 决策

- **广播**：`to:'*'` 扇出到团队内除发送者外的全部成员，逐条持久化（离线不丢）。**未实现 topic 订阅**（需要订阅表 + 过滤器语法）。
- **请求-响应**：`MessageBus.request()` 生成 `correlationId`，持久化请求，按 `timeoutMs + retries + retryDelayMs` 等待同一 correlation 的 `response|note` 消息；Worker 侧暴露为 `msg.request` RPC。响应同样持久化，可按 correlation 查询。
- **YAML 导入导出**：未实现。当前团队/任务/依赖的创建走 REST；导出报告为 Markdown。

## 后果

- ✅ FR-4.4 的 request/response 与广播语义可用且持久；`/api/messages?correlation=` 可查配对。
- ⚠️ topic 订阅、YAML 导入导出属于 M3 可用性范围，未覆盖；不阻塞任何 AC。按 brief「不在 PRD 之外自创需求 / 冲突取成本更低者 + ADR」处理。
- ➜ 扩展点：`message` 表加 `topic` 列即可支持订阅过滤；YAML 可在 `core` 增 `exportTeam()/importTeam()`，序列化 team/members/tasks/deps 四张表。


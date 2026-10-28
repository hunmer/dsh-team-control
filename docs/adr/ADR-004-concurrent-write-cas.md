# ADR-004：并发写采用 CAS + 退避重试，未实现路径租约

- 状态：已接受
- 日期：2026-10-28
- 关联：C3 / FR-3.6 / AC-5

## 背景

brief 第 6 节要求「并发写靠重试一次 → 退避 + 可配置上限；≥3 写者考虑租约」。PRD FR-3.6 要求「同路径并发写：版本校验 + 可选路径租约；冲突按退避重试（上限可配）」。

## 决策

- 所有写经 `PermBroker.fsWrite()`，在 DB `file_state` 维护 `version/hash`；请求可带 `expectVersion`，不匹配返回 `E_VERSION` 并附当前版本。
- 写操作为「临时文件 + rename」原子替换；version 自增与 audit 在同一事务。
- Worker 内置 `fs.append` 原语：读 → 拼接 → CAS 写 → 冲突指数退避（`retries` 可配）。这是 AC-5 的收敛原语。
- **路径租约未实现**：CAS 已经保证「零丢更新」；租约需要额外的租约表、续租、死锁回收，收益仅是减少重试次数。按 brief「取实现成本更低者 + 写 ADR」处理。

## 后果

- ✅ AC-5 三人并发 × 20 轮零丢更新；`metrics.conflicts` 可见重试压力与 `conflictRate`。
- ⚠️ 高冲突场景（>8 写者同文件）重试次数上升；`retries` 上限与退避基数是可配参数，超限会显式失败而不是静默覆盖。
- ➜ 后续如需租约，扩展点：`file_state` 增加 `lease_owner/lease_until` 并在 `fsWrite` 前置检查，不影响现有 API。


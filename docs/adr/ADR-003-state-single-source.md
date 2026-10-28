# ADR-003：状态只存一份（member_state 为唯一状态源，租约移出）

- 状态：已接受
- 日期：2026-10-28
- 关联：C2 / FR-5.5 / AC-9

## 背景

PRD §5 的 `member` 表含 `status / lease_until / current_task_id / current_step_seq`，同时又要求 `member_state` 可由 `event` 完全重建。若两处都存 `status`，二者必然漂移；若把 `lease_until` 放进 `member_state`，它又无法由事件重建（租约每 5–15s 续一次，写成事件会让事件流爆炸）。

## 决策

把成员状态拆成三张表，职责互斥：

- `member`：**身份与配置**（name/role/model/context_mode/default_plan），无 `status`。
- `member_state`：**事件可推导的投影**（seq/step/phase/status/last/next/blockers/as_of/stale）——只允许 `EventStore.append()` 在同一事务里更新。
- `member_runtime`：**易失运行时**（lease_until/pid/started_at），明确声明「不可由事件重建」，重启即从租约过期逻辑收敛。

## 后果

- ✅ `rebuild()` 与 `append()` 共用同一个纯函数 `project()`，结构上不可能分叉；`/api/verify` 逐字段深比较，长期为 `ok:true`。
- ✅ `member_state.seq == max(event.seq)` 是硬不变量；不等则 `stale=1` 并告警（FR-5.5）。
- ⚠️ PRD 的 `member.status` 列位置偏离（语义不变）。已在本 ADR 记录，非静默改动。
- ⚠️ 查询「成员 + 状态 + 租约」需要三表 JOIN；已封装在 `core.memberView()`，API 形状不变。


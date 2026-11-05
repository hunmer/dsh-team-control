# ADR-013：显式记忆——一条记忆一个文件，索引在内存，记忆 id 脱离团队

- 状态：已接受
- 日期：2026-11-05
- 关联：`docs/CONTRACT.md` §3.14 / `src/memory.mjs` / `tests/ac-19-memory.mjs` / `tests/plugin-memory.mjs`

## 背景

团队跑任务时，成员收工后把「接口约定、踩过的坑、决策理由、未决问题」留在自己的上下文里，
下一个成员（甚至另一个团队的成员）看不到。用户要的是：

- 每个成员一块可存多条信息的 key-value 空间，团队一块共享空间；
- 成员收工时把有价值的 handoff 存进自己的空间；收到 Lead 要求时再上传到团队空间；
- 持久化到文件，**不要保存到数据库**；
- 记忆不跟 team/member 绑定，每条有独立 id，之后可以把 id 交给其他团队的成员读取。

同时 PRD D-7 写的是「成员复用，但按任务隔离上下文，不保留对话记忆」。本功能是**显式记忆**，
不是把对话历史保存下来再接回去；D-7 原文不改，避免把「自动记忆」也当成已承诺能力。

## 决策

- **正文文件是唯一真相**：`<home>/memory/objects/<memoryId>.json`，一条一个文件，人类可读可手改；
  文件里**只写事实**（id/key/kind/title/value/tags/visibility/时间/version），
  不写 `teamId`/`memberId`/`scope`/`source`——这样一条记忆拷到任何团队都只靠 id 就能读。
- **归属放 team 数据**：SQLite 表 `memory_link(memory_id PRIMARY KEY, team_id, scope, member_id, task_id, created_at)`
  只记「这条记忆属于哪个团队/成员空间」，不存正文。用户明确允许「team 数据记录每个 member 随机分配的 memoryId」，
  与「记忆不要保存到数据库」不冲突：数据库里没有正文。删团队只删 link，文件保留。
- **内存索引只做加速**：记录表按 id 扫目录重建；key 唯一性按空间 `scope:teamId:memberId` 归并，
  空间由 core 从 `memory_link` 灌入（`bind()`），不落文件。扫描失败/损坏文件记日志跳过，不阻塞启动。
- **写入原子性**：同目录 tmp 文件 + `rename` 替换；`expectedVersion` 做 CAS，冲突 409，避免两个成员
  同时覆盖同一个槽位。
- **两条空间、一个 id 空间**：`scope=member|team` 只决定归属，记忆 id 全局唯一且独立于团队；
  团队删除不级联删文件。`visibility=shared` 时，任意团队的成员可凭 id 读取，为跨团队交换预留。
- **对外字段改名 `slot`**：全局脱敏规则会把任何名字含 `key` 的字符串字段替换成 `<redacted>`，
  文件里仍叫 `key`，API 出口一律叫 `slot`，否则面板和工具结果全是打码值。
- **只记录不注入**：不自动把记忆塞进 spawn/派发 prompt；只在 `taskBrief` 里加一句轻引导，
  成员自己决定写不写。没有可复用结论就跳过，不强制、不做兜底快照。
- **成员可直接写团队空间**：不必先上传到私有再分享；`source.memberId` 记录谁写的，Lead 可删。
  成员只能写自己的 member 空间，防止互相覆盖。
- **脱敏不变量不破**：文件里原样保存；API/SSE/日志/报告出口继续走全局 redactor。

## 备选方案与被否决的原因

1. **存 SQLite 新表**：查询、事务、级联都更顺手，但用户明确要求「持久化到文件，不要保存到数据库」；
   且记忆要能脱离 sidecar 生命周期被手改/带走 → 否决。
2. **所有记忆一个 JSON 大文件**：写入要整文件重写，并发和损坏半径都大；一条一文件可以只替换单条、
   单条损坏不影响其他记忆 → 否决。
3. **记忆绑定 memberId 做主键**：成员被删除/复用后 id 失效，且无法把一条记忆交给别的团队 → 否决；
   改为独立 `mem_*` id，归属只放 `memory_link`。
3.1. **把 teamId/memberId/scope 写进记忆文件**：实现简单、无需索引表，但用户要求文件只存事实、
   不要绑定团队/成员 → 否决（本 ADR 上一版即此方案，已按用户口径改掉）。
3.2. **归属只放 sidecar 内存/一个大 JSON 索引文件**：sidecar 重启后归属丢失，且团队删除无法精确解绑；
   放进 team 数据（SQLite）最贴合「team 记录 member 的 memoryId」 → 采纳。
4. **自动快照成员对话/上下文**：用户明确「非必要不做」，而且会把 D-7 的「按任务隔离上下文」变成空话；
   本 ADR 只承诺显式写入 → 否决。
5. **写入前做内容审核/敏感值过滤**：文件层不做内容校验（用户要求「不限制」）；出口脱敏已覆盖泄漏面，
   入口过滤只会让成员写不进真实结论 → 否决。

## 后果

- 新增 5 个工具：`team_memory_write/read/list/share/delete`，`team_*` 工具从 14 个变 19 个。
- 新增 7 条 REST（`/api/memory...`）与 SSE 合成帧 `memory.updated`（只带 id/scope，不带正文）。
- 面板新增「记忆」页签（`#/w/<ws>/t/<team>/memory`）：scope 切换、类型过滤、搜索、详情、改可见性、删除。
- 记忆总量与单条大小有上限（5000 条 / 64KB），超限显式报错，不做静默截断。
- 团队/成员删除后记忆文件仍在磁盘上（link 已删，成为孤儿文件）；面板与 Lead 仍可按 id 读取。
  需要清理时用 `POST /api/memory/prune`（`confirm=true`，可带 `ids` 只清指定项）或直接删目录。
- `memory_link` 是唯一需要备份的归属信息；只拷 `memory/objects/` 仍能保住正文，但会丢失空间归属。

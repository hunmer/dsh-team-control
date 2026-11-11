# 变更记录（本套索引）

> 只记录索引/文档的生成与更新，不记录产品 Changelog。倒序，最多 5 条。

## 2026-11-11 · 面板指标与任务重置

- 面板：`agent-steering` 底部展示轮数/步数、tok/s、token 总量、缓存命中、上下文占用（数据来自 `sessionStats` + `tokenUsage` 投影→`context_snapshot.stats_json`）；`app-shell` 窄屏隐藏侧栏与 trigger；`Timeline` 去掉内部滚动；任务菜单新增仅 failed/done 可用的「重置」（`POST /api/board/tasks/:id/reset`）。
- 索引：`claude/public-interfaces.md`、`claude/data-model.md`（schema v17 + `stats_json`）、`claude/dependencies-and-config.md`、`claude/entrypoints.md`、`claude/testing-and-quality.md`、根 `CLAUDE.md` 资产 hash 同步；全量 `npm test` 33/33。

## 2026-11-05 · 深挖（第二阶段）

- `dsh-plugin/claude/overview.md`：新增「关键内存态」（leadByTeam/heldSessions 等）与「逐工具实现速查」（16 个工具的 sidecar 端点、route 合并、审批/冻结机制）两大节；`public-interfaces.md` 工具表补齐 board 两工具、标题改 16 个工具。
- `src/web-ui/claude/overview.md`：视图表按实际重写（Board.tsx=Trace 瀑布、BoardPage/TasksView=工作区看板），TAB_NAMES 修正为实际 8 个；新增手写路由与 `lib/board.ts` 看板 API 两节；store.tsx 深读（SSE 帧/去抖/轮询/Trace 分页/竞态约定）。
- `src/web-ui/CLAUDE.md`、`dsh-plugin/CLAUDE.md`：扫描状态更新为"含深读"；剩余未逐行仅 `views/Home.tsx` 与 `tasks/TasksView.tsx` 内部。

## 2026-11-05 · 增量更新（对应 v0.2.0）

- 根 [`CLAUDE.md`](../CLAUDE.md)：资产 hash 更新（`app-BWq-9mG2.js`/`panel-l54G6Q6n.css`）、schema v9→v14、ADR 11→12、扫描状态刷新。
- `claude/data-model.md`：schema v12→v14；新增看板状态机小节（`BOARD_STATUSES`、claim/stopTask 联动）。
- `claude/file-map.md`：目录树整体重写（删 policy/broker/runner/worker，新增 `src/board.mjs`；`dsh-plugin/index.js` 3484 行 16 工具；tests 31 脚本；ADR-012）。
- `claude/module-responsibilities.md` / `claude/entrypoints.md` / `claude/overview.md` / `claude/public-interfaces.md` / `claude/conventions.md`：清理 v2 已移除的 worker/broker 残留描述，补 `/api/board/**` 路由与 ADR-012，CLI `approve`→`approvals`。
- `src/CLAUDE.md`、`dsh-plugin/CLAUDE.md`：版本号与扫描状态同步。

## 2026-11-01 · 首次生成

- 新增根 [`CLAUDE.md`](../CLAUDE.md)（轻量索引）+ `claude/` 11 份详情文件。
- 新增 5 个模块索引：`src/`、`src/web-ui/`、`dsh-plugin/`、`dsh-plugin-ui/`、`tests/`。
- 扫描依据：`docs/CONTRACT.md`（405 行）全文、`src/*.mjs` 全部、`bin/dsh-team.mjs`、`dsh-plugin/index.js` 结构、`dsh-plugin-ui/{index,client}.js` 结构、`src/web-ui/src` 结构、`tests/lib/harness.mjs` 导出、`docs/adr/` 11 份标题、`prd/` 摘要。
- 未覆盖：`src/web-ui/src/views/Home.tsx` 与 `store.tsx` 未逐行读；`docs/handoffs/` 正文未展开；`src/web/assets` 产物内容不读。
- 发现待修正：README 与 `skills/dsh-agent-team/SKILL.md` 仍写「11 个 `team_*` 工具」，实际为 12 个（含 `team_todo`）。

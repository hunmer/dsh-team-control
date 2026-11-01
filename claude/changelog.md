# 变更记录（本套索引）

> 只记录索引/文档的生成与更新，不记录产品 Changelog。倒序，最多 5 条。

## 2026-11-01 · 首次生成

- 新增根 [`CLAUDE.md`](../CLAUDE.md)（轻量索引）+ `claude/` 11 份详情文件。
- 新增 5 个模块索引：`src/`、`src/web-ui/`、`dsh-plugin/`、`dsh-plugin-ui/`、`tests/`。
- 扫描依据：`docs/CONTRACT.md`（405 行）全文、`src/*.mjs` 全部、`bin/dsh-team.mjs`、`dsh-plugin/index.js` 结构、`dsh-plugin-ui/{index,client}.js` 结构、`src/web-ui/src` 结构、`tests/lib/harness.mjs` 导出、`docs/adr/` 11 份标题、`prd/` 摘要。
- 未覆盖：`src/web-ui/src/views/Home.tsx` 与 `store.tsx` 未逐行读；`docs/handoffs/` 正文未展开；`src/web/assets` 产物内容不读。
- 发现待修正：README 与 `skills/dsh-agent-team/SKILL.md` 仍写「11 个 `team_*` 工具」，实际为 12 个（含 `team_todo`）。

# tests/ · 验收与回归

## 项目简单介绍

`tests/` 是 dsh-team 的验收套件：全部**真子进程 + 真 HTTP/SSE**，禁止 mock sidecar。`run-all.mjs` 顺序跑 `tests/*.mjs`，每条脚本自己建临时 workspace/data、起 sidecar（`--port 0`）、跑断言、收尾清理。AC-01~AC-19 对应 `docs/CONTRACT.md` 的验收条目（AC-18 为工作区看板，AC-19 为显式记忆）；另有插件/面板/路由/CLI/迁移/计价/todo-plan 等专项脚本，共 33 个。

插件类脚本（`plugin-*`）不拉真 sidecar，用**假 ctx** 捕获工具注册与调用（AC-15 是典型）。

## 约定的规则

- 新增脚本放 `tests/`，命名 `ac-NN-<topic>.mjs` 或 `<area>-<topic>.mjs`，会被 `run-all.mjs` 自动拾取。
- 必须输出 `PASS <id> <detail>` / `FAIL <id> <reason>`，失败用非零退出码。
- 临时目录用 `os.tmpdir()/dsh-team-ac<NN>-<rand>`；**成功时删除，失败时保留并打印路径**。
- 只通过 `lib/harness.mjs` 交互（`startSidecar` / `apiClient` / `waitFor` / `sseOpen` / `readDb` / `runAc`）。
- 禁止依赖固定端口（一律 `--port 0` + 从 ready 行读端口）。
- 禁止把「等一会儿」写死成 `sleep(3000)`；用 `waitFor(cond, timeout)`。
- 单跑：`node tests/run-all.mjs --only ac-05`。

## 文件索引

| 文件 | 用途 | 何时阅读 |
|---|---|---|
| [harness 与脚本矩阵](claude/overview.md) | harness 全部导出、每条脚本覆盖什么 | 加测试或定位失败 |
| [常见问题](claude/faq.md) | 抖动/残留/端口类问题 | 测试不稳时 |

## 扫描状态

- 更新时间：2026-11-05（增量）
- 已扫描：`run-all.mjs` 机制（顺序执行、`--only` 过滤、PASS/FAIL 契约）；`lib/harness.mjs` 全部导出与 `startSidecar` 实现要点；全部脚本文件名与覆盖主题。
- 未逐行：各 AC 脚本内部断言细节。
- 下一步：改契约时按 `ac-NN` 编号对照 `docs/CONTRACT.md` 的验收表逐条核。

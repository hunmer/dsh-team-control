# 测试与质量

> **v2 变更（2026-11）**：worker 运行时与四域 broker 已移除；成员一律是真 sub-agent，权限由 DSH 权限预设按成员分配，成员审批经 `team_approve` 转发给 Lead。下文涉及 `worker` / `broker` / `policy` / `scope` 的段落为历史记录，以 [CONTRACT.md](../docs/CONTRACT.md) 与 [README](../README.md) 为准。

## 跑法

```bash
npm test                          # node tests/run-all.mjs，全部脚本，失败非零退出
node tests/run-all.mjs --only ac-05   # 只跑匹配的脚本
npm run demo                      # demo/run-demo.mjs 手演
```

`run-all.mjs` 顺序执行 `tests/*.mjs`（**AC 脚本优先**），逐个 `spawn(process.execPath, [脚本])`，收集 `PASS <id> <detail>` / `FAIL <id> <reason>`。

## harness（`tests/lib/harness.mjs`）

导出：`REPO`、`BIN`、`sha256`、`sleep`、`assert`、`assertEqual`、`mkTmp`、`startSidecar({dataDir, ws, env, port=0, cwd})`、`apiClient`、`waitFor`、`sseOpen`、`readDb`、`runAc`，并 re-export `fs/path/os`。

`startSidecar` 起真实子进程、读**第一行 JSON** 拿 `port`/`token`，返回带 `close()` 的句柄。

## AC 约定（新增脚本必须遵守）

1. 在 `os.tmpdir()` 建 `dsh-team-ac<NN>-<rand>` 临时 workspace + data。
2. `spawn(process.execPath, ['bin/dsh-team.mjs','up','--port','0','--data', …])`。
3. **只走真实 HTTP/SSE 与真实子进程**——禁止 mock sidecar、禁止伪造崩溃。
4. 收尾 SIGKILL + 删临时目录；**失败则保留并打印路径**便于取证。
5. 输出以 `PASS`/`FAIL` 开头的一行。

## 脚本矩阵

| 脚本 | 覆盖 |
|---|---|
| `ac-01-members` … `ac-16-dispatch-hints` | 16 条验收：成员上限、四域拒绝、审批、DAG 竞态、中断、续传、派发提示等 |
| `routes-smoke` | 全部路由的冒烟（状态码 + 形状） |
| `cli-smoke` | `up/status/dag/logs/approve/down` |
| `db-migration` | 缺列补列、`schema_version` 升版、二次打开幂等 |
| `changes-diff` | 统一 diff 生成与行数统计 |
| `panel-contract` | `src/web/panel.html` 与 assets 的引用一致性 |
| `ui-member-strip` | 面板 `src/web-ui` 侧的组件契约 |
| `plugin-agent` / `plugin-changes` / `plugin-trace` / `plugin-watchdog` / `plugin-teamid-guard` / `plugin-models` / `plugin-client` | Host/Client 插件行为（AC-15 用**假 ctx** 捕获工具，不拉真 sidecar） |
| `llm-catalog` / `pricing` | 模型目录同步、峰值时段计价 |
| `skill-provider` | skills provider 注册与 `SKILL.md` 可读 |
| `todo-plan` | 待办清单读写与面板同步 |

## 质量工具

- 无 ESLint/Prettier 配置；后端质量靠 **测试 + 契约比对**。
- 面板侧 `npx tsc -b`（`strict`、`verbatimModuleSyntax`）是唯一静态检查。
- `screenshots.json` + `screenshots/*.png` 是面板视觉基线，改动 UI 后手工比对。

## 已知风险点

- 端口/进程类用例容易在 CI 上抖动（`port=0` + `waitFor` 已缓解）。
- `node --permission` 参数形态依赖 Node 版本，换大版本先跑 `ac-01`。
- 面板构建产物名带 hash（`app-Cnup_l1j.js`、`panel-CgW3h5RW.css`），改构建配置会让 `panel-contract` 失败——属预期。

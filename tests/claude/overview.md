# harness 与脚本矩阵

## `lib/harness.mjs` 导出

| 导出 | 说明 |
|---|---|
| `REPO` | 仓库根（`tests/lib/` 上两级） |
| `BIN` | `bin/dsh-team.mjs` 绝对路径 |
| `sha256(x)` | 文件/字符串哈希，用于 audit 前后比对 |
| `sleep(ms)` | 唯一允许的定长等待 |
| `assert(cond, msg)` / `assertEqual(a, b, msg)` | 断言，失败抛错 |
| `mkTmp(prefix)` | 在 `os.tmpdir()` 建临时目录并返回路径 |
| `startSidecar({dataDir, ws, env, port=0, cwd})` | spawn `up`，读**第一行 JSON** 拿 `{url,port,token,pid}`，返回带 `close()` 的句柄 |
| `apiClient(baseUrl)` | 薄封装 `get/post/patch/del`，返回解析后的 JSON 与状态码 |
| `waitFor(fn, {timeout, interval})` | 轮询直到 `fn()` 真值 |
| `sseOpen(baseUrl)` | 打开 `/api/events`，返回可 `await frame()` 的句柄（支持 `lastEventId` 续传测试） |
| `readDb(dataDir)` | 用 `node:sqlite`（或 `sqlite3` CLI）读库做断言 |
| `runAc(id, fn)` | AC 脚本外壳：计时、捕获、打印 `PASS/FAIL`、决定临时目录去留 |

并 re-export `fs / path / os`。

## 脚本矩阵

**AC（对应 `docs/CONTRACT.md` 验收条目）**

| 脚本 | 覆盖 |
|---|---|
| `ac-01-members` | 建团队/加成员/上限与 `maxMembers` |
| `ac-02`…`ac-04` | 四域拒绝、审批流、grant 单次性 |
| `ac-05` | 派发与 settle 窗口（ADR-005 的核心用例） |
| `ac-06`…`ac-10` | DAG 依赖/条件、失败传播、关键路径、状态收敛 |
| `ac-11`…`ac-14` | 中断/恢复、租约、SSE 续传、审计哈希 |
| `ac-15-dispatch-hints` | 插件侧：假 ctx 捕获工具注册（不拉 sidecar） |
| `ac-16-dispatch-hints` | 派发提示 |

**专项**

| 脚本 | 覆盖 |
|---|---|
| `routes-smoke` | 全部路由冒烟（状态码 + 返回形状） |
| `cli-smoke` | `up/status/dag/logs/approve/down` 全链路 |
| `db-migration` | 缺列补列、`schema_version` 升版、二次打开幂等 |
| `changes-diff` | 统一 diff 与行数统计 |
| `panel-contract` | `src/web/panel.html` 与引用 assets 的一致性 |
| `ui-member-strip` | `src/web-ui` 侧组件契约 |
| `plugin-agent` | agent 运行时派发/上报链路 |
| `plugin-changes` | `FILE_TOOLS` → member_change |
| `plugin-trace` | 工具调用 → span、`traceInputMax` 截断 |
| `plugin-watchdog` | 心跳/保底泵 |
| `plugin-teamid-guard` | `teamId` 必须是 `result.team.id`，非名字 |
| `plugin-models` | 模型目录同步 |
| `plugin-client` | Client half 的 loader/注册回退 |
| `llm-catalog` | provider/route 持久化与开关 |
| `pricing` | 峰值时段与计价 |
| `skill-provider` | skills provider 注册、`SKILL.md` 可读 |
| `todo-plan` | 待办清单读写与面板同步 |

## 写一条新 AC 的骨架

```js
import { startSidecar, apiClient, waitFor, mkTmp, runAc } from './lib/harness.mjs'

await runAc('ac-99', async (t) => {
  const dir = mkTmp('dsh-team-ac99')
  const sc = await startSidecar({ dataDir: `${dir}/data`, ws: `${dir}/ws` })
  try {
    const api = apiClient(sc.url)
    const team = await api.post('/api/teams', { name: 't', runtime: 'worker', maxMembers: 2 })
    // …断言…
    t.assert(cond, '说明')
  } finally {
    await sc.close()
  }
})
```

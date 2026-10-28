# ADR-002：C1 的强制点（Node 权限模型 + 模块白名单 + 全局中和）

- 状态：已接受（含已知边界）
- 日期：2026-10-28
- 关联：C1 / FR-3.3 / AC-3

## 背景

PRD 3.2 要求「Worker 只挂载 sidecar 提供的代理工具，禁用原生直连 IO」，并把 OS 级沙箱列为 P1 兜底（Windows Job Object / 受限令牌 / 目录 ACL）。核心难点：**执行层强制**，不能只靠提示词或代码约定。

实测 Node v24.22.0 的 `--permission`：
- 覆盖 **fs（读/写）、child_process、worker_threads、addons、wasi**
- **不覆盖网络**（`node --help` 无 `--allow-net`；`net.connect`/`fetch` 仍可用）

## 决策

三层叠加，全部在 Worker 进程启动时生效：

1. **权限旗标**：`node --permission --allow-fs-read=<bundleDir>`，不给写/子进程/worker/addons 权限。因此 `fs.writeFileSync`、`child_process.execSync`、`new Worker` 均抛 `ERR_ACCESS_DENIED`——这是内核外的进程级强制，不是提示。
2. **模块解析白名单**：bundle 第一行动态注册 `module.registerHooks()`（同步、主线程，无需 `--allow-worker`），`resolve` 只放行 `node:module`，其余 specifier（含 `createRequire` 的 CJS 路径）一律 `ERR_ACCESS_DENIED`。这承担了**没有内核门的 net 域**。
3. **全局中和**：`fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest` 置为 `undefined`；`process.binding`/`_linkedBinding`/`dlopen`/`getBuiltinModule`/`report`/`kill` 替换为抛错函数。其中 `getBuiltinModule` 与 `report.writeReport` 是实测发现的两条未被权限模型覆盖的逃逸路径。

Worker 因此**只能**通过 stdout/stdin 的 NDJSON RPC 请求 sidecar 代做 IO，`src/broker.mjs` 是唯一决策点。

## 后果

- ✅ 四域越界在 Worker 侧就是硬失败；AC-3 用真实探针（`import('node:fs')`、`fetch`、`getBuiltinModule`、`binding`、`sync write`）逐项取证。
- ✅ 不需要管理员权限、Job Object 或 ACL 改造即可在 Windows 上强制。
- ⚠️ 这是**进程内**强制：若 Worker 进程被替换为任意二进制，或 Node 未来新增未中和的内置入口，则需要 P1 的 OS 级沙箱补强。已在 README「已知取舍」标注。
- ⚠️ 模块白名单使得 Worker 不能使用任何第三方库；当前 Worker 是自包含脚本，符合设计。
- ⚠️ `module.registerHooks` 为较新 API，依赖 Node ≥22.15（本项目要求 ≥22.5，实测 24.22 可用；若在 22.5–22.14 上运行会退化，建议引擎提升到 ≥22.15）。→ 已在 README 要求 ≥22.5 的基础上，实际以 24.x 为目标验证。

## 替代方案为何未选

- 仅靠「Worker 代码不 import fs」：违反 C1 的「禁用」语义，可被绕过。
- Windows Job Object / 受限令牌：需要原生模块或管理员权限，且不能阻止 `fetch` 出网，投入产出比低；保留为 P1。


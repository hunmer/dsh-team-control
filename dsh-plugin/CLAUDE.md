# dsh-plugin · Host 适配层

## 项目简单介绍

`dsh-plugin/` 是 DSH 宿主的 Host 插件（包名 `dsh-team-control`），把 sidecar 的能力翻译成模型能直接调的 14 个 `team_*` + 2 个 `board_*` 工具，并负责 sidecar 生命周期（`autoStart` 时自己拉起）、成员子会话的拉起与权限预设下发、审批转发、以及运行数据的回传（工具调用 → span、文件改动 → member_change、LLM 用量 → 费用、上下文占用 → context_snapshot）。

它**不做权限判定**——成员的沙箱与审批由 DSH 权限预设和宿主执行，插件只把成员审批转发给 Lead（`team_approve`）；它也不持有 sidecar 的 db。

## 约定的规则

- 插件零第三方依赖，`index.js` 必须能被 Node 直接 import（无构建）。
- 工具 schema 是**对外契约**：改参数会影响 `skills/dsh-agent-team/SKILL.md` 与实际使用，改完同步文档。
- 所有 sidecar 请求走同一个 `resolveConfig()` 里的 `baseUrl` + `requestTimeoutMs`，不要各处新建 client。
- 上报是**尽力而为**：上报失败不能让工具调用失败（try/catch 吞掉并降级），否则用户任务会被观测逻辑拖死。
- agent 成员的 `agent/status → idle` 有 settle 窗口；维护期（maintenance）事件要忽略，别把维护态当空闲去派活。
- 敏感值不进 span/message：入参超 `traceInputMax`（默认 1200）截断，命中敏感键必须 `<redacted>`。

## 文件索引

| 文件 | 用途 | 何时阅读 |
|---|---|---|
| [工具面与生命周期](claude/public-interfaces.md) | 16 个工具的参数/语义、钩子与泵 | 改工具或加钩子 |
| [实现要点](claude/overview.md) | 配置解析、sidecar 拉起、agent 派发时序 | 排查「工具报错/没派发」 |
| [常见问题](claude/faq.md) | 插件侧症状定位 | 工具异常先看这里 |

## 扫描状态

- 更新时间：2026-11-05（增量，含深读）
- 已扫描：`index.js` 的 `buildTools` 工具清单与行号、`resolveConfig` 全部键、`apply` 的钩子与泵清单；**全部 16 个工具的 `execute` 实现已深读**（端点、参数覆盖关系、校验、冻结/审批机制，见 [claude/overview.md](claude/overview.md) 的「逐工具实现速查」与「关键内存态」）；`changes.js`、`pricing.js` 导出面；`cordis.patch.yml`；`locale/*.json`。
- 下一步：改某个工具前，先读该工具 `execute` 与对应 sidecar 路由两端。

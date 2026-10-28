# @local/dsh-team-plugin

把本仓的 **dsh-team sidecar** 暴露为 DSH 模型可调用工具的 Host 插件（bundle）。

- 编排内核仍在 sidecar 进程里（[`../src/`](../src/)），本插件只做**适配 + 生命周期**，不重写调度/权限/事件流。
- 零第三方依赖：只用 Node 内置模块；工具以普通 `ToolDefinition` 对象注册（JSON Schema 参数），不依赖 `defineTool`。
- 8 个工具：`team_create` `team_spawn` `team_status` `team_task` `team_send` `team_scope` `team_control` `team_report`。

## 安装

在 DSH 里用 `plugin_manager` 安装本目录（绝对路径），它会写 profile 的 `dependencies`（`link:`）与 `dsh.profile.bundles`：

```text
plugin_manager(action: "install_bundle", target: "C:\\...\\agent-team-plugin\\dsh-plugin")
```

期望结果：`application: "applied"`、`warnings: []`，随后工具面出现 8 个 `team_*` 工具。
安装后可用 `cordis_inspect_query` 的 `Tool.listTools` / `Config.listConfigs` 复核（无需审批）。
卸载：`plugin_manager(action: "remove_bundle", target: "@local/dsh-team-plugin")`。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-team
      name: '@local/dsh-team-plugin'
      config:
        baseUrl: http://127.0.0.1:4317
        autoStart: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:4317` | sidecar 地址；端口从这个 URL 推导 |
| `autoStart` | `true` | sidecar 不可达时，首次工具调用自动拉起 `dsh-team up` |
| `home` | `~/.dsh/team` | 数据目录（`team.db` / `token`）；必须与 sidecar 一致 |
| `sidecarEntry` | `../bin/dsh-team.mjs` | sidecar 入口；默认按包位置推导，无需配置 |
| `startTimeoutMs` | `20000` | 自动拉起的等待上限 |
| `requestTimeoutMs` | `60000` | 单次 API 调用超时 |

> 本插件**不导出 `Config` schema**，因此 `Config.listConfigs` 对它的 `status` 是 `absent` ——
> 这是「无 schema」而不是「配置未生效」；`dsh --profile <p> --dump-config` 可看到 row 的
> `config: {baseUrl, autoStart}` 已合成。代价是拼错的字段不会被校验，代码侧已做默认值兜底。

## 生命周期

- 插件**只回收自己拉起的** sidecar 子进程（`ctx.effect` 的 disposer 里 kill）；用户手工起的服务不受影响。
- sidecar 是 DSH Host 的子进程：Host 退出后它可能存活，下次工具调用会用健康检查复用；
  要彻底停：`node bin/dsh-team.mjs down`，或把 `autoStart` 设为 `false`。
- 工具不受 DSH 的沙箱审批约束（它们是纯 HTTP 客户端）；真正的权限边界仍由 sidecar 的四域
  PermBroker 执行，且 Worker 进程没有原生 IO 能力（见 [ADR-002](../docs/adr/ADR-002-worker-confinement.md)）。

## 面板位置

本包只提供**工具面**。界面在配套的 [`@local/dsh-team-ui`](../dsh-plugin-ui/)：一个注册在
`settings.plugins.tab` 的 React 页面（设置 → 插件 → dsh-team 控制台），经 Host 同源代理读取
sidecar。独立的 `{baseUrl}/panel` 仍然保留，适合不打开 DSH 时使用。

不把独立面板塞进 iframe 的原因：DSH 插件规范要求 UI 用 React 组件渲染在 Slot 里，
iframe 文档拿不到主题 token / 明暗切换 / `ctx.locale`。

## 自测

```bash
node dsh-plugin/test-adapter.mjs   # 临时 sidecar 上跑完建队→加成员→阻塞→审批→报告→卸载
```

该脚本不依赖演示实例，覆盖注册契约、真实 API 调用、错误文案与卸载清理。

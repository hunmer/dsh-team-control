# src/web-ui 常见问题

**`/panel` 打开是 `panel not built yet`**
`src/web/panel.html` 不存在。`cd src/web-ui && npm install && npm run build`。

**`/panel` 白屏，console 报 assets 404**
`base` 不是 `/panel/`，或产物没重新 build（文件名带 hash，旧 html 指向旧 js）。

**页面加载时闪白**
`panel.html` 里的内联主题脚本没跑或 `localStorage['dsh-team.panel.theme.v1']` 的值变了。首帧前必须上暗色 class，不能等 React 挂载。

**主题与宿主不一致**
`main.tsx` 的 `applyDshTheme(readDshTheme())` 没拿到宿主主题（不在 iframe 里、或桥未就绪时降级到本地偏好）。检查 `lib/dsh-bridge.ts`。

**SSE 不实时 / 时间线缺事件**
1. `lastEventId` 是否在重连后带上；2. `/events` 是否被代理缓冲（`dsh-plugin-ui` 要流式直通）；3. 新帧类型没在 store 的分派里加分支。

**数据对不上（面板显示旧值）**
store 是「首屏快照 + 增量」，若某个动作只改了本地 state 没落 sidecar，刷新就回退。以 sidecar 为准。

**`import type` 报错**
`verbatimModuleSyntax: true`：纯类型必须 `import type { X } from …`，值导入不能夹类型。

**改了 `components/ui/` 里的组件，下次同步被覆盖**
预期行为。定制请包一层或改业务组件。

**新页签不出现**
三处没同步：`TAB_NAMES`（`store.tsx`）、`TAB_LABELS/TAB_ORDER`（`shell.tsx`）、`App.tsx` 的分发。

**`?api=/dsh-team-api&embed=1` 是什么**
嵌入模式。`api` 指向 Host 同源代理前缀；`embed=1` 让面板收起外层壳。改这个参数要同时改 `dsh-plugin-ui/client.js`。

**类型和 sidecar 响应不一致**
`types.ts` 是手写的，sidecar 改响应形状时必须同步；`tests/routes-smoke` 只校验形状大致，不校验字段类型。

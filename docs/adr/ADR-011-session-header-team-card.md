# ADR-011：会话右上角团队卡片——AgentFindings 移植到 header 胶囊 + overlay 浮层

- 状态：已接受
- 日期：2026-10-29
- 关联：`docs/adr/ADR-010-panel-affectui-home.md`（面板 affectui 化）/ `dsh-plugin-ui/README.md`

## 背景

GUI 里「进入团队会话」的入口原本只有左侧栏页签（ADR-008/010）。实际使用时，团队在跑的时候
当前对话页看不出任何信号：既不知道有没有团队、也不知道有几人在跑、有没有卡在审批/失败。
affectui 提供了 `agent-findings`（`default-workspace/affectui-agent-findings/src`）——
一张「成员进度 + 最新发现」的卡片，正好是团队运行态的直观表达。

约束：`dsh-plugin-ui` 的 client half 是**单文件、无打包器**，`window.__ModuleLoader__.load` 里只能
`require('react')`，所以 affectui 的 TSX 组件与 CSS 必须内联成 `createElement` + 字符串常量。

## 决策

### D1：胶囊在 header，卡片在 `shell.overlay`

- `conversation.session.header.utilities`（list, session 作用域）只能放行内控件，且高度受限，
  塞不下整张卡片。因此该 slot 只放 26px 高的**胶囊按钮**（id `dsh-team:members`，order 5），
  显示团队名 / 「运行中 n/m」/ 严重·警告计数。
- 卡片落在 `shell.overlay`（frame-wide 浮层，id `dsh-team:findings`，order 30），
  `position:fixed; top:56px; right:20px; width:368px`；该层本身点击穿透，卡片自己
  `pointer-events:auto`。好处是卡片不被 header 的 overflow/层叠上下文裁剪。

### D2：两个 slot 之间用极简外部 store 通信

`shell.overlay` 的条目拿不到 `sessionId`（overlay 是 root 作用域），而 header 胶囊拿得到。
所以用 `cardStore`（Map + listeners + `active`）桥接：

- 胶囊按本会话 `parentId/origin` 筛出团队成员会话 id，用它作 key 拉 sidecar 快照并 `setActive`；
- 浮层读 `active` 指向的那份快照；胶囊卸载（切走会话）时 `setActive(null)`，卡片随之消失，
  不会挂在已关闭的会话上。

### D3：数据合成放在 client 侧，不改 sidecar 契约

一轮轮询 = `/status` + `/teams`（并发）→ 用 `member.agentSessionId` 命中团队成员 → 反查团队 →
再并发 `/tasks?team=` 与 `/events/history?team=&limit=40`。发现条目 = 成员 blocker（`scope_request`
→警告，`quota/interrupt/agent/lease/worker`→严重，`dep`→提示）+ 事件流（`FAIL*`→严重，
`DENIED/CONFLICT`→警告，其余提示），最多 48 条，最新在前。进度取 `member.pct` × 当前任务 `plan.length`。

特判：成员已 `retired` 但子会话还在时不作数（按 `teamId` 过滤 `status !== 'retired'`）。

### D4：抗抖动三条规则（都是实测踩出来的）

1. **用户操作优先**：首次轮询到有人在跑时自动展开；用户点过胶囊/关闭按钮后置 `pinned`，
   之后的轮询不再改写 `open`——否则 4s 一次的快照会把用户刚展开的卡片收回去。
2. **不清屏**：`snapshot === null` 只累加 `misses`，连续 3 次才收起入口；
   请求失败且已有数据时只标 `error`（胶囊虚线 + 运行时加 `·!`）。
3. **乱序保护**：每次轮询带递增 token，只有 token 不小于已应用 token 的响应才落库。
   没有这条时，先发后到的旧成功响应会覆盖新状态——表现就是「卡片闪一下就消失」。

### D5：视觉原样移植，配色绑定宿主 token

CSS 从 `agent-findings-css.ts` 整段内联（`${ROW_HEIGHT}px` → `40px`），类名保持 `ui-afc__*`，
仅新增外壳样式 `.dsht-afc-pill*`、`.dsht-afc-dock*`。

不采用它在 `.dark` / `[data-theme="dark"]` 下的硬编码色值，而是在 `.dsht-afc-dock .ui-afc`
这一层重绑 `--ui-afc-*` 变量：卡片底 `--dsw-alias-bg-overlay`、文字 `label-primary/secondary`、
描边 `border-l1/l2`、严重/警告 `state-error-primary/state-warn-primary`，其余用 `color-mix()`
派生。理由：宿主可能在 `<html>` 上挂 class、也可能只切 CSS 变量，绑 token 两种情况都对；
且选择器具体度 (0,2,0) 高于 `:where(...) .ui-afc` (0,1,0)，不依赖加载顺序。

卡片背景做**磨砂玻璃**：`--ui-afc-card` 换成 `color-mix(… bg-overlay 72%, transparent)`，
`.ui-afc__card` 加 `backdrop-filter: blur(24px) saturate(170%)`（含 `-webkit-` 前缀），标题条
`blur(14px)`。`@supports not` 分支退回 `bg-overlay` / `bg-layer-2` 实色——毛玻璃依赖合成层，
宿主禁用或显卡受限时必须有可读兜底，否则半透明底叠在浅色页面上会糊成一片。

### D6：浮层锚定在胶囊按钮下方

胶囊在 `conversation.session.header.utilities`，卡片在 `shell.overlay`，两者不在同一棵 DOM
子树，没有共同的定位祖先。方案是运行时测量：按 `[data-dsh-team-pill="<teamId>"]` 找到按钮，
取 `getBoundingClientRect()` 得到 `top = rect.bottom + 8`、`right = innerWidth - rect.right`，
以 `position: fixed` 贴到按钮正下方，并在 `resize` / 捕获阶段 `scroll` 时重算；
卡片 `max-height` 也按下方剩余视口算（CSS 变量 `--dsht-dock-max`）。
没有采用「把卡片渲染进 header 的同一个容器再 `position: absolute`」：header 与浮层的
overflow/z-index 由宿主控制，卡片很容易被裁切。测量失败时退回 CSS 兜底坐标（右上角，`top:56px; right:20px`）。

### D7：样式与文案的「只能出现一次」约束

- 样式在 `apply()` 里注入 `<head>`（`#dsh-team-ui-styles`，`ensureStyles()` 去重），
  **不再随组件树渲染 `<style>`**。原因：团队面板没打开时胶囊/浮层会完全无样式；而卡片里
  内联的 `<style>` 在非 React 19 运行时不会被提升，会在列表上方露出一段固定文本。
- 文案走 `localizer(t)` 兜底：宿主字典缺 key 时 `t` 返回原 key，界面就会出现一行不变的
  `status_*` / `card_checks`；这层兜底本地 `DICT` 并自行插值 `{var}`，未知成员状态收敛到
  `status_unknown`，且未知状态不再映射成「已完成」。

## 后果

- 团队在跑时，当前对话页右上角有常驻信号，点开即「谁在跑 / 卡在哪 / 发现了什么」；
  点任意发现条目直接在右侧栏打开该成员对话（`dsh-resource://subagentchat/...`，与内置子代理卡片同一机制）。
- 成本：每会话 4s 一次轮询（4 个请求），只在存在团队成员子会话时才发起。
- 测试：`tests/ui-member-strip.mjs` 用 stub React 直接跑真实 `client.js`，覆盖筛选、计数、
  浮层渲染、轮询不覆盖用户选择、单次失败保留数据、旧响应不覆盖新状态。

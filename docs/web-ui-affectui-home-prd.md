# web-ui 主页 affectui 化 + 侧边栏导航 需求文档（v1）

> 对象：`src/web-ui`（`@local/dsh-team-panel-ui`，React 19 + Tailwind v4 + Vite 6）。
> 需求来源：用户口头需求（2026-10-29），原话要点："将 affectui-agent-run 的组件作为 agent-team-plugin\src\web-ui 主页，并且将现在 web-ui 的顶部 tabs 改成侧边 sidebar"。
> 本文档只描述**要什么**；实现方案细节由实施者决定，冲突走 docs/adr。

---

## 1. 背景与范围

当前 `src/web-ui` 的面板骨架是「顶栏 + 横向 Tabs」：进入面板默认落在成员看板（board），7 个视图靠顶部一排页签切换，没有主页（home）概念，也没有右侧信息面板。团队希望面板的观感对齐 affectui 的 AgentRun 界面（左侧导航栏 + 运行时间线 + 右侧审批面板），并以它作为面板的主页。

范围：**仅 `src/web-ui` 前端**。构建产物仍输出到 `../web`、由 sidecar 在 `/panel` 提供服务（见 src/web-ui/package.json description），sidecar API 与 store 数据层不改。

> 历史备注：2026-10-29 曾把本需求误读为「替换 DSH Web GUI（127.0.0.1:3080）的主页」并安装过临时插件 `@local/affect-home-ui`，当日已卸载并删除源目录。本需求与 DSH 宿主 UI 无关，任何人不应再朝那个方向实现。

---

## 2. 现状盘点（实现前必须核对的锚点）

### 2.1 web-ui 侧

| 事实 | 位置 |
|---|---|
| TAB_NAMES = `['board','dag','timeline','models','permissions','approvals','messages']`，类型 `TabName` | `src/web-ui/src/store.tsx:13-14` |
| 默认 tab 为 `board`；tab 持久化到 localStorage 并在启动时恢复 | `src/web-ui/src/store.tsx:97`、`src/web-ui/src/store.tsx:102` |
| `setTab(tab)` 切换视图并按需懒加载对应数据 | `src/web-ui/src/store.tsx:538-542` |
| App 骨架：TopBar（团队选择/连接状态/快照/刷新/导出）+ Banner + 横向 `TabsList`（7 个 `TabsTab` + 徽标）+ `main` 内 7 个 `TabsPanel` | `src/web-ui/src/App.tsx:105-140` |
| 徽标来源：board=成员数、approvals=待审数、messages=未读数 | `src/web-ui/src/App.tsx:99-103` |
| 视图组件 | `src/web-ui/src/views/{Board,Dag,Timeline,Models,Permissions,Approvals,Messages}.tsx` |
| dev 端口 5183；`tsc -b && vite build` 产出至 `../web` | `src/web-ui/vite.config.ts:32`、package.json scripts |

### 2.2 affectui 侧（素材）

源码：`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\affectui-agent-run\src`，22 文件约 6910 行，**唯一外部依赖 react/react-dom**（无其他 npm 包），样式全部内联为 TS 常量字符串。

| 组件/模块 | 文件 | 说明 |
|---|---|---|
| `AgentRun` | agent-run.tsx（647 行） | 完整主页：内嵌 AppShell，中列运行时间线，右列审批面板（`Needs your input`）。Props：`{title, steps, draft, agent, autoRun, onApprove, onDeny, onStop, onDone, user, onNavigate, children}`，全部可选，缺省即 demo 数据 |
| `AppShell` / `Icon` / `Menu` | app-shell.tsx（1104 行） | 应用壳：左侧导航栏（`nav`/`groups`/`active`/`onNavigate`）+ 主区 + 可选右栏，CSS-in-JS `<style href precedence>` 注入 |
| `ApprovalCard` | approval-card.tsx（534 行） | 右侧审批卡（标题/风险等级/明细/批准拒绝） |
| `PlanSteps` | plan-steps.tsx（814 行） | 步骤时间线（运行/等待/完成/停止状态机） |
| `ToolCallGroup`/`ToolCall` | tool-calls.tsx（513 行） | 工具调用折叠组 |
| `DiffCard` | diff-card.tsx（751 行） | 草稿 diff 卡 |
| `Button` / `RunLoader` | button.tsx / loader.tsx | 基础件 |
| 图标 | icons.ts（538 行）、icon-paths.ts（601 行） | 内联 SVG path，无图标库依赖 |
| CSS | `*-css.ts` 各文件 | 自包含设计 token（`--ui-pl-*`、`--ui-sg-*`、`.ui-as-*` 的 `--ink/--muted/--line/--panel` 等），类名前缀 `ui-as-/ui-ar-/ui-pl-/ui-ac-/ui-df-/ui-sg-/ui-btn-`，自带 `:where(.dark,[data-theme="dark"])` 暗色覆盖，不依赖 Tailwind |
| demo 演示数据 | agent-run.tsx 内 `NAV_ITEMS`/`NAV_GROUPS`/`STEPS`/`DRAFT` | Home/Chat/Runs/Analytics/Deliverables 导航；5 步计划（`send` 步含审批）；Q3 备忘录 diff |
| **不引入** | screen-stage.tsx / screen-stage-css.ts / demo.tsx / main.tsx | 1440×900 缩放演示舞台与 demo 入口，面板内不需要 |

---

## 3. 功能需求

### FR-1 素材引入（vendor）
1. 将 2.2 表中除「不引入」外的 affectui 源文件**原样复制**到 `src/web-ui/src/affectui/`（保留子目录扁平即可），仅允许修改 import 路径与 `import type` 语法以适配本仓 tsconfig；禁止改组件行为与样式。
2. 不新增任何 npm 依赖；不引入 affectui 项目的 vite.config/tsconfig。

### FR-2 主页（home）
1. 新增 home 视图：整屏渲染 `<AgentRun />`（不包 ScreenStage），成为面板**默认首屏**（替代现在的 board 首屏）。
2. 首期使用 AgentRun 内置 demo 数据（自动播放的 5 步计划 + 右侧审批卡 + diff 卡），呈现「侧边栏 + 运行时间线 + 右侧审批」的完整效果；真实数据接线见 FR-8。
3. affectui 侧栏内 `Chat` 项点击应跳到面板 messages 视图（`onNavigate` 接 `setTab('messages')`）；其余导航项本期允许保持展示态。

### FR-3 顶部 Tabs → 左侧 sidebar
1. 移除 App.tsx 的横向 `TabsList` 页签条（App.tsx:115-124）；7 个既有视图改为**左侧竖向导航栏**项：图标 + 中文标签 + 徽标 + active 高亮，键盘可达（方向键/回车）不劣于现状。
2. 导航项顺序沿用 `TAB_NAMES`，另在首位加「主页」项（对应 FR-2 home）。
3. TopBar（团队选择、连接状态、快照信息、刷新、导出）保留，位置迁移到主区顶部，功能与样式基本不变。
4. 视图切换语义不变：仍走 `setTab`，懒加载与持久化行为保持（`store.tsx:538`、`store.tsx:102`）。

### FR-4 导航状态
1. 面板启动默认落在 home；历史持久化 tab 为 7 个业务视图之一时仍恢复该视图（持久化兼容旧值）。
2. home 本身是否持久化由实现决定（见 D2），但**不得**让旧 localStorage 数据导致白屏或回退到 board。

### FR-5 徽标
board/approvals/messages 三个导航项的徽标（成员数/待审数/未读数）在 sidebar 中继续显示，数据源不变（App.tsx:99-103 的 useMemo 迁移即可）。

### FR-6 暗色模式
affectui 组件自带暗色覆盖；sidebar 与新骨架需同时适配 web-ui 现有 Tailwind 暗色方案，两套体系在暗色下观感一致（不允许出现一半亮一半暗）。

### FR-7 构建与产物
`tsc -b && vite build` 通过，产物仍输出 `../web`；`npm run dev`（5183 端口）与 sidecar `/panel` 两种访问方式均正常。

### FR-8 真实数据接线（后续阶段，非本期验收项）
- 审批队列 `scopeRequests` → AgentRun 的 `steps[n].approval` / ApprovalCard（批准/拒绝调既有 API）；
- 成员运行轨迹 → PlanSteps/ToolCalls；
- 团队概览 → 右侧 details。
本期只需保证 AgentRun 的 props 是可注入的（不写死在视图内部）。

---

## 4. 决策点（实现前确认，结论记入 adr/）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | affectui AgentRun **自带的左侧导航栏**与新的 app 级 sidebar 如何共存 | A：app 级常驻 sidebar 承载视图导航，AgentRun 原样内嵌（保留其 demo 导航）；B：app sidebar 只在业务视图显示，home 整屏交给 AgentRun 自己的侧栏；C：把 AgentRun 的 `nav`/`groups` props 重写成 7 个业务视图，全局共用一个 affectui AppShell | **C**（观感最统一，改动集中在壳层；A 最省事可作 M1 过渡） |
| D2 | home 是否纳入 `TabName` 联合类型 | 加 `'home'` vs 独立布尔状态 | 加 `'home'`，`TAB_NAMES` 不动（持久化白名单继续只认 7 个业务值） |
| D3 | sidebar 实现载体 | 复用 affectui `AppShell` 侧栏 vs Tailwind 自建 | 若 D1=C 则自然用 AppShell；否则自建轻量 Tailwind 侧栏 |

---

## 5. 非目标

1. 不动 DSH Web GUI / 宿主插件体系（3080 那套），也不重建 `affect-home-plugin`。
2. 不引入 ScreenStage 缩放舞台、affectui 的 demo 入口文件。
3. 不改 sidecar REST/SSE API、store 数据层与各业务视图内部逻辑（视图只在容器/布局层面适配）。
4. 不做移动端专属布局（保持现状水平即可）。

---

## 6. 验收标准

| # | 标准 |
|---|---|
| AC-1 | `npm run dev` 打开面板，首屏为 affectui AgentRun 界面：左侧导航、中列运行时间线（自动播放）、右侧「Needs your input」审批面板三要素齐全 |
| AC-2 | 顶部横向页签条不复存在；左侧 sidebar 可在 home + 7 个业务视图间切换，active 指示正确，刷新后停留在当前视图（home 除外，见 FR-4） |
| AC-3 | board/approvals/messages 徽标在 sidebar 正确显示且随数据实时更新 |
| AC-4 | TopBar 功能完整：团队切换、连接状态徽章、快照信息、刷新快照、导出报告均可用 |
| AC-5 | 暗色模式下 affectui 区域与周边 Tailwind 区域无明暗割裂 |
| AC-6 | `tsc -b && vite build` 通过；`src/web-ui/src/affectui/` 内文件与源项目逐字节等价（import 路径/tsconfig 适配 diff 除外，diff 需在 PR 说明列出） |
| AC-7 | 7 个业务视图在新骨架下渲染结果与改造前一致（数据、交互不回归） |

---

## 7. 里程碑建议

| 阶段 | 内容 | 对应 |
|---|---|---|
| M1 | FR-1 + FR-2：vendor 进来，home 静态展示 AgentRun（先不拆旧 Tabs） | AC-1、AC-6 |
| M2 | FR-3 + FR-4 + FR-5 + FR-6：sidebar 替换顶部 Tabs，导航/徽标/暗色收口 | AC-2~AC-5、AC-7 |
| M3 | FR-8：真实数据接线（另行细化） | — |

---

## 8. 风险与注意

1. **StrictMode 双挂载**：web-ui `main.tsx` 用 `<StrictMode>`，AgentRun 是 setTimeout 链驱动的自动播放状态机，双挂载下可能双倍推进/闪烁。需实测；若异常，可在 home 视图外层去 StrictMode 或给 AgentRun 传 `autoRun` 受控。
2. **React 版本**：affectui 依赖 React 19 的 `<style href precedence>`（AppShell/各组件用它注入样式）；web-ui 为 react 19.1，满足。不要降级。
3. **字体**：affectui CSS 显式声明 `font-family:"Inter", ui-sans-serif, system-ui…`；web-ui 未引入 Inter 时会落到系统字体栈，观感略异。是否引入 Inter 由实现者定（非验收项）。
4. **样式隔离**：affectui 全部类名 `ui-*` 前缀 + 自有 token，与 Tailwind 无命名冲突；但**不要**在 `.ui-as-*` 祖先节点上叠加会重置盒模型的 Tailwind 基类。
5. **tsconfig 差异**：affectui 源码用 `import type`/模板字符串 CSS 常量，web-ui 的 tsc 配置（如 verbatimModuleSyntax）可能要求小幅语法适配——只许适配语法，不许改逻辑（AC-6）。
6. **持久化兼容**：旧用户 localStorage 里只有 7 个业务 tab 值；新增 `'home'` 后读取逻辑必须容忍并按 FR-4 处理。

---

## 9. 参考

- 素材源：`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\affectui-agent-run\src`（只读引用，勿原地修改）
- 本面板契约：`docs/CONTRACT.md`（数据层口径，本需求不触碰）
- 原始 PRD：`prd/agent-team-plugin-prd.md`

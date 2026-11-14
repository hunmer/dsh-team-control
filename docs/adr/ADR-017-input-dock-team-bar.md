# ADR-017：团队进度条从输入框胶囊改到聊天框上方

- 状态：已采纳（2026-11-14）
- 取代：ADR-011 中「胶囊在 `conversation.input.left`、卡片在 overlay、入口默认收起」的形态
- 相关：`dsh-plugin-ui/client.js`、`tests/ui-member-strip.mjs`

## 背景

ADR-011 把团队入口做成了 `conversation.input.left` 里的 26px 胶囊：默认收起，点开才在
`shell.overlay` 弹出整张卡片（团队名 + 打开面板 + 停止 + 关闭，下面是全部成员的
`AgentFindings`）。实际使用中暴露出三个问题：

1. 胶囊挤在输入框工具行里，和权限控件抢位置，团队一多只能看「n/m」数字；
2. 成员状态要展开整张卡片才看得到，日常扫一眼的成本太高；
3. 卡片顶栏（团队名/打开面板/停止/关闭）和成员内容捆在一起，想看某个成员也得先展开整张卡。

## 决策

改为**两层结构**：

1. **容器**：注册到 `conversation.input.dock`（`dsh-team:members`，order 40）。该槽由
   `dsh-client-ui-conversation` 渲染在 composer 卡片正上方（`div.composerStack`，
   `flex-direction:column`），放在 composer 卡片正上方；条目宽度随内容自适应、最宽 80%。
   容器内：
   - 左：团队名、状态点 + 运行中数量（tooltip 里是完整的 `n/m`）、严重计数；
   - 中：成员横向铺开，每人一个 chip（模型品牌图标、状态红点压在图标右下角、名字、
     Todo 进度）；
   - 右：原卡片顶栏的两个动作（打开面板 / 停止团队）；关闭浮层靠再点成员 chip 或 Esc。
2. **浮层**：`shell.overlay`（`dsh-team:findings`，order 30）只在用户点某个成员 chip 时渲染，
   内容是**该成员**的 `AgentFindings` 行 + 常驻展开的步骤清单，用 `data-dsh-team-chip`
   取 chip 的 `getBoundingClientRect()` 贴在其下方；再点同一个 chip 收起，点别的直接切换。

停止团队改为在进度条右侧的图标按钮上触发，二次确认弹窗仍由进度条组件自己渲染
（`stopUi` 状态原先在卡片组件里，随按钮一起搬到进度条）。

## 理由

- `conversation.input.dock` 的语义就是「Full-width entries above the composer card」，
  比在工具行里塞胶囊更符合宿主设计，也不占权限控件的位置。
- 成员 chip 把「谁在跑、跑到哪」变成常驻信息，不需要展开。
- 浮层只承载「成员详情」，锚点从胶囊变成单成员 chip，定位更精确；数量不再受浮层高度限制
  （进度条自己可以横向滚动）。
- `cardStore` 增加 `focus`（聚焦成员 id），与 `open`/`pinned` 一起构成用户选择：
  `applySnapshot` 只在成员仍存在时保留 `focus`，成员退场或用户关闭都会收起浮层，
  4s 轮询不会覆盖用户操作。

## 影响

- `cardStore.toggle` 不再有调用方，已删除；关闭改由成员 chip（`openMember`，再点同一人收起）
  与 Esc（`close`）驱动，`close` 同时清空 `focus`。
- ADR-011 的其余结论（快照轮询、自动开面板每会话一次、单次失败标 stale、样式一次性注入、
  主题 token、磨砂背景、`subagentchat` 深链）全部继续有效。
- `tests/ui-member-strip.mjs` 重写为验证进度条 + 成员 chip + 单成员浮层。

// dsh-team 面板新增：纵向视图覆盖样式。
// 参考 affectui agent-fleet 的 wide 分支布局：父卡片在左，子级纵向罗列在其右侧，
// 连线从卡片右缘中点出发（几何见 agent-tree.tsx measure() 的 vertical 分支）。
// 原始 agent-tree CSS 是 demo bundle 生成物，不动它，覆盖规则追加在这里并在组件内后置注入。
export const AGENT_TREE_VERTICAL_CSS = `/* dsh-team vertical view: children stack to the right of their card, connectors leave the right edge */
.ui-agtc[data-vertical] .ui-agtc__tree{grid-template-columns:auto minmax(0,1fr);column-gap:48px;align-items:center;justify-items:start}
.ui-agtc[data-vertical] .ui-agtc__level{display:grid;gap:12px;margin-top:0;padding-left:0;width:auto;min-width:0;justify-content:start}
.ui-agtc[data-vertical] .ui-agtc__hang{grid-template-columns:auto minmax(0,1fr);column-gap:48px;align-items:center;width:auto}
.ui-agtc[data-vertical] .ui-agtc__below{padding-left:0}
.ui-agtc[data-vertical] .ui-agtc__node{width:var(--ui-agtc-card-w)}`;

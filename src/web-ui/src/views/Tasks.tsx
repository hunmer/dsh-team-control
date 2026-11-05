/**
 * 工作区任务看板（M3）。
 *
 * 视觉沿用 affectUI TaskBoard，数据来自 sidecar `/api/board`。
 * 三列：Waiting = todo/planned/failed，Progress = planning/inprogress，Done = done。
 *
 * 实现已按功能拆分到 ./tasks/：
 * - TasksView.tsx  主视图（数据加载、三列/封存渲染、拖拽调度）
 * - TaskCard.tsx   任务卡片
 * - TaskPanel.tsx  任务详情侧滑面板
 * - dialogs.tsx    新建任务 / 看板设置对话框
 * - fields.tsx     表单基础控件（Field / RouteSelect / ModePicker）
 * - shared.ts      共享类型、常量与纯工具函数
 */
export { TasksView } from './tasks/TasksView';

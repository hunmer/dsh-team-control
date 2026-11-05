/**
 * 全局侧栏导航（PRD FR-3 / FR-5）。
 *
 * 7 个视图（home + 6 个业务视图；home 即时间线）按 TAB_ORDER 顺序排列，
 * 徽标数字直接取自 store 里已算好的 useMemo，不新增数据源。
 * 图标来自 lucide-react，外壳由 components/app-shell（coss ui）渲染。
 */
import type { ReactNode } from 'react';
import {
  Brain,
  Database,
  FileDiff,
  House,
  Layers,
  LayoutDashboard,
  Mail,
  Boxes,
  Network,
  type LucideIcon,
} from 'lucide-react';
import type { NavGroup, NavItem } from '@/components/app-shell';
import type { TabName } from '@/store';

export const TAB_LABELS: Record<TabName, string> = {
  home: '主页',
  board: '成员看板',
  review: '审阅',
  context: '上下文分析',
  memory: '记忆',
  dag: '依赖 DAG',
  models: '模型路由',
  messages: '消息',
  presets: '组合预设',
};

const TAB_ICONS: Record<TabName, LucideIcon> = {
  home: House,
  board: LayoutDashboard,
  review: FileDiff,
  context: Layers,
  memory: Brain,
  dag: Network,
  models: Database,
  messages: Mail,
  presets: Boxes,
};

/** FR-3.2：主页在前（即时间线），其余沿用 TAB_NAMES 的顺序。 */
export const TAB_ORDER: TabName[] = ['home', 'board', 'review', 'context', 'memory', 'dag', 'models', 'messages', 'presets'];

export type TabBadges = Partial<Record<TabName, number | null>>;

export function buildNav(badges: TabBadges): NavItem[] {
  return TAB_ORDER.map((tab) => {
    const Icon = TAB_ICONS[tab];
    return {
      label: TAB_LABELS[tab],
      icon: <Icon className="size-4" />,
      count: badges[tab] ?? undefined,
    };
  });
}

/**
 * 侧栏标签 → 视图。除中文标签外，兼容旧的英文入口：
 * `Chat` 落到消息（FR-2.3），`Home` 回到主页。
 */
export function tabFromLabel(label: string): TabName | null {
  const match = TAB_ORDER.find((tab) => TAB_LABELS[tab] === label);
  if (match) return match;
  const aliases: Record<string, TabName> = {
    Home: 'home',
    Chat: 'messages',
    Messages: 'messages',
    Runs: 'home',
    Board: 'board',
    Review: 'review',
    Changes: 'review',
    Context: 'context',
    Timeline: 'home',
  };
  return aliases[label] ?? null;
}

/** 传给 AppShell 的公共外壳参数。 */
export interface ShellChrome {
  nav: NavItem[];
  groups: NavGroup[];
  active: string;
  onNavigate: (label: string) => void;
  header: { title: ReactNode; actions?: ReactNode };
  /** 侧栏顶部的团队切换器（AppShell 的 sidebarTop 插槽）。 */
  sidebarTop?: ReactNode;
  /** 侧栏底部插槽（设置按钮）。 */
  footer?: ReactNode;
}

/**
 * 全局侧栏导航（PRD FR-3 / FR-5）。
 *
 * affectui 的 `AgentRun` 与 `AppShell` 都接受 `nav` / `groups` / `active` / `onNavigate`，
 * 这里集中维护一套：8 个视图（home + 7 个业务视图）按 TAB_NAMES 顺序排列，
 * 徽标数字直接取自 store 里已算好的 useMemo，不新增数据源。
 */
import type { ReactNode } from 'react';
import type { NavGroup, NavItem } from '@/affectui/app-shell';
import { CHECK_ICON, SETTINGS_ICON } from '@/affectui/icon-paths';
import {
  BOARD_CHART_ICON,
  CLOCK_ICON,
  DATABASE_ICON,
  HOME_ICON,
  MAIL_ICON,
  WORKFLOW_ICON,
} from '@/affectui/icons';
import type { TabName } from '@/store';

export const TAB_LABELS: Record<TabName, string> = {
  home: '主页',
  board: '成员看板',
  dag: '依赖 DAG',
  timeline: '时间线',
  models: '模型路由',
  permissions: '权限矩阵',
  approvals: '审批队列',
  messages: '消息',
};

const TAB_ICONS: Record<TabName, NavItem['icon']> = {
  home: HOME_ICON,
  board: BOARD_CHART_ICON,
  dag: WORKFLOW_ICON,
  timeline: CLOCK_ICON,
  models: DATABASE_ICON,
  permissions: SETTINGS_ICON,
  approvals: CHECK_ICON,
  messages: MAIL_ICON,
};

/** FR-3.2：主页在前，其余沿用 TAB_NAMES 的顺序。 */
export const TAB_ORDER: TabName[] = ['home', 'board', 'dag', 'timeline', 'models', 'permissions', 'approvals', 'messages'];

export type TabBadges = Partial<Record<TabName, number | null>>;

export function buildNav(badges: TabBadges): NavItem[] {
  return TAB_ORDER.map((tab) => ({
    label: TAB_LABELS[tab],
    icon: TAB_ICONS[tab],
    count: badges[tab] ?? undefined,
  }));
}

/**
 * 侧栏标签 → 视图。除中文标签外，兼容 affectui demo 里的英文入口：
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
    Timeline: 'timeline',
  };
  return aliases[label] ?? null;
}

/** 传给 AppShell / AgentRun 的公共外壳参数。 */
export interface ShellChrome {
  nav: NavItem[];
  groups: NavGroup[];
  active: string;
  onNavigate: (label: string) => void;
  header: { title: ReactNode; actions?: ReactNode };
  /** 侧栏顶部的团队切换器（AppShell 的 sidebarTop 插槽）。 */
  sidebarTop?: ReactNode;
}

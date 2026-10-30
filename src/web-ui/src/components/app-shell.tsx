/**
 * 面板外壳（coss ui 版）。
 *
 * 由 coss 的 Sidebar / SidebarMenu / Separator / Tooltip 组合而成，
 * 取代原先从 affectui 迁移进来的 1111 行手写实现（.ui-as-* 类 + role="menu" 等）。
 *
 * 侧栏收起成图标条时，`sidebarTop`（团队切换器）会移进顶栏内联展示，
 * 避免窄轨道里宽度超出侧栏、看起来像浮层。
 */
import { useEffect, type ReactNode } from 'react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';

export interface NavItem {
  label: string;
  icon?: ReactNode;
  count?: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  empty?: string;
}

export interface AppShellHeaderConfig {
  title: ReactNode;
  actions?: ReactNode;
}

export interface AppShellProps {
  nav: NavItem[];
  groups?: NavGroup[];
  active: string;
  onNavigate: (label: string) => void;
  header: AppShellHeaderConfig;
  /** 侧栏顶部插槽（团队切换器）。 */
  sidebarTop?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

function NavList({ items, active, onNavigate }: { items: NavItem[]; active: string; onNavigate: (label: string) => void }) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.label}>
          <SidebarMenuButton
            isActive={item.label === active}
            onClick={() => onNavigate(item.label)}
            tooltip={item.label}
            type="button"
          >
            {item.icon}
            <span>{item.label}</span>
          </SidebarMenuButton>
          {item.count !== undefined && <SidebarMenuBadge>{item.count}</SidebarMenuBadge>}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function ShellBody({ nav, groups = [], active, onNavigate, header, sidebarTop, footer, children }: AppShellProps) {
  const { isMobile, state, setOpenMobile } = useSidebar();
  // 收起到图标条时顶栏没有多余宽度，把团队切换器内联进 header
  const topInHeader = !isMobile && state === 'collapsed';

  // 小屏侧栏是抽屉：跳转到别的视图（点导航、收件箱跳审阅、hash 路由变化）后自动收起，
  // 否则抽屉会盖住刚跳过去的页面。
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [active, isMobile, setOpenMobile]);

  const navigate = (label: string) => {
    onNavigate(label);
    // 点当前视图时 active 不变、上面的 effect 不会触发，这里直接收掉
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <Sidebar collapsible="icon">
        {sidebarTop && !topInHeader && <SidebarHeader className="p-2 pt-3.5">{sidebarTop}</SidebarHeader>}
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>导航</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavList items={nav} active={active} onNavigate={navigate} />
            </SidebarGroupContent>
          </SidebarGroup>
          {groups.map((group, index) => (
            <SidebarGroup key={group.label}>
              {index === 0 && <SidebarSeparator />}
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                {group.items.length === 0 ? (
                  <p className="px-2 py-1.5 text-muted-foreground text-xs">{group.empty ?? '暂无内容'}</p>
                ) : (
                  <NavList items={group.items} active={active} onNavigate={navigate} />
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        {footer && <SidebarFooter>{footer}</SidebarFooter>}
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator className="h-5" orientation="vertical" />
          {topInHeader && sidebarTop && <div className="w-44 shrink-0">{sidebarTop}</div>}
          {!topInHeader && <div className="truncate font-medium text-sm">{header.title}</div>}
          {header.actions && <div className="ml-auto flex items-center gap-2">{header.actions}</div>}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
      </SidebarInset>
    </>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh">
        <ShellBody {...props} />
      </SidebarProvider>
    </TooltipProvider>
  );
}

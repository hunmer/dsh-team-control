/**
 * AppShell / Menu / Icon 鈥?readable reconstruction of chunks/W7XoacvA.js.
 *
 * Dependencies inlined from other chunks:
 * - HugeiconsIcon-C2cDExRS.js  鈫?HugeiconsIconBase (base SVG renderer, inlined below)
 * - component-B3wch4yo.js      鈫?SetupGuide (rendered inside AppShell's getting-started drawer)
 * (component-CuOxVraS.js is only used by the filter-menu helper, which AppShell/Menu/Icon
 *  do not depend on, so it is not reproduced here.)
 *
 * All logic is kept identical to the minified original; identifiers were renamed semantically.
 */

import * as React from "react";

import { Button } from "@/components/ui/button";

import {
  APP_SHELL_CSS,
  SETUP_GUIDE_CSS,
} from "./app-shell-css";
import {
  CHEVRON_DOWN,
  CHEVRON_RIGHT,
  CHECK_ICON,
  CLOSE_X,
  DELIVERABLES_ICON,
  EDIT_PENCIL_ICON,
  FOLDER_OPEN_ICON,
  HELP_CIRCLE_ICON,
  INTEGRATIONS_ICON,
  LOGOUT_ICON,
  PANEL_ICON,
  PLUS_ICON,
  SEARCH_ICON,
  SETTINGS_ICON,
  SIDEBAR_COLLAPSE_ICON,
  USER_ICON,
  type IconDef,
  type IconPathProps,
  type IconPathTuple,
} from "./icon-paths";

// ---------------------------------------------------------------------------
// Base icon renderer (inlined from HugeiconsIcon-C2cDExRS.js)
// ---------------------------------------------------------------------------

export type { IconDef, IconPathProps, IconPathTuple };

const HUGEICONS_DEFAULT_ATTRS = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
} as const;

export interface HugeiconsIconProps extends React.SVGProps<SVGSVGElement> {
  color?: string;
  size?: number;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  className?: string;
  altIcon?: IconDef;
  showAlt?: boolean;
  icon?: IconDef;
  primaryColor?: string;
  secondaryColor?: string;
  disableSecondaryOpacity?: boolean;
}

const HugeiconsIconBase = React.forwardRef<SVGSVGElement, HugeiconsIconProps>(
  function HugeiconsIconBase(
    {
      color = "currentColor",
      size = 24,
      strokeWidth,
      absoluteStrokeWidth = false,
      className = "",
      altIcon,
      showAlt = false,
      icon,
      primaryColor,
      secondaryColor,
      disableSecondaryOpacity = false,
      ...rest
    },
    ref,
  ) {
    const normalizedStroke =
      strokeWidth === undefined
        ? undefined
        : absoluteStrokeWidth
          ? (Number(strokeWidth) * 24) / Number(size)
          : strokeWidth;
    const strokeProps =
      normalizedStroke === undefined ? {} : { strokeWidth: normalizedStroke, stroke: "currentColor" };
    const svgProps: React.SVGProps<SVGSVGElement> & { ref: React.Ref<SVGSVGElement> } = {
      ref,
      ...HUGEICONS_DEFAULT_ATTRS,
      width: size,
      height: size,
      color: primaryColor || color,
      className,
      ...strokeProps,
      ...rest,
    };
    // Sort elements without opacity first, matching the original renderer.
    const children = [...(showAlt && altIcon ? altIcon : icon ?? [])]
      .sort(([, a], [, b]) => {
        const aHasOpacity = a.opacity !== undefined;
        return b.opacity === undefined ? (aHasOpacity ? -1 : 0) : 1;
      })
      .map(([tag, props]: IconPathTuple) => {
        const hasOpacity = props.opacity !== undefined;
        const opacity = hasOpacity && !disableSecondaryOpacity ? props.opacity : undefined;
        const colorOverride = secondaryColor
          ? {
              ...(props.stroke === undefined
                ? { fill: hasOpacity ? secondaryColor : primaryColor || color }
                : { stroke: hasOpacity ? secondaryColor : primaryColor || color }),
            }
          : {};
        return React.createElement(tag, { ...props, ...strokeProps, ...colorOverride, opacity, key: props.key });
      });
    return React.createElement("svg", svgProps, children);
  },
);

// ---------------------------------------------------------------------------
// Icon (chunk: T, export s)
// ---------------------------------------------------------------------------

export function Icon({
  icon,
  size = 16,
  stroke = 1.9,
  color = "currentColor",
}: {
  icon: IconDef;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  return <HugeiconsIconBase icon={icon} size={size} strokeWidth={stroke} color={color} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  icon?: IconDef;
  count?: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  empty?: string;
}

export interface SetupTask {
  id: string;
  label: string;
  done?: boolean;
}

export interface SetupGroup {
  id: string;
  title: string;
  tasks: SetupTask[];
}

export interface AppShellHeaderConfig {
  title?: React.ReactNode;
  actions?: React.ReactNode;
}

export interface WidthConfig {
  default?: number;
  min?: number;
  max?: number;
}

export interface AppShellProps {
  children?: React.ReactNode;
  active?: string;
  onNavigate?: (target: string) => void;
  workspace?: string;
  user?: { name?: string; avatar?: string };
  nav?: NavItem[];
  projects?: string[];
  groups?: NavGroup[];
  setup?: SetupGroup[];
  sidebarWidth?: WidthConfig;
  panel?: React.ReactNode;
  panelTitle?: string;
  panelWidth?: WidthConfig;
  header?: AppShellHeaderConfig;
  /** Rendered at the very top of the sidebar, above the workspace switcher. */
  sidebarTop?: React.ReactNode;
  className?: string;
  layout?: string;
  // The original component ignores unknown props (onApprove/onDeny/onStop/onDone are
  // spread in by callers and simply dropped). Keep that permissive behavior type-safe.
  [key: string]: unknown;
}

export interface MenuItem {
  label: string;
  description?: string;
  icon?: IconDef;
  checked?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

// ---------------------------------------------------------------------------
// Popover positioning helper
// ---------------------------------------------------------------------------

function nearestScrollContainerRect(element: HTMLElement): DOMRect {
  for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX) || node.classList.contains("ui-as")) {
      return node.getBoundingClientRect();
    }
  }
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

function Popover({
  open,
  onClose,
  children,
  align = "start",
  side = "bottom",
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
}) {
  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = React.useState<{ side: string; align: string }>({ side, align });

  React.useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!open || !el) return;
    let next = { side, align };
    el.dataset.side = side;
    el.dataset.align = align;
    const bounds = nearestScrollContainerRect(el);
    const rect = el.getBoundingClientRect();
    if (side === "bottom" && rect.bottom > bounds.bottom - 6) next = { ...next, side: "top" };
    if (side === "top" && rect.top < bounds.top + 6) next = { ...next, side: "bottom" };
    if (align === "start" && rect.right > bounds.right - 6) next = { ...next, align: "end" };
    if (align === "end" && rect.left < bounds.left + 6) next = { ...next, align: "start" };
    el.dataset.side = next.side;
    el.dataset.align = next.align;
    el.style.translate = "";
    const adjusted = el.getBoundingClientRect();
    const scale = adjusted.width / el.offsetWidth || 1;
    let shift = 0;
    if (adjusted.right > bounds.right - 6) shift = bounds.right - 6 - adjusted.right;
    if (adjusted.left + shift < bounds.left + 6) shift = bounds.left + 6 - adjusted.left;
    if (shift) el.style.translate = `${shift / scale}px 0`;
    setPlacement(next);
  }, [open, side, align]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const anchor = popoverRef.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return open ? (
    <div
      ref={popoverRef}
      className={["ui-as-popover", className].filter(Boolean).join(" ")}
      data-align={placement.align}
      data-side={placement.side}
      role="dialog"
    >
      {children}
    </div>
  ) : null;
}

// ---------------------------------------------------------------------------
// Menu list + Menu (chunk: I / L, exports: Menu = r)
// ---------------------------------------------------------------------------

function MenuList({ items, onPick }: { items: MenuItem[]; onPick: () => void }) {
  return (
    <div role="menu" className="ui-as-menu__list">
      {items.map((item) => (
        <button
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          className="ui-as-menu__item"
          data-danger={item.danger || undefined}
          data-rich={item.description ? true : undefined}
          key={item.label}
          onClick={() => {
            item.onSelect?.();
            onPick();
          }}
        >
          {item.icon && <Icon icon={item.icon} size={15} />}
          <span className="ui-as-menu__label">
            {item.label}
            {item.description && <small>{item.description}</small>}
          </span>
          {item.checked && <Icon icon={CHECK_ICON} size={14} />}
        </button>
      ))}
    </div>
  );
}

export function Menu({
  trigger,
  items,
  align = "start",
  side = "bottom",
  title,
  className,
}: {
  trigger: (args: { open: boolean; toggle: () => void }) => React.ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  side?: "top" | "bottom";
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className={["ui-as-anchor", className].filter(Boolean).join(" ")}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      <Popover open={open} onClose={() => setOpen(false)} align={align} side={side} className="ui-as-menu">
        {title && <span className="ui-as-menu__title">{title}</span>}
        <MenuList items={items} onPick={() => setOpen(false)} />
      </Popover>
    </span>
  );
}

// ---------------------------------------------------------------------------
// SetupGuide (inlined from component-B3wch4yo.js; rendered in the sidebar drawer)
// ---------------------------------------------------------------------------

const SgChevron = () => (
  <svg
    className="ui-sg__chevron"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </svg>
);

const SgMinimize = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 2.5v4h4M9.5 6.5l4.5-4.5M6.5 13.5v-4h-4M6.5 9.5 2 14" />
  </svg>
);

const SgExpand = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 2h4v4M14 2 9.5 6.5M6 14H2v-4M2 14l4.5-4.5" />
  </svg>
);

const SgClose = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  </svg>
);

const SgDoneMark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path d="m5 8.2 2 2 4-4.2" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SgLock = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <path d="m4 12 8-8" />
  </svg>
);

export function SetupGuide({
  title = "Setup guide",
  groups,
  onEdit,
  onClose,
  onChange,
  className,
}: {
  title?: string;
  groups: SetupGroup[];
  onEdit?: () => void;
  onClose?: () => void;
  onChange?: (doneIds: string[]) => void;
  className?: string;
}) {
  const [done, setDone] = React.useState<Set<string>>(
    () => new Set(groups.flatMap((group) => group.tasks.filter((task) => task.done).map((task) => task.id))),
  );
  const firstIncomplete = groups.find((group) => group.tasks.some((task) => !done.has(task.id)));
  const [openGroupId, setOpenGroupId] = React.useState<string | null>(firstIncomplete?.id ?? null);
  const [collapsed, setCollapsed] = React.useState(false);
  const totalTasks = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  const doneCount = groups.reduce((sum, group) => sum + group.tasks.filter((task) => done.has(task.id)).length, 0);
  const ratio = totalTasks ? Math.min(1, doneCount / totalTasks) : 0;

  const toggleTask = (group: SetupGroup, taskId: string) => {
    const next = new Set(done);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    setDone(next);
    onChange?.([...next]);
    if (group.tasks.every((task) => next.has(task.id))) {
      const upcoming = groups.find((candidate) => candidate.tasks.some((task) => !next.has(task.id)));
      window.setTimeout(() => setOpenGroupId(upcoming?.id ?? null), 420);
    }
  };

  return (
    <>
      <style href="ui-setup-guide" precedence="default">
        {SETUP_GUIDE_CSS}
      </style>
      <section className={["ui-sg", className].filter(Boolean).join(" ")} aria-label={title}>
        <header className="ui-sg__head">
          <h3 className="ui-sg__title" title={title} dir="auto">
            {title}
          </h3>
          <div className="ui-sg__actions">
            {onEdit && (
              <button type="button" className="ui-sg__edit" onClick={onEdit}>
                Edit
              </button>
            )}
            <button
              type="button"
              className="ui-sg__icon-btn"
              aria-label={collapsed ? "Expand setup guide" : "Minimize setup guide"}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <SgExpand /> : <SgMinimize />}
            </button>
            {onClose && (
              <button type="button" className="ui-sg__icon-btn" aria-label="Close setup guide" onClick={onClose}>
                <SgClose />
              </button>
            )}
          </div>
        </header>
        <span
          className="ui-sg__track"
          role="progressbar"
          aria-label={`${title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <span className="ui-sg__fill" style={{ transform: `scaleX(${ratio})` }} />
        </span>
        <div className="ui-sg__body" data-hidden={collapsed || undefined}>
          <div className="ui-sg__groups">
            {groups.map((group, groupIndex) => {
              const isOpen = openGroupId === group.id;
              const groupDone = group.tasks.every((task) => done.has(task.id));
              const nextTaskId = group.tasks.find((task) => !done.has(task.id))?.id;
              const nextTaskIndex = group.tasks.findIndex((task) => task.id === nextTaskId);
              const panelId = `ui-sg-${group.id}`;
              return (
                <div className="ui-sg__group" data-open={isOpen || undefined} key={`${groupIndex}-${group.id}`}>
                  <button
                    type="button"
                    className="ui-sg__group-head"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setOpenGroupId(isOpen ? null : group.id)}
                  >
                    <span className="ui-sg__group-title" data-done={groupDone || undefined} dir="auto">
                      {group.title}
                    </span>
                    <SgChevron />
                  </button>
                  <div className="ui-sg__panel" id={panelId} inert={!isOpen}>
                    <ul className="ui-sg__tasks">
                      {group.tasks.map((task, taskIndex) => {
                        const isDone = done.has(task.id);
                        const locked = !isDone && nextTaskIndex !== -1 && taskIndex > nextTaskIndex;
                        const state = isDone ? "done" : locked ? "locked" : "current";
                        return (
                          <li key={`${taskIndex}-${task.id}`}>
                            <button
                              type="button"
                              className="ui-sg__task"
                              data-state={state}
                              disabled={locked}
                              aria-pressed={isDone}
                              onClick={() => toggleTask(group, task.id)}
                            >
                              <span className="ui-sg__mark" aria-hidden="true">
                                {state === "done" ? <SgDoneMark /> : state === "locked" ? <SgLock /> : null}
                              </span>
                              <span className="ui-sg__task-label" dir="auto">
                                {task.label}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Column resizer (chunk: le)
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ColumnResizer({
  edge,
  label,
  value,
  default: defaultValue,
  min,
  max,
  onChange,
  onDrag,
  root,
}: {
  edge: "left" | "right";
  label: string;
  value: number;
  default: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onDrag: (dragging: boolean) => void;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const dragRef = React.useRef<{ x: number; width: number; scale: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const direction = edge === "left" ? 1 : -1;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rootEl = root.current;
    const scale = rootEl && rootEl.offsetWidth ? rootEl.getBoundingClientRect().width / rootEl.offsetWidth : 1;
    dragRef.current = { x: e.clientX, width: value, scale: scale || 1 };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    setDragging(true);
    onDrag(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) onChange(clamp(Math.round(drag.width + ((e.clientX - drag.x) / drag.scale) * direction), min, max));
  };
  const endDrag = () => {
    if (dragRef.current) {
      dragRef.current = null;
      setDragging(false);
      onDrag(false);
    }
  };

  return (
    <div
      className="ui-as-resizer"
      data-edge={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onChange(clamp(value + (e.key === "ArrowRight" ? step : -step) * direction, min, max));
        }
        if (e.key === "Home") onChange(min);
        if (e.key === "End") onChange(max);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// AppShell defaults
// ---------------------------------------------------------------------------

const DEFAULT_NAV: NavItem[] = [
  { label: "New chat", icon: EDIT_PENCIL_ICON },
  { label: "Folders", icon: DELIVERABLES_ICON },
  { label: "Integrations", icon: INTEGRATIONS_ICON },
];

const DEFAULT_PROJECTS = ["Q3 Campaign", "Brand assets", "Hiring", "Research"];

const DEFAULT_SETUP: SetupGroup[] = [
  {
    id: "workspace",
    title: "Set up your workspace",
    tasks: [
      { id: "name", label: "Name your workspace", done: true },
      { id: "invite", label: "Invite your teammates" },
      { id: "connect", label: "Connect your first app" },
    ],
  },
  {
    id: "work",
    title: "Start working",
    tasks: [
      { id: "folder", label: "Create a folder" },
      { id: "chat", label: "Start your first chat" },
      { id: "upload", label: "Upload a file" },
    ],
  },
  {
    id: "profile",
    title: "Make it yours",
    tasks: [
      { id: "avatar", label: "Add a profile picture" },
      { id: "notify", label: "Choose your notifications" },
    ],
  },
];

const NARROW_AT = 900;

function cheerText(progress: number): string {
  return progress >= 100 ? "All done!" : progress >= 60 ? "Almost there!" : progress > 0 ? "Great start!" : "Let's go!";
}

// ---------------------------------------------------------------------------
// AppShell (chunk: ce, export t)
// ---------------------------------------------------------------------------

export function AppShell({
  children,
  active,
  onNavigate,
  workspace = "Acme",
  user = { name: "Alex Morgan" },
  nav = DEFAULT_NAV,
  projects = DEFAULT_PROJECTS,
  groups,
  setup = DEFAULT_SETUP,
  sidebarWidth,
  panel,
  panelTitle = "Workspace",
  panelWidth,
  header,
  sidebarTop,
  className,
  layout,
}: AppShellProps) {
  const [newsCount, setNewsCount] = React.useState(2);
  const [sideCollapsed, setSideCollapsed] = React.useState(false);
  const widthCfg: Required<WidthConfig> = { default: 272, min: 220, max: 380, ...sidebarWidth };
  const panelCfg: Required<WidthConfig> = { default: 360, min: 280, max: 560, ...panelWidth };
  const [sideWidth, setSideWidth] = React.useState(widthCfg.default);
  const [panelSize, setPanelSize] = React.useState(panelCfg.default);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [resizing, setResizing] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [isNarrow, setIsNarrow] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setIsNarrow(el.offsetWidth <= NARROW_AT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (isNarrow) setDrawerOpen(false);
    setPanelOpen(!isNarrow);
  }, [isNarrow]);

  const sidebarHidden = isNarrow ? !drawerOpen : sideCollapsed;

  const handleNavigate = (target: string) => {
    setDrawerOpen(false);
    onNavigate?.(target);
  };

  type GuideState = "closed" | "open" | "closing";
  const [guideState, setGuideState] = React.useState<GuideState>("closed");
  const guideOpen = guideState === "open";
  const setGuide = (open: boolean) => {
    if (open) return setGuideState("open");
    setGuideState((state) => (state === "open" ? "closing" : state));
  };

  React.useEffect(() => {
    if (guideState !== "closing") return;
    const timer = window.setTimeout(() => setGuideState("closed"), 420);
    return () => window.clearTimeout(timer);
  }, [guideState]);

  const guideRef = React.useRef<HTMLDivElement | null>(null);
  const [guideHeight, setGuideHeight] = React.useState(0);
  const [collapsedHeight, setCollapsedHeight] = React.useState(0);

  React.useLayoutEffect(() => {
    const el = guideRef.current;
    if (el) {
      setGuideHeight(el.offsetHeight);
      if (guideState === "closed") setCollapsedHeight(el.offsetHeight);
    }
  }, [guideState]);

  React.useLayoutEffect(() => {
    const el = guideRef.current;
    if (!el) return;
    const measure = () => setGuideHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!guideOpen) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setGuide(false);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [guideOpen]);

  React.useEffect(() => {
    if (!drawerOpen || guideState !== "closed") return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, guideState]);

  React.useEffect(() => {
    if (!isNarrow || !panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setPanelOpen(false);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, panelOpen]);

  const [doneTaskIds, setDoneTaskIds] = React.useState<string[]>(() =>
    setup.flatMap((group) => group.tasks.filter((task) => task.done).map((task) => task.id)),
  );
  const totalTasks = setup.reduce((sum, group) => sum + group.tasks.length, 0);
  const progress = totalTasks ? Math.round((doneTaskIds.length / totalTasks) * 100) : 0;
  const userName = user.name ?? "";
  const initials = userName
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("");

  return (
    <div
      ref={rootRef}
      className={["ui-as", "ui-as-app", className].filter(Boolean).join(" ")}
      style={{ "--side-w": `${sideWidth}px`, "--panel-w": `${panelSize}px` } as React.CSSProperties}
      data-collapsed={(sideCollapsed && !isNarrow) || undefined}
      data-drawer={(isNarrow && drawerOpen) || undefined}
      data-panel={panel ? (panelOpen ? "open" : "closed") : undefined}
      data-resizing={resizing || undefined}
      data-header={header ? "" : undefined}
      data-layout={layout}
    >
      <style href="ui-app-shell" precedence="default">
        {APP_SHELL_CSS}
      </style>
      <button
        className="ui-as-icon-btn ui-as-side-open"
        type="button"
        aria-label="Open sidebar"
        tabIndex={sidebarHidden ? 0 : -1}
        onClick={() => (isNarrow ? setDrawerOpen(true) : setSideCollapsed(false))}
      >
        <Icon icon={SIDEBAR_COLLAPSE_ICON} size={16} />
      </button>
      {panel && (
        <button
          className="ui-as-icon-btn ui-as-panel-open"
          type="button"
          aria-label={`Open ${panelTitle.toLowerCase()}`}
          tabIndex={panelOpen ? -1 : 0}
          onClick={() => setPanelOpen(true)}
        >
          <Icon icon={PANEL_ICON} size={16} />
        </button>
      )}
      <div
        className="ui-as-scrim"
        aria-hidden="true"
        onClick={() => {
          setDrawerOpen(false);
          if (isNarrow) setPanelOpen(false);
        }}
      />
      {!sidebarHidden && !isNarrow && (
        <ColumnResizer
          edge="left"
          label="Resize sidebar"
          value={sideWidth}
          {...widthCfg}
          onChange={setSideWidth}
          onDrag={setResizing}
          root={rootRef}
        />
      )}
      {panel && panelOpen && !isNarrow && (
        <ColumnResizer
          edge="right"
          label={`Resize ${panelTitle.toLowerCase()}`}
          value={panelSize}
          {...panelCfg}
          onChange={setPanelSize}
          onDrag={setResizing}
          root={rootRef}
        />
      )}
      {header && (
        <>
          <div className="ui-as-bar ui-as-bar--side" inert={sidebarHidden}>
            <Button
              className="panel-coss"
              variant="ghost"
              size="icon-sm"
              aria-label="Collapse sidebar"
              onClick={() => setSideCollapsed(true)}
            >
              <Icon icon={SIDEBAR_COLLAPSE_ICON} size={16} />
            </Button>
            <button className="ui-as-icon-btn" type="button" aria-label="Search">
              <Icon icon={SEARCH_ICON} size={16} />
            </button>
          </div>
          <div className="ui-as-bar ui-as-bar--main">
            <div className="ui-as-bar__title">{header.title}</div>
            {header.actions && <div className="ui-as-bar__actions">{header.actions}</div>}
          </div>
          {panel && (
            <div className="ui-as-bar ui-as-bar--panel" inert={!panelOpen}>
              <span className="ui-as-panel__title">{panelTitle}</span>
              <button
                className="ui-as-icon-btn"
                type="button"
                aria-label={`Close ${panelTitle.toLowerCase()}`}
                onClick={() => setPanelOpen(false)}
              >
                <Icon icon={PANEL_ICON} size={16} />
              </button>
            </div>
          )}
        </>
      )}
      <aside className="ui-as-side" inert={sidebarHidden}>
        {sidebarTop}
        <header className="ui-as-side__head">
          <Menu
            title="Workspaces"
            items={[
              { label: workspace, description: "Pro 路 8 members", checked: true },
              { label: "Personal", description: "Free", checked: false },
              { label: "Create workspace", icon: PLUS_ICON },
            ]}
            trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
              <button className="ui-as-side__workspace" type="button" aria-expanded={open} onClick={toggle}>
                <span className="ui-as-side__logo">{workspace[0]}</span>
                {workspace}
                <Icon icon={CHEVRON_DOWN} size={13} />
              </button>
            )}
          />
          <span className="ui-as-side__tools">
            <button className="ui-as-icon-btn" type="button" aria-label="Search">
              <Icon icon={SEARCH_ICON} size={16} />
            </button>
            <button
              className="ui-as-icon-btn"
              type="button"
              aria-label={isNarrow ? "Close sidebar" : "Collapse sidebar"}
              onClick={() => (isNarrow ? setDrawerOpen(false) : setSideCollapsed(true))}
            >
              <Icon icon={SIDEBAR_COLLAPSE_ICON} size={16} />
            </button>
          </span>
        </header>
        <nav className="ui-as-side__nav" aria-label="Main menu">
          <div className="ui-as-side__group">
            {nav.map((item) => (
              <button
                type="button"
                className="ui-as-side__item"
                aria-current={active === item.label ? "page" : undefined}
                onClick={() => handleNavigate(item.label)}
                key={item.label}
              >
                <Icon icon={item.icon as IconDef} size={16} />
                {item.label}
                {item.count !== undefined && <span className="ui-as-side__count">{item.count}</span>}
              </button>
            ))}
          </div>
          {groups ? (
            groups.map((group) => (
              <div className="ui-as-side__group" key={group.label}>
                <span className="ui-as-side__label">{group.label}</span>
                {group.items.length === 0 && group.empty && <span className="ui-as-side__empty">{group.empty}</span>}
                {group.items.map((item) => (
                  <button
                    type="button"
                    className="ui-as-side__item"
                    aria-current={active === item.label ? "page" : undefined}
                    onClick={() => handleNavigate(item.label)}
                    key={item.label}
                  >
                    <Icon icon={item.icon as IconDef} size={16} />
                    {item.label}
                    {item.count !== undefined && <span className="ui-as-side__count">{item.count}</span>}
                  </button>
                ))}
              </div>
            ))
          ) : (
            <>
              <span className="ui-as-side__label">Projects</span>
              {projects.map((project) => (
                <button
                  type="button"
                  className="ui-as-side__item"
                  aria-current={active === project ? "page" : undefined}
                  onClick={() => handleNavigate(project)}
                  key={project}
                >
                  <Icon icon={FOLDER_OPEN_ICON} size={16} />
                  {project}
                </button>
              ))}
            </>
          )}
        </nav>
        <div className="ui-as-side__foot">
          {newsCount > 0 && (
            <div className="ui-as-news" data-count={newsCount}>
              <div className="ui-as-news__card ui-as-news__card--back" aria-hidden="true">
                <span className="ui-as-news__kicker">New in {workspace}</span>
                <Icon icon={CLOSE_X} size={13} />
              </div>
              <div className="ui-as-news__card">
                <div className="ui-as-news__top">
                  <span className="ui-as-news__kicker">New in {workspace}</span>
                  <button
                    type="button"
                    className="ui-as-news__close"
                    aria-label="Dismiss"
                    onClick={() => setNewsCount((count) => count - 1)}
                  >
                    <Icon icon={CLOSE_X} size={13} />
                  </button>
                </div>
                <b className="ui-as-news__title">{newsCount > 1 ? "Shared folders" : "Scheduled chats"}</b>
                <button type="button" className="ui-as-news__more">
                  Full changelog
                  <Icon icon={CHEVRON_RIGHT} size={13} />
                </button>
              </div>
            </div>
          )}
          <div className="ui-as-guide-slot" style={collapsedHeight ? { height: collapsedHeight } : undefined}>
            <div
              className="ui-as-guide"
              data-open={guideState !== "closed" || undefined}
              data-state={guideState}
              style={{ height: (guideState === "open" ? guideHeight : collapsedHeight) || undefined }}
            >
              <div ref={guideRef} className="ui-as-guide__inner">
                {guideState === "closed" ? (
                  <button
                    type="button"
                    className="ui-as-steps ui-as-guide__content"
                    aria-expanded={false}
                    onClick={() => setGuide(true)}
                    key="summary"
                  >
                    <span className="ui-as-steps__title">
                      Getting started
                      <Icon icon={CHEVRON_RIGHT} size={13} />
                    </span>
                    <span className="ui-as-steps__sub">
                      {progress}% done 路{" "}
                      <span className="ui-as-steps__cheer">{cheerText(progress)}</span>
                    </span>
                    <span className="ui-as-steps__bar">
                      <i style={{ width: `${Math.max(progress, 4)}%` }} />
                    </span>
                  </button>
                ) : (
                  <div className="ui-as-guide__content" key="guide">
                    <SetupGuide
                      title="Getting started"
                      groups={setup.map((group) => ({
                        ...group,
                        tasks: group.tasks.map((task) => ({ ...task, done: doneTaskIds.includes(task.id) })),
                      }))}
                      onChange={setDoneTaskIds}
                      onClose={() => setGuide(false)}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
          <Menu
            side="top"
            className="ui-as-user-menu"
            items={[
              { label: "Profile", icon: USER_ICON },
              { label: "Settings", icon: SETTINGS_ICON },
              { label: "Help & feedback", icon: HELP_CIRCLE_ICON },
              { label: "Log out", icon: LOGOUT_ICON, danger: true },
            ]}
            trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
              <button type="button" className="ui-as-user" aria-expanded={open} onClick={toggle}>
                {user.avatar ? (
                  <img src={user.avatar} alt="" width={21} height={21} />
                ) : (
                  <span className="ui-as-user__initials">{initials}</span>
                )}
                {userName}
                <Icon icon={CHEVRON_DOWN} size={13} />
              </button>
            )}
          />
        </div>
      </aside>
      <main className="ui-as-main">{children}</main>
      {panel && (
        <aside className="ui-as-panel" aria-label={panelTitle} inert={!panelOpen}>
          <header className="ui-as-panel__head">
            <span className="ui-as-panel__title">{panelTitle}</span>
            <button
              className="ui-as-icon-btn"
              type="button"
              aria-label={`Close ${panelTitle.toLowerCase()}`}
              onClick={() => setPanelOpen(false)}
            >
              <Icon icon={PANEL_ICON} size={16} />
            </button>
          </header>
          <div className="ui-as-panel__body">{panel}</div>
        </aside>
      )}
    </div>
  );
}

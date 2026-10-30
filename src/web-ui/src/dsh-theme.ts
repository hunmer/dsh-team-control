/**
 * 跟随 DSH 宿主主题。
 *
 * 编排面板以同源 iframe 嵌在 DSH Web 里（`/dsh-team-api/panel?...&embed=1`），
 * 因此可以直接读父文档的 `body[data-ds-dark-theme]` 与 `--dsw-alias-*` 主题变量，
 * 把它们映射成面板自己的 coss/Tailwind 变量（`--background` / `--border` …）。
 *
 * 宿主侧变量都定义在 `body` 上（浅色在 `body`，深色在 `body[data-ds-dark-theme]`），
 * 所以取父窗口 body 的计算样式。独立打开（无父窗口 / 跨源）时返回 null，
 * 面板继续用本地浅色/深色开关。
 */

export type DshThemeMode = 'light' | 'dark';

export interface DshTheme {
  mode: DshThemeMode;
  /** 面板 CSS 变量 → 宿主解析后的颜色值。 */
  vars: Record<string, string>;
}

/** 已经写到本面板 <html> 上的变量，退出跟随时要清掉。 */
const applied = new Set<string>();

function hostDocument(): Document | null {
  try {
    const parent = window.parent;
    if (!parent || parent === window) return null;
    const doc = parent.document;
    return doc && doc.body ? doc : null;
  } catch {
    return null;
  }
}

function luminance(color: string): number | null {
  let r = 0;
  let g = 0;
  let b = 0;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const digits = hex[1];
    const full = digits.length <= 4
      ? digits.slice(0, 3).split('').map((c) => c + c).join('')
      : digits.slice(0, 6);
    r = Number.parseInt(full.slice(0, 2), 16);
    g = Number.parseInt(full.slice(2, 4), 16);
    b = Number.parseInt(full.slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
    if (!rgb) return null;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  if (![r, g, b].every((value) => Number.isFinite(value))) return null;
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const INK = '#0b0b0c';
const PAPER = '#ffffff';
const INK_LUMINANCE = luminance(INK) ?? 0.005;

/** 在给定底色上取对比更强的那个前景（白 / 近黑）。 */
function contrastOn(color: string | undefined, mode: DshThemeMode): string {
  const l = color ? luminance(color) : null;
  if (l == null) return mode === 'dark' ? '#f9fafb' : '#0f1115';
  const onPaper = 1.05 / (l + 0.05);
  const onInk = (l + 0.05) / (INK_LUMINANCE + 0.05);
  return onPaper >= onInk ? PAPER : INK;
}

function readToken(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

/** 读取宿主当前主题；拿不到（独立打开 / 跨源 / 宿主没装主题）时返回 null。 */
export function readDshTheme(): DshTheme | null {
  const doc = hostDocument();
  if (!doc) return null;
  const html = doc.documentElement;
  const body = doc.body;
  const styles = window.parent.getComputedStyle(body);
  const base = readToken(styles, '--dsw-alias-bg-base');
  if (!base) return null;

  const mode: DshThemeMode = body.hasAttribute('data-ds-dark-theme') || html.hasAttribute('data-ds-dark-theme')
    ? 'dark'
    : 'light';

  const layer1 = readToken(styles, '--dsw-alias-bg-layer-1');
  const layer2 = readToken(styles, '--dsw-alias-bg-layer-2');
  const overlay = readToken(styles, '--dsw-alias-bg-overlay');
  const border1 = readToken(styles, '--dsw-alias-border-l1');
  const border2 = readToken(styles, '--dsw-alias-border-l2');
  const brand = readToken(styles, '--dsw-alias-brand-primary');
  const label1 = readToken(styles, '--dsw-alias-label-primary');
  const label2 = readToken(styles, '--dsw-alias-label-secondary');
  const error = readToken(styles, '--dsw-alias-state-error-primary');
  const success = readToken(styles, '--dsw-alias-state-success-primary');
  const warn = readToken(styles, '--dsw-alias-state-warn-primary');
  const sidebar = readToken(styles, '--dsw-specific-sidebar-fill');

  const vars: Record<string, string> = {};
  const put = (name: string, value: string | undefined) => {
    if (value) vars[name] = value;
  };
  const putAll = (names: string[], value: string | undefined) => {
    if (value) for (const name of names) vars[name] = value;
  };

  put('--background', base);
  put('--card', layer1 || base);
  put('--popover', overlay || layer1 || base);
  put('--sidebar', sidebar || layer1 || base);
  putAll(['--foreground', '--card-foreground', '--popover-foreground', '--secondary-foreground',
    '--accent-foreground', '--sidebar-foreground', '--code-foreground'], label1);
  putAll(['--muted-foreground'], label2);
  putAll(['--border', '--sidebar-border'], border1);
  putAll(['--input', '--sidebar-ring'], border2 || border1);
  putAll(['--secondary', '--muted', '--accent', '--sidebar-accent', '--code'], layer2 || layer1);
  putAll(['--primary', '--ring', '--info', '--sidebar-primary'], brand);
  put('--destructive', error);
  put('--success', success);
  put('--warning', warn);
  // 这组 *-foreground 在本面板里是「语义色的文字版本」（Badge 用 bg-x/8 + text-x-foreground），
  // 所以直接用宿主的语义色本身，而不是反色。
  putAll(['--info-foreground'], brand);
  putAll(['--destructive-foreground'], error);
  putAll(['--success-foreground'], success);
  putAll(['--warning-foreground'], warn);
  putAll(['--primary-foreground', '--sidebar-primary-foreground'], contrastOn(brand, mode));
  putAll(['--code-highlight'], layer2 || layer1);

  return { mode, vars };
}

/**
 * 把宿主主题写到面板自己的 <html>：class / data-theme 供 Tailwind 与图表组件，
 * 颜色变量以行内样式覆盖 coss 默认值。传 null 时撤销全部覆盖。
 */
export function applyDshTheme(theme: DshTheme | null): void {
  const root = document.documentElement;
  if (!theme) {
    for (const name of applied) root.style.removeProperty(name);
    applied.clear();
    return;
  }
  root.classList.toggle('dark', theme.mode === 'dark');
  root.dataset.theme = theme.mode;
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.vars)) {
    root.style.setProperty(name, value);
    applied.add(name);
  }
}

/** 监听宿主主题变化（切换明暗、改主题色）；返回取消函数。 */
export function watchDshTheme(onChange: () => void): () => void {
  const doc = hostDocument();
  if (!doc) return () => {};
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      onChange();
    });
  };
  const observer = new MutationObserver(schedule);
  const options: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-ds-dark-theme'],
  };
  observer.observe(doc.documentElement, options);
  observer.observe(doc.body, options);
  // 从别的窗口切回来时补一次（宿主可能在此期间换了主题）。
  window.addEventListener('focus', schedule);
  return () => {
    observer.disconnect();
    window.removeEventListener('focus', schedule);
    if (frame) window.cancelAnimationFrame(frame);
  };
}

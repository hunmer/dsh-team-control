/**
 * 面板外观（浅色 / 深色）。
 *
 * 两套配色都要生效（PRD FR-6）：
 * - coss/Tailwind 主题靠 `<html class="dark">`（coss-theme.css 的 `@custom-variant dark (&:is(.dark *))`）；
 * - 图表组件（agent-tree / agent-lanes / trace-waterfall）的暗色覆盖写作 `:where(.dark, [data-theme="dark"]) .ui-*`，需要祖先节点同时带 class 与 data 属性。
 *
 * 嵌在 DSH 里时（同源 iframe）跟随宿主主题：明暗 + `--dsw-alias-*` 颜色变量，
 * 见 `./dsh-theme`；宿主没有可用主题（独立打开）时回退到本地开关并持久化。
 */
import { useCallback, useEffect, useState } from 'react';
import { applyDshTheme, readDshTheme, watchDshTheme } from './dsh-theme';

export type ThemeName = 'light' | 'dark';

const STORE_THEME = 'dsh-team.panel.theme.v1';

function readStoredTheme(): ThemeName {
  try {
    const value = localStorage.getItem(STORE_THEME);
    return value === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 把本地主题写到 <html>：class 供 Tailwind/coss，data-theme 供图表组件。 */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * @returns `[主题, 切换, 是否跟随宿主]`；跟随宿主时切换是空操作。
 */
export function useTheme(): [ThemeName, () => void, boolean] {
  const [theme, setTheme] = useState<ThemeName>(readStoredTheme);
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    const sync = () => {
      const host = readDshTheme();
      setFollowing(host !== null);
      if (host) {
        applyDshTheme(host);
        setTheme(host.mode);
        return;
      }
      applyDshTheme(null);
      applyTheme(theme);
    };
    sync();
    return watchDshTheme(sync);
  }, [theme, following]);

  useEffect(() => {
    if (following) return;
    try {
      localStorage.setItem(STORE_THEME, theme);
    } catch { /* 隐私模式忽略 */ }
  }, [theme, following]);

  const toggle = useCallback(() => {
    // 跟随宿主时不接管：外观由 DSH 的设置决定。
    if (readDshTheme()) return;
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return [theme, toggle, following];
}

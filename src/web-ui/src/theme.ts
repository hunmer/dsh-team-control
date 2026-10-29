/**
 * 面板外观（浅色 / 深色）。
 *
 * 两套配色都要生效（PRD FR-6）：
 * - coss/Tailwind 主题靠 `<html class="dark">`（coss-theme.css 的 `@custom-variant dark (&:is(.dark *))`）；
 * - affectui 组件的暗色覆盖写作 `:where(.dark, [data-theme="dark"]) .ui-as`，需要祖先节点同时带 class 与 data 属性。
 * 因此切换时两处一起设置；不做系统主题跟随，保持面板默认浅色不变。
 */
import { useCallback, useEffect, useState } from 'react';

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

/** 把主题写到 <html>：class 供 Tailwind/coss，data-theme 供 affectui。 */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function useTheme(): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORE_THEME, theme);
    } catch { /* 隐私模式忽略 */ }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return [theme, toggle];
}

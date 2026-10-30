/**
 * DSH 工作区路径匹配：注册表里的 path 与团队上的 workspace 都是绝对路径，
 * Windows 下分隔符可能是 `\`，比较前统一成 `/`、小写、去尾斜杠。
 */
export const normalizePath = (value?: string | null): string =>
  String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 团队的工作区是否就是该工作区（相等，或位于其子目录下）。 */
export function workspaceMatches(teamWorkspace: string | undefined | null, workspacePath: string): boolean {
  const a = normalizePath(teamWorkspace);
  const b = normalizePath(workspacePath);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/');
}

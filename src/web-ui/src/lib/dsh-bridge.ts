/**
 * 面板 ↔ DSH 宿主页面的桥。
 *
 * 面板始终跑在一个同源 iframe 里（`/dsh-team-api/panel`），拿不到 DSH 的客户端服务；
 * 想「打开某个成员的对话」只能请宿主页面代劳 —— 用 postMessage 发一条请求，
 * 由 dsh 客户端插件（`dsh-plugin-ui/client.js` 的 TeamView）调用 sidebarRight/uiWorkspace 完成。
 */

export interface OpenMemberRequest {
  type: 'dsh-team:open-member';
  /** 成员在 DSH 里的子会话 id */
  sessionId: string;
  /** lead 会话 id（DSH 用它还原 subagentchat 地址；缺省时由 DSH 自己推断） */
  parentSessionId?: string;
}

export type OpenMemberResult = 'sent' | 'no-session' | 'not-embedded';

/** 面板是否跑在 DSH 页面的 iframe 里（独立打开 `/panel` 时为 false）。 */
export function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

/** 请宿主页面打开成员的对话侧栏；返回发送结果，宿主无响应时不会有反馈。 */
export function openMemberConversation(member: {
  agentSessionId?: string | null;
}, parentSessionId?: string | null): OpenMemberResult {
  const sessionId = member.agentSessionId || '';
  if (!sessionId) return 'no-session';
  if (!isEmbedded()) return 'not-embedded';
  const payload: OpenMemberRequest = {
    type: 'dsh-team:open-member',
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
  };
  // 面板与宿主同源，targetOrigin 用当前 origin 即可
  window.parent.postMessage(payload, window.location.origin);
  return 'sent';
}

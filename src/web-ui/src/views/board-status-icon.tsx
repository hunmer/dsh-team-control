/** affectUI TaskBoard 的状态图标（复制自模板，去掉外部类型依赖）。 */
export type BoardStatusKind =
  | 'backlog'
  | 'todo'
  | 'progress'
  | 'review'
  | 'done'
  | 'canceled';

export function StatusIcon({ kind, color = 'currentColor' }: { kind: BoardStatusKind; color?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke={color}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'backlog' && (
        <path d="M2.5 9.5 4 3.5h8l1.5 6M2.5 9.5v3h11v-3M2.5 9.5H6l.8 1.5h2.4l.8-1.5h3.5" />
      )}
      {kind === 'todo' && <rect x="3" y="3" width="10" height="10" rx="2.5" />}
      {kind === 'progress' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3l2 1.5" />
        </>
      )}
      {kind === 'review' && (
        <>
          <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
          <circle cx="8" cy="8" r="1.8" />
        </>
      )}
      {kind === 'done' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="3" fill={color} stroke="none" />
          <path d="m5.5 8.2 1.8 1.8 3.3-3.6" stroke="#fff" strokeWidth="1.5" />
        </>
      )}
      {kind === 'canceled' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m4.2 11.8 7.6-7.6" />
        </>
      )}
    </svg>
  );
}

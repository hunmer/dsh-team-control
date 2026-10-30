/**
 * ShineBorder —— 流星边框（meteor beam）容器。
 * 旋转的 conic-gradient 光束透过 padding 露出边框，形成绕边流光。
 */
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ShineBorderProps = {
  children: ReactNode;
  className?: string;
  borderWidth?: number;
  /** 一圈流光的旋转周期（秒） */
  duration?: number;
  color?: string;
};

export function ShineBorder({
  children,
  className,
  borderWidth = 3,
  duration = 4,
  color = 'var(--color-blue-500)',
}: ShineBorderProps) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-2xl border p-(--bw)', className)}
      style={{ '--bw': `${borderWidth}px` } as CSSProperties}
    >
      {/* 旋转的 conic 光束（流星效果） */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div
          className="absolute left-1/2 top-1/2 h-[200%] w-[200%] origin-center animate-rotating-beam"
          style={
            {
              background: `conic-gradient(from 90deg, transparent 0%, transparent 60%, ${color} 100%)`,
              '--duration': `${duration}s`,
            } as CSSProperties
          }
        />
      </div>

      {/* 静态细边框 */}
      <div className="pointer-events-none absolute inset-0 rounded-2xl border border-border/50" />

      {/* 内容层 */}
      <div className="relative z-10 h-full rounded-[calc(1rem-var(--bw))] bg-card">{children}</div>

      <style>{`
        @keyframes rotating-beam {
          0% { transform: translate(-50%, -50%) rotate(0deg); }
          100% { transform: translate(-50%, -50%) rotate(360deg); }
        }
        .animate-rotating-beam {
          animation: rotating-beam var(--duration, 4s) linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-rotating-beam { animation: none; }
        }
      `}</style>
    </div>
  );
}

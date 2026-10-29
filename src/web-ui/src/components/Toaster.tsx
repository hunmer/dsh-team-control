import { usePanel } from '@/store';

const KIND_CLASS: Record<string, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  info: 'border-border bg-card text-foreground',
};

export function Toaster() {
  const { toasts } = usePanel();
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`pointer-events-auto rounded-md border px-3 py-2 text-xs shadow-lg ${KIND_CLASS[toast.kind] ?? KIND_CLASS.info}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

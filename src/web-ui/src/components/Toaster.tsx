/**
 * store 的 toasts → coss ui Toast 的桥接。
 *
 * 渲染由 `<ToastProvider>`（components/ui/toast）负责，这里只把新出现的
 * store toast 推给全局 toastManager；store 仍保留自己的 TTL 逻辑。
 */
import { useEffect, useRef } from 'react';
import { toastManager } from '@/components/ui/toast';
import { usePanel } from '@/store';

type ToastKind = 'ok' | 'warn' | 'error' | 'info';

const KIND_TYPE: Record<ToastKind, 'success' | 'warning' | 'error' | 'info'> = {
  ok: 'success',
  warn: 'warning',
  error: 'error',
  info: 'info',
};

const KIND_TIMEOUT: Record<ToastKind, number> = {
  ok: 4200,
  warn: 4200,
  error: 8000,
  info: 4200,
};

export function Toaster() {
  const { toasts } = usePanel();
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    for (const item of toasts) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      toastManager.add({
        title: item.message,
        timeout: KIND_TIMEOUT[item.kind] ?? KIND_TIMEOUT.info,
        type: KIND_TYPE[item.kind] ?? KIND_TYPE.info,
      });
    }
    // store 丢弃过期 toast 后同步清理，避免 seen 无限增长。
    if (seen.current.size > toasts.length) {
      seen.current = new Set(toasts.map((item) => item.id));
    }
  }, [toasts]);

  return null;
}

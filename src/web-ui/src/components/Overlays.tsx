import { useState } from 'react';
import { usePanel } from '@/store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const TEXTS = {
  missing: {
    title: '缺少访问 token',
    detail: '本面板通过 sidecar 的本地 token 鉴权。请使用启动横幅输出的 panel 链接（形如 127.0.0.1:4317/panel#token=<token>）打开，或在此粘贴 token。token 只保存在内存，不写入浏览器存储。',
  },
  invalid: {
    title: '未授权（401）',
    detail: 'token 无效或已轮换。请使用 sidecar 启动横幅中的 panel 链接（…/panel#token=<token>）重新打开，或在此粘贴 token。',
  },
} as const;

export function AuthOverlayDialog() {
  const { authOverlay, submitToken } = usePanel();
  const [token, setToken] = useState('');
  const open = authOverlay === 'missing' || authOverlay === 'invalid';
  const text = authOverlay === 'invalid' ? TEXTS.invalid : TEXTS.missing;
  const submit = () => {
    const value = token.trim();
    if (!value) return;
    setToken('');
    submitToken(value);
  };
  return (
    <Dialog open={open} onOpenChange={() => { /* 只能通过提交 token / 重载关闭 */ }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.detail}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-3">
          <Input
            type="password"
            placeholder="粘贴 token（来自 sidecar 启动横幅）"
            aria-label="token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => location.reload()}>重新加载页面</Button>
          <Button onClick={submit}>使用 token 进入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BootErrorOverlay() {
  const { bootError, retryBoot } = usePanel();
  if (!bootError) return null;
  return (
    <div className="p-4">
      <Alert variant="error">
        <AlertTitle>加载失败</AlertTitle>
        <AlertDescription>{bootError}</AlertDescription>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" onClick={() => location.reload()}>重新加载页面</Button>
          <Button size="sm" onClick={retryBoot}>重试</Button>
        </div>
      </Alert>
    </div>
  );
}

/**
 * 成员信息 —— 面板里任何出现成员的地方都能看到同一份信息。
 *
 * 头像来源仍是 `@/lib/model-icons` 的厂商图标（ModelAvatar），识别不出品牌时退回名字首字母。
 * 聊天记录不在面板里渲染：面板是 DSH 页面里的同源 iframe，只能发消息请宿主页面打开成员会话
 * （`@/lib/dsh-bridge` → `dsh-plugin-ui/client.js` 的 TeamView 监听 message）。
 *
 * 三个出口共用 `MemberInfoContent`：
 *   MemberAvatarButton —— 头像按钮 + 浮层（成员胶囊、成员下拉旁）
 *   MemberInfoDialog   —— 受控对话框（排行行、总览图例等整块可点的地方）
 *   MemberInfoContent  —— 纯内容，供上面两者复用
 */
import type { ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { usePanel } from '@/store';
import type { Member } from '@/types';
import { ModelAvatar } from '@/components/ModelAvatar';
import { brandOfModel } from '@/lib/model-brand';
import { StatusPill } from '@/components/Bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { openMemberConversation } from '@/lib/dsh-bridge';
import { fmtCost, fmtTokens } from '@/lib/format';

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  blocked: '阻塞',
  idle: '空闲',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** 成员详情：状态、身份、当前任务、上下文与累计用量、会话 id，外加「打开聊天记录」。 */
export function MemberInfoContent({ member }: { member: Member }) {
  const { state, toast } = usePanel();
  // 上下文快照与用量来自 /api/contexts（Host 周期上报），按 memberId 关联
  const snap = state.contexts.find((c) => c.memberId === member.id) ?? null;
  const usage = snap?.usage ?? null;
  const used = snap ? snap.used || snap.blocks.reduce((sum, b) => sum + b.tokens, 0) : 0;
  const limit = snap?.limit || 0;
  const pctUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const canOpen = Boolean(member.agentSessionId);

  const openChat = () => {
    const result = openMemberConversation(member, state.team?.leadSessionId);
    if (result === 'no-session') toast('该成员没有 DSH 会话（worker 运行时没有会话）', 'warn');
    else if (result === 'not-embedded') toast('面板不在 DSH 页面里打开，无法唤起成员对话', 'warn');
  };

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <ModelAvatar model={member.model} name={member.name} size={18} />
        <span className="truncate text-sm font-medium">{member.name || member.id}</span>
        <StatusPill status={member.status} />
        <span className="text-muted-foreground">{STATUS_TEXT[member.status] ?? member.status}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1">
        <Row label="成员 ID"><code className="text-[11px]">{member.id}</code></Row>
        {member.role ? <Row label="角色">{member.role}</Row> : null}
        {member.model ? <Row label="模型">{member.model}</Row> : null}
        {member.reasoningEffort ? (
          <Row label="思考强度">
            <code className="text-[11px]">{member.reasoningEffort}</code>
            <span className="text-muted-foreground"> · 派发时锁定</span>
          </Row>
        ) : null}
        {member.currentTaskId ? <Row label="当前任务"><code className="text-[11px]">{member.currentTaskId}</code></Row> : null}
        {member.step ? <Row label="步骤">{member.step}</Row> : null}
        {typeof member.pct === 'number' ? (
          <Row label="进度">
            <span className="inline-flex items-center gap-1">
              <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, member.pct))}%` }} />
              </span>
              {Math.round(member.pct)}%
            </span>
          </Row>
        ) : null}
        {member.last ? <Row label="最近">{member.last}</Row> : null}
        {member.next ? <Row label="下一步">{member.next}</Row> : null}
        {snap ? (
          <Row label="上下文">
            <span className="inline-flex items-center gap-1">
              {fmtTokens(used)} / {limit > 0 ? fmtTokens(limit) : '未知'}
              {limit > 0 ? <span className="text-muted-foreground">({pctUsed}%)</span> : null}
            </span>
          </Row>
        ) : null}
        {usage ? (
          <>
            <Row label="累计 tokens">
              {fmtTokens(usage.total)}
              <span className="text-muted-foreground">
                {' '}(入 {fmtTokens(usage.input)} · 出 {fmtTokens(usage.output)})
              </span>
            </Row>
            <Row label="花费">{fmtCost(usage.cost)}</Row>
          </>
        ) : null}
        <Row label="会话">
          {member.agentSessionId
            ? <code className="text-[11px]">{member.agentSessionId}</code>
            : <span className="text-muted-foreground">无 DSH 会话</span>}
        </Row>
      </dl>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={!canOpen}
          title={canOpen ? '在 DSH 右侧栏打开该成员的聊天记录' : '该成员没有 DSH 会话'}
          onClick={openChat}
        >
          <MessageSquare className="size-3.5" />
          打开聊天记录
        </Button>
      </div>
    </div>
  );
}

export interface MemberAvatarButtonProps {
  member: Member | null | undefined;
  /** 头像像素尺寸，默认 14（与成员胶囊里的图标一致） */
  size?: number;
  className?: string;
}

/** 可点击的成员头像：浮层里是该成员的信息 + 「打开聊天记录」。 */
export function MemberAvatarButton({ member, size = 14, className }: MemberAvatarButtonProps) {
  if (!member) return null;
  const name = member.name || member.id;
  const hasBrand = Boolean(brandOfModel(member.model, member.name));

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={
              'flex size-5 shrink-0 items-center justify-center rounded-full outline-none transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring'
              + (className ? ' ' + className : '')
            }
            title={`${name} · 查看成员信息`}
            aria-label={`${name} · 查看成员信息`}
          />
        }
      >
        <ModelAvatar model={member.model} name={member.name} size={size} />
        {hasBrand ? null : (
          <span className="text-[10px] font-semibold text-muted-foreground">
            {(member.name || member.id || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" className="w-80 p-4">
        <PopoverTitle className="sr-only">{`${name} 的成员信息`}</PopoverTitle>
        <MemberInfoContent member={member} />
      </PopoverPopup>
    </Popover>
  );
}

export interface MemberInfoDialogProps {
  /** 传 null 关闭；传成员则打开 */
  member: Member | null;
  onOpenChange: (open: boolean) => void;
}

/** 受控的成员信息对话框：排行榜行、用量总览图例等「整块可点」的地方用。 */
export function MemberInfoDialog({ member, onOpenChange }: MemberInfoDialogProps) {
  return (
    <Dialog open={Boolean(member)} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{member ? `${member.name || member.id} · 成员信息` : '成员信息'}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {member ? <MemberInfoContent member={member} /> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

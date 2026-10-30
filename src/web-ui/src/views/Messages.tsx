import { useMemo } from 'react';
import { usePanel } from '@/store';
import type { TeamMessage } from '@/types';
import { Button } from '@/components/ui/button';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import { MessageSequence, pairMessages } from '@/components/message-sequence';
import type { TabName } from '@/store';

export function isUnacked(message: TeamMessage): boolean {
  return !message.ackedAt && message.status !== 'acked' && message.status !== 'expired';
}

export function MessagesView() {
  const { state, memberName, refreshMessages, toast } = usePanel();
  const { messages, members, tasks, errors } = state;

  // 已经一问一答（或收件成员已完成任务）的消息不再算「未 ack」——双方都看到了，回执语义已满足。
  const repliedIds = useMemo(() => {
    const { replyOf, requestOf, taskReplyOf } = pairMessages(messages, tasks);
    return new Set<string>([...replyOf.keys(), ...requestOf.keys(), ...taskReplyOf.keys()]);
  }, [messages, tasks]);
  const unackedCount = messages.filter((message) => isUnacked(message) && !repliedIds.has(message.id)).length;

  const correlations = useMemo(() => {
    const set = new Set<string>();
    for (const message of messages) if (message.correlationId) set.add(message.correlationId);
    return set.size;
  }, [messages]);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3" data-view="messages">
      <SectionHead
        title="消息与回执"
        meta={<MetaLine>
          {`${messages.length} 条消息 · 未 ack ${unackedCount} · ${correlations} 组关联` + (errors.messages ? ` · 加载失败：${errors.messages}` : '')}
        </MetaLine>}
        controls={
          <Button size="sm" variant="outline" onClick={() => {
            void refreshMessages().catch((err) => toast('消息刷新失败：' + (err instanceof Error ? err.message : String(err)), 'error'));
          }}>刷新</Button>
        }
      />
      {errors.messages && !messages.length
        ? <EmptyState title="消息加载失败" detail={errors.messages} />
        : !messages.length
          ? <EmptyState title="暂无消息" detail="每个成员一列，消息箭头从发送方指向接收方" />
          : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <MessageSequence members={members} memberName={memberName} messages={messages} tasks={tasks} />
              <div className="flex shrink-0 flex-wrap items-center gap-3 px-1 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-px w-5 bg-amber-500" />未 ack</span>
                <span className="flex items-center gap-1"><span className="h-px w-5 bg-sky-500" />已投递</span>
                <span className="flex items-center gap-1"><span className="h-px w-5 bg-emerald-500" />已回复（双向箭头）</span>
                <span className="flex items-center gap-1"><span className="h-px w-5 bg-muted-foreground" />已确认</span>
                <span className="flex items-center gap-1"><span className="h-px w-5 bg-destructive" />过期</span>
                <span>悬停箭头查看消息详情；列内回环＝发给自己的消息；横向滚动查看全部成员</span>
              </div>
            </div>
          )}
    </section>
  );
}

export type { TabName };

/**
 * 上下文分析 —— 用 living treemap 看「谁的上下文窗口被什么填满了」。
 *
 * 数据来自 GET /api/contexts（Host 插件周期上报 + agent/status 变化时补报）：
 *   每个成员一条快照：blocks(按类别归并的 token 占用) / limit(窗口) / compaction(压缩前后)
 * SSE 的 context.update 帧会触发去抖刷新，所以压缩发生时看板会自动切到对比视图。
 */
import { useMemo, useState } from 'react';
import { usePanel } from '@/store';
import type { ContextUsage } from '@/types';
import { ContextMap, type ContextAgent } from '@/components/context-map/context-map';
import { BarRaceChart, type BarRaceDatum } from '@/components/bar-race-chart/bar-race-chart';
import { MemberFanoutGrid, type FanoutMember } from '@/components/fan-out-grid/fan-out-grid';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import { modelAvatar } from '@/components/ModelAvatar';
import { MemberAvatarButton, MemberInfoDialog } from '@/components/member-info';
import { fmtCost, fmtTokens } from '@/lib/format';

/** 窗口未知（provider 没报 contextWindow）时的兜底值，只用于画空闲空间。 */
const DEFAULT_LIMIT = 200_000;

/** 排行口径：默认按总 tokens 排序。 */
type RankingMetric = 'input' | 'output' | 'total' | 'cost';

const RANKING_METRICS: { value: RankingMetric; label: string }[] = [
  { value: 'input', label: '输入' },
  { value: 'output', label: '输出' },
  { value: 'total', label: '总 tokens' },
  { value: 'cost', label: '花费' },
];

/** 取某成员（或 Lead）在某口径下的排行数值；没汇总到用量时按 0 处理。 */
function metricValue(usage: ContextUsage | null | undefined, metric: RankingMetric): number {
  if (!usage) return 0;
  if (metric === 'input') return usage.input;
  if (metric === 'output') return usage.output;
  if (metric === 'cost') return usage.cost;
  return usage.total;
}

export function ContextView() {
  const { state, refreshContexts, memberName } = usePanel();
  const { teamId, contexts, contextLead, errors, members } = state;
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 当前查看的成员（要拿它的 agentSessionId 去 DSH 打开对话）。 */
  const currentMember = members.find((m) => m.id === (picked ?? contexts[0]?.memberId)) ?? null;
  const [metric, setMetric] = useState<RankingMetric>('total');
  /** 点排行榜某行时打开同一个成员信息对话框 */
  const [infoId, setInfoId] = useState<string | null>(null);
  const infoMember = infoId ? members.find((m) => m.id === infoId) ?? null : null;

  // 快照按 updated_at 倒序返回：默认看最近上报的那个成员
  const selected = picked && contexts.some((c) => c.memberId === picked) ? picked : contexts[0]?.memberId ?? null;
  const snap = useMemo(() => contexts.find((c) => c.memberId === selected) ?? null, [contexts, selected]);

  const agents = useMemo<ContextAgent[]>(
    () => contexts.map((c) => ({
      id: c.memberId,
      name: memberName(c.memberId),
      model: c.model ?? undefined,
      icon: modelAvatar(c.model, memberName(c.memberId), c.provider, 14),
      limit: c.limit || DEFAULT_LIMIT,
    })),
    [contexts, memberName],
  );

  /** Base UI Select 需要 items 才能把 value 映射回显示文案，否则触发器显示原始 id。 */
  const memberItems = useMemo(
    () => agents.map((a) => ({ value: a.id, label: `${a.name}${a.model ? ` · ${a.model}` : ''}` })),
    [agents],
  );

  const refresh = () => {
    if (!teamId || busy) return;
    setBusy(true);
    void refreshContexts().catch(() => undefined).finally(() => setBusy(false));
  };

  let body: React.ReactNode;
  if (!teamId) {
    body = <EmptyState title="未选择团队" />;
  } else if (errors.contexts && !contexts.length) {
    body = <EmptyState title="上下文数据加载失败" detail={errors.contexts} />;
  } else if (!snap) {
    body = (
      <EmptyState
        title="还没有上下文上报"
        detail="成员开始执行后，Host 插件会周期性上报其上下文窗口占用"
      />
    );
  } else {
    body = (
      <ContextMap
        title="上下文窗口"
        blocks={snap.blocks}
        limit={snap.limit || DEFAULT_LIMIT}
        model={snap.model ?? undefined}
        agents={agents}
        agent={snap.memberId}
        onAgentChange={(id) => setPicked(id)}
        compaction={snap.compaction ?? null}
        status={snap.status ?? undefined}
      />
    );
  }

  const used = snap ? snap.used || snap.blocks.reduce((sum, b) => sum + b.tokens, 0) : 0;
  const limit = snap?.limit || DEFAULT_LIMIT;

  /** 排行：所有成员 + Lead 的用量，按当前口径降序；SSE 刷新时数值与名次都会带过渡动画。 */
  const ranking = useMemo<BarRaceDatum[]>(() => {
    const rows: BarRaceDatum[] = contexts.map((c) => ({
      id: c.memberId,
      label: memberName(c.memberId),
      value: metricValue(c.usage, metric),
      icon: modelAvatar(c.model, memberName(c.memberId), c.provider, 14),
    }));
    // Lead 没有上下文快照，只有用量；还没产生 LLM 调用时不占一个全 0 的行。
    if (contextLead && (contextLead.total > 0 || contextLead.cost > 0)) {
      rows.push({ id: 'lead', label: memberName('lead'), value: metricValue(contextLead, metric) });
    }
    return rows;
  }, [contexts, contextLead, memberName, metric]);

  const metricLabel = RANKING_METRICS.find((m) => m.value === metric)?.label ?? '总 tokens';

  /** 总览网格的成员口径：所有成员的累计 tokens / 花费（Lead 一起算，口径与排行一致）。 */
  const fanoutMembers = useMemo<FanoutMember[]>(() => {
    const rows: FanoutMember[] = contexts.map((c) => ({
      id: c.memberId,
      name: memberName(c.memberId),
      tokens: c.usage?.total ?? 0,
      cost: c.usage?.cost ?? 0,
      icon: modelAvatar(c.model, memberName(c.memberId), c.provider, 16),
    }));
    if (contextLead && (contextLead.total > 0 || contextLead.cost > 0)) {
      rows.push({ id: 'lead', name: memberName('lead'), tokens: contextLead.total, cost: contextLead.cost });
    }
    return rows;
  }, [contexts, contextLead, memberName]);

  return (
    <section className="space-y-3">
      <SectionHead
        title="上下文分析"
        meta={snap ? `${fmtTokens(used)} / ${fmtTokens(limit)} tokens · ${snap.updatedAt ?? ''}` : undefined}
        controls={
          <div className="flex items-center gap-2">
            {agents.length ? (
              <Select
                items={memberItems}
                value={selected ?? undefined}
                onValueChange={(value) => setPicked(String(value))}
              >
                <SelectTrigger size="sm" className="w-52" title="切换查看的成员" aria-label="成员">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memberItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <MemberAvatarButton member={currentMember} size={18} />
            <Button size="sm" variant="outline" disabled={!teamId || busy} onClick={refresh}>
              {busy ? '刷新中…' : '刷新上下文'}
            </Button>
          </div>
        }
      />
      {body}
      <MemberInfoDialog member={infoMember} onOpenChange={(open) => { if (!open) setInfoId(null); }} />
      {ranking.length ? (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">成员用量排行</span>
            <SegmentedControl size="sm" aria-label="排行口径">
              {RANKING_METRICS.map((m) => (
                <SegmentedControlItem
                  key={m.value}
                  aria-current={metric === m.value ? 'page' : undefined}
                  onClick={() => setMetric(m.value)}
                >
                  {m.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
          <BarRaceChart
            data={ranking}
            topN={Math.max(1, Math.min(6, ranking.length))}
            formatValue={metric === 'cost' ? fmtCost : fmtTokens}
            caption={metric === 'cost' ? '消耗花费排行' : `${metricLabel}排行`}
            period="实时"
            onSelect={(id) => { if (id !== 'lead') setInfoId(id); }}
          />
        </div>
      ) : null}
      {fanoutMembers.length ? (
        <MemberFanoutGrid
          members={fanoutMembers}
          title="上下文用量总览"
          job={`${fanoutMembers.length} 个成员 · 累计`}
          formatCost={fmtCost}
        />
      ) : null}
      {snap?.breakdown ? (
        <MetaLine>
          system {fmtTokens(snap.breakdown.system ?? 0)} · tools {fmtTokens(snap.breakdown.tools ?? 0)} · messages {fmtTokens(snap.breakdown.messages ?? 0)}
          {snap.asOfSeq ? ` · 截至事件 #${snap.asOfSeq}` : ''}
        </MetaLine>
      ) : null}
      {contexts.length && errors.contexts ? (
        <MetaLine>上一次自动刷新失败：{errors.contexts}（保留最后一次成功快照）</MetaLine>
      ) : null}
    </section>
  );
}

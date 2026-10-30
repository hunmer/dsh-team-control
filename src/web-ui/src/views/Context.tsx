/**
 * 上下文分析 —— 用 living treemap 看「谁的上下文窗口被什么填满了」。
 *
 * 数据来自 GET /api/contexts（Host 插件周期上报 + agent/status 变化时补报）：
 *   每个成员一条快照：blocks(按类别归并的 token 占用) / limit(窗口) / compaction(压缩前后)
 * SSE 的 context.update 帧会触发去抖刷新，所以压缩发生时看板会自动切到对比视图。
 *
 * 展示：每个成员一张 ContextMap 卡片并列铺开（左上角是成员名 + 模型图标），不再用下拉切换。
 * 底部的「上下文用量总览」按 trace 里的 LLM 调用时间顺序铺格子：不同成员的调用交错出现，
 * 悬浮任意一格可看到这一刻是谁、用的什么模型、本次输入/输出与花费。
 */
import { useEffect, useMemo, useState } from 'react';
import { usePanel } from '@/store';
import type { ContextUsage, TraceNode } from '@/types';
import { ContextMap } from '@/components/context-map/context-map';
import { BarRaceChart, type BarRaceDatum } from '@/components/bar-race-chart/bar-race-chart';
import { MemberFanoutGrid, type FanoutMember, type FanoutSlice } from '@/components/fan-out-grid/fan-out-grid';
import { Button } from '@/components/ui/button';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';
import { modelAvatar } from '@/components/ModelAvatar';
import { MemberInfoDialog } from '@/components/member-info';
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
  const { state, refreshContexts, refreshTrace, memberName } = usePanel();
  const { teamId, contexts, contextLead, errors, members, trace } = state;
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<RankingMetric>('total');
  /** 点排行榜某行时打开同一个成员信息对话框 */
  const [infoId, setInfoId] = useState<string | null>(null);
  const infoMember = infoId ? members.find((m) => m.id === infoId) ?? null : null;

  const refresh = () => {
    if (!teamId || busy) return;
    setBusy(true);
    void refreshContexts().catch(() => undefined).finally(() => setBusy(false));
  };

  /** 头部汇总：所有成员窗口之和，作为并列卡片的总体参照。 */
  const totalUsed = contexts.reduce((sum, c) => sum + (c.used || c.blocks.reduce((s, b) => s + b.tokens, 0)), 0);
  const totalLimit = contexts.reduce((sum, c) => sum + (c.limit || DEFAULT_LIMIT), 0);

  // 总览网格需要 trace 里的调用时间线；从别的页签切进来时 trace 可能还没加载过。
  useEffect(() => {
    if (teamId && !trace) void refreshTrace().catch(() => undefined);
  }, [teamId, trace, refreshTrace]);

  /**
   * 时间切片：trace 里每次 LLM 调用一条，按发生时间升序。
   * 成员归属靠最近的 `member:` 前缀节点；`session:` 是 Lead 的会话。
   */
  const slices = useMemo<FanoutSlice[]>(() => {
    if (!trace?.root) return [];
    const out: FanoutSlice[] = [];
    const walk = (node: TraceNode, fallbackMember: string) => {
      const memberId = node.id.startsWith('member:')
        ? node.id.slice('member:'.length)
        : node.id.startsWith('session:')
          ? 'lead'
          : fallbackMember;
      if (node.kind === 'llm') {
        const tokens = (node.tokensIn ?? 0) + (node.tokensOut ?? 0);
        if (tokens > 0) {
          out.push({
            memberId,
            tokens,
            at: trace.originMs + node.start,
            note: node.model,
            inTokens: node.tokensIn,
            outTokens: node.tokensOut,
            cost: node.cost,
          });
        }
      }
      for (const child of node.children) walk(child, memberId);
    };
    walk(trace.root, 'lead');
    return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }, [trace]);

  /** 没有成员快照时保持原来的累计视图，避免和「还没有上下文上报」的空态自相矛盾。 */
  const timeSlices = contexts.length ? slices : [];

  let body: React.ReactNode;
  if (!teamId) {
    body = <EmptyState title="未选择团队" />;
  } else if (errors.contexts && !contexts.length) {
    body = <EmptyState title="上下文数据加载失败" detail={errors.contexts} />;
  } else if (!contexts.length) {
    body = (
      <EmptyState
        title="还没有上下文上报"
        detail="成员开始执行后，Host 插件会周期性上报其上下文窗口占用"
      />
    );
  } else {
    // 并列展示：所有成员一次性排成一行，每张卡片固定宽度，放不下就横向滚动
    body = (
      <div className="flex snap-x snap-mandatory items-start gap-3 overflow-x-auto pb-2">
        {contexts.map((c) => {
          const name = memberName(c.memberId);
          return (
            <div key={c.memberId} className="w-[520px] shrink-0 snap-start rounded-xl border bg-card p-4">
              <ContextMap
                title={name}
                headerIcon={modelAvatar(c.model, name, c.provider, 14)}
                blocks={c.blocks}
                limit={c.limit || DEFAULT_LIMIT}
                compaction={c.compaction ?? null}
                status={c.status ?? undefined}
              />
              {c.breakdown ? (
                <MetaLine>
                  system {fmtTokens(c.breakdown.system ?? 0)} · tools {fmtTokens(c.breakdown.tools ?? 0)} · messages{' '}
                  {fmtTokens(c.breakdown.messages ?? 0)}
                  {c.asOfSeq ? ` · 截至事件 #${c.asOfSeq}` : ''}
                </MetaLine>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

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
    const rows: FanoutMember[] = contexts.map((c) => {
      const limit = c.limit || DEFAULT_LIMIT;
      const used = c.used || c.blocks.reduce((s, b) => s + b.tokens, 0);
      return {
        id: c.memberId,
        name: memberName(c.memberId),
        tokens: c.usage?.total ?? 0,
        cost: c.usage?.cost ?? 0,
        icon: modelAvatar(c.model, memberName(c.memberId), c.provider, 16),
        // 悬浮明细：每个成员的模型与上下文窗口占用都不同
        detail: `${c.model ?? '未知模型'} · 上下文 ${fmtTokens(used)} / ${fmtTokens(limit)}（${Math.round((used / limit) * 100)}%）`,
      };
    });
    const seen = new Set(rows.map((r) => r.id));
    if (contextLead && (contextLead.total > 0 || contextLead.cost > 0)) {
      rows.push({
        id: 'lead',
        name: memberName('lead'),
        tokens: contextLead.total,
        cost: contextLead.cost,
        detail: '主控 agent · 未上报上下文窗口',
      });
      seen.add('lead');
    }
    // trace 里出现过、但没有上下文快照的成员：用调用切片汇总，避免总览缺人 / 配色错位
    if (timeSlices.length) {
      const agg = new Map<string, { tokens: number; cost: number; note?: string }>();
      for (const s of timeSlices) {
        if (seen.has(s.memberId)) continue;
        const cur = agg.get(s.memberId) ?? { tokens: 0, cost: 0 };
        cur.tokens += s.tokens;
        cur.cost += s.cost ?? 0;
        cur.note = cur.note ?? s.note;
        agg.set(s.memberId, cur);
      }
      for (const [id, v] of agg) {
        rows.push({
          id,
          name: memberName(id),
          tokens: v.tokens,
          cost: v.cost,
          detail: `${v.note ?? '未知模型'} · 来自 trace 调用记录（无上下文快照）`,
        });
      }
    }
    return rows;
  }, [contexts, contextLead, memberName, timeSlices]);

  return (
    <section className="space-y-3">
      <SectionHead
        title="上下文分析"
        meta={
          contexts.length
            ? `${contexts.length} 个成员 · 合计 ${fmtTokens(totalUsed)} / ${fmtTokens(totalLimit)} tokens`
            : undefined
        }
        controls={
          <div className="flex items-center gap-2">
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
          slices={timeSlices}
          title="上下文用量总览"
          job={
            timeSlices.length
              ? `${fanoutMembers.length} 个成员 · ${timeSlices.length} 次调用（按时间顺序）`
              : `${fanoutMembers.length} 个成员 · 累计`
          }
          formatCost={fmtCost}
        />
      ) : null}
      {contexts.length && errors.contexts ? (
        <MetaLine>上一次自动刷新失败：{errors.contexts}（保留最后一次成功快照）</MetaLine>
      ) : null}
    </section>
  );
}

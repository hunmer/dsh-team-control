/**
 * 依赖 DAG —— 使用 affectui agent-tree 的卡片树 UI 效果渲染。
 * DAG（多父依赖）映射为树：每个任务挂在它的第一个上游依赖下，
 * 其余上游在卡片 tiles 里以 "↑N" 标注；READY / BLOCKED / CP 同样以 tile 呈现。
 */
import { useMemo } from 'react';
import { usePanel } from '@/store';
import { truncate } from '@/lib/format';
import type { DagData, DagNode } from '@/types';
import { AgentTree, type AgentStatus, type TreeAgent } from '@/components/agent-tree/agent-tree';
import { EmptyState, MetaLine, SectionHead } from '@/components/Bits';

const shortId = (id: string) => (id.includes('_') ? id.slice(id.lastIndexOf('_') + 1) : id);

function mapStatus(node: DagNode): AgentStatus {
  const status = String(node.status || 'pending');
  if (status === 'running') return 'running';
  if (status === 'done' || status === 'succeeded') return 'done';
  if (status === 'failed') return 'failed';
  if (node.blocked || status === 'blocked' || status === 'waiting') return 'waiting';
  return 'queued';
}

/** DAG → TreeAgent 树（多父挂到第一个上游，防环） */
export function dagToTree(dag: DagData, memberName: (id?: string | null) => string): TreeAgent {
  const nodes = dag.nodes ?? [];
  const edges = dag.edges ?? [];
  const readySet = new Set<string>([...(dag.ready ?? [])]);
  for (const node of nodes) if (node.ready) readySet.add(node.taskId);
  const criticalSet = new Set(dag.criticalPath ?? []);

  const byId = new Map(nodes.map((node) => [node.taskId, node]));
  // 依赖来源兼容：edges 显式边 + 节点内联 dependsOn（去重）
  const downstream = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to)) return;
    if (!downstream.has(from)) downstream.set(from, new Set());
    downstream.get(from)!.add(to);
  };
  for (const edge of edges) addEdge(edge.from, edge.to);
  for (const node of nodes) for (const dep of node.dependsOn ?? []) addEdge(dep, node.taskId);
  const downstreamList = new Map<string, string[]>();
  for (const [from, tos] of downstream) downstreamList.set(from, [...tos].sort((a, b) => a.localeCompare(b)));

  const visited = new Set<string>();
  const toAgent = (taskId: string): TreeAgent => {
    const node = byId.get(taskId)!;
    const status = mapStatus(node);
    const tags: string[] = [];
    if (readySet.has(taskId)) tags.push('READY');
    if (node.blocked) tags.push('BLK');
    if (criticalSet.has(taskId)) tags.push('CP');
    const extraUpstream = Math.max(0, upstreamCount.get(taskId)! - 1);
    if (extraUpstream > 0) tags.push('↑' + extraUpstream);
    return {
      id: taskId,
      name: truncate(node.subject || taskId, 26),
      model: shortId(taskId),
      task: `${memberName(node.assignee)} · 尝试 #${node.attempts || 0}`,
      tools: tags.map((tag) => <span key={tag} title={tag === 'CP' ? '关键路径' : tag === 'BLK' ? '被阻塞' : tag.startsWith('↑') ? `另有 ${tag.slice(1)} 个上游依赖` : '依赖就绪'}>{tag === 'CP' ? '★' : tag === 'BLK' ? '⏸' : tag.startsWith('↑') ? tag : '●'}</span>),
      status,
      ask: status === 'waiting' ? '等待上游依赖完成…' : undefined,
      children: visited.has(taskId)
        ? []
        : (visited.add(taskId), (downstreamList.get(taskId) ?? []).map(toAgent)),
    };
  };

  // 上游计数（取内联 dependsOn 与显式 edges 的较大者，避免同源数据重复计数）
  const inlineDeps = new Map<string, number>();
  for (const node of nodes) inlineDeps.set(node.taskId, node.dependsOn?.length ?? 0);
  const edgeDeps = new Map<string, number>();
  for (const edge of edges) edgeDeps.set(edge.to, (edgeDeps.get(edge.to) ?? 0) + 1);
  const upstreamCount = new Map<string, number>();
  for (const node of nodes) upstreamCount.set(node.taskId, Math.max(inlineDeps.get(node.taskId) ?? 0, edgeDeps.get(node.taskId) ?? 0));
  const roots = nodes.filter((node) => !upstreamCount.get(node.taskId)).map((node) => node.taskId);

  const readyCount = nodes.filter((n) => readySet.has(n.taskId)).length;
  const blockedCount = nodes.filter((n) => n.blocked).length;
  const depTotal = Math.max(edges.length, [...upstreamCount.values()].reduce((sum, n) => sum + n, 0));
  const statuses = nodes.map(mapStatus);
  const rootStatus: AgentStatus = statuses.includes('running') ? 'running'
    : statuses.includes('failed') ? 'failed'
      : statuses.includes('waiting') ? 'waiting'
        : statuses.every((s) => s === 'done') && nodes.length ? 'done' : 'queued';

  return {
    id: '__dag_root__',
    name: '任务 DAG',
    model: `${nodes.length} 节点 · ${depTotal} 依赖`,
    task: `ready ${readyCount} · blocked ${blockedCount}${dag.criticalPath?.length ? ` · 关键路径 ${dag.criticalPath.map(shortId).join(' → ')}` : ''}`,
    status: rootStatus,
    children: roots.map(toAgent),
  };
}

export function DagView() {
  const { state, memberName } = usePanel();
  const { dag, teamId, errors } = state;
  const nodes = dag?.nodes ?? [];
  const edges = dag?.edges ?? [];

  const tree = useMemo(
    () => (dag && nodes.length ? dagToTree(dag, memberName) : null),
    [dag, nodes.length, memberName],
  );

  if (!teamId) return <section className="space-y-3"><SectionHead title="依赖 DAG" meta={<MetaLine>—</MetaLine>} /><EmptyState title="未选择团队" detail="等待 /api/teams 返回团队列表后自动加载。" /></section>;
  if (errors.dag && !nodes.length) return <section className="space-y-3"><SectionHead title="依赖 DAG" meta={<MetaLine>—</MetaLine>} /><EmptyState title="DAG 加载失败" detail={errors.dag} /></section>;
  if (!tree) return (
    <section className="space-y-3">
      <SectionHead title="依赖 DAG" meta={<MetaLine>0 节点</MetaLine>} />
      <EmptyState title="暂无任务节点" detail="用 POST /api/tasks / /api/deps 建图后这里显示依赖关系。" />
    </section>
  );

  return (
    <section className="space-y-3">
      <AgentTree
        root={tree}
        title="依赖 DAG"
        formatCost={() => ''}
      />
    </section>
  );
}

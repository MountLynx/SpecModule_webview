// 分层布局（TB 自上而下）：宽扁节点沿短边（纵向）逐层延伸，同层节点横向
// 并排——一屏纵向容纳更多层，横向容纳更多同层节点，信息密度高于 LR。
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "./api";

const NODE_W = 190;
const NODE_H = 64;

/** 节点标称尺寸（= dagre 布局所用视在尺寸）；流节点必须显式携带，
 * 否则 React Flow MiniMap 按 userNode 尺寸过滤会把全部节点判为无尺寸而画空。 */
export const NODE_SIZE = { width: NODE_W, height: NODE_H };

/** 布局输入：id + 视在尺寸（状态节点与卫星产物卡尺寸不同，布局统一按尺寸计算） */
export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export function layoutGraphSized(
  nodes: LayoutNode[],
  edges: { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) pos.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 });
  }
  return pos;
}

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  return layoutGraphSized(
    nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges,
  );
}

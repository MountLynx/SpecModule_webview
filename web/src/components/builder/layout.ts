// 构建器画布自动布局（TB，同只读图 dagre.ts 的取向；节点必须显式携带宽高，
// 否则 React Flow MiniMap 按 userNode 尺寸过滤会把全部节点判为无尺寸而画空）。
import dagre from "@dagrejs/dagre";
import type { BuilderDraft, BuilderNode } from "../../api";

/** 构建器节点标称尺寸（= dagre 布局所用视在尺寸） */
export const BUILDER_NODE_SIZE = { width: 190, height: 64 };

/** 返回重排后的 nodes 数组（draft.nodes 替换用；位置取 dagre 左上角坐标）。 */
export function autoLayout(
  nodes: BuilderNode[],
  edges: BuilderDraft["edges"],
): BuilderNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes)
    g.setNode(n.id, { width: BUILDER_NODE_SIZE.width, height: BUILDER_NODE_SIZE.height });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return p
      ? {
          ...n,
          position: {
            x: p.x - BUILDER_NODE_SIZE.width / 2,
            y: p.y - BUILDER_NODE_SIZE.height / 2,
          },
        }
      : n;
  });
}

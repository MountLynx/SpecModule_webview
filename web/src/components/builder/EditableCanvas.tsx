// 编辑画布：draft.nodes/edges 为唯一数据源，React Flow 完全受控——
// 所有变更（连线/删除/拖拽落位/点选）都以 onChange 回写 draft，画布零独立状态。
import { useCallback, useMemo } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodeDrag,
  type OnNodesDelete,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { BuilderDraft, BuilderEdge, BuilderNode } from "../../api";
import { genId } from "../../api";
import { autoLayout, BUILDER_NODE_SIZE } from "./layout";
import { BuilderNodeView, type BuilderFlowNode } from "./BuilderNodeView";

const nodeTypes: NodeTypes = { builder: BuilderNodeView };

/** 节点类型 → 草稿引用字段（画布内只读展示；编辑走 api.NODE_REF_FIELD，不入画布） */
const REF_KEY = {
  harness: "harness",
  script: "script",
  command: "command",
  submodule: "submodule",
} as const;

export type Selection = { kind: "node" | "edge"; id: string } | null;

interface Props {
  draft: BuilderDraft;
  selected: Selection;
  onSelect: (s: Selection) => void;
  onChange: (fn: (d: BuilderDraft) => BuilderDraft) => void;
}

/** 草稿自动布局（ModuleBuilder「自动布局」按钮共用） */
export function relayout(draft: BuilderDraft): BuilderDraft {
  return { ...draft, nodes: autoLayout(draft.nodes, draft.edges) };
}

export function EditableCanvas({ draft, selected, onSelect, onChange }: Props) {
  // 派生流节点：显式携带宽高（同 GraphView——MiniMap 按 userNode 尺寸过滤，
  // 缺尺寸会把全部节点判为无尺寸而画空）。
  const rfNodes: BuilderFlowNode[] = useMemo(
    () =>
      draft.nodes.map((n) => ({
        id: n.id,
        type: "builder" as const,
        position: n.position,
        width: BUILDER_NODE_SIZE.width,
        height: BUILDER_NODE_SIZE.height,
        data: {
          label: n.label,
          nodeType: n.type,
          ref: String(n[REF_KEY[n.type]] ?? ""),
          isStart: n.is_start,
        },
        selected: selected?.kind === "node" && selected.id === n.id,
      })),
    [draft.nodes, selected],
  );

  // guard 边：带标签 + 动画虚流（蓝），普通边走默认实线。
  const rfEdges: Edge[] = useMemo(
    () =>
      draft.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.guard ?? undefined,
        animated: !!e.guard,
        style: e.guard ? { stroke: "var(--ph-running, #3b82f6)", strokeWidth: 1.5 } : undefined,
        labelStyle: { fontSize: 11, fill: "hsl(var(--muted-foreground))" },
        labelBgStyle: { fill: "hsl(var(--card))" },
        selected: selected?.kind === "edge" && selected.id === e.id,
      })),
    [draft.edges, selected],
  );

  const patchNode = useCallback(
    (id: string, patch: Partial<BuilderNode>) => {
      onChange((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
    },
    [onChange],
  );

  // 拖拽落位：拖动过程由 RF 内部落位，松手才把最终位置提交回 draft。
  const onNodeDragStop = useCallback<OnNodeDrag<BuilderFlowNode>>(
    (_, node) => patchNode(node.id, { position: node.position }),
    [patchNode],
  );

  // 连线：新边回写 draft 并选中它（便于立即补 guard）。
  const onConnect = useCallback<OnConnect>(
    (params: Connection) => {
      const edge: BuilderEdge = {
        id: genId("e"),
        from: params.source,
        to: params.target,
        guard: null,
      };
      onChange((d) => ({ ...d, edges: [...d.edges, edge] }));
      onSelect({ kind: "edge", id: edge.id });
    },
    [onChange, onSelect],
  );

  // 删节点：级联删掉两端涉及该节点的边（draft 里没有悬空边）。
  const onNodesDelete = useCallback<OnNodesDelete>(
    (ns) => {
      const set = new Set(ns.map((n) => n.id));
      onChange((d) => ({
        ...d,
        nodes: d.nodes.filter((n) => !set.has(n.id)),
        edges: d.edges.filter((e) => !set.has(e.from) && !set.has(e.to)),
      }));
      onSelect(null);
    },
    [onChange, onSelect],
  );

  const onEdgesDelete = useCallback<OnEdgesDelete>(
    (es) => {
      const set = new Set(es.map((e) => e.id));
      onChange((d) => ({ ...d, edges: d.edges.filter((e) => !set.has(e.id)) }));
      onSelect(null);
    },
    [onChange, onSelect],
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_, n) => onSelect({ kind: "node", id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: "edge", id: e.id })}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        deleteKeyCode={["Delete", "Backspace"]}
      >
        <Background gap={16} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

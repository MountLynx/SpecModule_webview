// 画布：dagre 分层布局 + 状态徽章 + guard 边标签 + 跟随镜头（手动即解锁）。
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph } from "../dagre";
import type { GraphPayload, StatusCore } from "../api";
import { StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";
import { Button } from "./ui/button";

const nodeTypes: NodeTypes = { status: StatusNode };

/** 与 index.html 初始化同优先级：localStorage 覆盖 > 跟随系统 */
function themeColorMode(): "light" | "dark" | "system" {
  const t = localStorage.getItem("specmodule-webview.theme");
  return t === "dark" || t === "light" ? t : "system";
}

type Props = {
  payload: GraphPayload;
  status: StatusCore | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
};

function GraphCanvas({ payload, status, selected, onSelect }: Props) {
  const { fitView } = useReactFlow();
  const colorMode = useMemo(() => themeColorMode(), []);
  const followRef = useRef(true); // 跟随模式（默认开；用户拖动即关）
  const fitLockRef = useRef(false); // 程序化 fitView 期间不误判为手动

  const nodes = useMemo<StatusFlowNode[]>(() => {
    const pos = layoutGraph(payload.graph.nodes, payload.graph.edges);
    const live: Record<string, (StatusNodeData & { state?: StatusNodeData["state"] })["state"]> = {
      ...payload.node_states,
    };
    if (status) {
      for (const n of payload.graph.nodes) {
        live[n.id] = {
          fired_count: live[n.id]?.fired_count ?? 0,
          last_status: live[n.id]?.last_status ?? null,
          last_tick: live[n.id]?.last_tick ?? null,
          running: status.phase === "running" && status.fireable.includes(n.id),
        };
      }
    }
    return payload.graph.nodes.map((n) => ({
      id: n.id,
      type: "status" as const,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { label: n.label, type: n.type, isStart: n.is_start, state: live[n.id] },
      selected: selected === n.id,
    }));
  }, [payload, status, selected]);

  const edges = useMemo<Edge[]>(() => {
    return payload.graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      label: e.guard ?? undefined,
      animated:
        !!status &&
        status.phase === "running" &&
        status.fireable.includes(e.from),
    }));
  }, [payload, status]);

  const fireableInView = useCallback((): string[] => {
    if (!status || status.phase !== "running") return [];
    return status.fireable.filter((id) =>
      payload.graph.nodes.some((n) => n.id === id),
    );
  }, [status, payload]);

  const centerOn = useCallback(
    (ids: string[]) => {
      fitLockRef.current = true;
      fitView({ nodes: ids.map((id) => ({ id })), duration: 600, padding: 0.25 }).then(
        () => {
          window.setTimeout(() => {
            fitLockRef.current = false;
          }, 80);
        },
      );
    },
    [fitView],
  );

  useEffect(() => {
    const ids = fireableInView();
    if (followRef.current && ids.length) centerOn(ids);
  }, [fireableInView, centerOn]);

  const onMoveStart = useCallback(() => {
    if (!fitLockRef.current) followRef.current = false;
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Button
        variant="outline"
        size="sm"
        className="absolute left-2 top-2 z-10"
        onClick={() => {
          followRef.current = true;
          const ids = fireableInView();
          if (ids.length) centerOn(ids);
        }}
      >
        回到当前
      </Button>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onMoveStart={onMoveStart}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        colorMode={colorMode}
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <MiniMap />
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

// 画布：dagre 分层布局 + 状态徽章 + guard 边标签 + 跟随镜头（手动即解锁）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph, NODE_SIZE } from "../dagre";
import type { GraphPayload, StatusCore } from "../api";
import { badgeOf, StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";
import { LocateFixed } from "lucide-react";
import { cn } from "../lib/utils";

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
  const [follow, setFollow] = useState(true); // 按钮文案随动（ref 不触发渲染）
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
      width: NODE_SIZE.width,
      height: NODE_SIZE.height,
      data: { label: n.label, type: n.type, isStart: n.is_start, state: live[n.id] },
      selected: selected === n.id,
    }));
  }, [payload, status, selected]);

  const edges = useMemo<Edge[]>(() => {
    return payload.graph.edges.map((e, i) => {
      const active =
        !!status && status.phase === "running" && status.fireable.includes(e.from);
      const stroke = active ? "var(--ph-running)" : "hsl(var(--border))";
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        label: e.guard ?? undefined,
        animated: active,
        style: { stroke, strokeWidth: active ? 1.8 : 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      };
    });
  }, [payload, status]);

  /** MiniMap 节点底色：与画布节点同一状态色（取 bg 变量） */
  const minimapColor = useCallback((n: StatusFlowNode): string => {
    const b = badgeOf(n.data.state);
    if (b === "running") return "var(--ph-running-bg)";
    if (b === "done") return "var(--ph-done-bg)";
    if (b === "failed" || b === "aborted") return "var(--ph-aborted-bg)";
    return "hsl(var(--muted))";
  }, []);

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

  /** 跟随入口：按钮/F 共用。运行中回中当前 fireable 节点；否则 fitView 全图（回到当前）。 */
  const engageFollow = useCallback(() => {
    followRef.current = true;
    setFollow(true);
    const ids = fireableInView();
    if (ids.length) {
      centerOn(ids);
    } else {
      fitLockRef.current = true;
      fitView({ duration: 600, padding: 0.2 }).then(() => {
        window.setTimeout(() => {
          fitLockRef.current = false;
        }, 80);
      });
    }
  }, [fireableInView, centerOn, fitView]);

  useEffect(() => {
    const ids = fireableInView();
    if (followRef.current && ids.length) centerOn(ids);
  }, [fireableInView, centerOn]);

  const onMoveStart = useCallback(() => {
    if (!fitLockRef.current) {
      followRef.current = false;
      setFollow(false);
    }
  }, []);

  // F 快捷键：重新跟随。输入框/文本域/下拉/contentEditable 聚焦时让位。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      engageFollow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engageFollow]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {(() => {
        const isRunning = status?.phase === "running";
        const label = !isRunning ? "回到当前" : follow ? "跟随中 · F" : "已解锁 · F";
        return (
          <button
            onClick={engageFollow}
            title="重新跟随正在执行的节点（F）"
            className={cn(
              "absolute left-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              isRunning && follow
                ? "border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] text-[var(--ph-running-text)]"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            <LocateFixed className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })()}
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
        <MiniMap nodeColor={minimapColor} pannable zoomable />
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
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

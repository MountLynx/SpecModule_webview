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
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph, NODE_SIZE } from "../dagre";
import { DATA_CARD_NODE_ID, DataCardNode, type DataCardFlowNode } from "./DataCardNode";
import type { TraceState } from "../lib/inputSource";
import type { GraphPayload, StatusCore } from "../api";
import { badgeOf, StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";
import { LocateFixed } from "lucide-react";
import { cn } from "../lib/utils";

const nodeTypes: NodeTypes = { status: StatusNode, dataCard: DataCardNode };

/** 与 index.html 初始化同优先级：localStorage 覆盖 > 跟随系统 */
function themeColorMode(): "light" | "dark" | "system" {
  const t = localStorage.getItem("specmodule-webview.theme");
  return t === "dark" || t === "light" ? t : "system";
}

/** 值卡头部来源标识：spec 卡 `spec.<key>`；上游卡 `<上游节点> → <字段名>` */
function cardHeading(trace: TraceState): string {
  return trace.source.kind === "spec"
    ? `spec.${trace.source.key}`
    : `${trace.source.nodeId} → ${trace.field}`;
}

/** 值卡正文：spec 卡 = spec 实际值（无存档/字段缺失 → 引用串原文 + 尾注）；
 * 上游卡 = 上游节点最新输出（尚无输出 → 尾注）。字符串原样，其余 JSON 化。 */
function cardBody(
  trace: TraceState,
  spec: Record<string, unknown> | null,
  outputs: Record<string, unknown>,
): string {
  if (trace.source.kind === "spec") {
    const { key } = trace.source;
    if (!spec || !(key in spec)) return `{spec.${key}}（无存档值）`;
    const v = spec[key];
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  }
  const out = outputs[trace.source.nodeId];
  if (out === undefined) return "（尚无输出）";
  return typeof out === "string" ? out : JSON.stringify(out, null, 2);
}

type Props = {
  payload: GraphPayload;
  status: StatusCore | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** 当前溯源态（null = 无）——非空时叠加值卡节点与数据流虚线 */
  trace: TraceState | null;
  /** run 的 spec 存档（spec 引用值卡正文；null = 无存档） */
  spec: Record<string, unknown> | null;
  /** 值卡 ✕ 关闭（清溯源） */
  onClearTrace: () => void;
};

function GraphCanvas({ payload, status, selected, onSelect, trace, spec, onClearTrace }: Props) {
  const { fitView } = useReactFlow();
  const colorMode = useMemo(() => themeColorMode(), []);
  const followRef = useRef(true); // 跟随模式（默认开；用户拖动即关）
  const [follow, setFollow] = useState(true); // 按钮文案随动（ref 不触发渲染）
  const fitLockRef = useRef(false); // 程序化 fitView 期间不误判为手动

  const nodes = useMemo<(StatusFlowNode | DataCardFlowNode)[]>(() => {
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
    const list: (StatusFlowNode | DataCardFlowNode)[] = payload.graph.nodes.map((n) => ({
      id: n.id,
      type: "status" as const,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      width: NODE_SIZE.width,
      height: NODE_SIZE.height,
      data: { label: n.label, type: n.type, isStart: n.is_start, state: live[n.id] },
      selected: selected === n.id,
    }));
    // 溯源值卡：锚定消费节点右侧固定偏移（图坐标随缩放平移；不参与 dagre）。
    // 消费节点不在当前图（换模块后引用失配）→ 不叠卡，trace 边同理（edges 处）。
    if (trace) {
      const cp = pos.get(trace.consumerId);
      if (cp) {
        list.push({
          id: DATA_CARD_NODE_ID,
          type: "dataCard",
          position: { x: cp.x + NODE_SIZE.width + 48, y: cp.y },
          width: 240,
          height: 180,
          draggable: false,
          selectable: false,
          data: {
            heading: cardHeading(trace),
            body: cardBody(trace, spec, status?.outputs ?? {}),
            onClose: onClearTrace,
          },
        });
      }
    }
    return list;
  }, [payload, status, selected, trace, spec, onClearTrace]);

  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = payload.graph.edges.map((e, i) => {
      const active =
        !!status && status.phase === "running" && status.fireable.includes(e.from);
      const stroke = active ? "var(--ph-running)" : "hsl(var(--foreground) / 0.28)";
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
    // 数据流虚线（与控制流实线可辨）：spec 卡 卡↔消费节点（无箭头）；
    // 上游卡 上游节点→消费节点（小箭头指消费）。消费节点/上游节点不在当前图
    //（trace 存续期间 moduleOverride 换图）→ 与卡一并缺席，防悬空边。
    if (trace) {
      const inGraph = (id: string) => payload.graph.nodes.some((n) => n.id === id);
      const drawable =
        inGraph(trace.consumerId) &&
        (trace.source.kind === "spec" || inGraph(trace.source.nodeId));
      if (drawable) {
        const stroke = "hsl(var(--foreground) / 0.28)";
        list.push(
          trace.source.kind === "spec"
            ? {
                id: "trace-edge",
                source: DATA_CARD_NODE_ID,
                target: trace.consumerId,
                style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
              }
            : {
                id: "trace-edge",
                source: trace.source.nodeId,
                target: trace.consumerId,
                style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
                markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
              },
        );
      }
    }
    return list;
  }, [payload, status, trace]);

  /** MiniMap 节点底色：取状态主色（bg 洗淡变体在小图上几乎不可见） */
  const minimapColor = useCallback((n: Node): string => {
    if (n.type === "dataCard") return "hsl(var(--muted-foreground) / 0.5)";
    const b = badgeOf((n as StatusFlowNode).data.state);
    if (b === "running") return "var(--ph-running)";
    if (b === "done") return "var(--ph-done)";
    if (b === "failed" || b === "aborted") return "var(--ph-aborted)";
    return "hsl(var(--muted-foreground) / 0.5)";
  }, []);

  const fireableInView = useCallback((): string[] => {
    if (!status || status.phase !== "running") return [];
    return status.fireable.filter((id) =>
      payload.graph.nodes.some((n) => n.id === id),
    );
  }, [status, payload]);

  const centerOn = useCallback(
    (ids: string[], padding = 0.25) => {
      fitLockRef.current = true;
      fitView({ nodes: ids.map((id) => ({ id })), duration: 600, padding }).then(
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

  // 溯源变化：镜头飞消费节点 + 值卡（padding 放宽容纳卡片）；飞行即解锁跟随
  //（与手动交互语义一致，F/按钮可再跟随）
  useEffect(() => {
    if (!trace) return;
    followRef.current = false;
    setFollow(false);
    centerOn([trace.consumerId, DATA_CARD_NODE_ID], 0.3);
  }, [trace, centerOn]);

  // F 快捷键：重新跟随。输入框/文本域/下拉/contentEditable 聚焦时让位。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
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
        onNodeClick={(_, n) => {
          if (n.type === "dataCard") return;
          onSelect(n.id);
        }}
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

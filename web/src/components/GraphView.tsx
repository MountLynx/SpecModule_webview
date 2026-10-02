// 画布：dagre 分层布局 + 状态徽章 + guard 边标签 + 跟随镜头 + 溯源值卡/数据流虚线（手动即解锁）。
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
import { layoutGraphSized, NODE_SIZE } from "../dagre";
import {
  DATA_CARD_NODE_ID,
  DATA_CARD_SIZE,
  DataCardNode,
  type DataCardFlowNode,
} from "./DataCardNode";
import {
  ARTIFACT_SIZE,
  ArtifactNode,
  artifactNodeId,
  type ArtifactFlowNode,
} from "./ArtifactNode";
import type { TraceState } from "../lib/inputSource";
import type { GraphEdge, GraphPayload, StatusCore } from "../api";
import { badgeOf, StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";
import { LocateFixed } from "lucide-react";
import { cn } from "../lib/utils";

const nodeTypes: NodeTypes = { status: StatusNode, dataCard: DataCardNode, artifact: ArtifactNode };

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
    if (!spec || !Object.prototype.hasOwnProperty.call(spec, key))
      return `{spec.${key}}（无存档值）`;
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
  const { fitView, getInternalNode } = useReactFlow();
  const colorMode = useMemo(() => themeColorMode(), []);
  const followRef = useRef(true); // 跟随模式（默认开；用户拖动即关）
  const [follow, setFollow] = useState(true); // 按钮文案随动（ref 不触发渲染）
  const fitLockRef = useRef(false); // 程序化 fitView 期间不误判为手动

  /** 卫星产物卡清单：仅保留生产者在当前图的条目（换模块后引用失配 → 与 trace 卡同一防悬空纪律） */
  const satellites = useMemo(() => {
    const artifacts = payload.artifacts ?? {};
    return Object.entries(artifacts).flatMap(([producer, entries]) =>
      payload.graph.nodes.some((n) => n.id === producer)
        ? entries.map((entry) => ({ producer, entry }))
        : [],
    );
  }, [payload]);

  const nodes = useMemo<(StatusFlowNode | DataCardFlowNode | ArtifactFlowNode)[]>(() => {
    const pos = layoutGraphSized(
      [
        ...payload.graph.nodes.map((n) => ({
          id: n.id,
          width: NODE_SIZE.width,
          height: NODE_SIZE.height,
        })),
        ...satellites.map(({ producer, entry }) => ({
          id: artifactNodeId(producer, entry.index),
          width: ARTIFACT_SIZE.width,
          height: ARTIFACT_SIZE.height,
        })),
      ],
      [
        ...payload.graph.edges,
        ...satellites.map(({ producer, entry }) => ({
          from: producer,
          to: artifactNodeId(producer, entry.index),
        })),
      ],
    );
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
    const list: (StatusFlowNode | DataCardFlowNode | ArtifactFlowNode)[] = payload.graph.nodes.map((n) => {
      // 受控 setNodes 每次采纳全新节点对象；对象缺 measured 时库会重置已测量的
      // handleBounds（parseHandles），而重测触发在持续 WS 推送下不可靠——handle
      // 测量一旦丢失，getEdgePosition 对全部边静默返回 null，连线整体消失且
      // 直至重挂载才恢复。把库侧上次测量值带回对象，采纳即保留测量，边不随推送掉线。
      const measured = getInternalNode(n.id)?.measured;
      return {
        id: n.id,
        type: "status" as const,
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        width: NODE_SIZE.width,
        height: NODE_SIZE.height,
        measured: measured ? { ...measured } : undefined,
        data: { label: n.label, type: n.type, isStart: n.is_start, state: live[n.id] },
        selected: selected === n.id,
      };
    });
    // 卫星产物卡：叶节点随 dagre 挂在生产者下方；measured 带回防 WS 采纳重置
    for (const { producer, entry } of satellites) {
      const id = artifactNodeId(producer, entry.index);
      const measured = getInternalNode(id)?.measured;
      list.push({
        id,
        type: "artifact",
        position: pos.get(id) ?? { x: 0, y: 0 },
        width: ARTIFACT_SIZE.width,
        height: ARTIFACT_SIZE.height,
        measured: measured ? { ...measured } : undefined,
        selectable: false,
        data: { runId: payload.run_id, producer, entry },
      });
    }
    // 溯源值卡（图坐标随缩放平移；不参与 dagre）。上游卡置于上游↔消费缺口右侧、
    // 垂直居中于缺口——卡顶接上游底、卡底接消费顶，值卡落在数据流路径上；
    // spec 卡 / 上游缺失回退 = 消费节点右侧固定偏移。消费节点不在当前图（换模块
    // 后引用失配）→ 不叠卡，trace 边同理（edges 处）。
    if (trace) {
      const cp = pos.get(trace.consumerId);
      if (cp) {
        const up = trace.source.kind === "node" ? pos.get(trace.source.nodeId) : null;
        // 值卡与状态节点同理：随推送重建的对象带回上次测量，虚线边不因采纳重置而消失
        const cardMeasured = getInternalNode(DATA_CARD_NODE_ID)?.measured;
        list.push({
          id: DATA_CARD_NODE_ID,
          type: "dataCard",
          position: {
            x: (up ? Math.max(up.x, cp.x) : cp.x) + NODE_SIZE.width + 48,
            y: up
              ? (up.y + NODE_SIZE.height + cp.y) / 2 - DATA_CARD_SIZE.height / 2
              : cp.y,
          },
          width: DATA_CARD_SIZE.width,
          height: DATA_CARD_SIZE.height,
          measured: cardMeasured ? { ...cardMeasured } : undefined,
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
  }, [payload, status, selected, trace, spec, onClearTrace, satellites]);

  const edges = useMemo<Edge[]>(() => {
    // 上游溯源时隐藏原上游→消费控制流实线（由卡 + 两段虚线承接其视觉；收起即恢复）。
    // 先 map 带原索引再过滤，保持既有边 id 稳定（避免无关边无谓重挂载）。
    const traceNode =
      trace && trace.source.kind === "node"
        ? { nodeId: trace.source.nodeId, consumerId: trace.consumerId }
        : null;
    const hidePair = traceNode
      ? (e: GraphEdge) => e.from === traceNode.nodeId && e.to === traceNode.consumerId
      : null;
    const list: Edge[] = payload.graph.edges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !hidePair || !hidePair(e))
      .map(({ e, i }) => {
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
    // 生产者 → 卫星产物卡虚线（数据流视觉，中性色同默认边）
    const satStroke = "hsl(var(--foreground) / 0.28)";
    for (const { producer, entry } of satellites) {
      list.push({
        id: `ea::${producer}::${entry.index}`,
        source: producer,
        target: artifactNodeId(producer, entry.index),
        style: { stroke: satStroke, strokeWidth: 1.2, strokeDasharray: "5 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: satStroke, width: 12, height: 12 },
      });
    }
    // 数据流虚线（dashed、中性色 `hsl(var(--foreground) / 0.28)` 同默认边）。
    // spec 卡：卡→消费节点（左锚点出线、无箭头）。上游卡：两段——上游节点底→卡顶、
    // 卡底→消费节点顶，每段带小箭头指流向。消费/上游节点不在当前图（换模块失配）
    // → 与卡一并缺席，防悬空边。
    if (trace) {
      const inGraph = (id: string) => payload.graph.nodes.some((n) => n.id === id);
      const stroke = "hsl(var(--foreground) / 0.28)";
      if (trace.source.kind === "spec") {
        if (inGraph(trace.consumerId)) {
          list.push({
            id: "trace-edge",
            source: DATA_CARD_NODE_ID,
            sourceHandle: "l",
            target: trace.consumerId,
            style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
          });
        }
      } else if (inGraph(trace.consumerId) && inGraph(trace.source.nodeId)) {
        list.push(
          {
            id: "trace-edge-in",
            source: trace.source.nodeId,
            target: DATA_CARD_NODE_ID,
            targetHandle: "t",
            style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
            markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
          },
          {
            id: "trace-edge-out",
            source: DATA_CARD_NODE_ID,
            sourceHandle: "b",
            target: trace.consumerId,
            style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
            markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
          },
        );
      }
    }
    return list;
  }, [payload, status, trace, satellites]);

  /** MiniMap 节点底色：取状态主色（bg 洗淡变体在小图上几乎不可见） */
  const minimapColor = useCallback((n: Node): string => {
    if (n.type === "dataCard") return "hsl(var(--muted-foreground) / 0.5)";
    if (n.type === "artifact") return "hsl(var(--primary) / 0.4)";
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

  // 溯源变化：镜头飞消费节点 + 值卡（上游溯源另含上游节点，整条接线路径可见；
  // padding 放宽容纳卡片）；飞行即解锁跟随（与手动交互语义一致，F/按钮可再跟随）
  useEffect(() => {
    if (!trace) return;
    followRef.current = false;
    setFollow(false);
    const ids =
      trace.source.kind === "node"
        ? [trace.source.nodeId, trace.consumerId, DATA_CARD_NODE_ID]
        : [trace.consumerId, DATA_CARD_NODE_ID];
    centerOn(ids, 0.3);
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
          if (n.type === "dataCard" || n.type === "artifact") return;
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

// 画布：dagre 分层布局（结构键控，推送不重排）+ 节点拖动持久（覆盖表）+ 状态徽章 + guard 边标签 + 跟随镜头 + 溯源值卡/数据流虚线（手动即解锁）。
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
  type OnNodeDrag,
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
  SPEC_CARD_SIZE,
  SpecCardNode,
  specCardNodeId,
  type SpecCardFlowNode,
} from "./SpecCardNode";
import {
  ARTIFACT_SIZE,
  ArtifactNode,
  artifactNodeId,
  type ArtifactFlowNode,
} from "./ArtifactNode";
import { resolveInputSource, type TraceState } from "../lib/inputSource";
import type { GraphEdge, GraphPayload, StatusCore } from "../api";
import { badgeOf, StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";
import { LocateFixed, RotateCcw } from "lucide-react";
import { cn } from "../lib/utils";

const nodeTypes: NodeTypes = {
  status: StatusNode,
  dataCard: DataCardNode,
  artifact: ArtifactNode,
  specCard: SpecCardNode,
};

type GraphFlowNode = StatusFlowNode | DataCardFlowNode | ArtifactFlowNode | SpecCardFlowNode;

/** 与 index.html 初始化同优先级：localStorage 覆盖 > 跟随系统 */
function themeColorMode(): "light" | "dark" | "system" {
  const t = localStorage.getItem("specmodule-webview.theme");
  return t === "dark" || t === "light" ? t : "system";
}

/** spec 卡正文：键值（字符串原样，其余 JSON 化）——卡仅对存档键渲染，无缺键分支 */
function specCardBody(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
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
  /** spec 卡直点 toggle（RunView 持有 trace） */
  onToggleSpecCard: (key: string) => void;
};

function GraphCanvas({
  payload,
  status,
  selected,
  onSelect,
  trace,
  spec,
  onClearTrace,
  onToggleSpecCard,
}: Props) {
  const { fitView, getInternalNode } = useReactFlow();
  const colorMode = useMemo(() => themeColorMode(), []);
  const followRef = useRef(true); // 跟随模式（默认开；用户拖动即关）
  const [follow, setFollow] = useState(true); // 按钮文案随动（ref 不触发渲染）
  const fitLockRef = useRef(false); // 程序化 fitView 期间不误判为手动
  // 用户拖过的节点位置（官方受控模式的等价物：拖动位置即状态）——节点组装时
  // 优先于 dagre 基准，使拖动在 WS 推送/点选引发的重渲染下不弹回
  const [overrides, setOverrides] = useState<Map<string, { x: number; y: number }>>(new Map());

  /** 卫星产物卡清单：仅保留生产者在当前图的条目（换模块后引用失配 → 与 trace 卡同一防悬空纪律） */
  const satellites = useMemo(() => {
    const artifacts = payload.artifacts ?? {};
    return Object.entries(artifacts).flatMap(([producer, entries]) =>
      payload.graph.nodes.some((n) => n.id === producer)
        ? entries.map((entry) => ({ producer, entry }))
        : [],
    );
  }, [payload]);

  /** spec 值卡清单：每键一卡（spec 存档键序；null/空 → 无卡列） */
  const specCards = useMemo(() => (spec ? Object.keys(spec) : []), [spec]);

  /** spec 键 → 消费节点 id 列表（inputs 值经 resolveInputSource 判定）；
   * 仅收录有卡的键——无卡键的溯源走浮卡兜底。依赖锚 payload.graph（WS merge
   * 为 spread、graph 身份跨推送稳定）：身份漂移会把溯源镜头 effect 每秒重飞 */
  const specConsumers = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!spec) return map;
    const nodeIds = new Set(payload.graph.nodes.map((n) => n.id));
    const keys = new Set(Object.keys(spec));
    for (const n of payload.graph.nodes) {
      for (const v of Object.values(n.inputs ?? {})) {
        const src = resolveInputSource(v, nodeIds);
        if (src?.kind === "spec" && keys.has(src.key)) {
          const list = map.get(src.key) ?? [];
          if (!list.includes(n.id)) list.push(n.id);
          map.set(src.key, list);
        }
      }
    }
    return map;
  }, [payload.graph, spec]);

  /** 结构内容键：布局输入的内容指纹（run/module + 节点 id 序 + 边集 + 卫星卡）。
   * status/selected/WS 推送不改变内容即不触发布局重算。 */
  const structureKey = useMemo(
    () =>
      [
        payload.run_id,
        payload.module ?? "",
        payload.graph.nodes.map((n) => n.id).join(","),
        payload.graph.edges.map((e) => `${e.from}>${e.to}`).join(","),
        satellites.map(({ producer, entry }) => artifactNodeId(producer, entry.index)).join(","),
      ].join("|"),
    [payload, satellites],
  );

  /** dagre 基准布局：只按结构内容键重算（官方 static layouting 语义——结构不变
   * 布局不重排）。依赖刻意只留键：键不变时数组身份随推送变化也沿用缓存（键即
   * 内容指纹，重算时闭包取当轮数组）。 */
  const basePos = useMemo(
    () =>
      layoutGraphSized(
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
      ),
    [structureKey],
  );

  /** spec 卡列基准位置：dagre 包围盒左侧一列（不进 dagre——无布局边会被
   * 当作无依赖节点散置）；每轮按同一规则重算，确定性等价缓存 */
  const specPos = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    if (!specCards.length || basePos.size === 0) return pos;
    let minX = Infinity;
    let minY = Infinity;
    for (const p of basePos.values()) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
    const x = minX - SPEC_CARD_SIZE.width - 48;
    let y = minY;
    for (const key of specCards) {
      pos.set(specCardNodeId(key), { x, y });
      y += SPEC_CARD_SIZE.height + 16;
    }
    return pos;
  }, [specCards, basePos]);

  /** 有效位置：用户拖过的节点以覆盖为准，其余走 dagre 基准；未命中（id 不在
   * 当前图，如 trace 引用失配）返回 undefined——沿用「不叠卡」防悬空语义 */
  const posOf = useCallback(
    (id: string) => overrides.get(id) ?? basePos.get(id) ?? specPos.get(id),
    [overrides, basePos, specPos],
  );

  const nodes = useMemo<GraphFlowNode[]>(() => {
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
    const list: GraphFlowNode[] = payload.graph.nodes.map((n) => {
      // 受控 setNodes 每次采纳全新节点对象；对象缺 measured 时库会重置已测量的
      // handleBounds（parseHandles），而重测触发在持续 WS 推送下不可靠——handle
      // 测量一旦丢失，getEdgePosition 对全部边静默返回 null，连线整体消失且
      // 直至重挂载才恢复。把库侧上次测量值带回对象，采纳即保留测量，边不随推送掉线。
      const measured = getInternalNode(n.id)?.measured;
      return {
        id: n.id,
        type: "status" as const,
        position: posOf(n.id) ?? { x: 0, y: 0 },
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
        position: posOf(id) ?? { x: 0, y: 0 },
        width: ARTIFACT_SIZE.width,
        height: ARTIFACT_SIZE.height,
        measured: measured ? { ...measured } : undefined,
        selectable: false,
        data: { runId: payload.run_id, producer, entry },
      });
    }
    // spec 值卡列：画布左侧常驻一列（每键一卡，不进 dagre）；measured 带回
    // 防 WS 采纳重置（同三卡纪律）
    for (const key of specCards) {
      const id = specCardNodeId(key);
      const measured = getInternalNode(id)?.measured;
      list.push({
        id,
        type: "specCard",
        position: posOf(id) ?? { x: 0, y: 0 },
        width: SPEC_CARD_SIZE.width,
        height: SPEC_CARD_SIZE.height,
        measured: measured ? { ...measured } : undefined,
        selectable: false,
        data: {
          key,
          body: specCardBody(spec?.[key]),
          active:
            trace != null &&
            trace.source.kind === "spec" &&
            trace.source.key === key,
          onToggle: () => onToggleSpecCard(key),
        },
      });
    }
    // 溯源值卡（图坐标随缩放平移；不参与 dagre）。上游卡置于上游↔消费缺口右侧、
    // 垂直居中于缺口——卡顶接上游底、卡底接消费顶，值卡落在数据流路径上；
    // spec 键无卡兜底 / 上游缺失回退 = 消费节点右侧固定偏移。消费节点不在当前图
    // （换模块后引用失配）→ 不叠卡，trace 边同理（edges 处）。
    if (trace) {
      // 浮卡承担：上游溯源（node 来源）恒浮卡；spec 溯源仅键无卡（无存档/
      // 键缺失）兜底——卡在列则虚线接常驻卡，不出浮卡。卡直点 consumerId
      // 必非 null（守卫为防御性）。
      const specHasCard =
        trace.source.kind === "spec" && specCards.includes(trace.source.key);
      const floating = trace.source.kind === "node" || !specHasCard;
      if (floating && trace.consumerId != null) {
        const cp = posOf(trace.consumerId);
        if (cp) {
          const up = trace.source.kind === "node" ? posOf(trace.source.nodeId) : null;
          // 值卡与状态节点同理：随推送重建的对象带回上次测量，虚线边不因采纳重置而消失。
          // 位置：用户拖过的以覆盖为准，否则按锚点计算。
          const cardMeasured = getInternalNode(DATA_CARD_NODE_ID)?.measured;
          list.push({
            id: DATA_CARD_NODE_ID,
            type: "dataCard",
            position:
              overrides.get(DATA_CARD_NODE_ID) ?? {
                x: (up ? Math.max(up.x, cp.x) : cp.x) + NODE_SIZE.width + 48,
                y: up
                  ? (up.y + NODE_SIZE.height + cp.y) / 2 - DATA_CARD_SIZE.height / 2
                  : cp.y,
              },
            width: DATA_CARD_SIZE.width,
            height: DATA_CARD_SIZE.height,
            measured: cardMeasured ? { ...cardMeasured } : undefined,
            selectable: false,
            data: {
              heading: cardHeading(trace),
              body: cardBody(trace, spec, status?.outputs ?? {}),
              onClose: onClearTrace,
            },
          });
        }
      }
    }
    return list;
  }, [payload, status, selected, trace, spec, onClearTrace, onToggleSpecCard, satellites, specCards, posOf]);

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
    // spec 溯源：常驻卡→消费节点（右锚出线带箭头）；键无卡兜底浮卡→消费节点
    // （左锚点出线、无箭头）。上游卡：两段——上游节点底→卡顶、卡底→消费节点顶，
    // 每段带小箭头指流向。消费/上游节点不在当前图（换模块失配）→ 对应边缺席，
    // 防悬空边。
    if (trace) {
      const inGraph = (id: string) => payload.graph.nodes.some((n) => n.id === id);
      const stroke = "hsl(var(--foreground) / 0.28)";
      if (trace.source.kind === "spec") {
        if (specCards.includes(trace.source.key)) {
          // 常驻 spec 卡在列：卡→消费节点虚线（卡直点=全部消费节点；胶囊点入=该节点）
          const targets =
            trace.consumerId != null
              ? [trace.consumerId]
              : (specConsumers.get(trace.source.key) ?? []);
          for (const tid of targets) {
            if (!inGraph(tid)) continue;
            list.push({
              id: `trace-edge-spec::${trace.source.key}::${tid}`,
              source: specCardNodeId(trace.source.key),
              sourceHandle: "r",
              target: tid,
              style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: stroke,
                width: 12,
                height: 12,
              },
            });
          }
        } else if (trace.consumerId != null && inGraph(trace.consumerId)) {
          // 兜底浮卡（无存档/键缺失）：卡→消费节点（左锚出线、无箭头，沿用旧形）
          list.push({
            id: "trace-edge",
            source: DATA_CARD_NODE_ID,
            sourceHandle: "l",
            target: trace.consumerId,
            style: { stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
          });
        }
      } else if (
        trace.consumerId != null &&
        inGraph(trace.consumerId) &&
        inGraph(trace.source.nodeId)
      ) {
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
  }, [payload, status, trace, satellites, specCards, specConsumers]);

  /** 拖动全程实时写覆盖表（跟手 + 防中途 WS 推送弹回——构建器画布同款模式）；
   * stop 兜底同形。 */
  const onNodeDrag = useCallback<OnNodeDrag<GraphFlowNode>>(
    (_, node) => setOverrides((m) => new Map(m).set(node.id, node.position)),
    [],
  );

  // 换 run / 换 module：覆盖表清空回 dagre；同 run 内结构变化（如新产物卡上图）
  // 不清——保留用户已排布的位置（与官方 static 语义的唯一偏差，已定稿采纳）
  useEffect(() => {
    setOverrides(new Map());
  }, [payload.run_id, payload.module]);

  // trace 变化：值卡语义随引用走，只清值卡自身覆盖（锚点仍取消费/上游节点有效位置）
  useEffect(() => {
    setOverrides((m) => {
      if (!m.has(DATA_CARD_NODE_ID)) return m;
      const next = new Map(m);
      next.delete(DATA_CARD_NODE_ID);
      return next;
    });
  }, [trace]);

  /** MiniMap 节点底色：取状态主色（bg 洗淡变体在小图上几乎不可见） */
  const minimapColor = useCallback((n: Node): string => {
    if (n.type === "dataCard") return "hsl(var(--muted-foreground) / 0.5)";
    if (n.type === "specCard") return "hsl(var(--muted-foreground) / 0.35)";
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

  // 溯源变化：镜头飞消费节点 + 值卡（上游=上游节点+浮卡整条路径；spec 卡直点=
  // 常驻卡+全部消费节点；胶囊点入=常驻卡+该节点；键无卡兜底=浮卡）。
  // 飞行即解锁跟随（与手动交互语义一致，F/按钮可再跟随）
  useEffect(() => {
    if (!trace) return;
    followRef.current = false;
    setFollow(false);
    const raw: (string | null)[] =
      trace.source.kind === "node"
        ? [trace.source.nodeId, trace.consumerId, DATA_CARD_NODE_ID]
        : specCards.includes(trace.source.key)
          ? [
              specCardNodeId(trace.source.key),
              ...(trace.consumerId != null
                ? [trace.consumerId]
                : (specConsumers.get(trace.source.key) ?? [])),
            ]
          : [trace.consumerId, DATA_CARD_NODE_ID];
    centerOn(raw.filter((id): id is string => id != null), 0.3);
  }, [trace, centerOn, specCards, specConsumers]);

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
      <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
        {(() => {
          const isRunning = status?.phase === "running";
          const label = !isRunning ? "回到当前" : follow ? "跟随中 · F" : "已解锁 · F";
          return (
            <button
              onClick={engageFollow}
              title="重新跟随正在执行的节点（F）"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
        {overrides.size > 0 && (
          <button
            onClick={() => setOverrides(new Map())}
            title="清除手动拖放的位置，回到自动布局"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置布局
          </button>
        )}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDrag}
        onMoveStart={onMoveStart}
        onNodeClick={(_, n) => {
          if (n.type === "dataCard" || n.type === "artifact" || n.type === "specCard") return;
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

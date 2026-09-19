# 图上数据溯源（输入胶囊定位 + spec/上游值卡 + 删除侧栏内联输入值卡）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一输入交互模型——点 NodePanel 里可定位的输入胶囊（`{spec.key}` / 裸节点名）→ 镜头飞到消费节点旁 → 图上浮现该输入的值卡 → 虚线指认数据从哪来；同时**删除侧栏内联「输入值」卡片**（图上值卡已承载接线语义与值展示，侧栏卡片重复多余）。

**Architecture:** 纯前端改动（`web/` 单侧），后端与 specmodule 库零改动、无新依赖。溯源状态（`TraceState`）由 RunView 持有：NodePanel 胶囊点击只上报 `(field, value)`；GraphView 据此叠加 React Flow 临时 `dataCard` 节点（新 nodeType）与 dashed 临时边，并复用 `centerOn` 飞行。引用来源判定收敛在独立纯函数模块 `lib/inputSource.ts`（NodePanel 判定胶囊可点与 GraphView 渲染共用）。spec 存档来自既有 `fetchInputs`（`GET /api/runs/{id}/inputs`，已存在），上游输出来自 WS status `outputs`——状态同源，卡片随推送自动刷新。

**Tech Stack:** React 18 + TypeScript + Tailwind + @xyflow/react v12（`web/`）；无后端改动。

**设计文档:** `docs/superpowers/specs/2026-09-19-graph-data-traceability-design.md`（含 2026-09-19 修订：内联值卡从「收窄保留」改为「整块删除」）

**关键语义备忘（执行者必读）:**

- **`web/` 无测试基建**（无 vitest/jest；生态纪律「不引入工具」）——本计划不写自动化测试：每个任务的门禁是 `cd web && npm run build`（= `tsc --noEmit` + `vite build`），行为验收靠 Task 5 人工走查。这是对 TDD 步骤的既定替代，非偷懒。
- **承接现状**：commit 45187db 实现的「输入胶囊点击展开内联值卡」（NodePanel `openInput` state + 对应 JSX）在本计划 Task 2 中**整块删除**，不是收窄保留。
- **引用语法事实**（库侧，不在前端重实现）：`{spec.key}` = spec 字典单层键常量引用；裸节点名（如 `"Organize"`）= producer 引用，吃该上游节点整个输出；其余（`{spec}`/`{tasklist}`/`{node}` 整体 token、字面量）不可定位。
- **溯源生命周期（RunView 单点持有）**：点可定位胶囊设置 trace；再点同一胶囊 / 点卡上 ✕ / 点画布空白（`selected` 变化）收起；切节点（`selected` 变化）与切 run（`runId` effect）归零。图上值卡/虚线完全由 trace 派生，无独立状态、无残留通道。
- **消费节点 ≡ 当前选中节点**：胶囊只存在于其节点面板中，`handleTraceInput` 以 `selected` 为消费节点，无需额外传递。
- 走查样本：academic_writer done run（如 `academic_writer_ee4c27`）——Loop1 的 `original_text` 值为 `{spec.raw_text}`（spec 卡），`draft_text` 值为 `Organize`（上游卡）。

---

### Task 1: 来源判定纯函数模块 `lib/inputSource.ts`

**Files:**
- Create: `web/src/lib/inputSource.ts`

- [ ] **Step 1: 创建模块**——新建 `web/src/lib/inputSource.ts`，内容完整如下：

```ts
// 输入引用来源判定（图上数据溯源，展示层映射）：`{spec.key}` → spec 常量引用、
// 裸节点名 → 上游 producer 引用；其余（整体 token / 字面量）→ null 不可定位。
// 语法依据：../SpecModule/module_harness/orchestrate/graph_builder.py:24-32。
// NodePanel 判定胶囊可点与 GraphView 渲染值卡共用本模块。

export type InputSource =
  | { kind: "spec"; key: string }
  | { kind: "node"; nodeId: string };

/** 一次溯源：消费节点 + 触发上报的输入字段名 + 来源 */
export interface TraceState {
  consumerId: string;
  field: string;
  source: InputSource;
}

export function resolveInputSource(
  value: string,
  nodeIds: Set<string>,
): InputSource | null {
  if (value.startsWith("{spec.") && value.endsWith("}")) {
    const key = value.slice("{spec.".length, -1);
    if (key) return { kind: "spec", key };
  }
  if (nodeIds.has(value)) return { kind: "node", nodeId: value };
  return null;
}
```

- [ ] **Step 2: 构建门禁**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview/web" && npm run build
```

Expected: 通过（`tsc --noEmit` 无错误 + vite build `✓ built`）。新模块暂无引用者，仅验证可编译。

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && git add web/src/lib/inputSource.ts && git commit -m "feat(web): 图上数据溯源来源判定纯函数 lib/inputSource.ts"
```

---

### Task 2: NodePanel 胶囊溯源上报 + 删除侧栏内联「输入值」卡片 + RunView 溯源状态

**Files:**
- Modify: `web/src/components/NodePanel.tsx`
- Modify: `web/src/components/RunView.tsx`

- [ ] **Step 1: NodePanel——imports 增加来源判定**——`web/src/components/NodePanel.tsx` 中，找到：

```tsx
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";
import { cn } from "../lib/utils";
```

替换为：

```tsx
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";
import { resolveInputSource, type TraceState } from "../lib/inputSource";
import { cn } from "../lib/utils";
```

- [ ] **Step 2: NodePanel——头注释更新**——文件顶部注释第 2 行 `// 输入标签胶囊（hover 看完整 JSON）+ 共享思考块 + 状态色输出卡（运行中占位/` 替换为：

```tsx
// 输入标签胶囊（可定位引用可点溯源，hover 看完整 JSON）+ 共享思考块 + 状态色输出卡（运行中占位/
```

- [ ] **Step 3: NodePanel——Props 块替换**——找到 `export function NodePanel({` 起的整个参数与类型块（`runId` 至 `onClose: () => void;` 止），替换为：

```tsx
export function NodePanel({
  runId,
  node,
  outputs,
  live,
  liveText,
  liveThinking,
  nodeIds,
  trace,
  onTraceInput,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点正在执行（run 运行中且该节点在流式或 fireable 执行集）——输出卡占位态判断用 */
  live: boolean;
  /** 该节点当前执行的流式文本（终态后由 outputs 接管） */
  liveText?: string;
  /** 该节点当前执行的思考文本（正文 token 到达后自动收起） */
  liveThinking?: string;
  /** 当前图全部节点 id（输入引用来源判定用） */
  nodeIds: Set<string>;
  /** 当前溯源态（null = 无）；来源胶囊 emphasis 依据 */
  trace: TraceState | null;
  /** 点可定位输入胶囊上报（RunView 持有溯源状态） */
  onTraceInput: (field: string, value: string) => void;
  onClose: () => void;
}) {
```

- [ ] **Step 4: NodePanel——删除 openInput state**——找到并整块删除（含注释行）：

```tsx
  // 展开显示值卡的输入键（null = 无；节点切换随 key 重挂载自动复位）
  const [openInput, setOpenInput] = useState<string | null>(null);
```

- [ ] **Step 5: NodePanel——输入行重写 + 删除内联值卡 JSX**——从 `{/* 输入行：「输入」前缀标签 + 键名胶囊（可点——展开该输入的值卡片，` 注释起，到内联值卡整块结束：

```tsx
          {openInput != null && node.inputs?.[openInput] !== undefined && (
            <div className="mt-2 overflow-hidden rounded-control border border-border">
              <div className="flex items-center justify-between border-b border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground">
                <span className="font-mono">{openInput}</span>
                <span>输入值</span>
              </div>
              <div className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">
                {String(node.inputs[openInput])}
              </div>
            </div>
          )}
```

（即原「输入行」div 与「输入值」卡片两块）整体替换为：

```tsx
          {/* 输入行：「输入」前缀标签 + 键名胶囊。可定位引用（{spec.key} / 裸节点名）
              可点——上报溯源（镜头飞消费节点 + 图上值卡，强调态跟随 trace，再点同一
              胶囊收起）；「其他」类值为普通胶囊不可点（hover 见完整 JSON）。
              侧栏内联「输入值」卡片已删除（图上值卡承载，避免重复）。
              节点类型已上移至头部名字旁，无输入键的节点整行不渲染 */}
          {Object.keys(node.inputs ?? {}).length > 0 && (
            <div
              className="mt-2.5 flex flex-wrap items-center gap-1"
              title={JSON.stringify(node.inputs)}
            >
              <span className="mr-0.5 text-[11px] text-muted-foreground">输入</span>
              {Object.keys(node.inputs ?? {}).map((k) => {
                const src = resolveInputSource(node.inputs[k], nodeIds);
                const active = trace != null && trace.consumerId === node.id && trace.field === k;
                return src ? (
                  <button
                    key={k}
                    aria-expanded={active}
                    title={`定位输入 ${k}`}
                    className={cn(
                      pillVariants({ variant: active ? "emphasis" : "default" }),
                      "cursor-pointer font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                    onClick={() => onTraceInput(k, node.inputs[k])}
                  >
                    {k}
                  </button>
                ) : (
                  <Pill key={k} variant="default" className="font-mono">
                    {k}
                  </Pill>
                );
              })}
            </div>
          )}
```

- [ ] **Step 6: RunView——imports 与溯源状态**——`web/src/components/RunView.tsx`：

  1. react import 行 `import { useCallback, useEffect, useRef, useState } from "react";` 替换为：

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

  2. `import {` 起 api import 块中，`fetchGraph,` 之后一行加 `fetchInputs,`（保持字母序不强制，与既有风格一致即可），并在 api import 块之后新增一行：

```tsx
import { resolveInputSource, type TraceState } from "../lib/inputSource";
```

  3. state 区（`const [procLog, setProcLog] = useState<string | null>(null);` 之后）新增：

```tsx
  // 溯源状态（图上值卡 + 数据流虚线的唯一事实源）：null = 无
  const [trace, setTrace] = useState<TraceState | null>(null);
```

  4. `const statusView: StatusCore | null = stream ?? initialStatus;` 之前新增：

```tsx
  const nodeIds = useMemo(
    () => new Set(payload?.graph.nodes.map((n) => n.id) ?? []),
    [payload],
  );

  // 溯源上报：可定位输入胶囊 → 记录消费节点+字段+来源；再点同一胶囊收起。
  // 消费节点以当前选中节点为准（胶囊只存在于其面板中）。
  const handleTraceInput = useCallback(
    (field: string, value: string) => {
      if (!selected) return;
      const src = resolveInputSource(value, nodeIds);
      if (!src) return;
      setTrace((prev) =>
        prev && prev.consumerId === selected && prev.field === field
          ? null
          : { consumerId: selected, field, source: src },
      );
    },
    [selected, nodeIds],
  );

  // 切节点 / 点画布空白（selected 变化）→ 溯源归零（图上值卡与虚线随 trace 清除）
  useEffect(() => {
    setTrace(null);
  }, [selected]);

  const clearTrace = useCallback(() => setTrace(null), []);
```

  5. run 切换清理 effect（`setModuleOverride(null);` 所在块）中，`setModuleOverride(null);` 之后一行加：

```tsx
    setTrace(null);
```

- [ ] **Step 7: RunView——NodePanel 接线**——`<NodePanel` JSX 块中，`liveThinking={liveThinking}` 之后、`onClose` 之前插入三行：

```tsx
            nodeIds={nodeIds}
            trace={trace}
            onTraceInput={handleTraceInput}
```

- [ ] **Step 8: 构建门禁**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview/web" && npm run build
```

Expected: 通过。此刻点胶囊只改 trace state（图上尚无卡片，Task 3 接管），界面无回归。

- [ ] **Step 9: Commit**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && git add web/src/components/NodePanel.tsx web/src/components/RunView.tsx && git commit -m "feat(web): 输入胶囊改为溯源上报 + 删除侧栏内联输入值卡（图上值卡接管）"
```

---

### Task 3: 图上值卡 `dataCard` 临时节点 + 数据流虚线 + 镜头飞行（GraphView + RunView spec 缓存）

**Files:**
- Create: `web/src/components/DataCardNode.tsx`
- Modify: `web/src/components/GraphView.tsx`
- Modify: `web/src/components/RunView.tsx`

- [ ] **Step 1: 新建 DataCardNode 组件**——创建 `web/src/components/DataCardNode.tsx`，内容完整如下：

```tsx
// 图上数据卡（溯源值卡，React Flow 临时节点）：头部 = 来源标识 + ✕ 关闭，
// 正文 = 值（mono、滚动、break-all）。B 语言中性卡 + 阴影抬升，区别于图上
// 状态节点；亮暗主题走既有变量。单例：同一时间至多一张（id 固定）。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { X } from "lucide-react";

/** 临时值卡节点固定 id（不参与 dagre，位置 = 消费节点右侧偏移） */
export const DATA_CARD_NODE_ID = "__dataCard";

export type DataCardNodeData = {
  /** 头部来源标识：spec 卡 `spec.<key>`；上游卡 `<上游节点> → <字段名>` */
  heading: string;
  /** 正文值文本（含回退尾注） */
  body: string;
  onClose: () => void;
};

export type DataCardFlowNode = Node<DataCardNodeData, "dataCard">;

function DataCardNodeInner({ data }: NodeProps<DataCardFlowNode>) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_6px_24px_rgba(0,0,0,0.18)]">
      <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">{data.heading}</span>
        <button
          aria-label="关闭值卡"
          className="shrink-0 rounded-[5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={data.onClose}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">
        {data.body}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export const DataCardNode = memo(DataCardNodeInner);
```

- [ ] **Step 2: GraphView——注册与类型**——`web/src/components/GraphView.tsx`：

  1. `@xyflow/react` 的 type import 行 `type Edge,` 所在块加 `type Node,`，变为：

```tsx
  type Edge,
  type Node,
  type NodeTypes,
```

  2. dagre import 行之后新增两行：

```tsx
import { DATA_CARD_NODE_ID, DataCardNode, type DataCardFlowNode } from "./DataCardNode";
import type { TraceState } from "../lib/inputSource";
```

  3. `const nodeTypes: NodeTypes = { status: StatusNode };` 替换为：

```tsx
const nodeTypes: NodeTypes = { status: StatusNode, dataCard: DataCardNode };
```

  4. `type Props = {` 块替换为：

```tsx
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
```

  5. `function GraphCanvas({ payload, status, selected, onSelect }: Props) {` 替换为：

```tsx
function GraphCanvas({ payload, status, selected, onSelect, trace, spec, onClearTrace }: Props) {
```

- [ ] **Step 3: GraphView——值卡文本派生函数**——`type Props` 之前（模块顶层）新增：

```tsx
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
```

- [ ] **Step 4: GraphView——nodes useMemo 叠加值卡节点**——`const nodes = useMemo<StatusFlowNode[]>(() => {` 起的整个 useMemo 替换为：

```tsx
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
```

- [ ] **Step 5: GraphView——edges useMemo 叠加数据流虚线**——`const edges = useMemo<Edge[]>(() => {` 起的整个 useMemo 替换为：

```tsx
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
```

- [ ] **Step 6: GraphView——centerOn 参数化 + 溯源飞行 + MiniMap/点击守卫**：

  1. `centerOn` useCallback 替换为（增加 padding 参数，默认不变）：

```tsx
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
```

  2. `onMoveStart` 的 useCallback 定义之后新增：

```tsx
  // 溯源变化：镜头飞消费节点 + 值卡（padding 放宽容纳卡片）；飞行即解锁跟随
  //（与手动交互语义一致，F/按钮可再跟随）
  useEffect(() => {
    if (!trace) return;
    followRef.current = false;
    setFollow(false);
    centerOn([trace.consumerId, DATA_CARD_NODE_ID], 0.3);
  }, [trace, centerOn]);
```

  3. `minimapColor` useCallback 替换为（签名放宽到通用 Node，值卡走中性色）：

```tsx
  const minimapColor = useCallback((n: Node): string => {
    if (n.type === "dataCard") return "hsl(var(--muted-foreground) / 0.5)";
    const b = badgeOf((n as StatusFlowNode).data.state);
    if (b === "running") return "var(--ph-running)";
    if (b === "done") return "var(--ph-done)";
    if (b === "failed" || b === "aborted") return "var(--ph-aborted)";
    return "hsl(var(--muted-foreground) / 0.5)";
  }, []);
```

  4. `<ReactFlow` 的 `onNodeClick` 行替换为（点值卡不改变选中，✕ 才关）：

```tsx
        onNodeClick={(_, n) => {
          if (n.type === "dataCard") return;
          onSelect(n.id);
        }}
```

- [ ] **Step 7: RunView——spec 缓存 + GraphView 接线**——`web/src/components/RunView.tsx`：

  1. state 区（Task 2 加的 `trace` 之后）新增：

```tsx
  // spec 存档缓存（溯源值卡正文）：随 run 拉一次；无存档（旧 run / 未归档）→ null 容忍
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
```

  2. run 切换清理 effect 中，Task 2 加的 `setTrace(null);` 之后一行加：

```tsx
    setSpec(null);
```

  3. 暂停状态初值 effect（`fetchControl` 那个）之后新增：

```tsx
  // spec 存档：落盘后拉一次（module_inputs 存档）；404/缺失静默 → null（值卡走无存档回退）
  useEffect(() => {
    if (!materialized) return;
    let cancelled = false;
    fetchInputs(runId)
      .then((d) => {
        if (!cancelled) setSpec(d.spec);
      })
      .catch(() => {
        if (!cancelled) setSpec(null);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, materialized]);
```

  4. `<GraphView` JSX 块替换为：

```tsx
            <GraphView
              payload={payload}
              status={statusView}
              selected={selected}
              onSelect={setSelected}
              trace={trace}
              spec={spec}
              onClearTrace={clearTrace}
            />
```

- [ ] **Step 8: 构建门禁**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview/web" && npm run build
```

Expected: 通过。功能至此完整：点胶囊 → 飞行 → 图上值卡 + 虚线。

- [ ] **Step 9: Commit**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && git add web/src/components/DataCardNode.tsx web/src/components/GraphView.tsx web/src/components/RunView.tsx && git commit -m "feat(web): 图上数据溯源值卡 + 数据流虚线 + 镜头飞行（dataCard 临时节点）"
```

---

### Task 4: 端到端走查（人工，dev server）

**Files:** 无代码改动；发现问题回对应组件修后重跑 `npm run build`。

- [ ] **Step 1: 起服务**——两个终端：

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview" && uv run uvicorn server.app:app --port 8000
```

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview/web" && npm run dev
```

打开 http://localhost:5173/ ，进入 runs 页签选一个 done 的 academic_writer run（如 `academic_writer_ee4c27`）。

- [ ] **Step 2: 主路径走查**（对设计文档 §6 验收 1-4 + 删卡验收 5）：
  1. 点节点 Loop1 → 侧栏开；点 `original_text` 胶囊 → 镜头飞 Loop1、其右侧浮 spec 值卡（头部 `spec.raw_text`，正文 = 草稿原文）、卡↔Loop1 虚线**无箭头**；跟随按钮变「已解锁 · F」。
  2. 点 `draft_text` 胶囊 → 仍一张卡：头部 `Organize → draft_text`，正文 = Organize 输出 JSON；虚线 Organize→Loop1 **带小箭头**；无叠卡。
  3. 收起三通道各验一次：卡上 ✕；点画布空白（面板同关）；再点同一胶囊。每通道后图上无卡片/虚线残留。
  4. 溯源中来源胶囊保持 primary 反色 emphasis；收起后回中性。
  5. **侧栏任何胶囊点击都不再出现「输入值」内联卡**；hover 输入行仍显示完整 JSON。
  6. 切到别的节点 → 值卡消失；切到另一个 run → 同样无残留。
  7. 右上主题切换亮/暗各目测一遍：值卡边框/头部/阴影可辨、虚线与实线控制流边可分辨。
  8. 浏览器控制台无 React 警告（重点：无「node type "dataCard" not found」类错误）。

- [ ] **Step 3: 回退路径抽查**（设计 §5）：如该 run 存在 `{spec}` 整体 token 或字面量输入 → 胶囊为普通样式、点击无反应；如 run 无 spec 存档（可另起 `--mock` run 验证）→ spec 值卡正文显示 `{spec.<key>}（无存档值）`，虚线与飞行照常。

- [ ] **Step 4: 最终构建门禁**

```bash
cd "C:/Users/xingy/Desktop/开发/SpecModule_webview/web" && npm run build
```

Expected: 通过。

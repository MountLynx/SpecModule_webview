# 运行图 spec 值卡常驻列与溯源统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运行图上常驻一列 spec 值卡（每键一卡），点卡出虚线指消费节点；NodePanel 点 spec 输入胶囊不再弹浮卡、复用常驻卡。

**Architecture:** 纯前端零后端改动——spec 存档已由 RunView 随 run 拉取传入 GraphView。新增 `SpecCardNode`（第三种图上卡），不进 dagre、手动定位于布局包围盒左侧一列；溯源虚线从常驻卡出线指入消费节点；DataCardNode 浮卡只承担上游溯源与「键无卡」兜底。设计定稿：`docs/superpowers/specs/2026-10-02-spec-cards-column-design.md`。

**Tech Stack:** React + TypeScript + @xyflow/react + Tailwind（本仓库 web/ 既有栈）。

**测试说明（仓库惯例）：** web/ 无前端单测设施（生态纪律：不引入 lint/test 工具），验收门 = `npm run build`（tsc --noEmit + vite build）+ 浏览器实证。故本计划无 pytest/vitest 步骤，以构建门与 Task 3 浏览器清单替代，非省略 TDD。

**依赖顺序:** Task 1 产出类型/组件/接线（构建暂红——GraphView 未消费，**不提交**）；Task 2 依赖 Task 1，GraphView 全量集成后构建门转绿并一次性提交；Task 3 端到端验证 + 归档 + 双线同步。仓库路径：`C:\Users\xingy\Desktop\开发\SpecModule_webview`。

---

### Task 1: TraceState 扩展 + SpecCardNode 组件 + RunView 接线

**Files:**
- Modify: `web/src/lib/inputSource.ts:10-15`（TraceState 接口）
- Create: `web/src/components/SpecCardNode.tsx`
- Modify: `web/src/components/RunView.tsx`（GraphView 调用处 + 新回调）

- [ ] **Step 1: TraceState 允许空消费目标**

`web/src/lib/inputSource.ts` 将：

```ts
/** 一次溯源：消费节点 + 触发上报的输入字段名 + 来源 */
export interface TraceState {
  consumerId: string;
  field: string;
  source: InputSource;
}
```

替换为：

```ts
/** 一次溯源：消费节点 + 触发上报的输入字段名 + 来源。
 * NodePanel 胶囊点入 = consumerId/field 具体值；spec 卡直点 = 二者皆 null
 * （溯源目标 = 该键全部消费节点，由渲染方展开虚线）。 */
export interface TraceState {
  consumerId: string | null;
  field: string | null;
  source: InputSource;
}
```

- [ ] **Step 2: 创建 SpecCardNode.tsx**

创建 `web/src/components/SpecCardNode.tsx`（全文）：

```tsx
// 图上 spec 值卡（React Flow 节点，常驻列）：头部 spec.<key>，正文键值
// （mono 滚动）。每个 spec 键一张，画布左侧一列（GraphView 手动定位，不进
// dagre）；trace 命中该键边框高亮；点击 = 溯源 toggle（trace 由 RunView 持有）。
// 无关闭按钮（常驻卡，区别于溯源浮卡）。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "../lib/utils";

/** spec 卡 id：specCard::<key>——跨重算稳定（measured 保留前提；id 为不透明
 * 串，键含特殊字符无解析风险） */
export function specCardNodeId(key: string): string {
  return `specCard::${key}`;
}

/** spec 卡标称尺寸（列定位与 MiniMap 用） */
export const SPEC_CARD_SIZE = { width: 200, height: 132 };

export type SpecCardNodeData = {
  key: string;
  /** 正文值文本（字符串原样 / JSON 化，GraphView 组装） */
  body: string;
  /** trace 命中该键（边框高亮） */
  active: boolean;
  /** 点击 = 溯源 toggle（RunView 持有 trace） */
  onToggle: () => void;
};

export type SpecCardFlowNode = Node<SpecCardNodeData, "specCard">;

function SpecCardNodeInner({ data }: NodeProps<SpecCardFlowNode>) {
  const heading = `spec.${data.key}`;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-[10px] border bg-card shadow-[0_6px_24px_rgba(0,0,0,0.18)] transition-colors",
        data.active ? "border-primary ring-1 ring-primary" : "border-border",
      )}
      onClick={(e) => {
        e.stopPropagation();
        data.onToggle();
      }}
    >
      <div
        title={heading}
        className="flex shrink-0 items-center border-b border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground"
      >
        <span className="truncate font-mono">{heading}</span>
      </div>
      {/* nowheel：滚轮留给正文滚动，不缩放画布（React Flow 节点内滚动区约定） */}
      <div className="nowheel flex-1 overflow-y-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">
        {data.body}
      </div>
      {/* 接线锚点（隐藏）：r=溯源虚线出线——spec 是数据源，卡列在左，出线朝图区 */}
      <Handle
        id="r"
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="opacity-0"
      />
    </div>
  );
}

export const SpecCardNode = memo(SpecCardNodeInner);
```

- [ ] **Step 3: RunView 接线（trace 回调 + prop 透传）**

`web/src/components/RunView.tsx` 在 `clearTrace` 定义（`const clearTrace = useCallback(() => setTrace(null), []);`）之后加：

```ts
  // spec 卡直点：置/收 spec 溯源（目标 = 该键全部消费节点，渲染方展开虚线）；
  // 再点同卡收起（与胶囊 toggle 同语义）。consumerId/field 为 null 标记
  // 「全部消费节点」形态，与胶囊点入（具体节点）区分。
  const handleToggleSpecCard = useCallback((key: string) => {
    setTrace((prev) =>
      prev &&
      prev.source.kind === "spec" &&
      prev.source.key === key &&
      prev.consumerId == null
        ? null
        : { source: { kind: "spec", key }, consumerId: null, field: null },
    );
  }, []);
```

GraphView 调用处（`<GraphView payload={payload} ... />`）`onClearTrace={clearTrace}` 之后加一行：

```tsx
              onToggleSpecCard={handleToggleSpecCard}
```

- [ ] **Step 4: 构建门（预期暂红，不提交）**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build`
Expected: FAIL——GraphView 尚未声明 `onToggleSpecCard` prop、且 `posOf(trace.consumerId)` 等处 `string | null` 不兼容（TraceState 已扩）。红点全部由 Task 2 收口，本步不要求绿、不提交。

### Task 2: GraphView 集成——spec 卡列、溯源虚线、浮卡兜底

**Files:**
- Modify: `web/src/components/GraphView.tsx`（import/props/memo/边/镜头/小地图/点击守卫）

- [ ] **Step 1: import 与类型注册**

`web/src/components/GraphView.tsx`：

(a) `import type { TraceState } from "../lib/inputSource";` 改为：

```ts
import { resolveInputSource, type TraceState } from "../lib/inputSource";
```

(b) DataCardNode import 块之后加：

```ts
import {
  SPEC_CARD_SIZE,
  SpecCardNode,
  specCardNodeId,
  type SpecCardFlowNode,
} from "./SpecCardNode";
```

(c) nodeTypes 行与 GraphFlowNode 类型改为：

```ts
const nodeTypes: NodeTypes = {
  status: StatusNode,
  dataCard: DataCardNode,
  artifact: ArtifactNode,
  specCard: SpecCardNode,
};
```

```ts
type GraphFlowNode = StatusFlowNode | DataCardFlowNode | ArtifactFlowNode | SpecCardFlowNode;
```

(d) `cardHeading` 函数之前加正文组装helper：

```ts
/** spec 卡正文：键值（字符串原样，其余 JSON 化）——卡仅对存档键渲染，无缺键分支 */
function specCardBody(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
```

- [ ] **Step 2: Props 增加卡 toggle 回调**

`type Props = { ... }` 中 `onClearTrace: () => void;` 之后加：

```ts
  /** spec 卡直点 toggle（RunView 持有 trace） */
  onToggleSpecCard: (key: string) => void;
```

`function GraphCanvas({ ... })` 参数解构同步加 `onToggleSpecCard`。

- [ ] **Step 3: spec 卡清单 / 消费节点 / 列定位三个 memo**

`satellites` memo 之后加两个（`payload`/`spec` 派生）：

```ts
  /** spec 值卡清单：每键一卡（spec 存档键序；null/空 → 无卡列） */
  const specCards = useMemo(() => (spec ? Object.keys(spec) : []), [spec]);

  /** spec 键 → 消费节点 id 列表（inputs 值经 resolveInputSource 判定）；
   * 仅收录有卡的键——无卡键的溯源走浮卡兜底 */
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
  }, [payload, spec]);
```

`basePos` memo 之后加列定位：

```ts
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
```

`posOf` 改为三级回落（overrides > dagre > spec 列）：

```ts
  const posOf = useCallback(
    (id: string) => overrides.get(id) ?? basePos.get(id) ?? specPos.get(id),
    [overrides, basePos, specPos],
  );
```

- [ ] **Step 4: nodes memo——spec 卡节点 + 浮卡承担收窄**

(a) 卫星卡 for 循环之后、`if (trace) {` 块之前插入：

```ts
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
```

(b) `if (trace) {` 块整体替换为（浮卡仅上游溯源 / 键无卡兜底两种形态承担；块内 DataCardNode push 主体不变，只换门卫）：

```ts
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
```

(c) 该 useMemo 依赖数组改为：

```ts
  }, [payload, status, selected, trace, spec, onClearTrace, onToggleSpecCard, satellites, specCards, posOf]);
```

- [ ] **Step 5: edges memo——spec 溯源虚线改接常驻卡**

`if (trace) {` 块整体替换为：

```ts
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
```

依赖数组改为：

```ts
  }, [payload, status, trace, satellites, specCards, specConsumers]);
```

- [ ] **Step 6: 溯源镜头适配**

「溯源变化」useEffect 整体替换为：

```ts
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
```

- [ ] **Step 7: MiniMap 配色 + 点击守卫**

(a) `minimapColor` 中 `if (n.type === "dataCard") return "hsl(var(--muted-foreground) / 0.5)";` 之后加：

```ts
    if (n.type === "specCard") return "hsl(var(--muted-foreground) / 0.35)";
```

(b) `onNodeClick` 守卫改为：

```ts
        onNodeClick={(_, n) => {
          if (n.type === "dataCard" || n.type === "artifact" || n.type === "specCard") return;
          onSelect(n.id);
        }}
```

- [ ] **Step 8: 构建门转绿**

Run: `cd "C:\Users\xingy\Desktop\开发\SpecModule_webview\web" && npm run build`
Expected: tsc + vite 全绿。

- [ ] **Step 9: 提交（Task 1+2 全部文件一次落）**

```bash
git add web/src/lib/inputSource.ts web/src/components/SpecCardNode.tsx web/src/components/GraphView.tsx web/src/components/RunView.tsx
git commit -m "feat(web): 运行图 spec 值卡常驻列——每键一卡、溯源虚线统一、浮卡仅兜底"
```

### Task 3: 端到端验证 + 归档 + 双线同步

**Files:**
- Modify: `roadmap/finish.md`（追加归档条目）
- 无代码改动（验证 + git 同步）

- [ ] **Step 1: 浏览器端到端验证（mock run）**

后端/前端 dev 服务若未运行则后台启动：项目根 `uv run uvicorn server.app:app --port 8000`；`cd web && npm run dev`。用 browser-use 打开 `http://localhost:5173/`，modules 页签选一个模块（如 academic_writer）发起 mock run，spec 填 2-3 个键值对 → 进入 run 视图验证：

- spec 各键值卡常驻图区左侧一列（头部 `spec.<key>`、正文为键值、可滚动）；
- 点某张卡 → 该卡高亮 + 虚线指向全部消费 `{spec.key}` 的节点，再点收起；
- 点节点开 NodePanel → 点 `{spec.key}` 输入胶囊 → **不弹浮卡**，左侧卡高亮 + 单条虚线到该节点；再点胶囊收起；
- 点上游节点输入胶囊（裸节点名引用）→ 仍出 DataCardNode 浮卡 + 两段虚线（上游链路不回归）；
- 拖动 spec 卡松手后 WS 推送/点选不弹回；「重置布局」清位；
- 打开无存档旧 run（或 spec 缺键场景）→ 无卡列、点 spec 胶囊回退浮卡（`（无存档值）`）；
- 亮/暗主题切换正常；MiniMap 有 spec 卡独立底色。

任何一项不符 → 修复后重跑本步。

- [ ] **Step 2: 归档 finish.md**

`roadmap/finish.md` 最新条目区追加：

```markdown
## 2026-10-02 运行图 spec 值卡常驻列与溯源统一

- 定稿：specs/2026-10-02-spec-cards-column-design.md；呈现形态经问答收敛为画布内一列常驻值卡（每键一卡）。
- 纯前端：SpecCardNode（每 spec 键一卡，布局包围盒左侧一列、不进 dagre、可拖）；溯源统一——spec 卡直点出虚线至全部消费节点、NodePanel 点 spec 胶囊复用常驻卡（不再弹浮卡）；TraceState 扩展 consumerId/field 可空；无存档/键缺失保留浮卡兜底（旧 run 不劣化）。
```

```bash
git add roadmap/finish.md
git commit -m "docs(roadmap): finish.md 归档运行图 spec 值卡常驻列"
```

- [ ] **Step 3: 双线同步**

```bash
git checkout feat/multiuser-gateway && git merge main -m "merge: main 并入 feat/multiuser-gateway——spec 值卡常驻列同步" && git checkout main
```

- [ ] **Step 4: 推送两线**

```bash
git push origin main feat/multiuser-gateway
```

（若推送因凭据失败：如实报告，不重试硬闯。）

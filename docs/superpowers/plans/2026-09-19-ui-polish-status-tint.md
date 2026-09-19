# 界面美化（B·状态染色）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-09-19-ui-polish-status-tint-design.md` 落地全应用视觉统一：状态色三阶令牌、图视图染色节点/活跃边、NodePanel V2、胶囊两态、lucide 图标清扫、跟随状态按钮、字号阶收敛。

**Architecture:** 纯 `web/` 前端改动（React + Tailwind + React Flow），后端/WS 契约零变更。先建令牌层（CSS 变量 + Pill/Spinner 基件），再自底向上改图视图 → 面板 → 壳层 → chat，最后全局清扫字号与字符图标。所有状态色消费点只引用 `--ph-*-bg/border/text` 变量，亮暗主题自动衍生。

**Tech Stack:** Vite + React 18 + TS + Tailwind 3 + @xyflow/react 12 + lucide-react（已装）+ tailwindcss-animate（已装）。无新增依赖。

**验证方式（重要）：** 本仓库前端无单测基建且约定不引入（AGENTS.md：No lint/format/type tooling——npm run build 的 tsc --noEmit 是唯一机器门）。每个任务以 `cd web && npm run build` 为通过标准；Task 3/4/6/9 另附 dev server 人工目测清单（dev server 地址 http://localhost:5173，后端 :8000）。

**工作区注意：** 开始前工作区有上一会话遗留的未提交改动（roadmap.md / App.tsx / NodePanel.tsx / ResizeHandle.tsx，功能完整、roadmap 日志已写）——Task 0 先原样提交，后续任务在其上叠加。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/index.css` | 修改 | 状态色三阶变量（亮暗）+ spinner keyframes + reduced-motion 降级 |
| `web/src/components/ui/spinner.tsx` | 新建 | 运行态 spinner 基件 |
| `web/src/components/ui/pill.tsx` | 新建 | 胶囊两态 + 状态色变体基件 |
| `web/src/components/StatusNode.tsx` | 重写 | 染色节点（浸染底/图标/×N 徽章/选中环） |
| `web/src/components/GraphView.tsx` | 修改 | 边着色+箭头、Minimap 着色、点阵背景、跟随状态按钮 + F |
| `web/src/components/ThinkBlock.tsx` | 新建 | chat 与 NodePanel 共享思考块 |
| `web/src/components/NodePanel.tsx` | 重写 | V2：粘性状态头部/输入胶囊/输出卡三态+复制/时间线 |
| `web/src/components/RunView.tsx` | 修改 | 传 `live` prop；头部 run_id + phase 胶囊 |
| `web/src/chat/ChatView.tsx` | 修改 | RunBlock 图标化 + 接入 ThinkBlock |
| `web/src/components/RunControls.tsx` | 修改 | 按钮图标化 + ⏸ 胶囊 |
| `web/src/components/RunList.tsx` | 修改 | 字符图标 → lucide |
| `web/src/components/ModuleDetail.tsx` | 修改 | ▶ → Play 图标 |
| `web/src/components/ResumeDialog.tsx` | 修改 | ✗ ✓ ⚠ → lucide |
| `web/src/components/TabBar.tsx` | 修改 | 激活页签 = primary 反色胶囊 |
| 全部 tsx | 清扫 | 字号阶 10/10.5→11、11.5→12、12.5→12、14.5→15 |
| `roadmap.md` | 修改 | 变更日志 |

ActivityBar 已全 lucide（Boxes/GitFork/Layers/List/MessageSquare/Settings），无需改动。

---

### Task 0: 提交在途工作（两侧侧栏可拖宽）

**Files:**
- Commit only: `roadmap.md` `web/src/App.tsx` `web/src/components/NodePanel.tsx` `web/src/components/ResizeHandle.tsx`

- [ ] **Step 1: 确认在途改动就是这四个文件**

Run: `git status --short`
Expected: 仅 ` M roadmap.md`、` M web/src/App.tsx`、` M web/src/components/NodePanel.tsx`、`?? web/src/components/ResizeHandle.tsx`。若有其他文件出现，停下报告，不要混提交。

- [ ] **Step 2: build 验证在途工作完好**

Run: `cd web && npm run build`
Expected: tsc 无错误、vite build 成功。

- [ ] **Step 3: 提交**

```bash
git add roadmap.md web/src/App.tsx web/src/components/NodePanel.tsx web/src/components/ResizeHandle.tsx
git commit -m "feat(web): 左右侧栏可拖宽——ResizeHandle + 宽度持久化（上一会话遗留提交）"
```

---

### Task 1: 令牌层——状态色三阶 + spinner 动画

**Files:**
- Modify: `web/src/index.css`

- [ ] **Step 1: 亮色块补三阶变体**

在 `:root` 块中 `--ph-truncated: #b45309;` 行之后插入：

```css
    --ph-running-bg: #eff6ff;
    --ph-running-border: #93b8f5;
    --ph-running-text: #1d4ed8;
    --ph-done-bg: #ecfdf3;
    --ph-done-border: #b2e5c3;
    --ph-done-text: #14532d;
    --ph-aborted-bg: #fef2f2;
    --ph-aborted-border: #fecaca;
    --ph-aborted-text: #991b1b;
    --ph-cancelled-bg: #fffbeb;
    --ph-cancelled-border: #fde68a;
    --ph-cancelled-text: #92400e;
    --ph-truncated-bg: #fefce8;
    --ph-truncated-border: #fde68a;
    --ph-truncated-text: #854d0e;
```

- [ ] **Step 2: 暗色块补三阶变体**

在 `.dark` 块中 `--ph-truncated: #fbbf24;` 行之后插入：

```css
    --ph-running-bg: #16233d;
    --ph-running-border: #2b4a7a;
    --ph-running-text: #93c5fd;
    --ph-done-bg: #12291b;
    --ph-done-border: #2b5a3c;
    --ph-done-text: #86efac;
    --ph-aborted-bg: #3a1a1a;
    --ph-aborted-border: #6e2c2c;
    --ph-aborted-text: #fca5a5;
    --ph-cancelled-bg: #38290e;
    --ph-cancelled-border: #6b5220;
    --ph-cancelled-text: #fde68a;
    --ph-truncated-bg: #33230c;
    --ph-truncated-border: #64521d;
    --ph-truncated-text: #fcd34d;
```

- [ ] **Step 3: 文件末尾追加 spinner + reduced-motion 降级**

在 `index.css` 末尾追加：

```css
/* 运行态 spinner（reduced-motion 时降级为静态圆环；React Flow 活跃边虚线停帧） */
.ph-spin {
  animation: ph-spin 0.9s linear infinite;
}
@keyframes ph-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ph-spin {
    animation: none;
  }
  .react-flow__edge.animated .react-flow__edge-path {
    animation: none !important;
  }
}
```

- [ ] **Step 4: build 验证**

Run: `cd web && npm run build`
Expected: 成功（CSS 独立于 tsc，此步主要防语法笔误破坏 vite build）。

- [ ] **Step 5: Commit**

```bash
git add web/src/index.css
git commit -m "feat(web): 状态色三阶令牌（--ph-*-bg/border/text 亮暗）+ spinner/reduced-motion 基建"
```

---

### Task 2: 基础组件——Spinner + Pill

**Files:**
- Create: `web/src/components/ui/spinner.tsx`
- Create: `web/src/components/ui/pill.tsx`

- [ ] **Step 1: 新建 spinner.tsx**

```tsx
// 运行态 spinner：running 语义色圆环旋转（reduced-motion 由 index.css 降级为静态）。
import { cn } from "../../lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ph-spin inline-block h-3 w-3 shrink-0 rounded-full border-2 border-[var(--ph-running)] border-t-transparent",
        className,
      )}
    />
  );
}
```

- [ ] **Step 2: 新建 pill.tsx**

```tsx
// 胶囊基件：默认 = 浅描边中性；emphasis = primary 反色（选中/强调，亮色黑底白字）；
// running/done/failed/cancelled/truncated = 状态洗淡色（只表达状态，不表达选中）。
// 消费端禁止再手搓胶囊样式——统一走这里。
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const pillVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-[11px] leading-4",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-muted-foreground",
        emphasis: "border-primary bg-primary text-primary-foreground",
        running:
          "border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] text-[var(--ph-running-text)]",
        done: "border-[var(--ph-done-border)] bg-[var(--ph-done-bg)] text-[var(--ph-done-text)]",
        failed:
          "border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)] text-[var(--ph-aborted-text)]",
        cancelled:
          "border-[var(--ph-cancelled-border)] bg-[var(--ph-cancelled-bg)] text-[var(--ph-cancelled-text)]",
        truncated:
          "border-[var(--ph-truncated-border)] bg-[var(--ph-truncated-bg)] text-[var(--ph-truncated-text)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type PillVariant = NonNullable<VariantProps<typeof pillVariants>["variant"]>;

export interface PillProps extends ComponentProps<"span">, VariantProps<typeof pillVariants> {}

export function Pill({ className, variant, ...props }: PillProps) {
  return <span className={cn(pillVariants({ variant }), className)} {...props} />;
}
```

- [ ] **Step 3: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ui/spinner.tsx web/src/components/ui/pill.tsx
git commit -m "feat(web): Pill 胶囊两态/状态变体 + Spinner 基础组件"
```

---

### Task 3: 图视图染色——StatusNode 重写 + 边/Minimap/背景

**Files:**
- Rewrite: `web/src/components/StatusNode.tsx`
- Modify: `web/src/components/GraphView.tsx`

- [ ] **Step 1: 重写 StatusNode.tsx（整文件替换）**

```tsx
// 自定义节点（B·状态染色）：完成=绿底绿边+✓、运行=蓝底蓝边+spinner+光环、
// 失败/中止=红系、未执行=白底虚线+空心圆；×N 徽章随节点状态色。颜色全部走
// index.css 状态色变量（--ph-*-bg/border/text），亮暗主题自动衍生。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, Circle, X } from "lucide-react";
import type { NodeState } from "../api";
import { Spinner } from "./ui/spinner";

export type StatusNodeData = {
  label: string;
  type: string;
  isStart: boolean;
  state?: NodeState;
};

export type StatusFlowNode = Node<StatusNodeData, "status">;

export function badgeOf(state?: NodeState): string {
  if (!state) return "idle";
  if (state.running) return "running";
  if (state.last_status && state.last_status !== "ok") return state.last_status;
  if (state.fired_count > 0) return "done";
  return "idle";
}

const SKIN: Record<string, string> = {
  running:
    "border-[1.5px] border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--ph-running)_14%,transparent)]",
  done: "border border-[var(--ph-done-border)] bg-[var(--ph-done-bg)]",
  failed: "border-[1.5px] border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)]",
  aborted: "border-[1.5px] border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)]",
  idle: "border border-dashed border-border bg-card",
};

const TEXT: Record<string, string> = {
  running: "text-[var(--ph-running-text)]",
  done: "text-[var(--ph-done-text)]",
  failed: "text-[var(--ph-aborted-text)]",
  aborted: "text-[var(--ph-aborted-text)]",
  idle: "text-muted-foreground",
};

function StatusIcon({ badge }: { badge: string }) {
  if (badge === "running") return <Spinner className="h-3.5 w-3.5" />;
  if (badge === "done")
    return <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ph-done)]" strokeWidth={3} />;
  if (badge === "failed" || badge === "aborted")
    return <X className="h-3.5 w-3.5 shrink-0 text-[var(--ph-aborted)]" strokeWidth={3} />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />;
}

function StatusNodeInner({ data, selected }: NodeProps<StatusFlowNode>) {
  const badge = badgeOf(data.state);
  return (
    <div
      className={`box-border flex h-full min-w-[150px] items-center gap-2 rounded-[10px] px-2.5 py-1.5 ${
        SKIN[badge] ?? SKIN.idle
      } ${selected ? "ring-2 ring-ring" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <StatusIcon badge={badge} />
      <div className="min-w-0 flex-1 text-left">
        <div
          className={`truncate text-[12px] font-semibold leading-tight ${TEXT[badge] ?? TEXT.idle}`}
        >
          {data.label}
        </div>
        <div className="truncate text-[11px] leading-tight text-muted-foreground/80">
          {data.type}
          {data.isStart ? " · start" : ""}
        </div>
      </div>
      {data.state && data.state.fired_count > 0 && (
        <span
          title="运行次数"
          className={`shrink-0 rounded-full bg-card/60 px-1.5 text-[11px] leading-4 ${
            TEXT[badge] ?? TEXT.idle
          }`}
        >
          ×{data.state.fired_count}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const StatusNode = memo(StatusNodeInner);
```

- [ ] **Step 2: GraphView 边着色 + 箭头**

`GraphView.tsx` 的 import 区加 `MarkerType` 与 `BackgroundVariant`：

```tsx
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
```

将 `edges` 的 useMemo 整体替换为：

```tsx
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
```

- [ ] **Step 3: MiniMap 着色 + 点阵背景 + 图标导入**

import 区加：

```tsx
import { LocateFixed } from "lucide-react";
import { cn } from "../lib/utils";
```

（`LocateFixed`/`cn` Task 4 用，此步先加会报 unused——`cn` 在 tsc 无 noUnusedLocals 时不报错；若 build 报 unused，则把这两个 import 挪到 Task 4 再加，其余不变。）

组件内加 Minimap 着色函数（放在 `edges` useMemo 之后）：

```tsx
  /** MiniMap 节点底色：与画布节点同一状态色（取 bg 变量） */
  const minimapColor = useCallback((n: StatusFlowNode): string => {
    const b = badgeOf(n.data.state);
    if (b === "running") return "var(--ph-running-bg)";
    if (b === "done") return "var(--ph-done-bg)";
    if (b === "failed" || b === "aborted") return "var(--ph-aborted-bg)";
    return "hsl(var(--muted))";
  }, []);
```

`<StatusNode>` 的 import 行已有 `badgeOf` 吗——当前是 `import { StatusNode, type StatusFlowNode, type StatusNodeData }`，改为：

```tsx
import { badgeOf, StatusNode, type StatusFlowNode, type StatusNodeData } from "./StatusNode";
```

ReactFlow 子元素替换：

```tsx
        <MiniMap nodeColor={minimapColor} pannable zoomable />
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
```

- [ ] **Step 4: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 5: dev server 目测**

打开 http://localhost:5173 → 运行历史点开一个 done 的 run：节点应为绿底绿边+✓、未执行节点白底虚线；边为暖灰细线带箭头；Minimap 节点有底色；亮/暗主题各看一眼（暗色在设置或 localStorage `specmodule-webview.theme` 切换）。有正在跑的 run 更佳：运行节点蓝底+光环+spinner，活跃边蓝色流动虚线。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/StatusNode.tsx web/src/components/GraphView.tsx
git commit -m "feat(web): 图视图状态染色——节点浸染/图标/活跃边/Minimap 着色"
```

---

### Task 4: 跟随状态按钮 + F 快捷键

**Files:**
- Modify: `web/src/components/GraphView.tsx`

- [ ] **Step 1: followRef 升级为 ref+state 双轨**

`GraphCanvas` 内，把 `const followRef = useRef(true);` 一行替换为：

```tsx
  const followRef = useRef(true); // 跟随模式（默认开；用户拖动即关）
  const [follow, setFollow] = useState(true); // 按钮文案随动（ref 不触发渲染）
```

`import { useCallback, useEffect, useMemo, useRef, useState } from "react";`（加 useState）。

- [ ] **Step 2: engageFollow 统一入口**

在 `centerOn` 之后加：

```tsx
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
```

- [ ] **Step 3: onMoveStart 同步 state**

```tsx
  const onMoveStart = useCallback(() => {
    if (!fitLockRef.current) {
      followRef.current = false;
      setFollow(false);
    }
  }, []);
```

- [ ] **Step 4: F 快捷键（输入控件聚焦时不触发）**

```tsx
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
```

- [ ] **Step 5: 替换按钮 JSX**

删除原 `<Button variant="outline" size="sm" className="absolute left-2 top-2 z-10" ...>回到当前</Button>` 整块，替换为：

```tsx
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
```

同时删除不再使用的 `import { Button } from "./ui/button";`。

- [ ] **Step 6: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 7: dev server 目测**

运行中 run：拖动画布 → 按钮变中性「已解锁 · F」；按 F 或点按钮 → 平滑回中并恢复蓝色「跟随中 · F」。终态 run：按钮中性「回到当前」，点击 fitView 全图。在 chat 输入框打字按 f 不触发。

- [ ] **Step 8: Commit**

```bash
git add web/src/components/GraphView.tsx
git commit -m "feat(web): 跟随状态按钮（跟随中/已解锁/回到当前）+ F 快捷键"
```

---

### Task 5: ThinkBlock 共享组件 + chat 接入

**Files:**
- Create: `web/src/components/ThinkBlock.tsx`
- Modify: `web/src/chat/ChatView.tsx`

- [ ] **Step 1: 新建 ThinkBlock.tsx**

```tsx
// 思考块（chat 回合思考行与 run 节点面板共用，视觉同源）：左边框 running 蓝、
// 斜体、muted 文本、240px 滚动上限。展开/收起交互留在消费端（chat 自动收起、
// NodePanel 手动覆盖自动），组件只管视觉；ref 转发供消费端做跟随尾部滚动。
import { forwardRef } from "react";
import { cn } from "../lib/utils";

export const ThinkBlock = forwardRef<HTMLDivElement, { text: string; className?: string }>(
  function ThinkBlock({ text, className }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "max-h-[240px] overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--ph-running-border)] pl-2 text-[11px] italic text-muted-foreground",
          className,
        )}
      >
        {text}
      </div>
    );
  },
);
```

- [ ] **Step 2: ChatView 图标导入与替换**

`ChatView.tsx` 顶部 import 加：

```tsx
import { Check, Circle, FileText, X } from "lucide-react";
import { ThinkBlock } from "../components/ThinkBlock";
```

RunBlock 内节点状态行（原 `{n.outcome === "failed" ? "✗" : n.outcome === "ok" ? "✓" : "◌"}` 的 `<span>`）替换为：

```tsx
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {n.outcome === "failed" ? (
                  <X className="h-3 w-3 text-[var(--ph-aborted)]" strokeWidth={3} />
                ) : n.outcome === "ok" ? (
                  <Check className="h-3 w-3 text-[var(--ph-done)]" strokeWidth={3} />
                ) : (
                  <Circle className="h-3 w-3 text-muted-foreground/50" />
                )}
              </span>
```

思考行（原 `border-l-2 border-border pl-2 text-[11.5px] italic` 那个 div）替换为：

```tsx
              <ThinkBlock text={n.thinking.slice(-800)} className="mt-1" />
```

卡片引用按钮（原 `📄 {r.title} → 已更新到卡片`）替换为：

```tsx
                    <FileText className="h-3 w-3 shrink-0" />
                    {r.title} → 已更新到卡片
```

（`📄` 后原有一个空格拼接，改为 JSX 相邻元素即可。）

- [ ] **Step 3: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 4: dev server 目测**

开一个 chat 会话发一条消息（或看历史含运行迹的会话）：回合块节点行图标为 lucide 线性图标；思考中左边框为蓝色系。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ThinkBlock.tsx web/src/chat/ChatView.tsx
git commit -m "feat(web): ThinkBlock 共享思考块 + chat 回合块 lucide 图标化"
```

---

### Task 6: NodePanel V2 + RunView 联动

**Files:**
- Rewrite: `web/src/components/NodePanel.tsx`
- Modify: `web/src/components/RunView.tsx`

- [ ] **Step 1: 重写 NodePanel.tsx（整文件替换）**

```tsx
// 节点面板（右侧边栏，V2）：粘性状态头部（状态图标+节点名+状态·次数胶囊）+
// 输入标签胶囊（hover 看完整 JSON）+ 共享思考块 + 状态色输出卡（运行中占位/
// 流式/终态三态 + 复制）+ 时间线式运行记录。与图区并排的全高侧栏。
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Copy, X } from "lucide-react";
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";
import { cn } from "../lib/utils";
import { ResizeHandle, useResizableWidth } from "./ResizeHandle";
import { ThinkBlock } from "./ThinkBlock";
import { Pill, type PillVariant } from "./ui/pill";
import { Spinner } from "./ui/spinner";

function pretty(v: unknown): string {
  if (v === undefined) return "（尚无输出）";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** 面板级状态：running（live）> 最新 firing 失败 > 有输出 done > idle */
function panelBadge(
  live: boolean,
  latest: unknown,
  lastEntry: TimelineEntry | undefined,
): { variant: PillVariant; label: string } {
  if (live) return { variant: "running", label: "运行中" };
  if (lastEntry && lastEntry.status !== "ok")
    return { variant: "failed", label: lastEntry.status === "aborted" ? "中止" : "失败" };
  if (latest !== undefined) return { variant: "done", label: "已完成" };
  return { variant: "default", label: "未执行" };
}

export function NodePanel({
  runId,
  node,
  outputs,
  live,
  liveText,
  liveThinking,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** run 处于 running phase——输出卡占位态判断用（首 token 到达前 liveText 仍为 undefined） */
  live: boolean;
  /** 该节点当前执行的流式文本（终态后由 outputs 接管） */
  liveText?: string;
  /** 该节点当前执行的思考文本（正文 token 到达后自动收起） */
  liveThinking?: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // 右侧栏拖宽（持久化，节点切换重挂载后仍恢复；双击手柄复位）
  const bar = useResizableWidth({
    storageKey: "specmodule-webview.sidebar.right",
    initial: 380, min: 260, max: 720, side: "right",
  });
  // 思考块展开态：null = 自动（思考中展开、正文到达收起）；用户点击后以手动为准
  const [thinkExpand, setThinkExpand] = useState<boolean | null>(null);
  const thinkAuto = !liveText;
  const thinkShown = liveThinking && (thinkExpand ?? thinkAuto);

  // 双 ref 各挂各的滚动容器：滚动 effect 按生效显示对象选择目标——无思考 run
  // （thinkShown 恒 falsy）跟随正文尾部；手动展开思考时跟随思考尾部。
  const thinkRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = thinkShown ? thinkRef.current : textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveText, liveThinking, thinkShown]);

  useEffect(() => {
    setEntries([]);
    setOpenTick(null);
    let cancelled = false;
    fetchNodeTimeline(runId, node.id)
      .then((t) => { if (!cancelled) setEntries(t.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runId, node.id]);

  const latest = outputs[node.id];
  const lastEntry = entries.length ? entries[entries.length - 1] : undefined;
  const badge = panelBadge(live, latest, lastEntry);
  // 终态输出卡配色：失败红系，其余 done 绿系
  const terminalTint =
    badge.variant === "failed"
      ? {
          border: "border-[var(--ph-aborted-border)]",
          head: "border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)] text-[var(--ph-aborted-text)]",
        }
      : {
          border: "border-[var(--ph-done-border)]",
          head: "border-[var(--ph-done-border)] bg-[var(--ph-done-bg)] text-[var(--ph-done-text)]",
        };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pretty(latest));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默
    }
  };

  return (
    <>
      <ResizeHandle dragging={bar.dragging} {...bar.handleProps} />
      <aside
        className="flex shrink-0 flex-col overflow-y-auto border-l bg-sidebar"
        style={{ width: bar.width }}
      >
        {/* 粘性状态头部 */}
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-sidebar px-3.5 py-2.5">
          {badge.variant === "running" ? (
            <Spinner />
          ) : badge.variant === "done" ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ph-done)]" strokeWidth={3} />
          ) : badge.variant === "failed" ? (
            <X className="h-3.5 w-3.5 shrink-0 text-[var(--ph-aborted)]" strokeWidth={3} />
          ) : (
            <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          )}
          <h3 className="m-0 flex-1 truncate text-[13px] font-bold">{node.id}</h3>
          <Pill variant={badge.variant} className="shrink-0">
            {badge.label}
            {entries.length > 0 && ` · ×${entries.length}`}
          </Pill>
          <button
            aria-label="关闭面板"
            className="rounded-[5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="px-3.5 pb-3.5 text-[12px]">
          {/* 输入：类型/起始/键名 标签胶囊（整组 hover 显示完整 JSON） */}
          <div className="mt-2.5 flex flex-wrap gap-1" title={JSON.stringify(node.inputs)}>
            <Pill className="font-mono">
              {node.type}
              {node.is_start ? " · start" : ""}
            </Pill>
            {Object.keys(node.inputs ?? {}).map((k) => (
              <Pill key={k} className="font-mono">
                {k}
              </Pill>
            ))}
          </div>

          {/* 思考块（与 chat 同源组件） */}
          {liveThinking ? (
            <section className="mt-3">
              <button
                aria-expanded={Boolean(thinkShown)}
                className="flex items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setThinkExpand(!(thinkExpand ?? thinkAuto))}
              >
                {thinkShown ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                {liveText ? `已思考 ${liveThinking.length} 字` : "思考中…"}
              </button>
              {thinkShown ? (
                <ThinkBlock ref={thinkRef} text={liveThinking.slice(-6000)} className="mt-1" />
              ) : null}
            </section>
          ) : null}

          {/* 最新输出卡：占位（运行中无流）/ 流式 / 终态 三态 */}
          <section className="mt-3">
            <h4 className="mb-1.5 text-[12px] font-semibold">最新输出</h4>
            {live && liveText == null ? (
              <div className="flex items-center gap-2 rounded-control border border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] px-2.5 py-2 text-[12px] text-[var(--ph-running-text)]">
                <Spinner />
                {node.type === "script" ? "脚本执行中…" : "运行中…"}
              </div>
            ) : liveText != null ? (
              <div className={`overflow-hidden rounded-control border border-[var(--ph-running-border)]`}>
                <div className="flex items-center justify-between border-b border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] px-2.5 py-1 text-[11px] text-[var(--ph-running-text)]">
                  <span>输出 · 流式</span>
                  <Spinner className="h-2.5 w-2.5 border-[1.5px]" />
                </div>
                <div
                  ref={textRef}
                  className="max-h-[240px] overflow-y-auto whitespace-pre-wrap p-2 font-mono text-[11px]"
                >
                  {liveText.slice(-10000)}
                </div>
              </div>
            ) : (
              <div className={`overflow-hidden rounded-control border ${terminalTint.border}`}>
                <div
                  className={`flex items-center justify-between border-b px-2.5 py-1 text-[11px] ${terminalTint.head}`}
                >
                  <span>输出 · 终态</span>
                  <button
                    onClick={copy}
                    title="复制输出"
                    className="flex items-center gap-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:opacity-80"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <div className="max-h-[240px] overflow-y-auto whitespace-pre-wrap p-2 font-mono text-[11px]">
                  {pretty(latest)}
                </div>
              </div>
            )}
          </section>

          {/* 运行记录：竖向时间线 */}
          <section className="mt-4">
            <h4 className="mb-1.5 text-[12px] font-semibold">运行记录（{entries.length} 次）</h4>
            {entries.length ? (
              <div className="relative ml-1.5 border-l border-border pl-3.5">
                {entries
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div key={e.tick} className="relative py-1.5">
                      <span
                        className={cn(
                          "absolute -left-[18px] top-[11px] h-2 w-2 rounded-full border-2 border-sidebar",
                          e.status === "ok" ? "bg-[var(--ph-done)]" : "bg-[var(--ph-aborted)]",
                        )}
                      />
                      <div
                        className="flex cursor-pointer items-center justify-between"
                        onClick={() => setOpenTick(openTick === e.tick ? null : e.tick)}
                      >
                        <span>tick {e.tick}</span>
                        <span
                          className={
                            e.status === "ok"
                              ? "text-[var(--ph-done)]"
                              : "text-[var(--ph-aborted)]"
                          }
                        >
                          {e.status}
                        </span>
                      </div>
                      {e.error && openTick !== e.tick && (
                        <div className="mt-0.5 text-[11px] text-[var(--ph-aborted)]">{e.error}</div>
                      )}
                      {openTick === e.tick && (
                        <pre className="mb-0 mt-1.5 whitespace-pre-wrap rounded-md border bg-card p-2 font-mono text-[11px]">
                          {pretty(e.output)}
                          {e.error ? `\nerror: ${e.error}` : ""}
                        </pre>
                      )}
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">尚无执行记录</div>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 2: RunView 头部 phase 胶囊 + live prop**

`RunView.tsx` import 区加：

```tsx
import { Pill, type PillVariant } from "./ui/pill";
import { Spinner } from "./ui/spinner";
```

组件外（`MATERIALIZE_TIMEOUT_MS` 常量之后）加：

```tsx
/** phase → 胶囊变体（未知 phase 走 default 中性） */
const PHASE_PILL: Record<string, PillVariant> = {
  running: "running",
  done: "done",
  aborted: "failed",
  cancelled: "cancelled",
  truncated: "truncated",
};
```

头部 JSX：把原来的

```tsx
        <span className="truncate font-mono">
          {`${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
            statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
          }${statusView?.error ? ` · ${statusView.error}` : ""}`}
        </span>
```

替换为：

```tsx
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{runId}</span>
          {(statusView?.phase ?? payload?.phase) && (
            <Pill
              variant={PHASE_PILL[statusView?.phase ?? payload?.phase ?? ""] ?? "default"}
              className="shrink-0"
            >
              {statusView?.phase === "running" && (
                <Spinner className="h-2.5 w-2.5 border-[1.5px]" />
              )}
              {statusView?.phase ?? payload?.phase}
              {statusView?.tick != null ? ` · tick ${statusView.tick}` : ""}
            </Pill>
          )}
          {statusView?.error && (
            <span className="truncate" title={statusView.error}>
              {statusView.error}
            </span>
          )}
        </span>
```

头部容器 className 里的 `text-[12.5px] text-muted-foreground` 保持（Task 9 统一清扫字号）。

`<NodePanel>` 调用处加 `live` prop：

```tsx
          <NodePanel
            key={selectedNode.id}
            runId={runId}
            node={selectedNode}
            outputs={statusView?.outputs ?? {}}
            live={statusView?.phase === "running"}
            liveText={liveText}
            liveThinking={liveThinking}
            onClose={() => setSelected(null)}
          />
```

- [ ] **Step 3: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 4: dev server 目测**

终态 run 点任一已执行节点：头部「已完成 · ×N」绿胶囊；输入区标签胶囊（hover 出完整 JSON）；输出卡绿头+复制按钮（点击变 ✓ 已复制）；运行记录时间线圆点+连线、点击展开全文。运行中 run 点正在执行的节点：蓝色头部+spinner、输出卡流式态；点 script 类型节点（如 academic_writer 的 Report 前置 script 节点）：输出卡为「脚本执行中…」占位而非空白。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/NodePanel.tsx web/src/components/RunView.tsx
git commit -m "feat(web): NodePanel V2——状态头部/输入胶囊/输出卡三态+复制/时间线 + run 头部 phase 胶囊"
```

---

### Task 7: 控制与列表按钮图标化（字符图标清扫）

**Files:**
- Modify: `web/src/components/RunControls.tsx`
- Modify: `web/src/components/RunList.tsx`
- Modify: `web/src/components/ModuleDetail.tsx`
- Modify: `web/src/components/ResumeDialog.tsx`

- [ ] **Step 1: RunControls 图标化**

import 区加：

```tsx
import { Ban, Bookmark, Pause, Play, RotateCcw, Square } from "lucide-react";
import { Pill } from "./ui/pill";
```

`⏸ 已暂停` span 替换为：

```tsx
        <Pill variant="cancelled">
          <Pause className="h-3 w-3" />
          已暂停
        </Pill>
```

五个按钮文案逐一改为图标+文字（按钮结构/disabled/confirm 逻辑不动）：

```tsx
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("pause")}>
          <Pause className="h-3.5 w-3.5" />暂停
        </Button>
```

```tsx
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("unpause")}>
          <Play className="h-3.5 w-3.5" />继续
        </Button>
```

```tsx
          onClick={() => {
            if (window.confirm("取消该运行？（已落盘，可稍后恢复/回退）")) act("cancel");
          }}
        >
          <Ban className="h-3.5 w-3.5" />取消
        </Button>
```

```tsx
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setCpOpen(true)}>
        <Bookmark className="h-3.5 w-3.5" />存检查点…
      </Button>
```

```tsx
          onClick={() => {
            if (window.confirm("硬终止恢复子进程？（不写终态，status 停留 running；之后可强制恢复）")) {
              onTerminate();
            }
          }}
        >
          <Square className="h-3.5 w-3.5" />终止进程
        </Button>
```

```tsx
      {resumable && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialogOpen(true)}>
          <RotateCcw className="h-3.5 w-3.5" />恢复 / 回退…
        </Button>
      )}
```

- [ ] **Step 2: RunList 图标化**

import 区加：

```tsx
import { Ban, Pause, Play, RotateCcw, RefreshCw, Trash2 } from "lucide-react";
```

「↻ 刷新」按钮内容替换为：

```tsx
          <RefreshCw className="h-3 w-3" />
          刷新
```

行内四个控制按钮内容替换（结构不动）：

```tsx
                    <Pause className="h-3 w-3" />
                    暂停
```

```tsx
                    <Play className="h-3 w-3" />
                    继续
```

```tsx
                    <Ban className="h-3 w-3" />
                    取消
```

```tsx
                    <RotateCcw className="h-3 w-3" />
                    恢复
```

删除按钮内容替换为：

```tsx
                    <Trash2 className="h-3 w-3" />
                    删除
```

`App.tsx:316` 的注释 `// RunList 行内 ↻：打开目标 run 页签并请求恢复对话框（runId + seq 守卫不变）` 顺手改为 `// RunList 行内恢复按钮：打开目标 run 页签并请求恢复对话框（runId + seq 守卫不变）`（仅注释，消除 grep 噪音）。

- [ ] **Step 3: ModuleDetail 发起运行按钮**

import 区加 `import { Play } from "lucide-react";`，按钮内容替换为：

```tsx
              {busy ? "启动中…" : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  发起运行
                </>
              )}
```

- [ ] **Step 4: ResumeDialog 预检图标**

import 区加：

```tsx
import { AlertTriangle, Check, X } from "lucide-react";
```

`✗ {e}` 行替换为：

```tsx
                  {preflight.hard_errors.map((e, i) => (
                    <div key={i} className="flex items-start gap-1">
                      <X className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={3} />
                      <span>{e}</span>
                    </div>
                  ))}
```

`⚠ {w}` 行替换为：

```tsx
                  {preflight.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-1">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
```

`✓ 未发现兼容性问题…` 行替换为：

```tsx
                <div className={`${okTextCls} flex items-start gap-1`}>
                  <Check className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={3} />
                  <span>未发现兼容性问题（回退目标 tick {preflight.target_tick}）</span>
                </div>
```

- [ ] **Step 5: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/RunControls.tsx web/src/components/RunList.tsx web/src/components/ModuleDetail.tsx web/src/components/ResumeDialog.tsx web/src/App.tsx
git commit -m "style(web): 运行控制/列表/对话框按钮 lucide 图标化（清扫 ⏸▶✕✓✗⚠↻）"
```

---

### Task 8: TabBar 激活页签 = primary 反色胶囊

**Files:**
- Modify: `web/src/components/TabBar.tsx`

- [ ] **Step 1: 重写页签渲染（结构/props 不变）**

整文件替换为：

```tsx
// 顶部页签栏（二期页签制核心）：模块库固定页签永远在首位；每个 chat 会话、
// 每个 run 视图各占一页签，可同时存在。点选激活主区内容，× 关闭（模块库不可关）。
// 激活页签 = primary 反色胶囊（选中强调，亮色黑底白字），非激活 hover 微底色。
import { Box, MessageSquare, Play, X } from "lucide-react";
import { cn } from "../lib/utils";

export type TabKind = "modules" | "chat" | "run";

export interface TabItem {
  /** "modules" | `chat:${sid}` | `run:${runId}` */
  id: string;
  kind: TabKind;
  label: string;
  closable: boolean;
}

interface Props {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose }: Props) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-sidebar px-1.5">
      {tabs.map((t) => {
        const active = t.id === activeId;
        const Icon = t.kind === "modules" ? Box : t.kind === "chat" ? MessageSquare : Play;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            title={t.label}
            className={cn(
              "group flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[160px] truncate">{t.label}</span>
            {t.closable && (
              <button
                title="关闭页签"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                className={cn(
                  "ml-0.5 rounded p-0.5",
                  active
                    ? "hover:bg-primary-foreground/20"
                    : "opacity-0 hover:bg-foreground/10 group-hover:opacity-60",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: build 验证**

Run: `cd web && npm run build`
Expected: 成功。

- [ ] **Step 3: dev server 目测**

激活页签黑底白字胶囊（暗色白底黑字），非激活 hover 有底色，关闭按钮 hover 可见。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/TabBar.tsx
git commit -m "style(web): TabBar 激活页签改 primary 反色胶囊"
```

---

### Task 9: 字号阶收敛 + 终检 + roadmap 日志

**Files:**
- Modify: `web/src/**/*.tsx`（机械替换）
- Modify: `roadmap.md`

- [ ] **Step 1: 字号机械替换（Git Bash，在 web/src 下执行）**

```bash
cd web/src
grep -rl 'text-\[10px\]' --include='*.tsx' . | xargs -r sed -i 's/text-\[10px\]/text-[11px]/g'
grep -rl 'text-\[10\.5px\]' --include='*.tsx' . | xargs -r sed -i 's/text-\[10\.5px\]/text-[11px]/g'
grep -rl 'text-\[11\.5px\]' --include='*.tsx' . | xargs -r sed -i 's/text-\[11\.5px\]/text-[12px]/g'
grep -rl 'text-\[12\.5px\]' --include='*.tsx' . | xargs -r sed -i 's/text-\[12\.5px\]/text-[12px]/g'
grep -rl 'text-\[14\.5px\]' --include='*.tsx' . | xargs -r sed -i 's/text-\[14\.5px\]/text-[15px]/g'
```

注意：`index.css` 的 `.md` 字号（15px/13px）已在阶内，不动。替换后跑一遍残留检查：

```bash
grep -rn 'text-\[10\|text-\[11\.5\|text-\[12\.5\|text-\[14\.5' --include='*.tsx' .
```

Expected: 无输出。

- [ ] **Step 2: 字符图标残留检查**

```bash
cd web && grep -rn "⏸\|▶\|✕\|✓\|✗\|◌\|📄\|↻\|▼\|⚠" src --include='*.tsx'
```

Expected: 无输出（Task 5/7 已清扫；若有漏网，按同方式换 lucide 图标）。

- [ ] **Step 3: build 终门**

Run: `cd web && npm run build`
Expected: tsc 无错误、vite build 成功。

- [ ] **Step 4: 亮暗双主题人工走查（dev server）**

清单（对照 spec §8）：染色节点/活跃边/Minimap；跟随按钮三态 + F；NodePanel 头部/输入胶囊/输出卡三态（含 script 占位）/时间线/复制；思考块 chat 与 NodePanel 同屏一致；页签黑底白字激活态；控制条与列表图标；chat 轻对齐后无明显字号跳变。暗色主题重复一遍。

- [ ] **Step 5: Commit 清扫**

```bash
git add -A web/src
git commit -m "style(web): 字号阶收敛 11/12/13/15——清除 10/10.5/11.5/12.5/14.5 碎阶"
```

- [ ] **Step 6: roadmap 变更日志**

`roadmap.md` 末尾追加（沿用现有条目格式）：

```markdown
- 2026-09-19 **界面美化（B·状态染色方向）全量落地**：状态色三阶令牌（`--ph-*-bg/border/text`
  亮暗）+ Pill 胶囊两态（选中=primary 反色）/Spinner 基件；图视图染色节点（浸染底+
  lucide 状态图标+运行光环）与活跃边蓝色流动、Minimap 着色、跟随状态按钮（跟随中/
  已解锁/回到当前 + F 快捷键）；NodePanel V2（粘性状态头部/输入标签胶囊/输出卡三态
  ——script 运行占位+流式+终态复制——/时间线运行记录）；ThinkBlock 共享思考块（chat 与
  run 侧栏同源）；控制条/列表/对话框/页签 lucide 图标化 + TabBar 激活胶囊；字号阶收敛
  11/12/13/15。设计：docs/superpowers/specs/2026-09-19-ui-polish-status-tint-design.md；
  实施计划：docs/superpowers/plans/2026-09-19-ui-polish-status-tint.md
```

```bash
git add roadmap.md
git commit -m "docs: roadmap 变更日志——界面美化 B 状态染色全量落地"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2 令牌（T1/T2/T9）、§3 图视图（T3/T4）、§4 NodePanel（T6，含占位态/复制/时间线）、§5 壳层（T7/T8 + ActivityBar 已合规不改）、§6 chat（T5 + T9 清扫）、§7 动效降级（T1 reduced-motion + 各 spinner）、§8 验收（T9 终检清单）——全覆盖。
- **占位符扫描**：无 TBD/「适当处理」类步骤；每个代码步骤均含完整代码。
- **类型一致性**：`PillVariant` 在 T2 导出、T6 PHASE_PILL 消费；`badgeOf` T3 导出、T3 minimapColor 消费；`live` prop T6 定义并在 RunView 调用处传入；ThinkBlock ref 类型 `HTMLDivElement` 与 NodePanel 双 ref 声明一致。

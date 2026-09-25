// 构建器自定义节点：类型徽章 + 任务名 + 组件引用名；起点节点左侧起点圆点。
// Handle 布局与 StatusNode 一致（上 target / 下 source，竖向流）。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Code2, SquareTerminal, Boxes } from "lucide-react";
import { cn } from "../../lib/utils";

export type BuilderNodeData = {
  label: string;
  nodeType: "harness" | "script" | "command" | "submodule";
  ref: string;
  isStart: boolean;
};
export type BuilderFlowNode = Node<BuilderNodeData, "builder">;

const TYPE_META = {
  harness: { icon: Bot, cls: "text-violet-500", text: "harness" },
  script: { icon: Code2, cls: "text-sky-500", text: "script" },
  command: { icon: SquareTerminal, cls: "text-amber-500", text: "command" },
  submodule: { icon: Boxes, cls: "text-emerald-500", text: "submodule" },
} as const;

function BuilderNodeInner({ data, selected }: NodeProps<BuilderFlowNode>) {
  const meta = TYPE_META[data.nodeType];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "box-border flex h-full items-center gap-2 rounded-[10px] border bg-card px-2.5 py-1.5",
        selected
          ? "border-[1.5px] border-primary shadow-[0_0_0_2px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]"
          : "border-border",
      )}
    >
      <Handle type="target" position={Position.Top} />
      {data.isStart && <span title="起点" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />}
      <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.cls)} />
      <div className="min-w-0 flex-1 text-left">
        <div title={data.label} className="truncate text-[12px] font-semibold leading-tight">
          {data.label}
        </div>
        <div
          title={data.ref}
          className="truncate font-mono text-[11px] leading-tight text-muted-foreground"
        >
          {meta.text} · {data.ref}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const BuilderNodeView = memo(BuilderNodeInner);

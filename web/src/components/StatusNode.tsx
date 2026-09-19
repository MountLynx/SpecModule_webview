// 自定义节点（B·状态染色）：完成=绿底绿边+对勾图标、运行=蓝底蓝边+spinner+光环、
// 失败/中止=红系、未执行=白底虚线+空心圆；×N 徽章随节点状态色。颜色全部走
// index.css 状态色变量（--ph-*-bg/border/text），亮暗主题自动衍生。
// 选中态随状态色：底色/描边常驻不丢，ring 取各 badge 的边框 token（恰比填充
// 深一档，与描边同色融为一体），外圈两层状态色光晕向外淡出（color-mix 从
// --ph-* 衍生，亮暗主题免维护）；idle 无状态色，ring 走中性 --border、光晕走
// foreground；running 选中时光环并入光晕层，避免两个 shadow 工具类叠加冲突。
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

const SKIN: Record<string, { frame: string; shadow: string; selected: string }> = {
  running: {
    frame: "border-[1.5px] border-[var(--ph-running-border)] bg-[var(--ph-running-bg)]",
    shadow: "shadow-[0_0_0_2px_color-mix(in_srgb,var(--ph-running)_14%,transparent)]",
    selected:
      "ring-1 ring-[color:var(--ph-running-border)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--ph-running)_16%,transparent),0_0_16px_1.5px_color-mix(in_srgb,var(--ph-running)_42%,transparent)]",
  },
  done: {
    frame: "border border-[var(--ph-done-border)] bg-[var(--ph-done-bg)]",
    shadow: "",
    selected:
      "ring-1 ring-[color:var(--ph-done-border)] shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--ph-done)_24%,transparent),0_0_16px_1.5px_color-mix(in_srgb,var(--ph-done)_42%,transparent)]",
  },
  failed: {
    frame: "border-[1.5px] border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)]",
    shadow: "",
    selected:
      "ring-1 ring-[color:var(--ph-aborted-border)] shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--ph-aborted)_24%,transparent),0_0_16px_1.5px_color-mix(in_srgb,var(--ph-aborted)_42%,transparent)]",
  },
  aborted: {
    frame: "border-[1.5px] border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)]",
    shadow: "",
    selected:
      "ring-1 ring-[color:var(--ph-aborted-border)] shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--ph-aborted)_24%,transparent),0_0_16px_1.5px_color-mix(in_srgb,var(--ph-aborted)_42%,transparent)]",
  },
  idle: {
    frame: "border border-dashed border-border bg-card",
    shadow: "",
    selected:
      "ring-1 ring-[color:hsl(var(--border))] shadow-[0_0_0_1.5px_color-mix(in_srgb,hsl(var(--foreground))_14%,transparent),0_0_16px_1.5px_color-mix(in_srgb,hsl(var(--foreground))_22%,transparent)]",
  },
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
  const skin = SKIN[badge] ?? SKIN.idle;
  return (
    <div
      className={`box-border flex h-full min-w-[150px] items-center gap-2 rounded-[10px] px-2.5 py-1.5 ${
        skin.frame
      } ${selected ? skin.selected : skin.shadow}`}
    >
      <Handle type="target" position={Position.Top} />
      <StatusIcon badge={badge} />
      <div className="min-w-0 flex-1 text-left">
        <div
          title={data.label}
          className={`truncate text-[12px] font-semibold leading-tight ${TEXT[badge] ?? TEXT.idle}`}
        >
          {data.label}
        </div>
        <div className="truncate text-[11px] leading-tight text-muted-foreground">
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

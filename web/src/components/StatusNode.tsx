// 自定义节点：名称 + 类型 + 状态色边框 + ×N 次数徽章。配色读 index.css 主题
// 变量——亮暗主题自动生效。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { NodeState } from "../api";

export type StatusNodeData = {
  label: string;
  type: string;
  isStart: boolean;
  state?: NodeState;
};

export type StatusFlowNode = Node<StatusNodeData, "status">;

const BORDER: Record<string, string> = {
  running: "var(--ph-running)",
  failed: "var(--ph-aborted)",
  aborted: "var(--ph-aborted)",
  done: "var(--ph-done)",
  idle: "hsl(var(--muted-foreground))",
};

export function badgeOf(state?: NodeState): string {
  if (!state) return "idle";
  if (state.running) return "running";
  if (state.last_status && state.last_status !== "ok") return state.last_status;
  if (state.fired_count > 0) return "done";
  return "idle";
}

function StatusNodeInner({ data }: NodeProps<StatusFlowNode>) {
  const badge = badgeOf(data.state);
  const color = BORDER[badge] ?? BORDER.idle;
  return (
    <div
      style={{
        border: `2px solid ${color}`,
        borderRadius: 8,
        padding: "6px 10px",
        minWidth: 150,
        height: "100%",
        boxSizing: "border-box",
        background: "hsl(var(--card))",
        color: "hsl(var(--card-foreground))",
        boxShadow: badge === "running" ? `0 0 0 4px color-mix(in srgb, ${color} 20%, transparent)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>{data.label}</strong>
        {data.state && data.state.fired_count > 0 && (
          <span
            title="运行次数"
            style={{
              fontSize: 11,
              background: "hsl(var(--secondary))",
              color: "hsl(var(--secondary-foreground))",
              borderRadius: 8,
              padding: "0 6px",
            }}
          >
            ×{data.state.fired_count}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>
        {data.type}
        {data.isStart ? " · start" : ""}
        {badge === "running" ? " · 运行中" : ""}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const StatusNode = memo(StatusNodeInner);

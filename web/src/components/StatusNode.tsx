// 自定义节点：名称 + 类型 + 状态色边框 + ×N 次数徽章。
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
  running: "#2563eb",
  failed: "#dc2626",
  aborted: "#dc2626",
  done: "#16a34a",
  idle: "#9ca3af",
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
        background: "#fff",
        boxShadow: badge === "running" ? `0 0 0 4px ${color}33` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>{data.label}</strong>
        {data.state && data.state.fired_count > 0 && (
          <span
            title="运行次数"
            style={{ fontSize: 11, background: "#eef2ff", borderRadius: 8, padding: "0 6px" }}
          >
            ×{data.state.fired_count}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "#6b7280" }}>
        {data.type}
        {data.isStart ? " · start" : ""}
        {badge === "running" ? " · 运行中" : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const StatusNode = memo(StatusNodeInner);

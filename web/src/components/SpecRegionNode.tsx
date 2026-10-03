// 图上 spec 分组框（React Flow 节点，纯视觉背景）：圆角虚线框 + 左上角标签
// 「spec 输入」，圈住全部 spec 值卡。无 Handle、不可选不可拖、pointer-events
// none（事件穿透到画布，拖画布/框选照常）；几何由 GraphView 每轮从 spec 卡
// 有效位置派生（本组件零状态）。
import { memo } from "react";
import type { Node } from "@xyflow/react";

/** 分组框节点 id：单一实例，不复用不拼键 */
export const SPEC_REGION_NODE_ID = "specRegion";

export type SpecRegionNodeData = Record<string, unknown>;

export type SpecRegionFlowNode = Node<SpecRegionNodeData, "specRegion">;

function SpecRegionNodeInner() {
  return (
    <div className="h-full w-full rounded-[14px] border border-dashed border-[hsl(var(--foreground)/0.25)]">
      <span className="select-none px-3 pt-1.5 font-mono text-[10px] leading-none text-muted-foreground">
        spec 输入
      </span>
    </div>
  );
}

export const SpecRegionNode = memo(SpecRegionNodeInner);

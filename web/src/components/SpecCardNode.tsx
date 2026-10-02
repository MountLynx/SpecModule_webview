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

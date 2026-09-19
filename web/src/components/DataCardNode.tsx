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

// 图上卫星产物卡（React Flow 节点）：文件图标 + 名称 + 大小 + 交付物徽标；
// 顶部隐藏 handle 接生产节点虚线。点击即下载（不进节点面板、不改选中态）。
// 卫星卡无占位态——仅节点真实产出（firings 有记录）后由 overlay 带上图。
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { FileDown } from "lucide-react";
import type { GraphArtifactEntry } from "../api";
import { fmtSize } from "../lib/utils";

/** 卫星卡 id：artifact::{producer}::{index}——跨重算稳定（measured 保留前提） */
export function artifactNodeId(producer: string, index: number): string {
  return `artifact::${producer}::${index}`;
}

/** 卫星卡标称尺寸（dagre 布局与 MiniMap 用） */
export const ARTIFACT_SIZE = { width: 176, height: 34 };

export type ArtifactNodeData = {
  runId: string;
  producer: string;
  entry: GraphArtifactEntry;
};

export type ArtifactFlowNode = Node<ArtifactNodeData, "artifact">;

function ArtifactNodeInner({ data }: NodeProps<ArtifactFlowNode>) {
  const { runId, producer, entry } = data;
  const href = `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(producer)}/artifacts/${entry.index}`;
  const download = () => {
    const a = document.createElement("a");
    a.href = href;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <div
      title={`${entry.name} · ${entry.modified}\n${entry.path}`}
      onClick={(e) => {
        e.stopPropagation();
        download();
      }}
      className="flex h-full w-full cursor-pointer items-center gap-1.5 rounded-[8px] border bg-card px-2 transition-colors hover:border-foreground/30 hover:bg-accent"
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="opacity-0"
      />
      <FileDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span
        className={`min-w-0 flex-1 truncate text-[11px] ${
          entry.kind === "deliverable" ? "font-medium" : ""
        }`}
      >
        {entry.name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {fmtSize(entry.size)}
      </span>
      {entry.kind === "deliverable" && (
        <span className="shrink-0 rounded border border-[var(--ph-done-border)] bg-[var(--ph-done-bg)] px-1 text-[10px] leading-4 text-[var(--ph-done-text)]">
          交付物
        </span>
      )}
    </div>
  );
}

export const ArtifactNode = memo(ArtifactNodeInner);

// 占位，Task 13 完整实现
import type { GraphNode } from "../api";

export function NodePanel(_props: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  onClose: () => void;
}) {
  return <aside style={{ width: 380, borderLeft: "1px solid #e5e7eb" }} />;
}

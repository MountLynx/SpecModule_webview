// 占位，Task 12 完整实现
import type { GraphPayload, StatusCore } from "../api";

export function GraphView(_props: {
  payload: GraphPayload | null;
  status: StatusCore | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>图视图（待实现）</div>;
}

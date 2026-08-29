import type { RunSummary } from "../api";

const PHASE_COLOR: Record<string, string> = {
  running: "#2563eb",
  done: "#16a34a",
  aborted: "#dc2626",
  cancelled: "#d97706",
};

export function RunList({
  runs,
  current,
  onSelect,
}: {
  runs: RunSummary[];
  current: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      style={{
        width: 230,
        flexShrink: 0,
        borderRight: "1px solid #e5e7eb",
        overflowY: "auto",
      }}
    >
      <div style={{ padding: "10px 12px", fontWeight: 600 }}>运行列表</div>
      {runs.map((r) => (
        <div
          key={r.run_id}
          onClick={() => onSelect(r.run_id)}
          style={{
            padding: "8px 12px",
            cursor: "pointer",
            background: r.run_id === current ? "#eef2ff" : undefined,
          }}
        >
          <div style={{ fontSize: 13 }}>{r.run_id}</div>
          <div style={{ fontSize: 11, color: PHASE_COLOR[r.phase] ?? "#6b7280" }}>
            {r.phase}
            {r.tick != null ? ` · tick ${r.tick}` : ""}
          </div>
        </div>
      ))}
      {!runs.length && (
        <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>暂无运行记录</div>
      )}
    </aside>
  );
}

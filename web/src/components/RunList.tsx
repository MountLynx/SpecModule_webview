import type { CSSProperties } from "react";
import { TERMINAL_PHASES, type ControlAction, type RunSummary } from "../api";

const PHASE_COLOR: Record<string, string> = {
  running: "#2563eb",
  done: "#16a34a",
  aborted: "#dc2626",
  cancelled: "#d97706",
  truncated: "#b45309",
};

/** 非英文 phase 的展示标签（其余原样显示） */
const PHASE_LABEL: Record<string, string> = {
  truncated: "已截断",
};

const miniBtn: CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  cursor: "pointer",
};

export function RunList({
  runs,
  current,
  onSelect,
  onControl,
  onResume,
}: {
  runs: RunSummary[];
  current: string | null;
  onSelect: (id: string) => void;
  onControl: (id: string, action: ControlAction) => void;
  onResume: (id: string) => void;
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
      {runs.map((r) => {
        const terminal = TERMINAL_PHASES.has(r.phase);
        return (
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
            <div
              style={{
                fontSize: 11,
                color: PHASE_COLOR[r.phase] ?? "#6b7280",
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span>
                {PHASE_LABEL[r.phase] ?? r.phase}
                {r.tick != null ? ` · tick ${r.tick}` : ""}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}
                    onClick={(e) => e.stopPropagation()}>
                {r.phase === "running" && !r.paused && (
                  <button style={miniBtn} title="暂停"
                          onClick={() => onControl(r.run_id, "pause")}>⏸</button>
                )}
                {r.phase === "running" && r.paused && (
                  <button style={miniBtn} title="继续"
                          onClick={() => onControl(r.run_id, "unpause")}>▶</button>
                )}
                {r.phase === "running" && (
                  <button
                    style={{ ...miniBtn, color: "#b91c1c" }}
                    title="取消"
                    onClick={() => {
                      if (window.confirm(`取消运行 ${r.run_id}？`)) {
                        onControl(r.run_id, "cancel");
                      }
                    }}
                  >✕</button>
                )}
                {terminal && (
                  <button style={miniBtn} title="恢复/回退"
                          onClick={() => onResume(r.run_id)}>↻</button>
                )}
              </span>
            </div>
          </div>
        );
      })}
      {!runs.length && (
        <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>暂无运行记录</div>
      )}
    </aside>
  );
}

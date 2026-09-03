// 运行历史视图：RunList 升格全宽历史列表——module 名（status.module 溯源，旧 run
// 回落 run_id 启发式）、phase 徽章、tick、更新时间、错误摘要；行内控制（暂停/
// 继续/取消/恢复沿用）+「查看」进运行视图 +「删除」（终态确认删；running 提示
// 先取消，可强制删除走 ?force=true 二次确认）。
import { useState } from "react";
import type { CSSProperties } from "react";
import {
  TERMINAL_PHASES,
  deleteRun,
  type ControlAction,
  type RunSummary,
} from "../api";
import { btnStyle } from "./dialogStyles";

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
  unknown: "未知（status 损坏）",
};

const miniBtn: CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  cursor: "pointer",
};

const mono: CSSProperties = { fontFamily: "monospace" };

const cell: CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #f3f4f6",
  fontSize: 13,
  verticalAlign: "top",
};

function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

export function RunsView({
  runs,
  current,
  onSelect,
  onControl,
  onResume,
  onDeleted,
}: {
  runs: RunSummary[];
  current: string | null;
  onSelect: (id: string) => void;
  onControl: (id: string, action: ControlAction) => void;
  onResume: (id: string) => void;
  /** 删除成功回调（App 刷新列表；删的是当前打开的 run 则清 runId） */
  onDeleted: (runId: string) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const del = async (r: RunSummary) => {
    setErr(null);
    let force = false;
    if (r.phase === "running") {
      const ok = window.confirm(
        `运行 ${r.run_id} 进行中——建议先取消再删除。\n确定强制删除？（不会停止进程，进程可能继续写已被删的目录）`,
      );
      if (!ok) return;
      force = true;
    } else if (!window.confirm(`删除运行 ${r.run_id}？（整个 run 目录，不可恢复）`)) {
      return;
    }
    setBusyId(r.run_id);
    try {
      await deleteRun(r.run_id, force);
      onDeleted(r.run_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflowY: "auto" }}>
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 600 }}>运行历史</span>
        <span style={{ color: "#6b7280" }}>{runs.length} 条</span>
        {err && <span style={{ color: "#b91c1c", fontSize: 12 }}>{err}</span>}
      </div>
      <table style={{ borderCollapse: "collapse" }}>
        <tbody>
          {runs.map((r) => {
            const terminal = TERMINAL_PHASES.has(r.phase);
            const moduleName = r.module ?? r.run_id;
            return (
              <tr
                key={r.run_id}
                onClick={() => onSelect(r.run_id)}
                style={{ cursor: "pointer", background: r.run_id === current ? "#eef2ff" : undefined }}
              >
                <td style={{ ...cell, minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>
                    {moduleName}
                    {r.module == null && (
                      <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>
                        （未知模块，run_id 启发式）
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#6b7280", ...mono }}>{r.run_id}</div>
                </td>
                <td style={{ ...cell, color: PHASE_COLOR[r.phase] ?? "#6b7280", whiteSpace: "nowrap" }}>
                  {PHASE_LABEL[r.phase] ?? r.phase}
                  {r.paused && <span style={{ color: "#b45309" }}> · 已暂停</span>}
                  {r.tick != null ? ` · tick ${r.tick}` : ""}
                </td>
                <td style={{ ...cell, fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" }}>
                  {fmtTime(r.updated_at)}
                  {!r.has_sqlite && <div style={{ fontSize: 11 }}>无 run.sqlite</div>}
                </td>
                <td style={{ ...cell, fontSize: 12, color: r.error ? "#b91c1c" : "#9ca3af", maxWidth: 360 }}>
                  {r.error
                    ? r.error.length > 120
                      ? r.error.slice(0, 120) + "…"
                      : r.error
                    : "—"}
                </td>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>
                  <span
                    style={{ display: "flex", gap: 4, alignItems: "center" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button style={miniBtn} title="查看运行视图" onClick={() => onSelect(r.run_id)}>
                      查看
                    </button>
                    {r.phase === "running" && !r.paused && (
                      <button style={miniBtn} title="暂停" onClick={() => onControl(r.run_id, "pause")}>⏸</button>
                    )}
                    {r.phase === "running" && r.paused && (
                      <button style={miniBtn} title="继续" onClick={() => onControl(r.run_id, "unpause")}>▶</button>
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
                      <button style={miniBtn} title="恢复/回退" onClick={() => onResume(r.run_id)}>↻</button>
                    )}
                    <button
                      style={{ ...miniBtn, color: "#b91c1c" }}
                      title="删除该 run 目录"
                      disabled={busyId === r.run_id}
                      onClick={() => del(r)}
                    >
                      删除
                    </button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!runs.length && (
        <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>
          暂无运行记录——到「模块库」发起一个运行，或用 CLI 在运行根目录起 run。
        </div>
      )}
    </div>
  );
}

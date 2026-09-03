// App 壳层：顶部视图切换（模块库 / 运行历史 / 运行视图），useState 存视图名
// （不引 router）。每个视图自包含组件，壳层只持有跨视图状态（当前 runId、
// runs 轮询、恢复对话框请求）；视图组织形式后续可改而视图内部不动。
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { fetchRuns, postControl, type ControlAction, type LaunchResult, type RunSummary } from "./api";
import { ModulesView } from "./components/ModulesView";
import { RunView, type ResumeRequestMsg } from "./components/RunView";
import { RunsView } from "./components/RunsView";

type ViewName = "modules" | "runs" | "run";

const NAV: { key: ViewName; label: string }[] = [
  { key: "modules", label: "模块库" },
  { key: "runs", label: "运行历史" },
  { key: "run", label: "运行视图" },
];

const navBtn = (active: boolean): CSSProperties => ({
  fontSize: 13,
  padding: "4px 14px",
  cursor: "pointer",
  border: "none",
  borderRadius: 6,
  background: active ? "#eef2ff" : "transparent",
  color: active ? "#4338ca" : "#374151",
  fontWeight: active ? 700 : 400,
});

export default function App() {
  const [view, setView] = useState<ViewName>("runs");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  // 打开恢复对话框的请求：带目标 runId（避免全局计数器泄漏到无关 run 的切换）+ seq 去重
  const [resumeRequest, setResumeRequest] = useState<ResumeRequestMsg | null>(null);

  const refreshRuns = useCallback(() => {
    fetchRuns()
      .then(setRuns)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
    const t = setInterval(refreshRuns, 5000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  // 打开 run：切运行视图（RunsView 行点击 / 查看按钮 / 发起运行成功共用）
  const openRun = useCallback((id: string) => {
    setRunId(id);
    setView("run");
  }, []);

  // RunsView 行内 ↻：切到目标 run 并请求打开恢复对话框（RunControls 按 runId + seq 守卫）
  const handleListResume = useCallback((rid: string) => {
    setRunId(rid);
    setView("run");
    setResumeRequest({ runId: rid, seq: Date.now() });
  }, []);

  // 恢复请求已被 RunControls 消费（防 run 切换重挂载后陈旧请求重放误开对话框）
  const consumeResumeRequest = useCallback(() => setResumeRequest(null), []);

  // RunsView 行内控制：失败静默——列表 5s 轮询刷新后状态即真相
  const handleListControl = useCallback(
    async (rid: string, action: ControlAction) => {
      try {
        await postControl(rid, action);
      } catch {
        // 行内静默：刷新后状态即真相
      }
      refreshRuns();
    },
    [refreshRuns],
  );

  // RunsView 删除成功：刷新列表；删的是当前打开的 run 则清 runId
  const handleDeleted = useCallback(
    (deletedId: string) => {
      refreshRuns();
      setRunId((cur) => (cur === deletedId ? null : cur));
    },
    [refreshRuns],
  );

  // 模块库发起运行成功（202）：切运行视图打开新 run
  const handleLaunched = useCallback(
    (r: LaunchResult) => {
      refreshRuns();
      openRun(r.run_id);
    },
    [refreshRuns, openRun],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <nav
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          padding: "6px 10px",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        {NAV.map((n) => (
          <button key={n.key} style={navBtn(view === n.key)} onClick={() => setView(n.key)}>
            {n.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
          SpecModule Webview
        </span>
      </nav>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {view === "modules" && <ModulesView onLaunched={handleLaunched} />}
        {view === "runs" && (
          <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
            <RunsView
              runs={runs}
              current={runId}
              onSelect={openRun}
              onControl={handleListControl}
              onResume={handleListResume}
              onDeleted={handleDeleted}
            />
          </div>
        )}
        {view === "run" &&
          (runId ? (
            <RunView
              runId={runId}
              resumeRequest={resumeRequest}
              onResumeRequestConsumed={consumeResumeRequest}
              onRequestResume={(rid) => setResumeRequest({ runId: rid, seq: Date.now() })}
              onRefreshRuns={refreshRuns}
            />
          ) : (
            <div style={{ flex: 1, padding: 12, color: "#9ca3af" }}>
              未打开任何 run——从「运行历史」选择或到「模块库」发起运行。
            </div>
          ))}
      </div>
    </div>
  );
}

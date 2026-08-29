import { useCallback, useEffect, useState } from "react";
import {
  fetchGraph,
  fetchModules,
  fetchRuns,
  fetchStatus,
  type GraphPayload,
  type ModuleInfo,
  type RunSummary,
  type StatusCore,
  type StatusResp,
} from "./api";
import { useRunStream } from "./ws";
import { GraphView } from "./components/GraphView";
import { NodePanel } from "./components/NodePanel";
import { RunList } from "./components/RunList";

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [initialStatus, setInitialStatus] = useState<StatusResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moduleOverride, setModuleOverride] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const stream = useRunStream(runId);

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

  useEffect(() => {
    if (!runId) return;
    setPayload(null);
    setSelected(null);
    setError(null);
    setInitialStatus(null);
    fetchStatus(runId)
      .then(setInitialStatus)
      .catch(() => {});
    fetchGraph(runId, moduleOverride ?? undefined)
      .then(setPayload)
      .catch((e: Error) => setError(e.message));
    fetchModules()
      .then(setModules)
      .catch(() => {});
  }, [runId, moduleOverride]);

  const statusView: StatusCore | null = stream ?? initialStatus;
  const selectedNode = payload?.graph.nodes.find((n) => n.id === selected) ?? null;
  const needModulePicker = !!error && error.includes("未找到");

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <RunList runs={runs} current={runId} onSelect={setRunId} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid #e5e7eb",
            fontSize: 13,
            color: "#6b7280",
          }}
        >
          {runId
            ? `${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
                statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
              }${statusView?.error ? ` · ${statusView.error}` : ""}`
            : "SpecModule 运行时图视图"}
        </header>
        <div style={{ flex: 1, position: "relative" }}>
          {error && (
            <div style={{ padding: 12, color: "#b91c1c" }}>
              图加载失败：{error}
              {needModulePicker && (
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <select onChange={(e) => setModuleOverride(e.target.value || null)} defaultValue="">
                    <option value="">选择模块…</option>
                    {modules.map((m) => (
                      <option key={`${m.kind}:${m.name}`} value={m.name}>
                        {m.name}（{m.kind}）
                      </option>
                    ))}
                  </select>
                  {moduleOverride && <span>已切换模块：{moduleOverride}</span>}
                </div>
              )}
            </div>
          )}
          {payload ? (
            <GraphView
              payload={payload}
              status={statusView}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            !error && <div style={{ padding: 12 }}>选择左侧 run 开始查看</div>
          )}
        </div>
      </div>
      {payload && selected && selectedNode && (
        <NodePanel
          runId={runId!}
          node={selectedNode}
          outputs={statusView?.outputs ?? {}}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

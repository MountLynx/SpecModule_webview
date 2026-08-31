import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchControl,
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
import { RunControls } from "./components/RunControls";
import { RunList } from "./components/RunList";

const TERMINAL_PHASES = new Set(["done", "aborted", "cancelled"]);

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [initialStatus, setInitialStatus] = useState<StatusResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  const [moduleOverride, setModuleOverride] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [paused, setPaused] = useState(false);
  const streamState = useRunStream(runId);
  const stream = streamState?.msg ?? null;
  // 已应用到 node_states 的 tick 基线（首条 WS 消息重放的是 /graph 初始载荷已计入的状态）
  const appliedTickRef = useRef<number | null>(null);

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

  // run 切换：清空全部派生状态（含 moduleOverride，避免上一个 run 的模块选择泄漏到下一个 run）
  useEffect(() => {
    if (!runId) return;
    setPayload(null);
    setSelected(null);
    setError(null);
    setInitialStatus(null);
    setModuleOverride(null);
    setPaused(false);
    appliedTickRef.current = null;
  }, [runId]);

  // 暂停状态初值（control.json；此后由 WS paused 增量驱动）
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetchControl(runId)
      .then((c) => {
        if (!cancelled) setPaused(c.paused);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // 加载：run/moduleOverride 变化即重新拉取；cancelled 防止切换后旧响应覆盖新 run 的状态
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetchStatus(runId)
      .then((s) => {
        if (!cancelled) setInitialStatus(s);
      })
      .catch(() => {});
    fetchGraph(runId, moduleOverride ?? undefined)
      .then((p) => {
        if (!cancelled) setPayload(p);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError({
            message: e.message,
            code: e instanceof ApiError ? e.code : null,
          });
        }
      });
    fetchModules()
      .then((m) => {
        if (!cancelled) setModules(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, moduleOverride]);

  // WS 增量：tick 前进即本地累加 fired_count/last_tick（last_status 留待终态权威重取）；
  // phase 到终态时重拉 /graph（快照/失败状态以库侧为准）
  useEffect(() => {
    // 陈旧流守卫：切 run 瞬间旧 run 的最后一条消息可能仍在 state（setState 批处理），
    // 不校验会把基线初始化到旧 run 的 tick，压制新 run 的本地增量
    if (!streamState || streamState.runId !== runId) return;
    const stream = streamState.msg;
    let cancelled = false;
    if (stream.tick != null) {
      if (appliedTickRef.current == null) {
        // 首条消息重放当前状态——已含在 /graph 初始载荷里，只记基线不重复计数
        appliedTickRef.current = stream.tick;
      } else if (stream.tick > appliedTickRef.current) {
        const tick = stream.tick;
        const fired = stream.fired;
        appliedTickRef.current = tick;
        setPayload(
          (prev) =>
            prev && {
              ...prev,
              node_states: {
                ...prev.node_states,
                ...Object.fromEntries(
                  Object.entries(prev.node_states).map(([id, ns]) =>
                    fired.includes(id)
                      ? [id, { ...ns, fired_count: ns.fired_count + 1, last_tick: tick }]
                      : [id, ns],
                  ),
                ),
              },
            },
        );
      }
    }
    if (stream.paused != null) setPaused(stream.paused);
    if (TERMINAL_PHASES.has(stream.phase)) {
      setPaused(false);
      fetchGraph(runId, moduleOverride ?? undefined)
        .then((p) => {
          if (!cancelled) setPayload(p);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [streamState, runId, moduleOverride]);

  const statusView: StatusCore | null = stream ?? initialStatus;
  const selectedNode = payload?.graph.nodes.find((n) => n.id === selected) ?? null;
  const needModulePicker = error?.code === "module_unresolved";

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
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {runId ? (
            <>
              <span>
                {`${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
                  statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
                }${statusView?.error ? ` · ${statusView.error}` : ""}`}
              </span>
              <RunControls
                runId={runId}
                phase={statusView?.phase ?? payload?.phase ?? null}
                paused={paused}
                moduleHint={moduleOverride}
                onAction={refreshRuns}
              />
            </>
          ) : (
            "SpecModule 运行时图视图"
          )}
        </header>
        <div style={{ flex: 1, position: "relative" }}>
          {error && (
            <div style={{ padding: 12, color: "#b91c1c" }}>
              图加载失败：{error.message}
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

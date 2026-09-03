// 运行视图容器：图视图 + 头部控制条 + 停滞黄条 + 节点面板（自 App 壳层搬迁，
// 功能不变）。增强：图加载失败区挂 process.log 尾部展示（3s 轮询 /process，
// 仅错误区可见时）——新 run 无 module_inputs 归档的 404 窗口期与 CLI 启动期
// 失败在此界面可见。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchControl,
  fetchGraph,
  fetchModules,
  fetchProcess,
  fetchStatus,
  postTerminate,
  TERMINAL_PHASES,
  type GraphPayload,
  type ModuleInfo,
  type StatusCore,
  type StatusResp,
} from "../api";
import { useRunStream } from "../ws";
import { GraphView } from "./GraphView";
import { NodePanel } from "./NodePanel";
import { RunControls } from "./RunControls";

export interface ResumeRequestMsg {
  runId: string;
  seq: number;
}

interface RunViewProps {
  runId: string;
  /** 打开恢复对话框的请求（RunsView/黄条发起；带目标 runId + seq 去重） */
  resumeRequest: ResumeRequestMsg | null;
  onResumeRequestConsumed: () => void;
  onRequestResume: (runId: string) => void;
  onRefreshRuns: () => void;
}

export function RunView({
  runId,
  resumeRequest,
  onResumeRequestConsumed,
  onRequestResume,
  onRefreshRuns,
}: RunViewProps) {
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [initialStatus, setInitialStatus] = useState<StatusResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  const [moduleOverride, setModuleOverride] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [paused, setPaused] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [procRunning, setProcRunning] = useState(false);
  // 图加载失败区的 process.log 尾（CLI 启动期失败界面可见）
  const [procLog, setProcLog] = useState<string | null>(null);
  const lastMsgAtRef = useRef<number>(Date.now());
  const liveRef = useRef(false);
  const streamState = useRunStream(runId);
  const stream = streamState?.msg ?? null;
  // 已应用到 node_states 的 tick 基线（首条 WS 消息重放的是 /graph 初始载荷已计入的状态）
  const appliedTickRef = useRef<number | null>(null);

  // run 切换：清空全部派生状态（含 moduleOverride，避免上一个 run 的模块选择泄漏到下一个 run）
  useEffect(() => {
    setPayload(null);
    setSelected(null);
    setError(null);
    setInitialStatus(null);
    setModuleOverride(null);
    setPaused(false);
    setProcLog(null);
    appliedTickRef.current = null;
    lastMsgAtRef.current = Date.now();
    setStalled(false);
  }, [runId]);

  // 暂停状态初值（control.json；此后由 WS paused 增量驱动）
  useEffect(() => {
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
    let cancelled = false;
    fetchStatus(runId)
      .then((s) => {
        if (!cancelled) setInitialStatus(s);
      })
      .catch(() => {});
    fetchGraph(runId, moduleOverride ?? undefined)
      .then((p) => {
        if (!cancelled) {
          setPayload(p);
          setError(null);
        }
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
      .then((d) => {
        if (!cancelled) setModules(d.modules);
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

  // 停滞计时基准：新消息即推进 + 自愈清黄条。独立于 WS 增量 effect——
  // moduleOverride 变化会重跑后者，但那不是活性信号，不应重置停滞计时。
  useEffect(() => {
    if (!streamState || streamState.runId !== runId) return;
    lastMsgAtRef.current = Date.now();
    setStalled(false);
  }, [streamState, runId]);

  const statusView: StatusCore | null = stream ?? initialStatus;

  // 停滞检测：running 且未暂停时，距最后一条 WS 消息超过 120s → 引导强制恢复。
  // 阈值取宽：单 tick 含多次 LLM 调用，5-10 分钟 tick 间隔属常态，提示是引导信号。
  useEffect(() => {
    liveRef.current = statusView?.phase === "running" && !paused;
  }, [statusView?.phase, paused]);

  useEffect(() => {
    const t = setInterval(() => {
      if (liveRef.current && Date.now() - lastMsgAtRef.current > 120_000) {
        setStalled(true);
      }
    }, 5_000);
    return () => clearInterval(t);
  }, []);

  // ⑤ terminate 按钮：running 期间轮询 /process（只对本 server 拉起的恢复子进程可见）
  useEffect(() => {
    if (statusView?.phase !== "running") {
      setProcRunning(false);
      return;
    }
    let cancelled = false;
    const poll = () =>
      fetchProcess(runId)
        .then((p) => {
          if (!cancelled) setProcRunning(p.running);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 3_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runId, statusView?.phase]);

  // 图加载失败区：process.log 尾 3s 轮询（仅错误区可见时）——CLI 启动期失败
  // （模块解析/模板翻译错误等）只有日志里有，界面必须能看见
  useEffect(() => {
    if (!error) {
      setProcLog(null);
      return;
    }
    let cancelled = false;
    const poll = () =>
      fetchProcess(runId)
        .then((p) => {
          if (!cancelled) setProcLog(p.log);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 3_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runId, error]);

  const terminateProc = useCallback(async () => {
    try {
      await postTerminate(runId);
    } catch {
      // 409（进程已退/注册表清空）等：静默，下一次 poll 自然纠正
    }
    onRefreshRuns();
  }, [runId, onRefreshRuns]);

  const selectedNode = payload?.graph.nodes.find((n) => n.id === selected) ?? null;
  // 选中节点的流式文本：仅 running 且流缓冲属于当前 run 时给出（终态后 outputs 接管）
  const liveText =
    statusView?.phase === "running" && streamState?.runId === runId && selectedNode
      ? streamState.stream.text[selectedNode.id]
      : undefined;
  const needModulePicker = error?.code === "module_unresolved";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
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
        <span>
          {`${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
            statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
          }${statusView?.error ? ` · ${statusView.error}` : ""}`}
        </span>
        <RunControls
          key={runId}
          runId={runId}
          phase={statusView?.phase ?? payload?.phase ?? null}
          paused={paused}
          moduleHint={moduleOverride}
          onAction={onRefreshRuns}
          resumeRequest={resumeRequest}
          onResumeRequestConsumed={onResumeRequestConsumed}
          procRunning={procRunning}
          onTerminate={terminateProc}
        />
      </header>
      {stalled && (
        <div
          style={{
            padding: "6px 14px",
            background: "#fef3c7",
            color: "#92400e",
            fontSize: 12,
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <span>
            进程长时间无输出——可能已失联/崩溃。若确认进程已退出，可强制恢复。
          </span>
          <button
            style={{ fontSize: 12, cursor: "pointer" }}
            onClick={() => onRequestResume(runId)}
          >
            打开恢复/回退…
          </button>
        </div>
      )}
      <div style={{ flex: 1, position: "relative", overflowY: "auto" }}>
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
            {procLog && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: "#6b7280" }}>process.log 尾部：</div>
                <pre
                  style={{
                    fontFamily: "monospace",
                    fontSize: 12,
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: 6,
                    padding: 8,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    maxHeight: 260,
                    overflowY: "auto",
                  }}
                >
                  {procLog}
                </pre>
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
          !error && <div style={{ padding: 12 }}>图加载中…</div>
        )}
      </div>
      {payload && selected && selectedNode && (
        <NodePanel
          runId={runId}
          node={selectedNode}
          outputs={statusView?.outputs ?? {}}
          liveText={liveText}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

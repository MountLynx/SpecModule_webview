// 运行视图容器：图视图 + 头部控制条 + 停滞黄条 + 右侧节点面板（图竖向 TB 分层，
// 连线自上节点底部连至下节点顶部，节点详情以全高侧栏并排于图区右侧）。
//
// 落盘等待门（materialized）：发起运行 202 → 子进程写出 status.json 有 ~1s
// 窗口，期间 run 目录尚不存在——立即拉图会 404 黏住（无重试）、连 WS 会被
// 服务端拒连并永久停止重连。故落盘前只轮询 /status（404 静默），成功即放行
// WS 与图加载；120s 未落盘在错误区示错并挂 process.log（启动失败界面可见）。
// 自愈：WS 已连后图仍处失败态（如 translating 期 module_inputs 未归档的 404），
// phase 前进说明归档可能已写——按 phase 去抖各重拉一次 graph。
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
import { Button } from "./ui/button";

export interface ResumeRequestMsg {
  runId: string;
  seq: number;
}

/** 落盘等待上限：超过则示错（轮询不停止，落盘即自愈）。 */
const MATERIALIZE_TIMEOUT_MS = 120_000;

interface RunViewProps {
  runId: string;
  /** 打开恢复对话框的请求（RunList/黄条发起；带目标 runId + seq 去重） */
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
  // 落盘等待门：false = run 尚未确认落盘（不连 WS、不拉图）
  const [materialized, setMaterialized] = useState(false);
  // 落盘等待超时示错（轮询不停止，落盘即自愈清零）
  const [materialTimeout, setMaterialTimeout] = useState(false);
  const lastMsgAtRef = useRef<number>(Date.now());
  const liveRef = useRef(false);
  // 落盘后才连 WS（run 不存在时服务端拒连 + 前端永久停连，不可逆）；
  // 终态回调刷新侧栏列表（列表不做周期轮询，事件钩子驱动）
  const streamState = useRunStream(materialized ? runId : null, onRefreshRuns);
  const stream = streamState?.msg ?? null;
  // 已应用到 node_states 的 tick 基线（首条 WS 消息重放的是 /graph 初始载荷已计入的状态）
  const appliedTickRef = useRef<number | null>(null);
  // 图失败自愈去抖：已重拉过的 phase（同一 phase 只重拉一次）
  const retriedPhaseRef = useRef<string | null>(null);

  // run 切换：清空全部派生状态（含 moduleOverride，避免上一个 run 的模块选择泄漏到下一个 run）
  useEffect(() => {
    setPayload(null);
    setSelected(null);
    setError(null);
    setInitialStatus(null);
    setModuleOverride(null);
    setPaused(false);
    setProcLog(null);
    setMaterialized(false);
    setMaterialTimeout(false);
    appliedTickRef.current = null;
    retriedPhaseRef.current = null;
    lastMsgAtRef.current = Date.now();
    setStalled(false);
  }, [runId]);

  // 落盘等待门：每 1s 轮询 /status，404（子进程 spawn→首写窗口）静默继续；
  // 成功 → status 初值 + 放行。120s 未落盘示错（轮询不停止，落盘即自愈）。
  useEffect(() => {
    if (materialized) return;
    let cancelled = false;
    const started = Date.now();
    const poll = () => {
      fetchStatus(runId)
        .then((s) => {
          if (cancelled) return;
          setInitialStatus(s);
          setMaterialTimeout(false);
          setMaterialized(true);
        })
        .catch(() => {
          if (!cancelled && Date.now() - started > MATERIALIZE_TIMEOUT_MS) {
            setMaterialTimeout(true);
          }
        });
    };
    poll();
    const t = setInterval(poll, 1_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runId, materialized]);

  // 暂停状态初值（control.json；此后由 WS paused 增量驱动）——同样以落盘为门
  useEffect(() => {
    if (!materialized) return;
    let cancelled = false;
    fetchControl(runId)
      .then((c) => {
        if (!cancelled) setPaused(c.paused);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, materialized]);

  // 加载：落盘后 / run/moduleOverride 变化即重新拉取；cancelled 防止切换后旧响应覆盖新 run 的状态
  useEffect(() => {
    if (!materialized) return;
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
  }, [runId, moduleOverride, materialized]);

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

  // 图失败自愈：图处于加载失败态且 WS status 的 phase 变化 → 重拉一次 graph。
  // 覆盖 translating 期 module_inputs 未归档的 404 窗口（phase 前进后归档已写）；
  // 同一 phase 只重拉一次（ref 去抖，避免 1s 推送节奏下的重试风暴）。
  useEffect(() => {
    if (!streamState || streamState.runId !== runId) return;
    if (error == null) return;
    const phase = streamState.msg.phase;
    if (phase == null || retriedPhaseRef.current === phase) return;
    retriedPhaseRef.current = phase;
    let cancelled = false;
    fetchGraph(runId, moduleOverride ?? undefined)
      .then((p) => {
        if (!cancelled) {
          setPayload(p);
          setError(null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [streamState, runId, error, moduleOverride]);

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

  // process.log 尾 3s 轮询：图加载失败 或 落盘等待超时（CLI 启动期失败界面可见）
  const showProcLog = error != null || (!materialized && materialTimeout);
  useEffect(() => {
    if (!showProcLog) {
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
  }, [runId, showProcLog]);

  const terminateProc = useCallback(async () => {
    try {
      await postTerminate(runId);
    } catch {
      // 409（进程已退/注册表清空）等：静默，下一次 poll 自然纠正
    }
    onRefreshRuns();
  }, [runId, onRefreshRuns]);

  const selectedNode = payload?.graph.nodes.find((n) => n.id === selected) ?? null;
  // 选中节点的流式文本/思考文本：仅 running 且流缓冲属于当前 run 时给出（终态后 outputs 接管）
  const liveText =
    statusView?.phase === "running" && streamState?.runId === runId && selectedNode
      ? streamState.stream.text[selectedNode.id]
      : undefined;
  const liveThinking =
    statusView?.phase === "running" && streamState?.runId === runId && selectedNode
      ? streamState.stream.thinking[selectedNode.id]
      : undefined;
  const needModulePicker = error?.code === "module_unresolved";
  const waitingMaterial = !materialized && materialTimeout;

  const procLogView = procLog && (
    <div className="mt-2.5">
      <div className="text-[12px] text-muted-foreground">process.log 尾部：</div>
      <pre className="mt-1 max-h-[260px] overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-secondary p-2 font-mono text-[12px]">
        {procLog}
      </pre>
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-3.5 py-2 text-[12.5px] text-muted-foreground">
        <span className="truncate font-mono">
          {`${runId} · ${statusView?.phase ?? payload?.phase ?? "…"}${
            statusView?.tick != null ? ` · tick ${statusView.tick}` : ""
          }${statusView?.error ? ` · ${statusView.error}` : ""}`}
        </span>
        <RunControls
          key={runId}
          runId={runId}
          phase={statusView?.phase ?? payload?.phase ?? null}
          paused={paused}
          // 恢复对话框模块名预填：优先图载荷的已解析模块名（status.json 溯源 >
          // run_id 启发式的服务端解析结果），图未加载时退回模块选择器覆盖值——
          // 不能直接用 runId 预填，否则预检必然 module_unresolved
          moduleHint={payload?.module ?? moduleOverride}
          onAction={onRefreshRuns}
          resumeRequest={resumeRequest}
          onResumeRequestConsumed={onResumeRequestConsumed}
          procRunning={procRunning}
          onTerminate={terminateProc}
        />
      </header>
      {stalled && (
        <div className="flex items-center gap-2.5 bg-[color-mix(in_srgb,var(--ph-truncated)_14%,transparent)] px-3.5 py-1.5 text-[12px] text-[var(--ph-truncated)]">
          <span>
            进程长时间无输出——可能已失联/崩溃。若确认进程已退出，可强制恢复。
          </span>
          <Button variant="outline" size="sm" onClick={() => onRequestResume(runId)}>
            打开恢复/回退…
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          {error && (
            <div className="p-3 text-[12.5px] text-destructive">
              图加载失败：{error.message}
              {needModulePicker && (
                <div className="mt-2 flex items-center gap-2">
                  <select
                    onChange={(e) => setModuleOverride(e.target.value || null)}
                    defaultValue=""
                    className="rounded-control border border-input bg-transparent px-2 py-1 text-[12.5px]"
                  >
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
              {procLogView}
            </div>
          )}
          {waitingMaterial && (
            <div className="p-3 text-[12.5px] text-[var(--ph-truncated)]">
              运行迟迟未落盘——可能启动失败，见下方日志
              {procLogView}
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
            !error && !waitingMaterial && <div className="p-3 text-[12.5px]">图加载中…</div>
          )}
        </div>
        {payload && selected && selectedNode && (
          <NodePanel
            runId={runId}
            node={selectedNode}
            outputs={statusView?.outputs ?? {}}
            liveText={liveText}
            liveThinking={liveThinking}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

// 运行视图容器：图视图 + 头部控制条 + 停滞黄条/已终止引导条 + 右侧节点面板（图竖向 TB 分层，
// 连线自上节点底部连至下节点顶部，节点详情以全高侧栏并排于图区右侧）。
// 已终止引导条：终止进程成功 → status 残留 running 是设计后果，控制通道已死——立即隐藏
// 暂停/取消并给出强制恢复入口，不等 120s 停滞检测；拉起新恢复进程或终态落盘即退出。
//
// 落盘等待门（materialized）：发起运行 202 → 子进程写出 status.json 有 ~1s
// 窗口，期间 run 目录尚不存在——立即拉图会 404 黏住（无重试）、连 WS 会被
// 服务端拒连并永久停止重连。故落盘前只轮询 /status（404 静默），成功即放行
// WS 与图加载；120s 未落盘在错误区示错并挂 process.log（启动失败界面可见）。
// 自愈：WS 已连后图仍处失败态（如 translating 期 module_inputs 未归档的 404），
// phase 前进说明归档可能已写——按 phase 去抖各重拉一次 graph。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchControl,
  fetchGraph,
  fetchInputs,
  fetchModules,
  fetchProcess,
  fetchRunArtifacts,
  fetchStatus,
  postTerminate,
  TERMINAL_PHASES,
  type GraphPayload,
  type ModuleInfo,
  type RunArtifact,
  type StatusCore,
  type StatusResp,
} from "../api";
import { resolveInputSource, type TraceState } from "../lib/inputSource";
import { useRunStream } from "../ws";
import { ArtifactsStrip } from "./ArtifactsStrip";
import { GraphView } from "./GraphView";
import { NodePanel } from "./NodePanel";
import { RunControls } from "./RunControls";
import { Button } from "./ui/button";
import { Pill, type PillVariant } from "./ui/pill";
import { Spinner } from "./ui/spinner";

export interface ResumeRequestMsg {
  runId: string;
  seq: number;
}

/** 落盘等待上限：超过则示错（轮询不停止，落盘即自愈）。 */
const MATERIALIZE_TIMEOUT_MS = 120_000;

/** 终止后 /process 轮询报告 running=true 的容忍窗：盖住与 terminate POST 在飞竞态的陈旧样本。 */
const TERMINATE_GRACE_MS = 5_000;

/** phase → 胶囊变体（未知 phase 走 default 中性） */
const PHASE_PILL: Record<string, PillVariant> = {
  running: "running",
  done: "done",
  aborted: "failed",
  cancelled: "cancelled",
  truncated: "truncated",
};

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
  // 终止成功且 status 残留 running（本地瞬态；拉起新进程或 phase 离开 running 即退出）
  const [terminated, setTerminated] = useState(false);
  // control.json 有未消费的 cancel 请求（等 tick 边界）——初值取自 control 读取，控制动作后重取
  const [cancelRequested, setCancelRequested] = useState(false);
  // 终止失败信息（409：server 重启清过注册表 / 进程已自然退出）——此前静默吞掉，用户零感知
  const [terminateErr, setTerminateErr] = useState<string | null>(null);
  // 图加载失败区的 process.log 尾（CLI 启动期失败界面可见）
  const [procLog, setProcLog] = useState<string | null>(null);
  // 溯源状态（图上值卡 + 数据流虚线的唯一事实源）：null = 无
  const [trace, setTrace] = useState<TraceState | null>(null);
  // spec 存档缓存（溯源值卡正文）：随 run 拉一次；无存档（旧 run / 未归档）→ null 容忍
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  // 落盘等待门：false = run 尚未确认落盘（不连 WS、不拉图）
  const [materialized, setMaterialized] = useState(false);
  // 落盘等待超时示错（轮询不停止，落盘即自愈清零）
  const [materialTimeout, setMaterialTimeout] = useState(false);
  const lastMsgAtRef = useRef<number>(Date.now());
  const liveRef = useRef(false);
  // 终止点击时刻（竞态容忍窗基准）：terminate POST 与 3s 轮询在飞交错时，
  // 轮询可能带回 terminate 前采样的 running=true，把刚置位的已终止态立刻清掉
  const terminateAtRef = useRef<number>(0);
  // 落盘后才连 WS（run 不存在时服务端拒连 + 前端永久停连，不可逆）；
  // 终态回调刷新侧栏列表（列表不做周期轮询，事件钩子驱动）
  const streamState = useRunStream(materialized ? runId : null, onRefreshRuns);
  const stream = streamState?.msg ?? null;
  // 图失败自愈去抖：已重拉过的 phase（同一 phase 只重拉一次）
  const retriedPhaseRef = useRef<string | null>(null);

  // run 切换：清空全部派生状态（含 moduleOverride，避免上一个 run 的模块选择泄漏到下一个 run）
  useEffect(() => {
    setPayload(null);
    setSelected(null);
    setError(null);
    setInitialStatus(null);
    setModuleOverride(null);
    setTrace(null);
    setSpec(null);
    setPaused(false);
    setProcLog(null);
    setMaterialized(false);
    setMaterialTimeout(false);
    setTerminated(false);
    setCancelRequested(false);
    setTerminateErr(null);
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

  // 暂停状态初值（control.json；此后由 WS paused 增量驱动）——同样以落盘为门；
  // 同一次读取顺带取未消费的 cancel 请求（页面载入即有待消费取消的场景）
  useEffect(() => {
    if (!materialized) return;
    let cancelled = false;
    fetchControl(runId)
      .then((c) => {
        if (!cancelled) {
          setPaused(c.paused);
          setCancelRequested(c.control?.action === "cancel");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, materialized]);

  // spec 存档：落盘后拉一次（module_inputs 存档）；404/缺失静默 → null（值卡走无存档回退）
  useEffect(() => {
    if (!materialized) return;
    let cancelled = false;
    fetchInputs(runId)
      .then((d) => {
        if (!cancelled) setSpec(d.spec);
      })
      .catch(() => {
        if (!cancelled) setSpec(null);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, materialized]);

  // spec 缺档兜底：存档写入晚于 status.json（translating 期 404 窗口），点开 spec
  // 值卡时缓存仍为 null 则补拉一次；无存档 run（spec 恒 null）不形成重拉循环
  useEffect(() => {
    if (trace?.source.kind !== "spec" || spec != null) return;
    let cancelled = false;
    fetchInputs(runId)
      .then((d) => {
        if (!cancelled) setSpec(d.spec);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trace, spec, runId]);

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

  // WS 累计覆盖：每条 status 携带按节点累计 node_states（服务端按 firings 表
  // 全量重建，轮询跳拍/断线重连不丢完成态）——纯覆盖到 payload；
  // phase 到终态时仍重拉 /graph（快照/失败状态以库侧为准）
  useEffect(() => {
    // 陈旧流守卫：切 run 瞬间旧 run 的最后一条消息可能仍在 state（setState 批处理）
    if (!streamState || streamState.runId !== runId) return;
    const stream = streamState.msg;
    let cancelled = false;
    const ns = stream.node_states;
    const arts = stream.artifacts;
    if (ns || arts) {
      setPayload(
        (prev) =>
          prev && {
            ...prev,
            ...(ns ? { node_states: { ...prev.node_states, ...ns } } : {}),
            ...(arts ? { artifacts: arts } : {}),
          },
      );
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

  const nodeIds = useMemo(
    () => new Set(payload?.graph.nodes.map((n) => n.id) ?? []),
    [payload],
  );

  // 溯源上报：可定位输入胶囊 → 记录消费节点+字段+来源；再点同一胶囊收起。
  // 消费节点以当前选中节点为准（胶囊只存在于其面板中）。
  const handleTraceInput = useCallback(
    (field: string, value: string) => {
      if (!selected) return;
      const src = resolveInputSource(value, nodeIds);
      if (!src) return;
      setTrace((prev) =>
        prev && prev.consumerId === selected && prev.field === field
          ? null
          : { consumerId: selected, field, source: src },
      );
    },
    [selected, nodeIds],
  );

  // 切节点 / 点画布空白（selected 变化）→ 溯源归零（图上值卡与虚线随 trace 清除）
  useEffect(() => {
    setTrace(null);
  }, [selected]);

  const clearTrace = useCallback(() => setTrace(null), []);

  // 产物清单：终态（done/aborted/cancelled/truncated）拉取——终态翻转与
  // 终态 run 首载都经 phase 变化触发；非终态清空（resume 重跑后旧清单失效）
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);

  const statusView: StatusCore | null = stream ?? initialStatus;

  const runPhase = statusView?.phase ?? payload?.phase ?? null;
  // phase 离开 running（终态落盘/载入非 running run）→ 已终止态与取消待定态一并退场
  useEffect(() => {
    if (runPhase !== "running") {
      setTerminated(false);
      setCancelRequested(false);
      setTerminateErr(null);
    }
  }, [runPhase]);
  useEffect(() => {
    if (runPhase == null || !TERMINAL_PHASES.has(runPhase)) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    fetchRunArtifacts(runId)
      .then((d) => {
        if (!cancelled) setArtifacts(d.artifacts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, runPhase]);

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

  // ⑤ terminate 按钮：running 期间轮询 /process（只对本 server 拉起的恢复子进程可见），
  // 同节奏顺带重读 control.json 做控制面调和（侧栏发起的取消不经控制条，靠此收敛）
  useEffect(() => {
    if (statusView?.phase !== "running") {
      setProcRunning(false);
      return;
    }
    let cancelled = false;
    const poll = () => {
      fetchProcess(runId)
        .then((p) => {
          if (!cancelled) {
            setProcRunning(p.running);
            // 强制恢复已拉起新进程——退出已终止态；容忍窗内 ignore（与 terminate POST 在飞的陈旧样本）
            if (p.running && Date.now() - terminateAtRef.current > TERMINATE_GRACE_MS) {
              setTerminated(false);
            }
          }
        })
        .catch(() => {});
      // 控制面调和：取消也能从侧栏行内发起（不经控制条），轮询重读 control.json
      // 让取消待定态对一切写入方收敛（暂停覆盖 cancel 同样由此修正）
      fetchControl(runId)
        .then((c) => {
          if (!cancelled) {
            setPaused(c.paused);
            setCancelRequested(c.control?.action === "cancel");
          }
        })
        .catch(() => {});
    };
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
    // 容忍窗自点击起算：盖住 terminate POST 完成前后仍在飞的 /process 轮询陈旧样本
    terminateAtRef.current = Date.now();
    setTerminateErr(null);
    try {
      await postTerminate(runId);
      // 终止成功：进程已死而 status 残留 running——立即进入已终止态，不等 120s 停滞检测
      setTerminated(true);
    } catch (e) {
      // 409（server 重启清过注册表 / 进程已自然退出）不再静默——透出控制条错误位，
      // 否则按钮看似没按，用户只能等 120s 停滞检测
      setTerminateErr(`终止失败：${e instanceof Error ? e.message : String(e)}`);
    }
    onRefreshRuns();
  }, [runId, onRefreshRuns]);

  // 控制条动作成功：刷新列表 + 重读 control.json，让取消待定态跟着服务端真相走
  //（暂停会覆盖待消费的 cancel 请求，靠重读修正而非本地推演）
  const handleControlsAction = useCallback(() => {
    onRefreshRuns();
    fetchControl(runId)
      .then((c) => {
        setPaused(c.paused);
        setCancelRequested(c.control?.action === "cancel");
      })
      .catch(() => {});
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
  // 节点级运行态：run 在跑且（该节点正在流式输出，或在当前 fireable 执行集中）
  const nodeLive =
    statusView?.phase === "running" &&
    selectedNode != null &&
    (liveText != null || statusView.fireable.includes(selectedNode.id));
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
      <header className="flex items-center gap-3 border-b px-3.5 py-2 text-[12px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{runId}</span>
          {(statusView?.phase ?? payload?.phase) && (
            <Pill
              variant={PHASE_PILL[statusView?.phase ?? payload?.phase ?? ""] ?? "default"}
              className="shrink-0"
            >
              {statusView?.phase === "running" && (
                <Spinner className="h-2.5 w-2.5 border-[1.5px]" />
              )}
              {statusView?.phase ?? payload?.phase}
              {statusView?.tick != null ? ` · tick ${statusView.tick}` : ""}
            </Pill>
          )}
          {statusView?.error && (
            <span className="truncate" title={statusView.error}>
              {statusView.error}
            </span>
          )}
        </span>
        <RunControls
          key={runId}
          runId={runId}
          phase={statusView?.phase ?? payload?.phase ?? null}
          paused={paused}
          cancelRequested={cancelRequested}
          terminated={terminated}
          // 恢复对话框模块名预填：优先图载荷的已解析模块名（status.json 溯源 >
          // run_id 启发式的服务端解析结果），图未加载时退回模块选择器覆盖值——
          // 不能直接用 runId 预填，否则预检必然 module_unresolved
          moduleHint={payload?.module ?? moduleOverride}
          onAction={handleControlsAction}
          resumeRequest={resumeRequest}
          onResumeRequestConsumed={onResumeRequestConsumed}
          procRunning={procRunning}
          onTerminate={terminateProc}
          terminateError={terminateErr}
          onResumeStarted={() => setTerminated(false)}
        />
      </header>
      <ArtifactsStrip runId={runId} artifacts={artifacts} />
      {terminated && runPhase === "running" && (
        <div className="flex items-center gap-2.5 bg-[color-mix(in_srgb,var(--ph-truncated)_14%,transparent)] px-3.5 py-1.5 text-[12px] text-[var(--ph-truncated)]">
          <span>进程已终止，status 残留 running——可强制恢复。</span>
          <Button variant="outline" size="sm" onClick={() => onRequestResume(runId)}>
            打开恢复/回退…
          </Button>
        </div>
      )}
      {stalled && !terminated && (
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
            <div className="p-3 text-[12px] text-destructive">
              图加载失败：{error.message}
              {needModulePicker && (
                <div className="mt-2 flex items-center gap-2">
                  <select
                    onChange={(e) => setModuleOverride(e.target.value || null)}
                    defaultValue=""
                    className="rounded-control border border-input bg-transparent px-2 py-1 text-[12px]"
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
            <div className="p-3 text-[12px] text-[var(--ph-truncated)]">
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
              trace={trace}
              spec={spec}
              onClearTrace={clearTrace}
            />
          ) : (
            !error && !waitingMaterial && <div className="p-3 text-[12px]">图加载中…</div>
          )}
        </div>
        {payload && selected && selectedNode && (
          <NodePanel
            key={selectedNode.id}
            runId={runId}
            node={selectedNode}
            outputs={statusView?.outputs ?? {}}
            live={nodeLive}
            liveText={liveText}
            liveThinking={liveThinking}
            nodeIds={nodeIds}
            trace={trace}
            onTraceInput={handleTraceInput}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

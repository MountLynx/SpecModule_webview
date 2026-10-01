// 节点面板（右侧边栏，V2）：粘性状态头部（状态图标+节点名+状态·次数胶囊）+
// 输入标签胶囊（可定位引用可点溯源，hover 看完整 JSON）+ 共享思考块 + 状态色输出卡（运行中占位/
// 流式/终态三态 + 复制）+ 时间线式运行记录 + LLM 调用链（可变状态审计：prompt/原始输出/
// 用量/校验重试/多调用轨迹，终态回看）。与图区并排的全高侧栏。
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Copy, X } from "lucide-react";
import { fetchNodeState, fetchNodeTimeline, type GraphNode, type NodeStatePayload, type TimelineEntry } from "../api";
import { resolveInputSource, type TraceState } from "../lib/inputSource";
import { cn } from "../lib/utils";
import { ResizeHandle, useResizableWidth } from "./ResizeHandle";
import { ThinkBlock } from "./ThinkBlock";
import { Pill, pillVariants, type PillVariant } from "./ui/pill";
import { Spinner } from "./ui/spinner";

function pretty(v: unknown): string {
  if (v === undefined) return "（尚无输出）";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** usage dict → 单行摘要（"input_tokens 12 · total_tokens 34"）；空/非 dict → null。 */
function usageText(u: unknown): string | null {
  if (u == null || typeof u !== "object") return null;
  const parts = Object.entries(u as Record<string, unknown>).map(
    ([k, n]) => `${k} ${String(n)}`,
  );
  return parts.length ? parts.join(" · ") : null;
}

/** 审计长文本块（prompt/原始输出/校验轨迹全文）：折叠头 + 复制 + mono pre。 */
function ChainPre({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默
    }
  };
  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between">
        <button
          aria-expanded={open}
          className="flex items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          {label}
        </button>
        <button
          onClick={copy}
          title={`复制${label}`}
          className="flex items-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      {open && (
        <pre className="mb-0 mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-card p-2 font-mono text-[11px]">
          {text}
        </pre>
      )}
    </div>
  );
}

/** 「LLM 调用链」小节：多调用节点（repair/image）渲染 _llm_calls 条目列表，
 *  单调用渲染标准键（标准键是 last-call-wins，多调用时与条目重复故不重复渲染）。
 *  无任何审计键（非 LLM 节点的空状态）→ 整节不渲染。 */
function ChainSection({
  tick,
  value,
}: {
  tick: number | null;
  value: Record<string, unknown>;
}) {
  const calls = Array.isArray(value._llm_calls)
    ? (value._llm_calls as Record<string, unknown>[])
    : [];
  const err = typeof value._llm_error === "string" ? value._llm_error : null;
  const usage = usageText(value._usage);
  const hasStandardKeys =
    err != null ||
    usage != null ||
    typeof value._prompt === "string" ||
    typeof value._llm_raw === "string" ||
    typeof value._image_path === "string" ||
    value._validation_attempts != null ||
    value._validation_retry_errors != null;
  if (calls.length === 0 && !hasStandardKeys) return null;
  return (
    <section className="mt-4">
      <h4 className="mb-1.5 text-[12px] font-semibold">
        LLM 调用链
        {tick != null && (
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
            tick {tick}
          </span>
        )}
      </h4>
      {calls.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {calls.map((c, i) => {
            const u = usageText(c.usage);
            const cerr = typeof c.error === "string" ? c.error : null;
            const hasBody =
              typeof c.prompt === "string" ||
              typeof c.raw === "string" ||
              typeof c.image_path === "string";
            return (
              <div key={i} className="overflow-hidden rounded-control border border-border">
                <div className="flex items-center justify-between gap-2 border-b bg-secondary px-2.5 py-1 text-[11px]">
                  <span className="shrink-0 font-medium">调用 {i + 1}</span>
                  {cerr ? (
                    <span className="truncate text-[var(--ph-aborted)]">{cerr}</span>
                  ) : u ? (
                    <span className="truncate text-muted-foreground">{u}</span>
                  ) : null}
                </div>
                <div className="px-2.5 py-1">
                  {typeof c.image_path === "string" && (
                    <div className="mb-0.5 break-all font-mono text-[11px] text-muted-foreground">
                      图像 {c.image_path}
                    </div>
                  )}
                  {typeof c.prompt === "string" && <ChainPre label="Prompt" text={c.prompt} />}
                  {typeof c.raw === "string" && <ChainPre label="原始输出" text={c.raw} />}
                  {!hasBody && (
                    <div className="py-0.5 text-[11px] text-muted-foreground">（无审计数据）</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {err && <div className="mt-1 text-[11px] text-[var(--ph-aborted)]">{err}</div>}
          {typeof value._prompt === "string" && <ChainPre label="Prompt" text={value._prompt} />}
          {typeof value._llm_raw === "string" && (
            <ChainPre label="原始输出" text={value._llm_raw} />
          )}
          {usage && <div className="mt-1.5 text-[11px] text-muted-foreground">{usage}</div>}
          {value._validation_attempts != null && (
            <ChainPre label="校验尝试" text={pretty(value._validation_attempts)} />
          )}
          {value._validation_retry_errors != null && (
            <ChainPre label="校验重试错误" text={pretty(value._validation_retry_errors)} />
          )}
          {typeof value._image_path === "string" && (
            <div className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
              图像 {value._image_path}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 面板级状态：running（live）> 最新 firing 失败 > 有输出 done > idle */
function panelBadge(
  live: boolean,
  latest: unknown,
  lastEntry: TimelineEntry | undefined,
): { variant: PillVariant; label: string } {
  if (live) return { variant: "running", label: "运行中" };
  if (lastEntry && lastEntry.status !== "ok")
    return { variant: "failed", label: lastEntry.status === "aborted" ? "中止" : "失败" };
  if (latest !== undefined) return { variant: "done", label: "已完成" };
  return { variant: "default", label: "未执行" };
}

export function NodePanel({
  runId,
  node,
  outputs,
  live,
  liveText,
  liveThinking,
  nodeIds,
  trace,
  onTraceInput,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点正在执行（run 运行中且该节点在流式或 fireable 执行集）——输出卡占位态判断用 */
  live: boolean;
  /** 该节点当前执行的流式文本（终态后由 outputs 接管） */
  liveText?: string;
  /** 该节点当前执行的思考文本（正文 token 到达后自动收起） */
  liveThinking?: string;
  /** 当前图全部节点 id（输入引用来源判定用） */
  nodeIds: Set<string>;
  /** 当前溯源态（null = 无）；来源胶囊 emphasis 依据 */
  trace: TraceState | null;
  /** 点可定位输入胶囊上报（RunView 持有溯源状态） */
  onTraceInput: (field: string, value: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // copied 复位定时器：连点去重 + 卸载清理
  const copyTimerRef = useRef<number | null>(null);
  // 右侧栏拖宽（持久化，节点切换重挂载后仍恢复；双击手柄复位）
  const bar = useResizableWidth({
    storageKey: "specmodule-webview.sidebar.right",
    initial: 380, min: 260, max: 720, side: "right",
  });
  // 思考块展开态：null = 自动（思考中展开、正文到达收起）；用户点击后以手动为准
  const [thinkExpand, setThinkExpand] = useState<boolean | null>(null);
  const thinkAuto = !liveText;
  const thinkShown = liveThinking && (thinkExpand ?? thinkAuto);

  // 双 ref 各挂各的滚动容器：滚动 effect 按生效显示对象选择目标——无思考 run
  // （thinkShown 恒 falsy）跟随正文尾部；手动展开思考时跟随思考尾部。
  const thinkRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = thinkShown ? thinkRef.current : textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveText, liveThinking, thinkShown]);

  // timeline 拉取：挂载 + live 翻转（run 终态）各拉一次——终态后徽章/×N 随之刷新；
  // 不清空旧 entries（key 重挂载已保证初始干净，翻转时清空会闪一下空白）
  useEffect(() => {
    let cancelled = false;
    fetchNodeTimeline(runId, node.id)
      .then((t) => { if (!cancelled) setEntries(t.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runId, node.id, live]);

  // LLM 链拉取：同 timeline 时点（挂载/节点切换/live 翻转），不轮询——直播由
  // 流式缓冲承担，本节定位终态回看（运行中取到当次调用中间态，照实渲染）。
  // 拉取前先清：节点切换瞬间不能残留上一节点的链（混串是误导，不同于 timeline）
  const [chain, setChain] = useState<NodeStatePayload | null>(null);
  useEffect(() => {
    let cancelled = false;
    setChain(null);
    fetchNodeState(runId, node.id)
      .then((c) => { if (!cancelled) setChain(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runId, node.id, live]);

  useEffect(() => () => { if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current); }, []);

  const latest = outputs[node.id];
  const lastEntry = entries.length ? entries[entries.length - 1] : undefined;
  const badge = panelBadge(live, latest, lastEntry);
  // 终态输出卡配色：失败红系，done 绿系，未执行中性
  const terminalTint =
    badge.variant === "failed"
      ? {
          border: "border-[var(--ph-aborted-border)]",
          head: "border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)] text-[var(--ph-aborted-text)]",
        }
      : badge.variant === "done"
        ? {
            border: "border-[var(--ph-done-border)]",
            head: "border-[var(--ph-done-border)] bg-[var(--ph-done-bg)] text-[var(--ph-done-text)]",
          }
        : {
            border: "border-border",
            head: "border-border bg-secondary text-muted-foreground",
          };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pretty(latest));
      setCopied(true);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默
    }
  };

  return (
    <>
      <ResizeHandle dragging={bar.dragging} {...bar.handleProps} />
      <aside
        className="flex shrink-0 flex-col overflow-y-auto border-l bg-sidebar"
        style={{ width: bar.width }}
      >
        {/* 粘性状态头部 */}
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-sidebar px-3.5 py-2.5">
          {badge.variant === "running" ? (
            <Spinner />
          ) : badge.variant === "done" ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ph-done)]" strokeWidth={3} />
          ) : badge.variant === "failed" ? (
            <X className="h-3.5 w-3.5 shrink-0 text-[var(--ph-aborted)]" strokeWidth={3} />
          ) : (
            <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          )}
          <div className="m-0 flex min-w-0 flex-1 items-baseline gap-1.5">
            <h3 className="m-0 truncate text-[13px] font-bold">{node.id}</h3>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {node.type}
              {node.is_start ? " · start" : ""}
            </span>
          </div>
          <Pill variant={badge.variant} className="shrink-0">
            {badge.label}
            {entries.length > 0 && ` · ×${entries.length}`}
          </Pill>
          <button
            aria-label="关闭面板"
            className="rounded-[5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="px-3.5 pb-3.5 text-[12px]">
          {/* 输入行：「输入」前缀标签 + 键名胶囊。可定位引用（{spec.key} / 裸节点名）
              可点——上报溯源（镜头飞消费节点 + 图上值卡，强调态跟随 trace，再点同一
              胶囊收起）；「其他」类值为普通胶囊不可点（hover 见完整 JSON）。
              侧栏内联「输入值」卡片已删除（图上值卡承载，避免重复）。
              节点类型已上移至头部名字旁，无输入键的节点整行不渲染 */}
          {Object.keys(node.inputs ?? {}).length > 0 && (
            <div
              className="mt-2.5 flex flex-wrap items-center gap-1"
              title={JSON.stringify(node.inputs)}
            >
              <span className="mr-0.5 text-[11px] text-muted-foreground">输入</span>
              {Object.keys(node.inputs ?? {}).map((k) => {
                const src = resolveInputSource(node.inputs[k], nodeIds);
                const active = trace != null && trace.consumerId === node.id && trace.field === k;
                return src ? (
                  <button
                    key={k}
                    aria-pressed={active}
                    title={`定位输入 ${k}`}
                    className={cn(
                      pillVariants({ variant: active ? "emphasis" : "default" }),
                      "cursor-pointer font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                    onClick={() => onTraceInput(k, node.inputs[k])}
                  >
                    {k}
                  </button>
                ) : (
                  <Pill key={k} variant="default" className="font-mono">
                    {k}
                  </Pill>
                );
              })}
            </div>
          )}

          {/* 思考块（与 chat 同源组件） */}
          {liveThinking ? (
            <section className="mt-3">
              <button
                aria-expanded={Boolean(thinkShown)}
                className="flex items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setThinkExpand(!(thinkExpand ?? thinkAuto))}
              >
                {thinkShown ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                {liveText ? `已思考 ${liveThinking.length} 字` : "思考中…"}
              </button>
              {thinkShown ? (
                <ThinkBlock ref={thinkRef} text={liveThinking.slice(-6000)} className="mt-1" />
              ) : null}
            </section>
          ) : null}

          {/* 最新输出卡：占位（运行中无流）/ 流式 / 终态 三态 */}
          <section className="mt-3">
            <h4 className="mb-1.5 text-[12px] font-semibold">最新输出</h4>
            {live && liveText == null ? (
              <div className="flex items-center gap-2 rounded-control border border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] px-2.5 py-2 text-[12px] text-[var(--ph-running-text)]">
                <Spinner />
                {node.type === "script" ? "脚本执行中…" : "运行中…"}
              </div>
            ) : liveText != null ? (
              <div className="overflow-hidden rounded-control border border-[var(--ph-running-border)]">
                <div className="flex items-center justify-between border-b border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] px-2.5 py-1 text-[11px] text-[var(--ph-running-text)]">
                  <span>输出 · 流式</span>
                  <Spinner className="h-2.5 w-2.5 border-[1.5px]" />
                </div>
                <div
                  ref={textRef}
                  className="max-h-[240px] overflow-y-auto whitespace-pre-wrap p-2 font-mono text-[11px]"
                >
                  {liveText.slice(-10000)}
                </div>
              </div>
            ) : (
              <div className={`overflow-hidden rounded-control border ${terminalTint.border}`}>
                <div
                  className={`flex items-center justify-between border-b px-2.5 py-1 text-[11px] ${terminalTint.head}`}
                >
                  <span>输出 · 终态</span>
                  <button
                    onClick={copy}
                    title="复制输出"
                    className="flex items-center gap-1 hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <div className="max-h-[240px] overflow-y-auto whitespace-pre-wrap p-2 font-mono text-[11px]">
                  {pretty(latest)}
                </div>
              </div>
            )}
          </section>

          {/* 运行记录：竖向时间线 */}
          <section className="mt-4">
            <h4 className="mb-1.5 text-[12px] font-semibold">运行记录（{entries.length} 次）</h4>
            {entries.length ? (
              <div className="relative ml-1.5 border-l border-border pl-3.5">
                {entries
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div key={e.tick} className="relative py-1.5">
                      <span
                        className={cn(
                          "absolute -left-[18px] top-[11px] h-2 w-2 rounded-full border-2 border-sidebar",
                          e.status === "ok" ? "bg-[var(--ph-done)]" : "bg-[var(--ph-aborted)]",
                        )}
                      />
                      <div
                        className="flex cursor-pointer items-center justify-between"
                        onClick={() => setOpenTick(openTick === e.tick ? null : e.tick)}
                      >
                        <span>tick {e.tick}</span>
                        <span
                          className={
                            e.status === "ok"
                              ? "text-[var(--ph-done)]"
                              : "text-[var(--ph-aborted)]"
                          }
                        >
                          {e.status}
                        </span>
                      </div>
                      {e.error && openTick !== e.tick && (
                        <div className="mt-0.5 text-[11px] text-[var(--ph-aborted)]">{e.error}</div>
                      )}
                      {openTick === e.tick && (
                        <pre className="mb-0 mt-1.5 whitespace-pre-wrap rounded-md border bg-card p-2 font-mono text-[11px]">
                          {pretty(e.output)}
                          {e.error ? `\nerror: ${e.error}` : ""}
                        </pre>
                      )}
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">尚无执行记录</div>
            )}
          </section>

          {/* LLM 调用链：有可变状态数据才渲染（非 LLM 节点零噪音） */}
          {chain?.found && chain.value && (
            <ChainSection tick={chain.tick} value={chain.value} />
          )}
        </div>
      </aside>
    </>
  );
}

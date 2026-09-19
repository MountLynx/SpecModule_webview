// 节点面板（右侧边栏，V2）：粘性状态头部（状态图标+节点名+状态·次数胶囊）+
// 输入标签胶囊（hover 看完整 JSON）+ 共享思考块 + 状态色输出卡（运行中占位/
// 流式/终态三态 + 复制）+ 时间线式运行记录。与图区并排的全高侧栏。
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Copy, X } from "lucide-react";
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";
import { cn } from "../lib/utils";
import { ResizeHandle, useResizableWidth } from "./ResizeHandle";
import { ThinkBlock } from "./ThinkBlock";
import { Pill, pillVariants, type PillVariant } from "./ui/pill";
import { Spinner } from "./ui/spinner";

function pretty(v: unknown): string {
  if (v === undefined) return "（尚无输出）";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
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
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // 展开显示值卡的输入键（null = 无；节点切换随 key 重挂载自动复位）
  const [openInput, setOpenInput] = useState<string | null>(null);
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
          <h3 className="m-0 flex-1 truncate text-[13px] font-bold">{node.id}</h3>
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
          {/* 输入：类型/起始为静态胶囊；键名胶囊可点——展开该输入的值卡片，
              激活键名胶囊 primary 反色强调，再点收起（整组 hover 仍显示完整 JSON） */}
          <div className="mt-2.5 flex flex-wrap gap-1" title={JSON.stringify(node.inputs)}>
            <Pill className="font-mono">
              {node.type}
              {node.is_start ? " · start" : ""}
            </Pill>
            {Object.keys(node.inputs ?? {}).map((k) => (
              <button
                key={k}
                aria-expanded={openInput === k}
                title={`查看输入 ${k}`}
                className={cn(
                  pillVariants({ variant: openInput === k ? "emphasis" : "default" }),
                  "cursor-pointer font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
                onClick={() => setOpenInput(openInput === k ? null : k)}
              >
                {k}
              </button>
            ))}
          </div>
          {openInput != null && node.inputs?.[openInput] !== undefined && (
            <div className="mt-2 overflow-hidden rounded-control border border-border">
              <div className="flex items-center justify-between border-b border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground">
                <span className="font-mono">{openInput}</span>
                <span>输入值</span>
              </div>
              <div className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">
                {String(node.inputs[openInput])}
              </div>
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
        </div>
      </aside>
    </>
  );
}

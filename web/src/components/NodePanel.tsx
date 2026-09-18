// 节点面板（右侧边栏）：元信息 + 最新输出（实时）+ firing 历史（点击展开全文）+
// 实时流文本。与图区并排的全高侧栏。
import { useEffect, useRef, useState } from "react";
import { fetchNodeTimeline, type GraphNode, type TimelineEntry } from "../api";

function pretty(v: unknown): string {
  if (v === undefined) return "（尚无输出）";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function NodePanel({
  runId,
  node,
  outputs,
  liveText,
  liveThinking,
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点当前执行的流式文本（phase=running 且有 token 时非空；终态后由 outputs 接管） */
  liveText?: string;
  /** 该节点当前执行的思考文本（reasoning 通道；正文 token 到达后自动收起） */
  liveThinking?: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);
  // 思考块展开态：null = 自动（思考中展开、正文到达收起）；用户点击后以手动为准
  const [thinkExpand, setThinkExpand] = useState<boolean | null>(null);
  const thinkAuto = !liveText;
  const thinkShown = liveThinking && (thinkExpand ?? thinkAuto);

  // 双 ref 各挂各的 pre：滚动 effect 按生效显示对象选择目标——无思考 run（thinkShown
  // 恒 falsy）跟随正文尾部；手动展开思考时跟随思考尾部。
  const thinkRef = useRef<HTMLPreElement | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = thinkShown ? thinkRef.current : textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveText, liveThinking, thinkShown]);

  useEffect(() => {
    setEntries([]);
    setOpenTick(null);
    let cancelled = false;
    fetchNodeTimeline(runId, node.id)
      .then((t) => { if (!cancelled) setEntries(t.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runId, node.id]);

  const latest = outputs[node.id];

  return (
    <aside className="w-[380px] shrink-0 overflow-y-auto border-l bg-sidebar">
      <header className="flex items-center justify-between px-3.5 py-2.5">
        <h3 className="m-0 text-[13px] font-bold">{node.id}</h3>
        <button
          aria-label="关闭面板"
          className="rounded-[5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="px-3.5 pb-3.5 text-[11.5px]">
        <p className="m-0 text-muted-foreground">
          类型 {node.type}
          {node.is_start ? " · start" : ""} · 输入 {JSON.stringify(node.inputs)}
        </p>
        {liveText || liveThinking ? (
          <section>
            <h4 className="mb-1.5 mt-3 text-[12px] font-semibold">
              实时输出<span className="text-[11px] font-normal text-[var(--ph-running)]">（流式）</span>
            </h4>
            {liveThinking ? (
              <div className="mb-1.5">
                <button
                  aria-expanded={Boolean(thinkShown)}
                  className="text-left text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setThinkExpand(!(thinkExpand ?? thinkAuto))}
                >
                  {liveText
                    ? `${thinkShown ? "▼" : "▶"} 已思考 ${liveThinking.length} 字`
                    : thinkShown
                      ? "▼ 思考中…"
                      : "▶ 思考中…"}
                </button>
                {thinkShown ? (
                  <pre
                    ref={thinkRef}
                    className="m-0 mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-md border border-dashed bg-card p-2 text-[11.5px] italic text-muted-foreground"
                  >
                    {liveThinking.slice(-6000)}
                  </pre>
                ) : null}
              </div>
            ) : null}
            {liveText ? (
              <pre
                ref={textRef}
                className="m-0 max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]"
              >
                {liveText.slice(-10000)}
              </pre>
            ) : null}
          </section>
        ) : null}
        <section>
          <h4 className="mb-1.5 mt-3 text-[12px] font-semibold">最新输出（实时）</h4>
          <pre className="m-0 whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]">
            {pretty(latest)}
          </pre>
        </section>
        <section>
          <h4 className="mb-1.5 mt-4 text-[12px] font-semibold">运行记录（{entries.length} 次）</h4>
          {entries
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.tick} className="border-b py-1.5">
                <div
                  className="flex cursor-pointer items-center justify-between"
                  onClick={() => setOpenTick(openTick === e.tick ? null : e.tick)}
                >
                  <span>tick {e.tick}</span>
                  <span className={e.status === "ok" ? "text-[var(--ph-done)]" : "text-[var(--ph-aborted)]"}>
                    {e.status}
                  </span>
                </div>
                {e.error && openTick !== e.tick && (
                  <div className="mt-0.5 text-[11.5px] text-[var(--ph-aborted)]">{e.error}</div>
                )}
                {openTick === e.tick && (
                  <pre className="mb-0 mt-1.5 whitespace-pre-wrap rounded-md border bg-card p-2 text-[11.5px]">
                    {pretty(e.output)}
                    {e.error ? `\nerror: ${e.error}` : ""}
                  </pre>
                )}
              </div>
            ))}
        </section>
      </div>
    </aside>
  );
}

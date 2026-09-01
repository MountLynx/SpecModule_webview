// web/src/components/NodePanel.tsx
// 节点面板：元信息 + 最新输出（实时）+ firing 历史（点击展开全文）。
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
  onClose,
}: {
  runId: string;
  node: GraphNode;
  outputs: Record<string, unknown>;
  /** 该节点当前执行的流式文本（phase=running 且有 token 时非空；终态后由 outputs 接管） */
  liveText?: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [openTick, setOpenTick] = useState<number | null>(null);

  const liveRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [liveText]);

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
    <aside
      style={{
        width: 380,
        flexShrink: 0,
        borderLeft: "1px solid #e5e7eb",
        overflowY: "auto",
        padding: 12,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{node.id}</h3>
        <button onClick={onClose}>×</button>
      </header>
      <p style={{ color: "#6b7280", fontSize: 12 }}>
        类型 {node.type}
        {node.is_start ? " · start" : ""} · 输入 {JSON.stringify(node.inputs)}
      </p>
      {liveText ? (
        <section>
          <h4 style={{ margin: "12px 0 6px" }}>
            实时输出<span style={{ color: "#2563eb", fontSize: 11 }}>（流式）</span>
          </h4>
          <pre
            ref={liveRef}
            style={{
              background: "#eff6ff",
              padding: 8,
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              margin: 0,
              maxHeight: 240,
              overflowY: "auto",
            }}
          >
            {liveText.slice(-10000)}
          </pre>
        </section>
      ) : null}
      <section>
        <h4 style={{ margin: "12px 0 6px" }}>最新输出（实时）</h4>
        <pre
          style={{
            background: "#f9fafb",
            padding: 8,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            margin: 0,
          }}
        >
          {pretty(latest)}
        </pre>
      </section>
      <section>
        <h4 style={{ margin: "16px 0 6px" }}>运行记录（{entries.length} 次）</h4>
        {entries
          .slice()
          .reverse()
          .map((e) => (
            <div key={e.tick} style={{ borderBottom: "1px solid #f3f4f6", padding: "6px 0" }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }}
                onClick={() => setOpenTick(openTick === e.tick ? null : e.tick)}
              >
                <span>tick {e.tick}</span>
                <span style={{ color: e.status === "ok" ? "#16a34a" : "#dc2626" }}>
                  {e.status}
                </span>
              </div>
              {e.error && openTick !== e.tick && (
                <div style={{ fontSize: 12, color: "#dc2626" }}>{e.error}</div>
              )}
              {openTick === e.tick && (
                <pre
                  style={{
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    background: "#f9fafb",
                    padding: 8,
                    margin: "6px 0 0",
                  }}
                >
                  {pretty(e.output)}
                  {e.error ? `\nerror: ${e.error}` : ""}
                </pre>
              )}
            </div>
          ))}
      </section>
    </aside>
  );
}

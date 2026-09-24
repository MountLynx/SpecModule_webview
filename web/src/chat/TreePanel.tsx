import { GitFork, Layers, Plus, X } from "lucide-react";
import { useMemo } from "react";
import type { Card, ConvState } from "./types";
import { LANE_W, layoutTree, X0, DOT_R, ROW_H } from "./treelayout";
import { cn, oneLine } from "../lib/utils";
import { Button } from "../components/ui/button";

interface Props {
  conv: ConvState | null;
  /** 行点击 = 导航：指针挪到该轮 + 主区跳转聚焦 */
  onNavigate: (seq: number) => void;
  cardSeqs: number[];
  onToggleCardSeq: (seq: number) => void;
  onGenerateCard: () => void;
}

/** 对话树面板：页签配套功能——绑定当前激活 chat 页签；无激活会话时空态引导。
 *  树图 = 全量分支索引，点击即导航（指针挪到该轮并跳转对话）；高亮行 = 指针行。 */
export function TreePanel(p: Props) {
  if (!p.conv)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-muted-foreground">
        <GitFork className="h-8 w-8 text-muted-foreground/40" />
        <div className="text-[13px]">未激活对话页签</div>
        <div className="text-[12px] opacity-70">从「对话」打开一个会话后，这里显示它的对话树</div>
      </div>
    );
  return <TreePanelInner {...p} conv={p.conv} />;
}

function TreePanelInner(p: Props & { conv: ConvState }) {
  const layout = useMemo(() => layoutTree(p.conv.nodes), [p.conv.nodes]);
  const cardsBySeq = useMemo(() => {
    const m = new Map<number, Card[]>();
    for (const c of p.conv.cards)
      for (const s of c.fromPath) m.set(s, [...(m.get(s) ?? []), c]);
    return m;
  }, [p.conv.cards]);
  const nodeBySeq = useMemo(() => new Map(p.conv.nodes.map((n) => [n.seq, n])), [p.conv.nodes]);
  const graphW = X0 * 2 + (layout.laneCount - 1) * LANE_W;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3">
        <GitFork className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground">对话树</span>
        <span className="truncate text-[12px] text-muted-foreground">{p.conv.name}</span>
      </div>
      {/* 图例 */}
      <div className="flex items-center gap-3 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-primary" /> 指针
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rotate-45 bg-primary/40" /> 主干末端
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full border border-dashed border-muted-foreground" /> 新起点
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {p.conv.nodes.length === 0 ? (
          <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">（空会话）</div>
        ) : (
          <div className="relative" style={{ height: layout.height }}>
            {/* SVG 层：连线 + 节点圆点 */}
            <svg className="pointer-events-none absolute inset-0" width={graphW + 40} height={layout.height}>
              {layout.edges.map((e, i) =>
                e.curve ? (
                  <path
                    key={i}
                    d={`M ${e.from.x} ${e.from.y} C ${e.from.x} ${e.ctrl}, ${e.to.x} ${e.ctrl}, ${e.to.x} ${e.to.y}`}
                    fill="none"
                    stroke="hsl(var(--muted-foreground))"
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                  />
                ) : (
                  <line
                    key={i}
                    x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}
                    stroke="hsl(var(--muted-foreground))"
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                  />
                ),
              )}
              {layout.nodes.map((pos) => {
                const node = nodeBySeq.get(pos.seq)!;
                const isPointer = pos.seq === p.conv.pointer;
                const isTrunkEnd = pos.seq === p.conv.trunkEnd;
                const isLeafStart = node.parent === null && pos.seq !== layout.nodes[0].seq;
                const pending = node.output === null;
                return (
                  <g key={pos.seq}>
                    {isTrunkEnd && (
                      <rect
                        x={pos.x - DOT_R - 2.5} y={pos.y - DOT_R - 2.5}
                        width={(DOT_R + 2.5) * 2} height={(DOT_R + 2.5) * 2}
                        rx={2} transform={`rotate(45 ${pos.x} ${pos.y})`}
                        fill="none" stroke="hsl(var(--primary) / 0.4)" strokeWidth={1.2}
                      />
                    )}
                    <circle
                      cx={pos.x} cy={pos.y} r={DOT_R}
                      fill={pending ? "hsl(var(--card))" : "hsl(var(--primary))"}
                      stroke="hsl(var(--primary))"
                      strokeWidth={pending ? 1.5 : 0}
                      opacity={pending ? 0.9 : 1}
                    />
                    {isLeafStart && (
                      <circle cx={pos.x} cy={pos.y} r={DOT_R + 3} fill="none"
                              stroke="hsl(var(--muted-foreground))" strokeDasharray="2 2" strokeWidth={1} />
                    )}
                    {isPointer && (
                      <circle cx={pos.x} cy={pos.y} r={DOT_R + 4.5} fill="none"
                              stroke="hsl(var(--primary))" strokeWidth={1.5} />
                    )}
                  </g>
                );
              })}
            </svg>
            {/* HTML 行层：标签 + 文本摘要（点行即导航） */}
            {layout.nodes.map((pos) => {
              const node = nodeBySeq.get(pos.seq)!;
              const cards = cardsBySeq.get(pos.seq) ?? [];
              const isPointer = pos.seq === p.conv.pointer;
              return (
                <div
                  key={pos.seq}
                  onClick={() => p.onNavigate(pos.seq)}
                  title="点击跳转到该轮所在分支对话"
                  className={cn(
                    "absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-[12px] hover:bg-foreground/[0.04]",
                    isPointer && "bg-foreground/[0.06]",
                  )}
                  style={{ top: pos.y - ROW_H / 2, height: ROW_H, paddingLeft: layout.gutter }}
                >
                  <span className="font-mono text-[11px] text-muted-foreground">#{pos.seq}</span>
                  {node.label && (
                    <span className="max-w-[45%] truncate rounded-full bg-primary/10 px-1.5 py-px text-[11px] text-foreground">
                      {node.label}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground/90">
                    {oneLine(node.input, 48)}
                  </span>
                  {node.output === null && (
                    <span className="shrink-0 rounded-full border border-dashed border-muted-foreground/60 px-1.5 py-px text-[11px] text-muted-foreground">
                      待答
                    </span>
                  )}
                  {cards.map((c) => (
                    <span key={c.id} title={`${c.id} · ${c.title}`}
                          className="shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">
                      [{c.id.replace("card_", "c_")}]
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 卡片提炼范围条（聊天气泡轮末操作条选点 → 自定义范围生成卡片） */}
      {p.cardSeqs.length > 0 && (
        <div className="mx-2 mb-2 flex items-center gap-1.5 rounded-panel border border-primary/40 bg-primary/[0.06] px-2.5 py-1.5 text-[12px]">
          <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="shrink-0 text-muted-foreground">卡片范围</span>
          <div className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {p.cardSeqs.map((s) => `#${s}`).join(" ")}
          </div>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" title="清除范围"
                  onClick={() => p.cardSeqs.forEach((s) => p.onToggleCardSeq(s))}>
            <X className="h-3 w-3" />
          </Button>
          <Button size="sm" className="h-6 px-2 text-[12px]" onClick={p.onGenerateCard}>
            <Plus className="h-3 w-3" /> 生成卡片
          </Button>
        </div>
      )}
    </div>
  );
}

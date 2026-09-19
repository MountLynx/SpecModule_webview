import { GitFork, Layers, Pencil, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Card, ConvState, Node } from "./types";
import { LANE_W, layoutTree, X0, DOT_R, ROW_H } from "./treelayout";
import { cn, oneLine } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog";

interface Props {
  conv: ConvState | null;
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
  onRenameNode: (seq: number, label: string) => Promise<void>;
  onBranchFrom: (seq: number) => void;
  cardSeqs: number[];
  onToggleCardSeq: (seq: number) => void;
  onGenerateCard: () => void;
}

/** 对话树面板：页签配套功能——绑定当前激活 chat 页签；无激活会话时空态引导 */
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
  const [renameTarget, setRenameTarget] = useState<Node | null>(null);
  const cardsBySeq = useMemo(() => {
    const m = new Map<number, Card[]>();
    for (const c of p.conv.cards)
      for (const s of c.fromPath) m.set(s, [...(m.get(s) ?? []), c]);
    return m;
  }, [p.conv.cards]);
  const nodeBySeq = useMemo(() => new Map(p.conv.nodes.map((n) => [n.seq, n])), [p.conv.nodes]);
  const selected = p.selectedSeq !== null ? nodeBySeq.get(p.selectedSeq) ?? null : null;
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
          <span className="inline-block h-2 w-2 rounded-full border border-dashed border-muted-foreground" /> 叶子
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
                    d={`M ${e.from.x} ${e.from.y} C ${e.from.x} ${(e.from.y + e.to.y) / 2}, ${e.to.x} ${(e.from.y + e.to.y) / 2}, ${e.to.x} ${e.to.y}`}
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
                      fill={
                        node.role === "user" ? "hsl(var(--primary))"
                          : "hsl(var(--card))"
                      }
                      stroke="hsl(var(--primary))"
                      strokeWidth={node.role === "user" ? 0 : 1.5}
                      opacity={node.role === "assistant" ? 0.85 : 1}
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
            {/* HTML 行层：标签 + 文本摘要（叶子/命名放对应节点旁） */}
            {layout.nodes.map((pos) => {
              const node = nodeBySeq.get(pos.seq)!;
              const cards = cardsBySeq.get(pos.seq) ?? [];
              return (
                <div
                  key={pos.seq}
                  onClick={() => p.onSelect(pos.seq)}
                  className={cn(
                    "absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-[12px] hover:bg-foreground/[0.04]",
                    p.selectedSeq === pos.seq && "bg-foreground/[0.06]",
                  )}
                  style={{ top: pos.row * ROW_H, height: ROW_H, paddingLeft: pos.x + DOT_R + 8 }}
                >
                  <span className="font-mono text-[11px] text-muted-foreground">#{pos.seq}</span>
                  {node.label && (
                    <span className="max-w-[45%] truncate rounded-full bg-primary/10 px-1.5 py-px text-[11px] text-foreground">
                      {node.label}
                    </span>
                  )}
                  <span className={cn("min-w-0 flex-1 truncate", node.role === "user" ? "text-foreground/90" : "text-muted-foreground")}>
                    {oneLine(node.text, 48)}
                  </span>
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

      {/* 卡片提炼范围条（树图选点 → 自定义范围生成卡片） */}
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

      {/* 选中节点详情 */}
      {selected && (
        <div className="mx-2 mb-2 rounded-panel border bg-card p-2.5">
          <div className="flex items-center gap-1.5 pb-1.5">
            <span className="font-mono text-[11px] text-muted-foreground">#{selected.seq}</span>
            <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[11px]">
              {selected.role === "user" ? "用户" : "助手"}
            </span>
            {selected.model && (
              <span className="truncate text-[11px] text-muted-foreground">{selected.model}</span>
            )}
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setRenameTarget(selected)}>
                <Pencil className="h-3 w-3" /> 命名
              </Button>
              <Button variant="ghost" size="sm"
                      className={cn(p.cardSeqs.includes(selected.seq) && "text-primary")}
                      onClick={() => p.onToggleCardSeq(selected.seq)}>
                <Layers className="h-3 w-3" />
                {p.cardSeqs.includes(selected.seq) ? "移出卡片范围" : "选入卡片范围"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => p.onBranchFrom(selected.seq)}>
                <GitFork className="h-3 w-3" /> 从此分支
              </Button>
            </div>
          </div>
          <div className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-6 text-foreground/85">
            {selected.text}
          </div>
        </div>
      )}

      {/* 节点命名对话框 */}
      <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent>
          <DialogTitle>
            <Pencil className="mr-1 inline h-4 w-4" /> 命名节点 #{renameTarget?.seq}
          </DialogTitle>
          {renameTarget && (
            <NodeRenameForm
              initial={renameTarget.label}
              onSubmit={async (v) => {
                await p.onRenameNode(renameTarget.seq, v);
                setRenameTarget(null);
              }}
              onCancel={() => setRenameTarget(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NodeRenameForm(p: { initial: string; onSubmit: (v: string) => Promise<void>; onCancel: () => void }) {
  const [v, setV] = useState(p.initial);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Input autoFocus value={v} placeholder="节点名称（留空 = 清除）"
             onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
      <DialogFooter>
        <Button variant="outline" onClick={p.onCancel}>取消</Button>
        <Button disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try { await p.onSubmit(v.trim()); } finally { setBusy(false); }
                }}>
          保存
        </Button>
      </DialogFooter>
    </>
  );
}

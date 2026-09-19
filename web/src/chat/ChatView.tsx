import { useEffect, useRef } from "react";
import type { Card, ConvState, Node, RunTrace } from "./types";
import { activePath } from "./types";
import { cn } from "../lib/utils";
import { Markdown } from "./Markdown";
import { Check, Circle, FileText, X } from "lucide-react";
import { ThinkBlock } from "../components/ThinkBlock";

interface Props {
  conv: ConvState;
  busy: boolean;
  error: string | null;
  run: RunTrace | null;
  onRetry: () => void;
  onOpenCards: () => void;
}

/** 主区聊天视图：活跃路径（path_to 指针）消息流 */
export function ChatView(p: Props) {
  const conv = p.conv;
  const path = activePath(conv);
  const cardsBySeq = new Map<number, Card[]>();
  for (const c of conv.cards)
    for (const s of c.fromPath) cardsBySeq.set(s, [...(cardsBySeq.get(s) ?? []), c]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [path.length, p.busy]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
        {path.length === 0 && !p.busy && (
          <div className="pt-24 text-center text-muted-foreground">
            <div className="text-base font-medium text-foreground">开始对话</div>
            <div className="pt-1 text-[13px]">
              输入消息开始；在树页签点选任意节点可「从此分支」，开启无上下文叶子提问也可。
            </div>
          </div>
        )}
        {path.map((n) => (
          <MessageItem key={n.seq} node={n} cards={cardsBySeq.get(n.seq) ?? []} />
        ))}
        {p.run && <RunBlock run={p.run} onOpenCards={p.onOpenCards} />}
        {p.busy && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="flex gap-1">
              <Dot delay="0s" />
              <Dot delay="0.15s" />
              <Dot delay="0.3s" />
            </span>
            思考中…
          </div>
        )}
        {p.error && (
          <div className="flex items-center gap-2 rounded-panel border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
            <span className="min-w-0 flex-1 break-words">{p.error}</span>
            {conv.unansweredUser !== null && (
              <button onClick={p.onRetry}
                      className="shrink-0 rounded-control border border-destructive/50 px-2 py-1 text-[12px] hover:bg-destructive/20">
                重试（#{conv.unansweredUser}）
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageItem({ node, cards }: { node: Node; cards: Card[] }) {
  if (node.role === "user") {
    return (
      <div className="group flex flex-col items-end">
        <MessageMeta node={node} cards={cards} align="right" />
        <div className="max-w-[min(85%,36rem)] whitespace-pre-wrap break-words rounded-panel rounded-br-lg bg-secondary/70 px-3.5 py-2 text-[14.5px] leading-6">
          {node.text}
        </div>
      </div>
    );
  }
  return (
    <div className="group flex w-full flex-col">
      <MessageMeta node={node} cards={cards} align="left" />
      <Markdown text={node.text} />
    </div>
  );
}

function MessageMeta({ node, cards, align }: { node: Node; cards: Card[]; align: "left" | "right" }) {
  return (
    <div className={cn("flex items-center gap-1.5 pb-1 text-[10.5px] text-muted-foreground/70",
                      align === "right" && "flex-row-reverse")}>
      <span className="font-mono">#{node.seq}</span>
      {node.label && <span className="rounded-full bg-primary/10 px-1.5 py-px text-foreground/80">{node.label}</span>}
      {node.model && <span className="truncate">{node.model}</span>}
      {cards.map((c) => (
        <span key={c.id} title={`${c.id} · ${c.title}`}
              className="rounded-full border border-border px-1.5 py-px">
          [{c.id.replace("card_", "c_")}]
        </span>
      ))}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: delay }} />
  );
}

/** 回合运行块：节点预告 → 逐 token 全文 → 收口（文档节点折叠为卡片链接片）。 */
function RunBlock({ run, onOpenCards }: { run: RunTrace; onOpenCards: () => void }) {
  return (
    <div className="rounded-panel border border-border/60 bg-sidebar px-3 py-2">
      <div className="pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {run.errored ? "回合失败" : run.finished ? "回合完成" : "回合运行中"} · {run.module}
      </div>
      <div className="flex flex-col gap-2.5">
        {run.nodes.map((n) => (
          <div key={n.key}>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {n.outcome === "failed" ? (
                  <X className="h-3 w-3 text-[var(--ph-aborted)]" strokeWidth={3} />
                ) : n.outcome === "ok" ? (
                  <Check className="h-3 w-3 text-[var(--ph-done)]" strokeWidth={3} />
                ) : (
                  <Circle className="h-3 w-3 text-muted-foreground/50" />
                )}
              </span>
              <span className={n.outcome === "failed" ? "text-destructive" : ""}>{n.label}</span>
            </div>
            {/* 思考行：思考中流式展示（斜体低强调），正文到达自动收起 */}
            {n.outcome === "running" && n.thinking && !n.text && (
              <ThinkBlock text={n.thinking.slice(-800)} className="mt-1" />
            )}
            {n.outcome === "running" && n.text && <Markdown text={n.text} />}
            {n.outcome === "ok" && n.refs.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {n.refs.map((r) => (
                  <button key={r.cardId} onClick={onOpenCards}
                          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-px text-[11.5px]
                                     text-muted-foreground hover:bg-foreground/[0.05]">
                    <FileText className="h-3 w-3 shrink-0" />
                    {r.title} → 已更新到卡片
                  </button>
                ))}
              </div>
            )}
            {n.outcome === "ok" && n.refs.length === 0 && !run.finished && n.text && (
              <Markdown text={n.text} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { GitFork, Layers, Pencil } from "lucide-react";
import type { Card, ConvState, Mode, Node, RunTrace, ToolStep } from "./types";
import { activePath } from "./types";
import { useRunStream } from "../ws";
import { fetchStatus } from "../api";
import { cn } from "../lib/utils";
import { Markdown } from "./Markdown";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Check, Circle, FileText, X } from "lucide-react";
import { ThinkBlock } from "../components/ThinkBlock";

interface Props {
  conv: ConvState;
  busy: boolean;
  error: string | null;
  run: RunTrace | null;
  /** 树图导航聚焦轮（滚动 + 闪烁高亮） */
  focusSeq: number | null;
  cardSeqs: number[];
  /** 模式清单（逐轮模式徽章显示名解析） */
  modes: Mode[];
  onToggleCardSeq: (seq: number) => void;
  onRenameTurn: (seq: number, label: string) => Promise<void>;
  onBranchFrom: (seq: number) => void;
  onRetry: () => void;
  /** 文档 ref 片点击：开卡片栏 + 聚焦挂载轮（滚动闪烁） */
  onLocateDoc: (seq: number) => void;
  /** 工具块 runId 点击：打开 RunView 页签 */
  onOpenRun: (runId: string) => void;
}

/** 主区聊天视图：活跃路径（path_to 指针）轮次流；节点 = 轮次（一问一答） */
export function ChatView(p: Props) {
  const conv = p.conv;
  const path = activePath(conv);
  const cardsBySeq = new Map<number, Card[]>();
  for (const c of conv.cards)
    if (c.ownerSeq === null)
      for (const s of c.fromPath) cardsBySeq.set(s, [...(cardsBySeq.get(s) ?? []), c]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 滚动单效应：树导航（focusSeq）聚焦滚动胜出；否则新消息/回合态变化贴底
  useEffect(() => {
    if (p.focusSeq != null) {
      rootRef.current?.querySelector(`[data-seq="${p.focusSeq}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [path.length, p.busy, p.focusSeq]);

  // 聚焦闪烁：focusSeq 变化 → 高亮 1.5s
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => {
    if (p.focusSeq == null) return;
    setFlash(p.focusSeq);
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [p.focusSeq]);

  return (
    <div ref={rootRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
        {path.length === 0 && !p.busy && (
          <div className="pt-24 text-center text-muted-foreground">
            <div className="text-base font-medium text-foreground">开始对话</div>
            <div className="pt-1 text-[13px]">
              输入消息开始；在树页签点选任意节点可跳转查看它所在的分支对话。
            </div>
          </div>
        )}
        {path.map((n) => (
          <TurnItem key={n.seq} node={n} cards={cardsBySeq.get(n.seq) ?? []}
                    flash={flash === n.seq} cardSeqs={p.cardSeqs} modes={p.modes}
                    onToggleCardSeq={p.onToggleCardSeq}
                    onRenameTurn={p.onRenameTurn} onBranchFrom={p.onBranchFrom} />
        ))}
        {p.run && <RunBlock run={p.run} onLocateDoc={p.onLocateDoc} onOpenRun={p.onOpenRun} />}
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
            {conv.unanswered !== null && (
              <button onClick={p.onRetry}
                      className="shrink-0 rounded-control border border-destructive/50 px-2 py-1 text-[12px] hover:bg-destructive/20">
                重试（#{conv.unanswered}）
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/** 一轮 = 用户气泡 + 助手回复 + 轮末操作条（悬停浮现） */
function TurnItem({ node, cards, flash, cardSeqs, modes, onToggleCardSeq, onRenameTurn, onBranchFrom }: {
  node: Node;
  cards: Card[];
  flash: boolean;
  cardSeqs: number[];
  modes: Mode[];
  onToggleCardSeq: (seq: number) => void;
  onRenameTurn: (seq: number, label: string) => Promise<void>;
  onBranchFrom: (seq: number) => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const inCardRange = cardSeqs.includes(node.seq);
  return (
    <div data-seq={node.seq}
         className={cn("group flex flex-col gap-3 rounded-panel transition-shadow",
                       flash && "ring-1 ring-primary/50")}>
      <div className="flex flex-col items-end">
        <MessageMeta seq={node.seq} label={node.label} modes={modes} cards={cards} align="right" />
        <div className="max-w-[min(85%,36rem)] whitespace-pre-wrap break-words rounded-panel rounded-br-lg bg-secondary/70 px-3.5 py-2 text-[15px] leading-6">
          {node.input}
        </div>
      </div>
      {node.output !== null && (
        <div className="flex w-full flex-col">
          <MessageMeta model={node.model} module={node.module} modes={modes} cards={[]} align="left" />
          <Markdown text={node.output} />
        </div>
      )}
      {/* 轮末操作条：命名 / 选入卡片范围 / 从此分支 */}
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px] text-muted-foreground"
                onClick={() => setRenameOpen(true)}>
          <Pencil className="h-3 w-3" /> 命名
        </Button>
        <Button variant="ghost" size="sm"
                className={cn("h-6 px-1.5 text-[12px]", inCardRange ? "text-primary" : "text-muted-foreground")}
                onClick={() => onToggleCardSeq(node.seq)}>
          <Layers className="h-3 w-3" /> {inCardRange ? "移出卡片范围" : "选入卡片范围"}
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px] text-muted-foreground"
                onClick={() => onBranchFrom(node.seq)}>
          <GitFork className="h-3 w-3" /> 从此分支
        </Button>
      </div>
      <Dialog open={renameOpen} onOpenChange={(o) => !o && setRenameOpen(false)}>
        <DialogContent>
          <DialogTitle>
            <Pencil className="mr-1 inline h-4 w-4" /> 命名轮次 #{node.seq}
          </DialogTitle>
          <NodeRenameForm
            initial={node.label}
            onSubmit={async (v) => {
              await onRenameTurn(node.seq, v);
              setRenameOpen(false);
            }}
            onCancel={() => setRenameOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MessageMeta({ seq, label, model, module, modes, cards, align }: {
  seq?: number;
  label?: string;
  model?: string;
  module?: string;
  modes: Mode[];
  cards: Card[];
  align: "left" | "right";
}) {
  const modeName = module ? modes.find((m) => m.key === module)?.displayName ?? module : null;
  return (
    <div className={cn("flex items-center gap-1.5 pb-1 text-[11px] text-muted-foreground/70",
                      align === "right" && "flex-row-reverse")}>
      {seq !== undefined && <span className="font-mono">#{seq}</span>}
      {label && <span className="rounded-full bg-primary/10 px-1.5 py-px text-foreground/80">{label}</span>}
      {modeName && <span className="rounded-full border border-border px-1.5 py-px">{modeName}</span>}
      {model && <span className="truncate">{model}</span>}
      {cards.map((c) => (
        <span key={c.id} title={`${c.id} · ${c.title}`}
              className="rounded-full border border-border px-1.5 py-px">
          [{c.id.replace("card_", "c_")}]
        </span>
      ))}
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

function Dot({ delay }: { delay: string }) {
  return (
    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: delay }} />
  );
}

/** 回合运行块：节点预告 → 逐 token 全文 → 收口（文档节点折叠为卡片链接片）。 */
function RunBlock({ run, onLocateDoc, onOpenRun }: {
  run: RunTrace; onLocateDoc: (seq: number) => void; onOpenRun: (rid: string) => void;
}) {
  return (
    <div className="rounded-panel border border-border/60 bg-sidebar px-3 py-2">
      <div className="pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {run.errored ? "回合失败" : run.finished ? "回合完成" : "回合运行中"} · {run.module}
      </div>
      {run.tools.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {run.tools.map((t) => (
            <ToolItem key={t.id} step={t} onOpenRun={onOpenRun} />
          ))}
        </div>
      )}
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
                  <button key={r.docKey} onClick={() => onLocateDoc(run.userSeq)}
                          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-px text-[12px]
                                     text-muted-foreground hover:bg-foreground/[0.05]">
                    <FileText className="h-3 w-3 shrink-0" />
                    {r.title} → 已挂到 #{run.userSeq}
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

/** 工具步骤块：名称 + 结果摘要；args 折叠；runId 块内订阅 WS 实时进度并可跳转 */
function ToolItem({ step, onOpenRun }: { step: ToolStep; onOpenRun: (rid: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-panel border border-border/50 bg-background px-2.5 py-1.5">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
              className="flex w-full items-center gap-1.5 text-left text-[12px]">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {step.status === "failed" ? (
            <X className="h-3 w-3 text-[var(--ph-aborted)]" strokeWidth={3} />
          ) : step.status === "ok" ? (
            <Check className="h-3 w-3 text-[var(--ph-done)]" strokeWidth={3} />
          ) : (
            <Circle className="h-3 w-3 animate-pulse text-muted-foreground/50" />
          )}
        </span>
        <span className="shrink-0 font-mono text-foreground/80">{step.name}</span>
        <span className={cn("min-w-0 flex-1 truncate",
                            step.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {step.summary}
        </span>
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control bg-secondary/60 px-2 py-1 text-[11px] text-muted-foreground">
          {step.args}
        </pre>
      )}
      {step.runId && <RunProgress runId={step.runId} onOpenRun={onOpenRun} />}
    </div>
  );
}

/** runId 内嵌进度：先过落盘等待门再连 WS（spawn→首写 status.json 有百毫秒窗口，
 * 服务端对不存在的 run 拒连且前端永久停连——RunView 同款模式） */
function RunProgress({ runId, onOpenRun }: { runId: string; onOpenRun: (rid: string) => void }) {
  const [materialized, setMaterialized] = useState(false);
  const [timeout, setTimeouted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    const poll = () => {
      fetchStatus(runId)
        .then(() => {
          if (!cancelled) {
            setTimeouted(false);
            setMaterialized(true);
          }
        })
        .catch(() => {
          if (!cancelled && Date.now() - started > 60_000) setTimeouted(true);
        });
    };
    poll();
    const t = setInterval(poll, 1_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [runId]);
  const st = useRunStream(materialized ? runId : null);
  const phase = timeout ? "落盘超时" : (st?.msg.phase ?? "…");
  return (
    <button onClick={() => onOpenRun(runId)}
            className="mt-1 flex w-full items-center gap-1.5 rounded-control bg-primary/[0.06] px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-primary/10">
      <span className="font-mono">{runId}</span>
      <span>phase={phase}</span>
      {st?.msg.tick != null && <span>tick={st.msg.tick}</span>}
      <span className="ml-auto shrink-0 text-primary">打开运行视图 →</span>
    </button>
  );
}

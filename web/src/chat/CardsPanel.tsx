import { Download, Layers, Library, MapPin, Pencil, Pin, PinOff, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import * as api from "./api";
import type { Card, ConvState, LibraryCard } from "./types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Markdown } from "./Markdown";

interface Props {
  conv: ConvState | null;
  genOpen: boolean;
  onGenOpenChange: (open: boolean) => void;
  cardSeqs: number[];
  onClearCardSeqs: () => void;
  onCreateCard: (req: api.CardReq) => Promise<void>;
  onPin: (cid: string, pinned: boolean) => Promise<void>;
  onEditCard: (cid: string, body: { title: string; body: string }) => Promise<void>;
  onDeleteCard: (cid: string) => Promise<void>;
  onImportCard: (body: { title: string; body: string; instruction?: string; ownerSeq?: number }) => Promise<void>;
}

/** 卡片面板：页签配套功能——绑定当前激活 chat 页签（conv 可空，内部空态） */
export function CardsPanel(p: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Card | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Card | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const conv = p.conv;
  // 全局卡区只列全局卡（ownerSeq=null）；节点卡归右栏「节点卡片」区，混列会随版本无限堆积
  const globalCards = conv ? conv.cards.filter((c) => c.ownerSeq === null) : [];

  const download = (cid: string) => {
    if (!conv) return;
    const a = document.createElement("a");
    a.href = api.cardExportUrl(conv.sid, cid);
    a.download = `${cid}.md`;
    a.click();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground">全局卡片</span>
        {conv && <span className="text-[12px] text-muted-foreground">{conv.name} · {globalCards.length} 张</span>}
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="outline" className="h-7" disabled={!conv}
                  onClick={() => setImportOpen(true)}>
            <Upload className="h-3.5 w-3.5" /> 导入
          </Button>
          <Button size="sm" className="h-7" disabled={!conv}
                  onClick={() => p.onGenOpenChange(true)}>
            <Plus className="h-3.5 w-3.5" /> 生成卡片
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!conv ? (
          <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">先打开一个对话</div>
        ) : globalCards.length === 0 ? (
          <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">
            还没有卡片。把当前分支段提炼为「脱离原对话也能读懂」的结构化产出。
          </div>
        ) : (
          globalCards.map((c) => (
            <div key={c.id}
                 onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                 className={cn("mb-1.5 cursor-pointer rounded-panel border px-2.5 py-2 transition-colors hover:bg-foreground/[0.03]",
                              expanded === c.id && "bg-foreground/[0.04]")}>
              <div className="flex items-center gap-1.5">
                <button title={c.pinned ? "取消 pin" : "pin（注入后续轮次）"}
                        onClick={(e) => { e.stopPropagation(); p.onPin(c.id, !c.pinned); }}
                        className={cn("shrink-0", c.pinned ? "text-primary" : "text-muted-foreground/50 hover:text-foreground")}>
                  {c.pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
                </button>
                {c.id.startsWith("spec:") && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600">旧版文档</span>
                )}
                <span className="font-mono text-[11px] text-muted-foreground">{c.id}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.title}</span>
              </div>
              <div className="flex items-center gap-1 pt-0.5 text-[11px] text-muted-foreground/80">
                <MapPin className="h-3 w-3" />
                来源 {c.fromPath.map((s) => `#${s}`).join(" → ") || "—"}
                {c.instruction && <span className="truncate">· 指令「{c.instruction}」</span>}
              </div>
              {expanded === c.id && (
                <div className="mt-1.5 border-t border-border pt-1.5">
                  <Markdown text={c.body} />
                  <div className="flex gap-1 pt-1.5" onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                            onClick={() => setEditTarget(c)}>
                      <Pencil className="h-3 w-3" /> 编辑
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                            onClick={() => download(c.id)}>
                      <Download className="h-3 w-3" /> 导出
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px] text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(c)}>
                      <Trash2 className="h-3 w-3" /> 删除
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}

        {/* 跨会话卡库（复制导入语义：导入 = 在当前会话建独立副本） */}
        <CardLibrary activeSid={conv?.sid ?? null} canImport={!!conv} onImport={(c) => {
          p.onImportCard({
            title: c.title, body: c.body,
            instruction: `导入自「${c.sessionName}」`,
          });
        }} />
      </div>

      {/* 生成卡片 Dialog（App 控制开关：树图选点提炼会从 Tree 页签打开） */}
      <Dialog open={p.genOpen} onOpenChange={p.onGenOpenChange}>
        <DialogContent>
          <GenerateForm conv={conv} cardSeqs={p.cardSeqs} onClearCardSeqs={p.onClearCardSeqs}
                        onDone={() => p.onGenOpenChange(false)} onCreate={p.onCreateCard} />
        </DialogContent>
      </Dialog>

      {/* 编辑卡片 Dialog */}
      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          {editTarget && (
            <>
              <DialogTitle>编辑卡片 {editTarget.id}</DialogTitle>
              <CardEditForm
                card={editTarget}
                onSubmit={async (title, body) => {
                  await p.onEditCard(editTarget.id, { title, body });
                  setEditTarget(null);
                }}
                onCancel={() => setEditTarget(null)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>删除卡片 {deleteTarget?.id}？</AlertDialogTitle>
          <AlertDialogDescription>
            「{deleteTarget?.title}」将从本对话删除（含 pin 状态）。此操作不可撤销。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (deleteTarget) p.onDeleteCard(deleteTarget.id);
              setDeleteTarget(null);
            }}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 导入卡片 Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <ImportForm
            conv={conv}
            onDone={() => setImportOpen(false)}
            onImport={async (body) => {
              await p.onImportCard(body);
              setImportOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── 生成卡片（branch / all / range / seqs 四种范围） ──

function GenerateForm(p: {
  conv: ConvState | null;
  cardSeqs: number[];
  onClearCardSeqs: () => void;
  onDone: () => void;
  onCreate: Props["onCreateCard"];
}) {
  const hasPreset = p.cardSeqs.length > 0;
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"branch" | "all" | "range" | "seqs">(hasPreset ? "seqs" : "branch");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState(false);
  const pointer = p.conv?.pointer ?? null;
  const rangeValid = mode !== "range" || (Number(start) > 0 && Number(end) >= Number(start));
  const seqsValid = mode !== "seqs" || p.cardSeqs.length > 0;
  return (
    <>
      <DialogTitle>生成卡片</DialogTitle>
      <DialogDescription>用 LLM 把对话段提炼为自包含卡片（默认 pinned）。</DialogDescription>
      <div className="grid gap-2.5">
        <Textarea autoFocus placeholder="提炼指令（留空 = 总结为卡片）" value={instruction}
                  onChange={(e) => setInstruction(e.target.value)} />
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          {([["branch", "当前分支段"], ["all", "全部路径"], ["range", "区间"], ["seqs", "自选节点"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
                    className={cn("rounded-control border px-2 py-1 transition-colors",
                                 mode === k ? "border-primary bg-primary/10" : "hover:bg-accent")}>
              {label}
            </button>
          ))}
        </div>
        {mode === "range" && (
          <div className="flex items-center gap-2 text-[12px]">
            <Input className="h-7 w-20" placeholder="起始 seq" value={start} onChange={(e) => setStart(e.target.value)} />
            <span>→</span>
            <Input className="h-7 w-20" placeholder="结束 seq" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        )}
        {mode === "seqs" && (
          <div className="text-[12px] text-muted-foreground">
            {hasPreset ? (
              <span>
                树图选点（{p.cardSeqs.length} 个）：{p.cardSeqs.map((s) => `#${s}`).join(" ")}
                <button className="ml-2 underline underline-offset-2 hover:text-foreground"
                        onClick={p.onClearCardSeqs}>清除</button>
              </span>
            ) : (
              <span>尚未选择节点——到「对话树」页签点开节点，用「选入卡片范围」添加。</span>
            )}
          </div>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
             title="勾选后创建节点卡：不进上下文、只作展示/追溯，右侧栏「节点卡片」区可见">
        <input type="checkbox" checked={attach} disabled={pointer === null}
               onChange={(e) => setAttach(e.target.checked)} />
        挂到当前选中轮（节点卡）
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={p.onDone}>取消</Button>
        <Button disabled={busy || !p.conv || !rangeValid || !seqsValid}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await p.onCreate({
                      instruction: instruction.trim() || "总结为卡片",
                      mode,
                      start: mode === "range" ? Number(start) : undefined,
                      end: mode === "range" ? Number(end) : undefined,
                      seqs: mode === "seqs" ? p.cardSeqs : undefined,
                      ownerSeq: attach && pointer !== null ? pointer : undefined,
                    });
                    p.onDone();
                    if (mode === "seqs") p.onClearCardSeqs();
                  } finally {
                    setBusy(false);
                  }
                }}>
          {busy ? "提炼中…" : "生成"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ── 编辑卡片 ──

export function CardEditForm(p: { card: Card; onSubmit: (title: string, body: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(p.card.title);
  const [body, setBody] = useState(p.card.body);
  const [busy, setBusy] = useState(false);
  return (
    <>
      {/* 对话框标题由调用点的 DialogTitle 提供（本表单被两个编辑对话框共用） */}
      <div className="grid gap-2.5">
        <Input autoFocus value={title} placeholder="标题"
               onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} />
        <Textarea className="min-h-[140px]" value={body} placeholder="正文（markdown）"
                  onChange={(e) => setBody(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={p.onCancel}>取消</Button>
        <Button disabled={busy || !title.trim()}
                onClick={async () => {
                  setBusy(true);
                  try { await p.onSubmit(title.trim(), body); } finally { setBusy(false); }
                }}>
          保存
        </Button>
      </DialogFooter>
    </>
  );
}

// ── 导入卡片（粘贴或选 .md/.txt 文件；首个 `# ` 行作为标题） ──

function ImportForm(p: {
  conv: ConvState | null;
  onDone: () => void;
  onImport: (body: { title: string; body: string; ownerSeq?: number }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState(false);
  const pointer = p.conv?.pointer ?? null;
  const fileRef = useRef<HTMLInputElement>(null);
  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const m = text.match(/^#\s+(.+)\r?\n+/);  // 首个 `# ` 行作为标题
      if (m) {
        setTitle(m[1].trim());
        setBody(text.slice(m[0].length));
      } else {
        setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
        setBody(text);
      }
    };
    reader.readAsText(file);
  };
  return (
    <>
      <DialogTitle>导入卡片</DialogTitle>
      <DialogDescription>直接把已有内容存为本对话卡片（不经 LLM，默认 pinned）。可粘贴，或选一个 .md/.txt 文件。</DialogDescription>
      <div className="grid gap-2.5">
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt" className="hidden"
               onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
        <Button variant="outline" size="sm" className="w-fit" onClick={() => fileRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> 选择文件
        </Button>
        <Input value={title} placeholder="标题"
               onChange={(e) => setTitle(e.target.value)} />
        <Textarea className="min-h-[140px]" value={body} placeholder="正文（markdown）"
                  onChange={(e) => setBody(e.target.value)} />
      </div>
      <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
             title="勾选后创建节点卡：不进上下文、只作展示/追溯，右侧栏「节点卡片」区可见">
        <input type="checkbox" checked={attach} disabled={pointer === null}
               onChange={(e) => setAttach(e.target.checked)} />
        挂到当前选中轮（节点卡）
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={p.onDone}>取消</Button>
        <Button disabled={busy || !title.trim() || !body.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await p.onImport({
                      title: title.trim(), body,
                      ownerSeq: attach && pointer !== null ? pointer : undefined,
                    });
                  } finally { setBusy(false); }
                }}>
          导入
        </Button>
      </DialogFooter>
    </>
  );
}

// ── 跨会话卡库 ──

function CardLibrary(p: { activeSid: string | null; canImport: boolean; onImport: (c: LibraryCard) => void }) {
  const [items, setItems] = useState<LibraryCard[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const others = (items ?? []).filter((c) => c.sid !== p.activeSid);
  return (
    <details onToggle={(e) => {
        // 非受控 details：首次展开时懒加载卡库
        if (e.currentTarget.open && !loaded) {
          setLoaded(true);
          api.listLibraryCards().then(setItems).catch(() => setItems([]));
        }
      }}
      className="mt-3 rounded-panel border border-dashed px-2.5 py-2 text-[12px] text-muted-foreground">
      <summary className="cursor-pointer select-none text-[12px] font-medium">
        <Library className="mr-1 inline h-3.5 w-3.5" /> 跨会话卡库（{items === null ? "…" : others.length} 张来自其他对话）
      </summary>
      <div className="pt-1.5">
        {others.length === 0 ? (
          <div className="py-2 text-[12px]">其他对话还没有卡片。</div>
        ) : (
          others.map((c) => (
            <div key={`${c.sid}/${c.id}`} className="flex items-center gap-1.5 py-1">
              <span className="min-w-0 flex-1 truncate" title={c.body}>{c.title}</span>
              <span className="max-w-[40%] shrink truncate text-[11px] opacity-70">{c.sessionName}</span>
              <Button variant="outline" size="sm" className="h-6 shrink-0 px-1.5 text-[11px]"
                      disabled={!p.canImport}
                      onClick={() => p.onImport(c)}>
                <Plus className="h-3 w-3" /> 导入
              </Button>
            </div>
          ))
        )}
        <div className="pt-1 text-[11px] opacity-70">导入会复制为当前对话的独立卡片，不随源卡片变化。</div>
      </div>
    </details>
  );
}

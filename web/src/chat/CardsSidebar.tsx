import { CornerUpRight, Download, FileText, MapPin, PanelRightClose, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import * as api from "./api";
import type { Card, ConvState } from "./types";
import { activePath } from "./types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Markdown } from "./Markdown";
import { CardEditForm, CardsPanel } from "./CardsPanel";

interface Props {
  conv: ConvState | null;
  onNavigate: (seq: number) => void;
  onCollapse: () => void;
  /** 节点卡升为全局（复制为全局 pinned 卡——跨分支传递入口） */
  onPromoteCard: (c: Card) => Promise<void>;
  // ↓ 透传全局卡区（CardsPanel）
  genOpen: boolean;
  onGenOpenChange: (open: boolean) => void;
  cardSeqs: number[];
  onClearCardSeqs: () => void;
  onCreateCard: (req: api.CardReq) => Promise<void>;
  onPin: (cid: string, pinned: boolean) => Promise<void>;
  onEditCard: (cid: string, body: { title: string; body: string }) => Promise<void>;
  onDeleteCard: (cid: string) => Promise<void>;
  onImportCard: (body: { title: string; body: string; instruction?: string }) => Promise<void>;
}

/** chat 页右侧边栏：上半「节点卡片」（指针轮产出 + 文档版本链），下半「全局卡片」 */
export function CardsSidebar(p: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground">卡片</span>
        <button title="收起卡片栏" onClick={p.onCollapse}
                className="ml-auto rounded-control p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <NodeCardsSection conv={p.conv} onNavigate={p.onNavigate} onEdit={p.onEditCard}
                          onDelete={p.onDeleteCard} onPromote={p.onPromoteCard} />
        <CardsPanel conv={p.conv} genOpen={p.genOpen} onGenOpenChange={p.onGenOpenChange}
                    cardSeqs={p.cardSeqs} onClearCardSeqs={p.onClearCardSeqs}
                    onCreateCard={p.onCreateCard} onPin={p.onPin} onEditCard={p.onEditCard}
                    onDeleteCard={p.onDeleteCard} onImportCard={p.onImportCard} />
      </div>
    </div>
  );
}

/** 节点卡片：当前指针轮的产出（模块文档版本 + 用户挂节点的卡） */
function NodeCardsSection({ conv, onNavigate, onEdit, onDelete, onPromote }: {
  conv: ConvState | null;
  onNavigate: (seq: number) => void;
  onEdit: (cid: string, body: { title: string; body: string }) => Promise<void>;
  onDelete: (cid: string) => Promise<void>;
  onPromote: (c: Card) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Card | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Card | null>(null);
  if (!conv) return null;
  const pointer = conv.pointer;
  const nodeCards = conv.cards.filter((c) => c.ownerSeq === pointer);
  // 导出：直链下载 .md（与全局卡区 CardsPanel 的 download 同一机制）
  const download = (cid: string) => {
    const a = document.createElement("a");
    a.href = api.cardExportUrl(conv.sid, cid);
    a.download = `${cid}.md`;
    a.click();
  };
  // 版本链 = 活跃路径上该文档的各版本（点击跳转该轮——分支到旧节点后其版本即生效）
  const docVersions = (docKey: string) => {
    const seqs = new Set(activePath(conv).map((n) => n.seq));
    return conv.cards
      .filter((c) => c.docKey === docKey && c.ownerSeq !== null && seqs.has(c.ownerSeq))
      .sort((a, b) => (a.ownerSeq ?? 0) - (b.ownerSeq ?? 0));
  };
  return (
    <div className="pb-2">
      <div className="flex items-center gap-1 px-1 pb-1 text-[11px] font-semibold text-muted-foreground">
        节点卡片
        <span className="font-normal opacity-80">
          {pointer === null ? "（未选中节点）" : `#${pointer}`}
        </span>
      </div>
      {pointer === null ? (
        <div className="rounded-panel border border-dashed px-2.5 py-3 text-[12px] text-muted-foreground">
          在树页签点选轮次，查看该轮产出的卡片。
        </div>
      ) : nodeCards.length === 0 ? (
        <div className="rounded-panel border border-dashed px-2.5 py-3 text-[12px] text-muted-foreground">
          该轮无产出卡片。
        </div>
      ) : (
        nodeCards.map((c) => (
          <div key={c.id} className="mb-1.5 rounded-panel border px-2.5 py-2">
            <div className="flex cursor-pointer items-center gap-1.5"
                 onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
              {c.docKey !== "" && (
                <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] text-primary">文档</span>
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.title}</span>
              <span className="font-mono text-[10px] text-muted-foreground/60">{c.id}</span>
            </div>
            {expanded === c.id && (
              <div className="pt-1.5">
                <Markdown text={c.body} />
                <div className="flex flex-wrap gap-1 pt-1.5">
                  {c.docKey !== "" && (
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                            onClick={() => setVersionsOf(versionsOf === c.id ? null : c.id)}>
                      <MapPin className="h-3 w-3" /> 版本链
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[12px]"
                          title="复制为全局卡片（跨分支传递）"
                          onClick={() => onPromote(c)}>
                    <CornerUpRight className="h-3 w-3" /> 升为全局
                  </Button>
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
                {versionsOf === c.id && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-border pt-1.5 text-[12px]">
                    <span className="text-muted-foreground">沿活跃路径：</span>
                    {docVersions(c.docKey).map((v) => (
                      <button key={v.id} onClick={() => onNavigate(v.ownerSeq ?? pointer)}
                              className={cn("rounded-full border px-1.5 py-px font-mono hover:bg-accent",
                                            v.ownerSeq === pointer && "border-primary text-primary")}>
                        #{v.ownerSeq}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))
      )}
      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          {editTarget && (
            <>
              <DialogTitle>编辑卡片 {editTarget.id}</DialogTitle>
              <CardEditForm
                card={editTarget}
                onSubmit={async (title, body) => {
                  await onEdit(editTarget.id, { title, body });
                  setEditTarget(null);
                }}
                onCancel={() => setEditTarget(null)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认（与全局卡区同一模式） */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>删除卡片 {deleteTarget?.id}？</AlertDialogTitle>
          <AlertDialogDescription>
            「{deleteTarget?.title}」将从本对话删除（含 pin 状态）。此操作不可撤销。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (deleteTarget) onDelete(deleteTarget.id);
              setDeleteTarget(null);
            }}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

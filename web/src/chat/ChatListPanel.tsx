import { Archive, FolderOpen, MoreHorizontal, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Mode, SessionSummary } from "./types";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

interface Props {
  serviceAvailable: boolean;
  sessions: SessionSummary[];
  /** 模式枚举（创建对话的分类选择器；服务未启用时空数组回落「直答」） */
  modes: Mode[];
  activeSid: string | null;
  onOpen: (sid: string) => void;
  onCreate: (name: string, system: string, category: string) => Promise<void>;
  onRename: (sid: string, name: string) => Promise<void>;
  onCategory: (sid: string, category: string) => Promise<void>;
  onArchive: (sid: string, archived: boolean) => Promise<void>;
  onDelete: (sid: string) => Promise<void>;
}

type DialogState =
  | { kind: "create" }
  | { kind: "rename"; sid: string; name: string }
  | { kind: "category"; sid: string; category: string }
  | null;

/** 对话面板（全局功能）：会话列表 + 管理；对话服务未启用时空态引导 */
export function ChatListPanel(p: Props) {
  if (!p.serviceAvailable)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-muted-foreground">
        <div className="text-[28px]">💬</div>
        <div className="text-[13px]">对话服务未挂载</div>
        <div className="text-[12px] opacity-70">对话功能内置于服务端——请确认后端已启动/升级后刷新</div>
      </div>
    );
  return <ChatListPanelInner {...p} />;
}

function ChatListPanelInner(p: Props) {
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirmDelete, setConfirmDelete] = useState<SessionSummary | null>(null);

  const filtered = useMemo(
    () =>
      p.sessions.filter(
        (s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()) || s.sid.includes(filter),
      ),
    [p.sessions, filter],
  );
  const active = filtered.filter((s) => !s.archived);
  const archived = filtered.filter((s) => s.archived);
  const categories = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const s of active) {
      const key = s.category || "";
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    return [...groups.entries()];
  }, [active]);

  const item = (s: SessionSummary) => (
    <div
      key={s.sid}
      onClick={() => p.onOpen(s.sid)}
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 rounded-control px-2 py-1.5 text-[13px]",
        p.activeSid === s.sid ? "bg-sidebar-selected" : "hover:bg-foreground/[0.04]",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{s.name}</span>
          {s.category && (
            <span className="shrink-0 rounded-full bg-foreground/[0.07] px-1.5 py-px text-[11px] text-muted-foreground">
              {s.category}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground/80">
          {s.nodeCount} 节点 · {relativeTime(s.mtimeMs)}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", sid: s.sid, name: s.name })}>
            <Pencil className="h-3.5 w-3.5" /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog({ kind: "category", sid: s.sid, category: s.category })}>
            <Tag className="h-3.5 w-3.5" /> 分类
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => p.onArchive(s.sid, !s.archived)}>
            <Archive className="h-3.5 w-3.5" /> {s.archived ? "取消归档" : "归档"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setConfirmDelete(s)}>
            <Trash2 className="h-3.5 w-3.5" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const group = (label: string, items: SessionSummary[], icon?: "open" | "archive") => (
    <div key={label} className="mb-2">
      <div className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {icon === "open" && <FolderOpen className="h-3 w-3" />}
        {icon === "archive" && <Archive className="h-3 w-3" />}
        {label}
        <span className="ml-auto font-normal">{items.length}</span>
      </div>
      {items.map(item)}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span className="text-[13px] font-semibold">对话</span>
        <Button size="sm" className="ml-auto h-7" onClick={() => setDialog({ kind: "create" })}>
          <Plus className="h-3.5 w-3.5" /> 新对话
        </Button>
      </div>
      <div className="px-3 pb-2">
        <Input
          placeholder="搜索对话…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-7 rounded-control bg-foreground/[0.03] text-[12px]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {filtered.length === 0 && (
          <div className="px-2 py-8 text-center text-[12px] text-muted-foreground">
            {filter ? "无匹配对话" : "还没有对话，点上方「新对话」开始"}
          </div>
        )}
        {categories.map(([cat, items]) =>
          cat === "" ? group("未分类", items) : group(cat, items),
        )}
        {archived.length > 0 && group("归档", archived, "archive")}
      </div>

      {/* 创建 / 重命名 / 分类 对话框 */}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          {dialog?.kind === "create" && <CreateForm onDone={setDialog} onCreate={p.onCreate} modes={p.modes} />}
          {dialog?.kind === "rename" && (
            <TextForm
              title="重命名对话"
              label="名称"
              initial={dialog.name}
              onSubmit={async (v) => {
                await p.onRename(dialog.sid, v);
                setDialog(null);
              }}
              onCancel={() => setDialog(null)}
            />
          )}
          {dialog?.kind === "category" && (
            <TextForm
              title="设置分类"
              label="分类（留空 = 未分类）"
              initial={dialog.category}
              onSubmit={async (v) => {
                await p.onCategory(dialog.sid, v);
                setDialog(null);
              }}
              onCancel={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认（不可撤销） */}
      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>删除对话「{confirmDelete?.name}」？</AlertDialogTitle>
          <AlertDialogDescription>
            此操作不可撤销，对话事件文件将被永久删除。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (confirmDelete) p.onDelete(confirmDelete.sid);
                setConfirmDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateForm(p: {
  onDone: (d: DialogState) => void;
  onCreate: (name: string, system: string, category: string) => Promise<void>;
  modes: Mode[];
}) {
  const [name, setName] = useState("");
  const [system, setSystem] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <DialogTitle>新对话</DialogTitle>
      <DialogDescription>创建一个对话树会话。</DialogDescription>
      <div className="grid gap-2.5">
        <Input autoFocus placeholder="对话名称" value={name} maxLength={80}
               onChange={(e) => setName(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-control border border-border bg-background px-2 text-[13px]">
          {p.modes.length === 0 && <option value="">直答</option>}
          {p.modes.map((m) => (
            <option key={m.key} value={m.key === "direct" ? "" : m.key}>
              {m.displayName}
            </option>
          ))}
        </select>
        <Textarea placeholder="会话级 system 指令（可选）" value={system}
                  onChange={(e) => setSystem(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => p.onDone(null)}>取消</Button>
        <Button disabled={!name.trim() || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await p.onCreate(name.trim(), system, category);
                    p.onDone(null);
                  } finally {
                    setBusy(false);
                  }
                }}>
          创建
        </Button>
      </DialogFooter>
    </>
  );
}

function TextForm(p: {
  title: string;
  label: string;
  initial: string;
  onSubmit: (v: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState(p.initial);
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); }}>
      <DialogTitle>{p.title}</DialogTitle>
      <div className="mt-3 grid gap-2.5">
        <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={p.onCancel}>取消</Button>
        <Button
          type="submit"
          disabled={busy}
          onClick={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await p.onSubmit(v.trim());
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </DialogFooter>
    </form>
  );
}

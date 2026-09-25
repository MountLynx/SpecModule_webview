// 侧栏组件库面板（构建板块）：分组浏览/上传/删除 + submodule 索引 + 草稿列表 + 新建模块。
// 组件详情浏览：harness/command 点开表单回填编辑；scripts/guards 点开只读代码预览。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileCode, FlaskConical, Hammer, Plus, TerminalSquare, Trash2, Wrench, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { errTextCls, labelCls, overlayCls, panelCls } from "./dialogTheme";
import {
  deleteLibraryItem, emptyDraft, fetchLibrary, fetchLibraryItem, fetchModules, putDraft,
  putLibraryCode, putLibraryJson, type LibraryIndex,
} from "../api";
import { CommandDialog, HarnessDialog } from "./library/ComponentForms";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  activeDraft: string | null;
  onOpenDraft: (name: string) => void;
  onCreated: (name: string) => void;
  onDeleted: (name: string) => void;
}

function ItemRow({ name, active, onOpen, onDelete }: {
  name: string; active: boolean; onOpen: () => void; onDelete: () => void;
}) {
  return (
    <div className={`group flex h-7 items-center gap-1 rounded-control px-1.5 ${active ? "bg-accent" : "hover:bg-accent/60"}`}>
      <button className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" onClick={onOpen} title={name}>
        {name}
      </button>
      <button title="删除" onClick={onDelete}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function GroupHeader({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
      {icon}{title}
      <span className="ml-auto">{action}</span>
    </div>
  );
}

export function LibraryPanel({ activeDraft, onOpenDraft, onCreated, onDeleted }: Props) {
  const [lib, setLib] = useState<LibraryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<"harnesses" | "commands" | null>(null);
  const [editName, setEditName] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; code: string } | null>(null);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadKind = useRef<"scripts" | "guards">("scripts");

  const refresh = useCallback(() => {
    fetchLibrary().then(setLib).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const del = async (kind: Parameters<typeof deleteLibraryItem>[0], name: string) => {
    if (!window.confirm(`删除 ${kind}/${name}？`)) return;
    try {
      await deleteLibraryItem(kind, name);
      if (kind === "drafts") onDeleted(name);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openEdit = (kind: "harnesses" | "commands", name: string | null) => {
    setEditKind(kind);
    setEditName(name);
  };

  const pickUpload = (kind: "scripts" | "guards") => {
    uploadKind.current = kind;
    fileRef.current?.click();
  };

  const onFile = async (f: File) => {
    const stem = f.name.replace(/\.py$/, "");
    if (!NAME_RE.test(stem)) {
      setError(`文件名 stem 须为 Python 标识符（注册名=stem）：${f.name}`);
      return;
    }
    try {
      await putLibraryCode(uploadKind.current, stem, await f.text());
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openCodePreview = async (kind: "scripts" | "guards", name: string) => {
    try {
      const d = await fetchLibraryItem(kind, name);
      setPreview({ name, code: String(d.code ?? "") });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // submodule 候选 = 已安装 packed/pip 模块 − 已登记（lib 变化时随之刷新）
  const [subCandidates, setSubCandidates] = useState<string[]>([]);
  useEffect(() => {
    fetchModules()
      .then((d) => setSubCandidates(
        d.modules.filter((m) => m.kind === "packed" || m.kind === "pip").map((m) => m.name)))
      .catch(() => {});
  }, [lib]);
  const subAvailable = subCandidates.filter(
    (c) => !lib?.submodules.some((s) => s.name === c));

  const addSubmodule = async (name: string) => {
    try {
      await putLibraryJson("submodules", name, {});
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="library-panel">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-3">
        <span className="text-[13px] font-semibold">🛠 组件库</span>
        <Button size="sm" className="ml-auto" onClick={() => setNewDraftOpen(true)}>
          <Plus className="h-3.5 w-3.5" />新建模块
        </Button>
      </div>
      {error && <div className={`px-3 pt-2 ${errTextCls}`}>{error}</div>}
      <input ref={fileRef} type="file" accept=".py" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
        <GroupHeader icon={<Wrench className="h-3.5 w-3.5" />} title="Harness"
          action={<Button variant="ghost" size="icon" title="新建 harness" onClick={() => openEdit("harnesses", null)}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.harnesses.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openEdit("harnesses", n)} onDelete={() => del("harnesses", n)} />
        ))}
        <GroupHeader icon={<TerminalSquare className="h-3.5 w-3.5" />} title="Command"
          action={<Button variant="ghost" size="icon" title="新建 command" onClick={() => openEdit("commands", null)}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.commands.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openEdit("commands", n)} onDelete={() => del("commands", n)} />
        ))}
        <GroupHeader icon={<FileCode className="h-3.5 w-3.5" />} title="Scripts"
          action={<Button variant="ghost" size="icon" title="上传 .py" onClick={() => pickUpload("scripts")}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.scripts.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openCodePreview("scripts", n)} onDelete={() => del("scripts", n)} />
        ))}
        <GroupHeader icon={<FlaskConical className="h-3.5 w-3.5" />} title="Guards"
          action={<Button variant="ghost" size="icon" title="上传 .py" onClick={() => pickUpload("guards")}><Plus className="h-3.5 w-3.5" /></Button>} />
        {lib?.guards.map((n) => (
          <ItemRow key={n} name={n} active={false} onOpen={() => openCodePreview("guards", n)} onDelete={() => del("guards", n)} />
        ))}
        <GroupHeader icon={<Hammer className="h-3.5 w-3.5" />} title="子模块（可引用的已装 packed 模块）" />
        <div className="mb-1 px-1.5">
          <select className="w-full rounded-control border border-input bg-transparent px-1.5 py-1 text-[12px]"
                  value="" disabled={subAvailable.length === 0}
                  onChange={(e) => { if (e.target.value) addSubmodule(e.target.value); }}>
            <option value="">{subAvailable.length ? "+ 以 submodule 形式入库…" : "（无 packed 模块）"}</option>
            {subAvailable.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {lib?.submodules.map((s) => (
          <ItemRow key={s.name} name={s.name} active={false} onOpen={() => {}} onDelete={() => del("submodules", s.name)} />
        ))}
        <GroupHeader icon={<Hammer className="h-3.5 w-3.5" />} title="模块草稿" />
        {lib?.drafts.length === 0 && (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">（空——点「新建模块」开始）</div>
        )}
        {lib?.drafts.map((n) => (
          <ItemRow key={n} name={n} active={n === activeDraft} onOpen={() => onOpenDraft(n)} onDelete={() => del("drafts", n)} />
        ))}
      </div>

      {editKind && (
        editKind === "harnesses"
          ? <HarnessDialog initial={editName} onClose={() => setEditKind(null)}
                           onSaved={() => { setEditKind(null); refresh(); }} />
          : <CommandDialog initial={editName} onClose={() => setEditKind(null)}
                           onSaved={() => { setEditKind(null); refresh(); }} />
      )}
      {preview && (
        <div className={overlayCls} onClick={() => setPreview(null)}>
          <div className={panelCls} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center">
              <div className="text-[13px] font-semibold">{preview.name}</div>
              <button className="ml-auto rounded p-1 hover:bg-accent" onClick={() => setPreview(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[12px]">{preview.code}</pre>
          </div>
        </div>
      )}
      {newDraftOpen && (
        <NewDraftDialog onClose={() => setNewDraftOpen(false)}
                        onCreated={(name) => { setNewDraftOpen(false); onCreated(name); refresh(); }} />
      )}
    </div>
  );
}

function NewDraftDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符（同时是包名/选择器）"); return; }
    setBusy(true); setErr(null);
    try {
      await putDraft(emptyDraft(name));
      onCreated(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className={labelCls}>新建模块草稿</div>
        <Input autoFocus value={name} placeholder="模块名（如 my_writer）"
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && create()} />
        {err && <div className={errTextCls}>{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={busy || !name} onClick={create}>创建</Button>
        </div>
      </div>
    </div>
  );
}

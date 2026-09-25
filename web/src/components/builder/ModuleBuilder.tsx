// 模块创建器主区：顶栏（元数据/Spec/添加节点/自动布局/校验/安装）+ 编辑画布 +
// 右侧配置面板 + 底部 tasklist 预览（validate 返回的服务端生成结果）。
// 草稿自动保存：变更置脏 → 800ms 防抖 PUT；校验/安装前先显式保存（saveNow）。
// 保存失败捕获服务端 message（saveError）就地透出——用户能看到为什么失败。
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, GitMerge, LayoutGrid, ShieldCheck, Table2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SpecForm } from "../SpecForm";
import { errTextCls, fieldCls, labelCls, okTextCls, overlayCls, panelCls } from "../dialogTheme";
import {
  fetchDraft, fetchLibrary, genId, installPack, putDraft, validatePack,
  type BuilderDraft, type BuilderNode, type LibraryIndex, type ModuleDetail,
  type SpecField, type SpecTypeName, type ValidatePackResult,
} from "../../api";
import { EditableCanvas, relayout, type Selection } from "./EditableCanvas";
import { NodePanel } from "./NodePanel";

interface Props {
  name: string;
  onInstalled: (moduleName: string) => void;
}

const ADD_TYPES: { type: BuilderNode["type"]; label: string }[] = [
  { type: "harness", label: "LLM 节点" },
  { type: "script", label: "Script 节点" },
  { type: "command", label: "Command 节点" },
  { type: "submodule", label: "子模块节点" },
];

type SaveState = "clean" | "dirty" | "saving" | "error";

export function ModuleBuilder({ name, onInstalled }: Props) {
  const [draft, setDraft] = useState<BuilderDraft | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryIndex | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<ValidatePackResult | null>(null);
  const [checkErrors, setCheckErrors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [installed, setInstalled] = useState<ModuleDetail | null>(null);
  const saveTimer = useRef<number | null>(null);
  // 回调里读最新草稿（addNode/saveNow 不入依赖数组）
  const draftRef = useRef<BuilderDraft | null>(null);
  draftRef.current = draft;

  const load = useCallback(() => {
    setLoadErr(null);
    fetchDraft(name)
      .then(setDraft)
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetchLibrary().then(setLibrary).catch(() => {}); // 库清单失败不阻塞——添加节点时提示
  }, [name]);

  useEffect(() => { load(); }, [load]);

  const onChange = useCallback((fn: (d: BuilderDraft) => BuilderDraft) => {
    setDraft((prev) => prev && fn(prev));
    setSaveState("dirty");
    setCheckResult(null);
    setCheckErrors(null);
  }, []);

  // 自动保存（防抖）：dirty → 800ms 后 PUT；失败记 saveError 供工具条透出原因
  useEffect(() => {
    if (saveState !== "dirty" || !draft) return;
    saveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await putDraft(draft);
        setSaveState("clean");
        setSaveError(null);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
        setSaveState("error");
      }
    }, 800);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [draft, saveState]);

  // 显式保存（校验/安装前置步骤）：失败抛带原因的 Error，由 runCheck 透出
  const saveNow = useCallback(async () => {
    const d = draftRef.current;
    if (!d) return;
    setSaveState("saving");
    try {
      await putDraft(d);
      setSaveState("clean");
      setSaveError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      setSaveState("error");
      throw new Error(`草稿保存失败：${msg}`);
    }
  }, []);

  const runCheck = useCallback(async (install: boolean) => {
    if (busy) return;
    setBusy(true);
    setCheckErrors(null);
    setCheckResult(null);
    try {
      await saveNow();
      if (install) {
        const detail = await installPack(name);
        setInstalled(detail);
      } else {
        setCheckResult(await validatePack(name));
      }
    } catch (e) {
      setCheckErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }, [busy, name, saveNow]);

  const addNode = useCallback((type: BuilderNode["type"]) => {
    const cur = draftRef.current;
    const refPool =
      type === "harness" ? library?.harnesses ?? [] :
      type === "script" ? library?.scripts ?? [] :
      type === "command" ? library?.commands ?? [] :
      library?.submodules.map((s) => s.name) ?? [];
    const ref = refPool[0] ?? "";
    if (!ref) {
      setCheckErrors([`组件库暂无 ${type} 组件——先到左侧组件库${type === "script" ? "上传" : "新建"}。`]);
      return;
    }
    const i = cur?.nodes.length ?? 0;
    // label = 引用名_序号；删除后再添加可能撞现存名（PUT 会 400 拒重名），递增避让
    const names = new Set(cur?.nodes.map((n) => n.label) ?? []);
    let label = `${ref}_${i}`;
    let k = i;
    while (names.has(label)) { k += 1; label = `${ref}_${k}`; }
    const node: BuilderNode = {
      id: genId("n"),
      label,
      type,
      is_start: i === 0,
      join: "AND",
      position: { x: 60 + i * 30, y: 60 + i * 30 },
      inputs: {},
      [type]: ref,
    };
    onChange((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelected({ kind: "node", id: node.id });
  }, [library, onChange]);

  if (loadErr) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <div className={errTextCls}>草稿加载失败：{loadErr}</div>
        <Button variant="outline" size="sm" onClick={load}>重试</Button>
      </div>
    );
  }
  if (!draft) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">加载草稿…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b px-3">
        <span className="max-w-[200px] truncate text-[13px] font-semibold" title={draft.meta.name}>{draft.meta.name}</span>
        {saveState === "error" ? (
          <span className={`${errTextCls} max-w-[320px] truncate`} title={saveError ?? "保存失败"}>
            保存失败{saveError ? `：${saveError}` : ""}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {saveState === "clean" && "已保存"}
            {saveState === "dirty" && "编辑中…"}
            {saveState === "saving" && "保存中…"}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => setMetaOpen(true)}>元数据</Button>
        <Button variant="ghost" size="sm" onClick={() => setSpecOpen(true)}>Spec</Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <select className="rounded-control border border-input bg-transparent px-1.5 py-1 text-[12px]"
                value="" onChange={(e) => e.target.value && addNode(e.target.value as BuilderNode["type"])}>
          <option value="">+ 添加节点…</option>
          {ADD_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <Button variant="ghost" size="sm" title="dagre 自动布局"
                onClick={() => onChange((d) => relayout(d))}>
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => runCheck(false)}>
            <ShieldCheck className="h-3.5 w-3.5" />校验
          </Button>
          <Button size="sm" disabled={busy} onClick={() => runCheck(true)}>
            <Download className="h-3.5 w-3.5" />安装进 store
          </Button>
        </div>
      </header>

      {/* 主体：画布 + 配置面板 */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <EditableCanvas draft={draft} selected={selected} onSelect={setSelected} onChange={onChange} />
        </div>
        <aside className="flex w-72 shrink-0 flex-col overflow-auto border-l bg-sidebar">
          <NodePanel draft={draft} library={library} selected={selected}
                     onChange={onChange} onSelect={setSelected} />
        </aside>
      </div>

      {/* 校验结果 / tasklist 预览 */}
      {(checkErrors || checkResult) && (
        <div className="max-h-44 shrink-0 overflow-auto border-t bg-muted/40 px-3 py-2">
          {checkErrors?.map((m, i) => (
            <div key={i} className={errTextCls}>✗ {m}</div>
          ))}
          {checkResult && (
            <>
              <div className={`${okTextCls} mb-1`}>✓ 校验通过（Pack 语义：module.json + 引用完整性）</div>
              <div className="mb-1 font-mono text-[11px] text-muted-foreground">Flow</div>
              <pre className="whitespace-pre-wrap font-mono text-[12px]">{checkResult.tasklist.Flow || "（单节点无边）"}</pre>
              <div className="mb-1 mt-2 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <Table2 className="h-3 w-3" />Tasks
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[12px]">{JSON.stringify(checkResult.tasklist.Tasks, null, 2)}</pre>
            </>
          )}
        </div>
      )}

      {installed && (
        <div className={overlayCls} onClick={() => setInstalled(null)}>
          <div className={panelCls} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <GitMerge className="h-4 w-4 text-emerald-500" />安装成功：{installed.name}
            </div>
            <div className="text-[12px] text-muted-foreground">
              已装入 store（{installed.kind}）。可在模块库发起运行。
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInstalled(null)}>留在创建器</Button>
              <Button size="sm" onClick={() => onInstalled(installed.name)}>去模块库试运行</Button>
            </div>
          </div>
        </div>
      )}

      {metaOpen && (
        <MetaDialog draft={draft} onClose={() => setMetaOpen(false)}
                    onSave={(meta) => { onChange((d) => ({ ...d, meta })); setMetaOpen(false); }} />
      )}
      {specOpen && (
        <SpecDialog draft={draft} onClose={() => setSpecOpen(false)}
                    onSave={(spec_schema, default_spec) => {
                      onChange((d) => ({ ...d, spec_schema, default_spec }));
                      setSpecOpen(false);
                    }} />
      )}
    </div>
  );
}

function MetaDialog({ draft, onClose, onSave }: {
  draft: BuilderDraft; onClose: () => void;
  onSave: (meta: BuilderDraft["meta"]) => void;
}) {
  const [meta, setMeta] = useState(draft.meta);
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(meta.name)) { setErr("模块名须为 Python 标识符"); return; }
    onSave(meta);
  };
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">模块元数据</div>
        <div>
          <div className={labelCls}>名称（包名/选择器，创建后建议不改——改名等于换草稿）</div>
          <Input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} className="font-mono" />
        </div>
        <div>
          <div className={labelCls}>版本</div>
          <Input value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} className="font-mono" />
        </div>
        <div>
          <div className={labelCls}>描述</div>
          <Input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
        </div>
        {err && <div className={errTextCls}>{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={save}>保存</Button>
        </div>
      </div>
    </div>
  );
}

const SPEC_TYPES: SpecTypeName[] = ["str", "int", "float", "bool", "list", "dict", "any"];

function SpecDialog({ draft, onClose, onSave }: {
  draft: BuilderDraft; onClose: () => void;
  onSave: (schema: SpecField[], defaultSpec: Record<string, unknown>) => void;
}) {
  const [schema, setSchema] = useState<SpecField[]>(draft.spec_schema);
  const [defaultSpec, setDefaultSpec] = useState<Record<string, unknown>>(draft.default_spec);
  const schemaObj = Object.fromEntries(schema.map((f) => [f.field, f.type]));
  const addField = () => setSchema((s) => [...s, { field: `field_${s.length + 1}`, type: "str" }]);
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">spec_schema 与参考 spec</div>
        <div>
          <div className={labelCls}>输入字段（{`type ∈ ${SPEC_TYPES.join("/")}`}）</div>
          <div className="flex flex-col gap-1">
            {schema.map((f, i) => (
              <div key={i} className="flex items-center gap-1">
                <Input value={f.field} className="w-40 font-mono text-[12px]"
                       onChange={(e) => setSchema((s) => s.map((x, j) => (j === i ? { ...x, field: e.target.value.replace(/\s/g, "_") } : x)))} />
                <select className={fieldCls} value={f.type}
                        onChange={(e) => setSchema((s) => s.map((x, j) => (j === i ? { ...x, type: e.target.value as SpecTypeName } : x)))}>
                  {SPEC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <Button variant="ghost" size="icon" onClick={() => setSchema((s) => s.filter((_, j) => j !== i))}>×</Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start" onClick={addField}>添加字段</Button>
          </div>
        </div>
        <div>
          <div className={labelCls}>default_spec（参考值；inputs 里用 {"{spec.字段}"} 引用）</div>
          <SpecForm
            key={`builder-spec:${schema.map((f) => `${f.field}:${f.type}`).join(",")}`}
            schema={schemaObj}
            defaultSpec={defaultSpec}
            onChange={(spec) => setDefaultSpec(spec ?? {})}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => onSave(schema, defaultSpec)}>保存</Button>
        </div>
      </div>
    </div>
  );
}

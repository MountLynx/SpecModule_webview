// 模块创建器主区：顶栏（元数据/Spec/添加节点/自动布局/校验/安装·更新）+ 编辑画布 +
// 右侧配置面板 + 底部 tasklist 预览（validate 返回的服务端生成结果）。
// 草稿自动保存：变更置脏 → 800ms 防抖 PUT；校验/安装前先显式保存（saveNow）。
// 保存失败捕获服务端 message（saveError）就地透出——用户能看到为什么失败。
// 添加节点走选择对话框：组件可视化挑选 + 任务名建议可改（不再静默取清单首个自动命名）；
// 组件库清单监听变更事件自动刷新——侧栏新建 harness/command 后在开页签立即可选。
// 元数据/Spec 对话框同 ComponentForms：遮罩不关闭 + 本地草稿（useFormDraft）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, GitMerge, LayoutGrid, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SpecForm } from "../SpecForm";
import { errTextCls, fieldCls, labelCls, okTextCls, overlayCls, panelCls } from "../dialogTheme";
import {
  fetchDraft, fetchLibrary, fetchModules, genId, installPack, onLibraryChanged,
  putDraft, updatePack, validatePack,
  type BuilderDraft, type BuilderNode, type LibraryIndex, type ModuleDetail,
  type SpecField, type SpecTypeName, type ValidatePackResult,
} from "../../api";
import { useFormDraft } from "../../lib/formDraft";
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
  const [addType, setAddType] = useState<BuilderNode["type"] | null>(null);
  const [installed, setInstalled] =
    useState<{ detail: ModuleDetail; mode: "install" | "update" } | null>(null);
  const saveTimer = useRef<number | null>(null);
  // 回调里读最新草稿（addNode/saveNow 不入依赖数组）
  const draftRef = useRef<BuilderDraft | null>(null);
  draftRef.current = draft;

  const load = useCallback(() => {
    setLoadErr(null);
    fetchDraft(name)
      .then((d) => {
        // 反解产物无布局（全零坐标）——载入即自动重排一次（随自动保存落盘）
        setDraft(
          d.nodes.length > 0 && d.nodes.every((n) => n.position.x === 0 && n.position.y === 0)
            ? relayout(d)
            : d,
        );
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetchLibrary().then(setLibrary).catch(() => {}); // 库清单失败不阻塞——添加节点时提示
  }, [name]);

  useEffect(() => { load(); }, [load]);

  // 侧栏组件库增删改 → 重拉清单（window 事件；与 LibraryPanel 无共同父级状态）
  useEffect(() => onLibraryChanged(() => {
    fetchLibrary().then(setLibrary).catch(() => {});
  }), []);

  // 已装模块清单（name→kind）：草稿名命中已装 packed 模块 → 显示「更新模块」
  const [moduleKinds, setModuleKinds] = useState<Record<string, string>>({});
  const refreshModuleKinds = useCallback(() => {
    fetchModules()
      .then((ms) => setModuleKinds(Object.fromEntries(ms.modules.map((m) => [m.name, m.kind]))))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshModuleKinds(); }, [refreshModuleKinds]);

  const onChange = useCallback((fn: (d: BuilderDraft) => BuilderDraft) => {
    setDraft((prev) => prev && fn(prev));
    setSaveState("dirty");
    setCheckResult(null);
    setCheckErrors(null);
  }, []);

  // 保存成功落位（自动保存/saveNow 共用）：仅当仍是本轮在飞保存（saving）才落
  // clean 并清错误；在飞期间的新编辑会把 state 置回 dirty——保持 dirty，由已武装
  // 的下一轮防抖补存。直接覆写 clean 会把 dirty 打掉，effect 清理随即取消补存
  // 定时器 → 新改动永不保存而工具条显示已保存（静默丢改动）。
  const markSaved = useCallback(() => {
    setSaveState((s) => {
      if (s !== "saving") return s;
      setSaveError(null); // →clean 分支内才清错误（dirty 存续时旧错误仍相关；幂等，StrictMode 重复执行无害）
      return "clean";
    });
  }, []);

  // 自动保存（防抖）：dirty → 800ms 后 PUT；失败记 saveError 供工具条透出原因
  useEffect(() => {
    if (saveState !== "dirty" || !draft) return;
    saveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await putDraft(draft);
        markSaved();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
        setSaveState("error");
      }
    }, 800);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [draft, saveState, markSaved]);

  // 显式保存（校验/安装前置步骤）：失败抛带原因的 Error，由 runCheck 透出
  const saveNow = useCallback(async () => {
    const d = draftRef.current;
    if (!d) return;
    setSaveState("saving");
    try {
      await putDraft(d);
      markSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      setSaveState("error");
      throw new Error(`草稿保存失败：${msg}`);
    }
  }, [markSaved]);

  // 三态：validate / install / update——安装与更新都按草稿当前 meta.name（所见即所装；
  // 旧实现用页签名 name，改名后会装到旧草稿文件的内容）
  const runCheck = useCallback(async (mode: "validate" | "install" | "update") => {
    if (busy) return;
    setBusy(true);
    setCheckErrors(null);
    setCheckResult(null);
    try {
      await saveNow();
      const dname = draftRef.current?.meta.name ?? name;
      if (mode === "install") {
        const detail = await installPack(dname);
        setInstalled({ detail, mode: "install" });
        refreshModuleKinds();
      } else if (mode === "update") {
        const detail = await updatePack(dname);
        setInstalled({ detail, mode: "update" });
        refreshModuleKinds();
      } else {
        setCheckResult(await validatePack(dname));
      }
    } catch (e) {
      setCheckErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }, [busy, name, saveNow, refreshModuleKinds]);

  // 打开添加对话框：顺带拉最新组件清单——侧栏刚建好的组件立即可选（事件刷新外的双保险）
  const openAdd = useCallback((type: BuilderNode["type"]) => {
    setAddType(type);
    fetchLibrary().then(setLibrary).catch(() => {});
  }, []);

  // AddNodeDialog 确认：ref/label 由用户选定（label 建议已在对话框内避让现存名）
  const addNode = useCallback((type: BuilderNode["type"], ref: string, label: string) => {
    const i = draftRef.current?.nodes.length ?? 0;
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
    setAddType(null);
  }, [onChange]);

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

  // 草稿名命中已装 packed 模块 → 顶栏切「更新模块」（改名后自动切回安装 = 另存新模块）
  const isInstalledPacked = moduleKinds[draft.meta.name] === "packed";

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
                value="" onChange={(e) => e.target.value && openAdd(e.target.value as BuilderNode["type"])}>
          <option value="">+ 添加节点…</option>
          {ADD_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <Button variant="ghost" size="sm" title="dagre 自动布局"
                onClick={() => onChange((d) => relayout(d))}>
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => runCheck("validate")}>
            <ShieldCheck className="h-3.5 w-3.5" />校验
          </Button>
          {isInstalledPacked ? (
            <Button size="sm" disabled={busy}
                    title="以草稿内容覆盖更新已装模块（旧包自动备份，失败回滚）"
                    onClick={() => {
                      if (window.confirm(`更新已装模块「${draft.meta.name}」？store 内旧包将被替换。`)) {
                        runCheck("update");
                      }
                    }}>
              <RefreshCw className="h-3.5 w-3.5" />更新模块
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => runCheck("install")}>
              <Download className="h-3.5 w-3.5" />安装进 store
            </Button>
          )}
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
              <GitMerge className="h-4 w-4 text-emerald-500" />
              {installed.mode === "update" ? "更新成功" : "安装成功"}：{installed.detail.name}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {installed.mode === "update"
                ? "已覆盖更新 store 内模块（旧包已备份替换）。可继续编辑或发起运行验证。"
                : `已装入 store（${installed.detail.kind}）。可在模块库发起运行。`}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInstalled(null)}>留在创建器</Button>
              <Button size="sm" onClick={() => onInstalled(installed.detail.name)}>去模块库试运行</Button>
            </div>
          </div>
        </div>
      )}

      {addType && (
        <AddNodeDialog type={addType} draft={draft} library={library}
                       onCancel={() => setAddType(null)}
                       onAdd={(ref, label) => addNode(addType, ref, label)} />
      )}
      {metaOpen && (
        <MetaDialog name={name} draft={draft} onClose={() => setMetaOpen(false)}
                    onSave={(meta) => { onChange((d) => ({ ...d, meta })); setMetaOpen(false); }} />
      )}
      {specOpen && (
        <SpecDialog name={name} draft={draft} onClose={() => setSpecOpen(false)}
                    onSave={(spec_schema, default_spec) => {
                      onChange((d) => ({ ...d, spec_schema, default_spec }));
                      setSpecOpen(false);
                    }} />
      )}
    </div>
  );
}

function MetaDialog({ name, draft, onClose, onSave }: {
  name: string; draft: BuilderDraft; onClose: () => void;
  onSave: (meta: BuilderDraft["meta"]) => void;
}) {
  const { value: meta, setValue: setMeta, persist, clear: clearDraft, restored } =
    useFormDraft(`build-meta:${name}`, draft.meta);
  const [err, setErr] = useState<string | null>(null);
  // 编辑统一走 upd（同步落草稿）
  const upd = (patch: Partial<BuilderDraft["meta"]>) => {
    const next = { ...meta, ...patch };
    setMeta(next);
    persist(next);
  };
  const discard = () => { clearDraft(); onClose(); };
  const save = () => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(meta.name)) { setErr("模块名须为 Python 标识符"); return; }
    onSave(meta);
    clearDraft();
  };
  return (
    <div className={overlayCls}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">模块元数据</div>
        {restored && (
          <div className="text-[11px] text-muted-foreground">已恢复上次未保存的编辑（「取消」将丢弃）</div>
        )}
        <div>
          <div className={labelCls}>名称（包名/选择器，创建后建议不改——改名等于换草稿）</div>
          <Input value={meta.name} onChange={(e) => upd({ name: e.target.value })} className="font-mono" />
        </div>
        <div>
          <div className={labelCls}>版本</div>
          <Input value={meta.version} onChange={(e) => upd({ version: e.target.value })} className="font-mono" />
        </div>
        <div>
          <div className={labelCls}>描述</div>
          <Input value={meta.description} onChange={(e) => upd({ description: e.target.value })} />
        </div>
        {err && <div className={errTextCls}>{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={discard}>取消</Button>
          <Button size="sm" onClick={save}>保存</Button>
        </div>
      </div>
    </div>
  );
}

const SPEC_TYPES: SpecTypeName[] = ["str", "int", "float", "bool", "list", "dict", "any"];

interface SpecFormState { schema: SpecField[]; defaultSpec: Record<string, unknown> }

function SpecDialog({ name, draft, onClose, onSave }: {
  name: string; draft: BuilderDraft; onClose: () => void;
  onSave: (schema: SpecField[], defaultSpec: Record<string, unknown>) => void;
}) {
  const { value: spec, setValue: setSpec, persist, clear: clearDraft, restored } =
    useFormDraft<SpecFormState>(`build-spec:${name}`,
      { schema: draft.spec_schema, defaultSpec: draft.default_spec });
  const schema = spec.schema;
  const defaultSpec = spec.defaultSpec;
  // 编辑统一走包装器（同步落草稿）
  const setSchema = (fn: (s: SpecField[]) => SpecField[]) => {
    const next = { ...spec, schema: fn(spec.schema) };
    setSpec(next);
    persist(next);
  };
  const setDefaultSpec = (v: Record<string, unknown>) => {
    const next = { ...spec, defaultSpec: v };
    setSpec(next);
    persist(next);
  };
  const discard = () => { clearDraft(); onClose(); };
  const schemaObj = Object.fromEntries(schema.map((f) => [f.field, f.type]));
  const addField = () => setSchema((s) => [...s, { field: `field_${s.length + 1}`, type: "str" }]);
  // 布局契约：标题/底栏常驻，两个子区各自封顶内滚（max-h + 边框 pane）——字段再多
  // 也不把 default_spec/保存按钮挤出视口。SpecForm 不按 schema 内容重挂载（无 key）：
  // schema 编辑经 props 响应式反映，JSON 模式下点「添加字段」/改字段名不再丢失
  // 正在编辑的 JSON 与模式状态。
  return (
    <div className={overlayCls}>
      <div className="flex max-h-[86vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-lg bg-card text-[13px] text-card-foreground shadow-xl">
        <div className="shrink-0 border-b px-4 py-2.5 font-semibold">spec_schema 与参考 spec</div>
        {restored && (
          <div className="shrink-0 px-4 pt-2 text-[11px] text-muted-foreground">已恢复上次未保存的编辑（「取消」将丢弃）</div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <div>
            <div className={labelCls}>输入字段（{`type ∈ ${SPEC_TYPES.join("/")}`}）</div>
            <div className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto rounded-control border border-input p-1">
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
              <Button variant="outline" size="sm" className="m-1 self-start" onClick={addField}>添加字段</Button>
            </div>
          </div>
          <div>
            <div className={labelCls}>default_spec（参考值；inputs 里用 {"{spec.字段}"} 引用）</div>
            <div className="mb-1 text-[11px] text-muted-foreground">
              保存并「安装/更新模块」后，模块库发起页的「spec 参考」将预填这份值
            </div>
            <div className="max-h-[34vh] overflow-y-auto rounded-control border border-input p-2">
              <SpecForm
                schema={schemaObj}
                defaultSpec={defaultSpec}
                onChange={(spec) => setDefaultSpec(spec ?? {})}
              />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={discard}>取消</Button>
          <Button size="sm" onClick={() => { onSave(schema, defaultSpec); clearDraft(); }}>保存</Button>
        </div>
      </div>
    </div>
  );
}

// 添加节点对话框：组件可视化挑选 + 任务名建议可改——不再静默取清单首个并自动命名
function AddNodeDialog({ type, draft, library, onCancel, onAdd }: {
  type: BuilderNode["type"]; draft: BuilderDraft; library: LibraryIndex | null;
  onCancel: () => void; onAdd: (ref: string, label: string) => void;
}) {
  const pool: string[] =
    type === "harness" ? library?.harnesses ?? [] :
    type === "script" ? library?.scripts ?? [] :
    type === "command" ? library?.commands ?? [] :
    library?.submodules.map((s) => s.name) ?? [];
  const names = new Set(draft.nodes.map((n) => n.label));
  // 任务名建议 = 引用名_序号（避让现存名，与旧自动命名规则一致；PUT 拒重名）
  const suggest = (ref: string) => {
    let k = draft.nodes.length;
    let label = `${ref}_${k}`;
    while (names.has(label)) { k += 1; label = `${ref}_${k}`; }
    return label;
  };
  const [ref, setRef] = useState(pool[0] ?? "");
  const [label, setLabel] = useState(pool[0] ? suggest(pool[0]) : "");
  const [labelTouched, setLabelTouched] = useState(false);
  const typeLabel = ADD_TYPES.find((t) => t.type === type)?.label ?? type;
  const pickRef = (r: string) => {
    setRef(r);
    if (!labelTouched) setLabel(suggest(r)); // 任务名没手改过才跟随换建议
  };
  const labelDup = label !== "" && names.has(label);
  return (
    <div className={overlayCls}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">新建节点（{typeLabel}）</div>
        <div>
          <div className={labelCls}>组件引用（{type}）</div>
          {pool.length === 0 ? (
            <div className={errTextCls}>
              组件库暂无 {type} 组件——先到左侧组件库{type === "script" ? "上传" : "新建"}。
            </div>
          ) : (
            <div className="flex max-h-44 flex-col gap-0.5 overflow-auto rounded-control border border-input p-1">
              {pool.map((o) => (
                <label key={o}
                       className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-[12px] ${o === ref ? "bg-accent" : "hover:bg-accent/60"}`}>
                  <input type="radio" name="builder-addnode-ref" checked={o === ref} onChange={() => pickRef(o)} />
                  {o}
                </label>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className={labelCls}>任务名（Flow 引用名，标识符）</div>
          <Input value={label} className="font-mono"
                 onChange={(e) => { setLabelTouched(true); setLabel(e.target.value.replace(/\s/g, "_")); }} />
          {labelDup && <div className={errTextCls}>任务名已存在，换一个</div>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
          <Button size="sm" disabled={!ref || !label || labelDup} onClick={() => onAdd(ref, label)}>添加</Button>
        </div>
      </div>
    </div>
  );
}

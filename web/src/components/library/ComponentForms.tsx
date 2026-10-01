// harness/command 组件表单对话框（自绘 overlay，dialogTheme 共享类）。
// 字段对照库 HarnessConfig / CommandConfig；保存走 PUT /api/library/{kind}/{name}，
// 服务端 from_dict 实例化验形——前端不做深校验，错误透出。
// 编辑模式（initial 非空）挂载时回填已存配置——同一端点 PUT，读-改-写而非盲覆盖。
// 遮罩点击不关闭（防误触丢编辑，仅 ×/取消 显式退出）；编辑即时落本地草稿
// （useFormDraft）——刷新/崩溃后重开自动恢复，「取消」显式丢弃。
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { errTextCls, fieldCls, labelCls, overlayCls, panelCls } from "../dialogTheme";
import { fetchLibraryItem, putLibraryJson } from "../../api";
import { useFormDraft } from "../../lib/formDraft";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 回填取值：null/undefined → 缺省，其余转字符串 */
const asText = (v: unknown, dflt = ""): string => (v == null ? dflt : String(v));

interface DialogProps {
  initial: string | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className={labelCls}>{label}</div>
      {children}
    </div>
  );
}

/** 表单对话框外壳：遮罩点击不关闭（防误触丢编辑），仅 ×/取消 显式退出 */
function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className={overlayCls}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <div className="text-[13px] font-semibold">{title}</div>
          <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
                  title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 草稿恢复提示（本次挂载来自 localStorage 恢复时置于表单顶部） */
function RestoredHint({ restored }: { restored: boolean }) {
  if (!restored) return null;
  return <div className="text-[11px] text-muted-foreground">已恢复上次未保存的编辑（「取消」将丢弃）</div>;
}

function NewKeyInput({ onAdd }: { onAdd: (k: string) => void }) {
  const [k, setK] = useState("");
  return (
    <>
      <Input value={k} placeholder="新键名" onChange={(e) => setK(e.target.value)} className="w-28 font-mono text-[12px]" />
      <Button variant="outline" size="sm" disabled={!k} onClick={() => { onAdd(k); setK(""); }}>添加键</Button>
    </>
  );
}

/** 键值对行编辑（prompt_modes / env 共用） */
function KvRows({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries(value);
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const del = (k: string) => {
    const next = { ...value };
    delete next[k];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <Input value={k} disabled className="w-28 font-mono text-[12px]" />
          <span className="text-muted-foreground">=</span>
          <Input value={v} onChange={(e) => set(k, e.target.value)} className="flex-1 font-mono text-[12px]" />
          <Button variant="ghost" size="icon" title="删除" onClick={() => del(k)}>×</Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <NewKeyInput onAdd={(k) => onChange({ ...value, [k]: "" })} />
      </div>
    </div>
  );
}

/** harness 表单整体（含名称/动态选项集/否定约束，作为一份草稿持久化） */
interface HarnessForm {
  name: string;
  prompt_core: string; model: string; temperature: string; think: string; api_params: string;
  mode: string; image_size: string; image_dir: string; validate_retries: string;
  out_type: string; out_schema: string; out_instruction: string;
  promptModes: Record<string, string>; notdo: string;
}

const HARNESS_EMPTY: HarnessForm = {
  name: "", prompt_core: "", model: "", temperature: "", think: "", api_params: "",
  mode: "text", image_size: "", image_dir: "images", validate_retries: "",
  out_type: "", out_schema: "", out_instruction: "", promptModes: {}, notdo: "",
};

export function HarnessDialog({ initial, onClose, onSaved }: DialogProps) {
  // 在途草稿按「类:名」锚定（新建 = __new__）；本地草稿优先于服务器回填——
  // 草稿存在即有未保存的在途编辑，回填反而会覆盖用户意图。
  const draftKey = `harness:${initial ?? "__new__"}`;
  const { value: form, setValue: setForm, persist, clear: clearDraft, restored } =
    useFormDraft<HarnessForm>(draftKey, HARNESS_EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!initial && !restored);
  // 编辑模式回填（本地草稿优先时不拉取）；失败示错并保持对话框打开（必填校验挡住半空保存）
  useEffect(() => {
    if (!initial || restored) return;
    let cancelled = false;
    fetchLibraryItem("harnesses", initial)
      .then((raw) => {
        if (cancelled) return;
        const s = raw as Record<string, unknown>;
        const pm = (s.prompt_modes ?? {}) as Record<string, unknown>;
        const of = (s.output_format ?? {}) as Record<string, unknown>;
        const think = s.think;
        const ap = s.api_params;
        const apEmpty =
          ap == null || (typeof ap === "object" && Object.keys(ap as object).length === 0);
        setForm({
          ...HARNESS_EMPTY,
          name: initial,
          prompt_core: asText(s.prompt_core),
          model: asText(s.model),
          temperature: s.temperature == null ? "" : String(s.temperature),
          think:
            typeof think === "boolean" ? (think ? "true" : "false")
            : think != null && typeof think === "object" ? JSON.stringify(think)
            : "",
          api_params: apEmpty ? "" : JSON.stringify(ap),
          mode: asText(s.mode, "text"),
          image_size: asText(s.image_size),
          image_dir: asText(s.image_dir, "images"),
          validate_retries: s.validate_retries == null ? "" : String(s.validate_retries),
          out_type: asText(of.type),
          out_schema: of.schema == null ? "" : JSON.stringify(of.schema),
          out_instruction: asText(of.instruction),
          promptModes: Object.fromEntries(Object.entries(pm).map(([k, v]) => [k, String(v)])),
          notdo: Array.isArray(s.notdo) ? s.notdo.map(String).join(", ") : asText(s.notdo),
        });
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoading(false);
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [initial, restored, setForm]);
  if (loading) {
    return (
      <Overlay title={initial ? `编辑 harness：${initial}` : "新建 harness"} onClose={onClose}>
        <div className="text-[12px] text-muted-foreground">加载中…</div>
      </Overlay>
    );
  }
  // 用户编辑统一走 upd（同步落草稿）；回填 setForm 不持久化——草稿只在用户动过之后存在
  const upd = (patch: Partial<HarnessForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    persist(next);
  };
  const discard = () => { clearDraft(); onClose(); };

  const save = async () => {
    const name = form.name;
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符"); return; }
    if (!form.prompt_core.trim()) { setErr("prompt_core 必填"); return; }
    // 载荷只带非空字段；数值/JSON 解析失败就地示错
    const payload: Record<string, unknown> = { name, prompt_core: form.prompt_core };
    if (Object.keys(form.promptModes).length) payload.prompt_modes = form.promptModes;
    if (form.notdo.trim()) payload.notdo = form.notdo.split(",").map((s) => s.trim()).filter(Boolean);
    if (form.model.trim()) payload.model = form.model.trim();
    if (form.temperature.trim()) {
      const t = Number(form.temperature);
      if (!Number.isFinite(t)) { setErr("temperature 须为数字"); return; }
      payload.temperature = t;
    }
    if (form.think.trim()) {
      if (form.think === "true" || form.think === "false") payload.think = form.think === "true";
      else { try { payload.think = JSON.parse(form.think); } catch { setErr("think 须为 true/false/JSON"); return; } }
    }
    if (form.api_params.trim()) {
      try { payload.api_params = JSON.parse(form.api_params); } catch { setErr("api_params 须为合法 JSON"); return; }
    }
    if (form.mode === "image") {
      payload.mode = "image";
      if (form.image_size.trim()) payload.image_size = form.image_size.trim();
      payload.image_dir = form.image_dir || "images";
    }
    if (form.validate_retries.trim()) {
      const vr = Number(form.validate_retries);
      if (!Number.isInteger(vr) || vr < 0) { setErr("validate_retries 须为 >= 0 的整数"); return; }
      if (vr > 0) {
        if (form.mode === "image") { setErr("image 模式无文本输出可校验，validate_retries 须为 0"); return; }
        payload.validate_retries = vr;
      }
    }
    if (form.out_type) {
      const of: Record<string, unknown> = { type: form.out_type };
      if (form.out_type === "json_schema" && form.out_schema.trim()) {
        try { of.schema = JSON.parse(form.out_schema); } catch { setErr("output schema 须为合法 JSON"); return; }
      }
      if (form.out_instruction.trim()) of.instruction = form.out_instruction;
      payload.output_format = of;
    }
    setBusy(true); setErr(null);
    try {
      await putLibraryJson("harnesses", name, payload);
      clearDraft();
      onSaved(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Overlay title={initial ? `编辑 harness：${initial}` : "新建 harness"} onClose={discard}>
      <RestoredHint restored={restored} />
      <Row label="名称（注册名）">
        <Input value={form.name} disabled={!!initial} onChange={(e) => upd({ name: e.target.value })} className="font-mono" />
      </Row>
      <Row label="prompt_core（必填，支持 {key} 占位）">
        <Textarea value={form.prompt_core} onChange={(e) => upd({ prompt_core: e.target.value })} rows={3} />
      </Row>
      <Row label="prompt_modes（动态选项集）">
        <KvRows value={form.promptModes} onChange={(v) => upd({ promptModes: v })} />
      </Row>
      <Row label="notdo（否定性约束，逗号分隔）">
        <Input value={form.notdo} onChange={(e) => upd({ notdo: e.target.value })} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="model"><Input value={form.model} onChange={(e) => upd({ model: e.target.value })} /></Row>
        <Row label="temperature"><Input value={form.temperature} onChange={(e) => upd({ temperature: e.target.value })} placeholder="0.3" /></Row>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Row label="think（true/false/JSON，空=不设）"><Input value={form.think} onChange={(e) => upd({ think: e.target.value })} /></Row>
        <Row label="mode">
          <select className={fieldCls} value={form.mode} onChange={(e) => upd({ mode: e.target.value })}>
            <option value="text">text</option>
            <option value="image">image</option>
          </select>
        </Row>
        <Row label="validate_retries（校验失败重试）">
          <Input value={form.validate_retries} onChange={(e) => upd({ validate_retries: e.target.value })} placeholder="0（缺省不重试）" />
        </Row>
      </div>
      {form.mode === "image" && (
        <div className="grid grid-cols-2 gap-2">
          <Row label="image_size"><Input value={form.image_size} onChange={(e) => upd({ image_size: e.target.value })} placeholder="1024x1024" /></Row>
          <Row label="image_dir"><Input value={form.image_dir} onChange={(e) => upd({ image_dir: e.target.value })} /></Row>
        </div>
      )}
      <Row label="api_params（SDK 透传 JSON，空=不设）">
        <Textarea value={form.api_params} onChange={(e) => upd({ api_params: e.target.value })} rows={2} className="font-mono" />
      </Row>
      <div className="grid grid-cols-3 gap-2">
        <Row label="output_format">
          <select className={fieldCls} value={form.out_type} onChange={(e) => upd({ out_type: e.target.value })}>
            <option value="">（不约束）</option>
            <option value="json_object">json_object</option>
            <option value="json_schema">json_schema</option>
            <option value="text">text</option>
          </select>
        </Row>
        {form.out_type === "json_schema" && (
          <Row label="schema JSON">
            <Textarea value={form.out_schema} onChange={(e) => upd({ out_schema: e.target.value })} rows={2} className="font-mono" />
          </Row>
        )}
        {form.out_type && (
          <Row label="instruction"><Input value={form.out_instruction} onChange={(e) => upd({ out_instruction: e.target.value })} /></Row>
        )}
      </div>
      {err && <div className={errTextCls}>{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={discard}>取消</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
    </Overlay>
  );
}

/** command 表单整体（含名称/环境变量/开关，作为一份草稿持久化） */
interface CommandForm {
  name: string; command: string; timeout_: string; cwd: string;
  env: Record<string, string>; capture: boolean; shell: boolean;
}

const COMMAND_EMPTY: CommandForm = { name: "", command: "", timeout_: "60", cwd: "", env: {}, capture: true, shell: true };

export function CommandDialog({ initial, onClose, onSaved }: DialogProps) {
  const draftKey = `command:${initial ?? "__new__"}`;
  const { value: form, setValue: setForm, persist, clear: clearDraft, restored } =
    useFormDraft<CommandForm>(draftKey, COMMAND_EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!initial && !restored);
  // 编辑模式回填（本地草稿优先时不拉取）；失败示错并保持对话框打开
  useEffect(() => {
    if (!initial || restored) return;
    let cancelled = false;
    fetchLibraryItem("commands", initial)
      .then((raw) => {
        if (cancelled) return;
        const s = raw as Record<string, unknown>;
        const storedEnv = (s.env ?? {}) as Record<string, unknown>;
        setForm({
          ...COMMAND_EMPTY,
          name: initial,
          command: asText(s.command),
          timeout_: s.timeout == null ? "60" : String(s.timeout),
          cwd: asText(s.cwd),
          env: Object.fromEntries(Object.entries(storedEnv).map(([k, v]) => [k, String(v)])),
          capture: s.capture_output == null ? true : Boolean(s.capture_output),
          shell: s.shell == null ? true : Boolean(s.shell),
        });
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoading(false);
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [initial, restored, setForm]);
  if (loading) {
    return (
      <Overlay title={initial ? `编辑 command：${initial}` : "新建 command"} onClose={onClose}>
        <div className="text-[12px] text-muted-foreground">加载中…</div>
      </Overlay>
    );
  }
  const upd = (patch: Partial<CommandForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    persist(next);
  };
  const discard = () => { clearDraft(); onClose(); };

  const save = async () => {
    const name = form.name;
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符"); return; }
    if (!form.command.trim()) { setErr("command 必填"); return; }
    let timeout = 60;
    if (form.timeout_.trim()) {
      const t = Number(form.timeout_);
      if (!Number.isFinite(t) || t <= 0) { setErr("timeout 须为正数"); return; }
      timeout = t;
    }
    const payload: Record<string, unknown> = { name, command: form.command, timeout };
    if (form.cwd.trim()) payload.cwd = form.cwd.trim();
    if (Object.keys(form.env).length) payload.env = form.env;
    payload.capture_output = form.capture;
    payload.shell = form.shell;
    setBusy(true); setErr(null);
    try {
      await putLibraryJson("commands", name, payload);
      clearDraft();
      onSaved(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Overlay title={initial ? `编辑 command：${initial}` : "新建 command"} onClose={discard}>
      <RestoredHint restored={restored} />
      <Row label="名称（注册名）">
        <Input value={form.name} disabled={!!initial} onChange={(e) => upd({ name: e.target.value })} className="font-mono" />
      </Row>
      <Row label="shell 命令（必填）">
        <Textarea value={form.command} onChange={(e) => upd({ command: e.target.value })} rows={2} className="font-mono" />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="timeout（秒）"><Input value={form.timeout_} onChange={(e) => upd({ timeout_: e.target.value })} /></Row>
        <Row label="cwd（空=缺省）"><Input value={form.cwd} onChange={(e) => upd({ cwd: e.target.value })} /></Row>
      </div>
      <Row label="env（额外环境变量）"><KvRows value={form.env} onChange={(v) => upd({ env: v })} /></Row>
      <div className="flex gap-4 text-[12px]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.capture} onChange={(e) => upd({ capture: e.target.checked })} />capture_output</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.shell} onChange={(e) => upd({ shell: e.target.checked })} />shell</label>
      </div>
      {err && <div className={errTextCls}>{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={discard}>取消</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
    </Overlay>
  );
}

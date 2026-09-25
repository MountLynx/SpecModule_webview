// harness/command 组件表单对话框（自绘 overlay，dialogTheme 共享类）。
// 字段对照库 HarnessConfig / CommandConfig；保存走 PUT /api/library/{kind}/{name}，
// 服务端 from_dict 实例化验形——前端不做深校验，错误透出。
import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { errTextCls, fieldCls, labelCls, overlayCls, panelCls } from "../dialogTheme";
import { putLibraryJson } from "../../api";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
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

const HARNESS_EMPTY = {
  prompt_core: "", model: "", temperature: "", think: "", api_params: "",
  mode: "text", image_size: "", image_dir: "images",
  out_type: "", out_schema: "", out_instruction: "",
};

export function HarnessDialog({ initial, onClose, onSaved }: DialogProps) {
  const [name, setName] = useState(initial ?? "");
  const [f, setF] = useState(HARNESS_EMPTY);
  const [promptModes, setPromptModes] = useState<Record<string, string>>({});
  const [notdo, setNotdo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));

  const save = async () => {
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符"); return; }
    if (!f.prompt_core.trim()) { setErr("prompt_core 必填"); return; }
    // 载荷只带非空字段；数值/JSON 解析失败就地示错
    const payload: Record<string, unknown> = { name, prompt_core: f.prompt_core };
    if (Object.keys(promptModes).length) payload.prompt_modes = promptModes;
    if (notdo.trim()) payload.notdo = notdo.split(",").map((s) => s.trim()).filter(Boolean);
    if (f.model.trim()) payload.model = f.model.trim();
    if (f.temperature.trim()) {
      const t = Number(f.temperature);
      if (!Number.isFinite(t)) { setErr("temperature 须为数字"); return; }
      payload.temperature = t;
    }
    if (f.think.trim()) {
      if (f.think === "true" || f.think === "false") payload.think = f.think === "true";
      else { try { payload.think = JSON.parse(f.think); } catch { setErr("think 须为 true/false/JSON"); return; } }
    }
    if (f.api_params.trim()) {
      try { payload.api_params = JSON.parse(f.api_params); } catch { setErr("api_params 须为合法 JSON"); return; }
    }
    if (f.mode === "image") {
      payload.mode = "image";
      if (f.image_size.trim()) payload.image_size = f.image_size.trim();
      payload.image_dir = f.image_dir || "images";
    }
    if (f.out_type) {
      const of: Record<string, unknown> = { type: f.out_type };
      if (f.out_type === "json_schema" && f.out_schema.trim()) {
        try { of.schema = JSON.parse(f.out_schema); } catch { setErr("output schema 须为合法 JSON"); return; }
      }
      if (f.out_instruction.trim()) of.instruction = f.out_instruction;
      payload.output_format = of;
    }
    setBusy(true); setErr(null);
    try {
      await putLibraryJson("harnesses", name, payload);
      onSaved(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Overlay title={initial ? `编辑 harness：${initial}` : "新建 harness"} onClose={onClose}>
      <Row label="名称（注册名）">
        <Input value={name} disabled={!!initial} onChange={(e) => setName(e.target.value)} className="font-mono" />
      </Row>
      <Row label="prompt_core（必填，支持 {key} 占位）">
        <Textarea value={f.prompt_core} onChange={(e) => upd({ prompt_core: e.target.value })} rows={3} />
      </Row>
      <Row label="prompt_modes（动态选项集）"><KvRows value={promptModes} onChange={setPromptModes} /></Row>
      <Row label="notdo（否定性约束，逗号分隔）">
        <Input value={notdo} onChange={(e) => setNotdo(e.target.value)} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="model"><Input value={f.model} onChange={(e) => upd({ model: e.target.value })} /></Row>
        <Row label="temperature"><Input value={f.temperature} onChange={(e) => upd({ temperature: e.target.value })} placeholder="0.3" /></Row>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Row label="think（true/false/JSON，空=不设）"><Input value={f.think} onChange={(e) => upd({ think: e.target.value })} /></Row>
        <Row label="mode">
          <select className={fieldCls} value={f.mode} onChange={(e) => upd({ mode: e.target.value })}>
            <option value="text">text</option>
            <option value="image">image</option>
          </select>
        </Row>
      </div>
      {f.mode === "image" && (
        <div className="grid grid-cols-2 gap-2">
          <Row label="image_size"><Input value={f.image_size} onChange={(e) => upd({ image_size: e.target.value })} placeholder="1024x1024" /></Row>
          <Row label="image_dir"><Input value={f.image_dir} onChange={(e) => upd({ image_dir: e.target.value })} /></Row>
        </div>
      )}
      <Row label="api_params（SDK 透传 JSON，空=不设）">
        <Textarea value={f.api_params} onChange={(e) => upd({ api_params: e.target.value })} rows={2} className="font-mono" />
      </Row>
      <div className="grid grid-cols-3 gap-2">
        <Row label="output_format">
          <select className={fieldCls} value={f.out_type} onChange={(e) => upd({ out_type: e.target.value })}>
            <option value="">（不约束）</option>
            <option value="json_object">json_object</option>
            <option value="json_schema">json_schema</option>
            <option value="text">text</option>
          </select>
        </Row>
        {f.out_type === "json_schema" && (
          <Row label="schema JSON">
            <Textarea value={f.out_schema} onChange={(e) => upd({ out_schema: e.target.value })} rows={2} className="font-mono" />
          </Row>
        )}
        {f.out_type && (
          <Row label="instruction"><Input value={f.out_instruction} onChange={(e) => upd({ out_instruction: e.target.value })} /></Row>
        )}
      </div>
      {err && <div className={errTextCls}>{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
    </Overlay>
  );
}

export function CommandDialog({ initial, onClose, onSaved }: DialogProps) {
  const [name, setName] = useState(initial ?? "");
  const [command, setCommand] = useState("");
  const [timeout_, setTimeout_] = useState("60");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [capture, setCapture] = useState(true);
  const [shell, setShell] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!NAME_RE.test(name)) { setErr("名称须为 Python 标识符"); return; }
    if (!command.trim()) { setErr("command 必填"); return; }
    let timeout = 60;
    if (timeout_.trim()) {
      const t = Number(timeout_);
      if (!Number.isFinite(t) || t <= 0) { setErr("timeout 须为正数"); return; }
      timeout = t;
    }
    const payload: Record<string, unknown> = { name, command, timeout };
    if (cwd.trim()) payload.cwd = cwd.trim();
    if (Object.keys(env).length) payload.env = env;
    payload.capture_output = capture;
    payload.shell = shell;
    setBusy(true); setErr(null);
    try {
      await putLibraryJson("commands", name, payload);
      onSaved(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Overlay title={initial ? `编辑 command：${initial}` : "新建 command"} onClose={onClose}>
      <Row label="名称（注册名）">
        <Input value={name} disabled={!!initial} onChange={(e) => setName(e.target.value)} className="font-mono" />
      </Row>
      <Row label="shell 命令（必填）">
        <Textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={2} className="font-mono" />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="timeout（秒）"><Input value={timeout_} onChange={(e) => setTimeout_(e.target.value)} /></Row>
        <Row label="cwd（空=缺省）"><Input value={cwd} onChange={(e) => setCwd(e.target.value)} /></Row>
      </div>
      <Row label="env（额外环境变量）"><KvRows value={env} onChange={setEnv} /></Row>
      <div className="flex gap-4 text-[12px]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} />capture_output</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={shell} onChange={(e) => setShell(e.target.checked)} />shell</label>
      </div>
      {err && <div className={errTextCls}>{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
    </Overlay>
  );
}

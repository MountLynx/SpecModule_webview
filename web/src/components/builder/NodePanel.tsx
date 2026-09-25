// 选中对象配置面板：节点（label/起点/join/组件引用/inputs 映射/覆盖参数/outputs）
// 或边（guard 选择）。组件引用从库清单选择；inputs 生产者支持下拉建议
// （上游任务名 / {spec.字段} / 原始 token）。
import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { fieldCls, labelCls } from "../dialogTheme";
import {
  NODE_REF_FIELD,
  type BuilderDraft,
  type BuilderEdge,
  type BuilderNode,
  type LibraryIndex,
} from "../../api";
import type { Selection } from "./EditableCanvas";

interface Props {
  draft: BuilderDraft;
  library: LibraryIndex | null;
  selected: Selection;
  onChange: (fn: (d: BuilderDraft) => BuilderDraft) => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function InputsEditor({ node, draft, onChange }: {
  node: BuilderNode; draft: BuilderDraft;
  onChange: (inputs: Record<string, string>) => void;
}) {
  const upstream = draft.nodes
    .filter((n) => n.id !== node.id)
    .map((n) => n.label);
  const specFields = draft.spec_schema.map((f) => `{spec.${f.field}}`);
  const suggestions = [...upstream, ...specFields, "{spec}", "{tasklist}", "{node}"];
  const entries = Object.entries(node.inputs);
  const listId = `inputs-sug-${node.id}`;
  return (
    <>
      <datalist id={listId}>
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
      <div className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1">
            <Input value={k} disabled className="w-24 font-mono text-[12px]" />
            <span className="text-[11px] text-muted-foreground">←</span>
            <Input value={v} list={listId} className="flex-1 font-mono text-[12px]"
                   onChange={(e) => onChange({ ...node.inputs, [k]: e.target.value })} />
            <Button variant="ghost" size="icon" title="删除"
                    onClick={() => { const next = { ...node.inputs }; delete next[k]; onChange(next); }}>×</Button>
          </div>
        ))}
        <NewInputRow onAdd={(k) => onChange({ ...node.inputs, [k]: "" })} />
      </div>
    </>
  );
}

function NewInputRow({ onAdd }: { onAdd: (k: string) => void }) {
  const [k, setK] = useState("");
  return (
    <div className="flex items-center gap-1">
      <Input value={k} placeholder="输入字段名" onChange={(e) => setK(e.target.value)}
             className="w-24 font-mono text-[12px]" />
      <Button variant="outline" size="sm" disabled={!k}
              onClick={() => { onAdd(k); setK(""); }}>添加输入</Button>
    </div>
  );
}

/** submodule outputs 映射加行：先填本节点字段名再添加（重名 = 覆盖旧值） */
function NewOutputRow({ onAdd }: { onAdd: (k: string) => void }) {
  const [k, setK] = useState("");
  return (
    <div className="flex items-center gap-1">
      <Input value={k} placeholder="输出字段名" onChange={(e) => setK(e.target.value)}
             className="w-24 font-mono text-[12px]" />
      <Button variant="outline" size="sm" disabled={!k}
              onClick={() => { onAdd(k); setK(""); }}>添加映射</Button>
    </div>
  );
}

/** harness 覆盖参数（常用两项类型化 + 其余 JSON） */
function OverridesEditor({ node, onChange }: {
  node: BuilderNode; onChange: (patch: Record<string, unknown> | undefined) => void;
}) {
  const ov = (node.overrides ?? {}) as Record<string, unknown>;
  const set = (k: string, v: unknown) => {
    const next = { ...ov, [k]: v };
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="mb-0.5 text-[11px] text-muted-foreground">model（覆盖库值，空=不覆盖）</div>
        <Input value={String(ov.model ?? "")} className="font-mono text-[12px]"
               onChange={(e) => set("model", e.target.value || undefined)} />
      </div>
      <div>
        <div className="mb-0.5 text-[11px] text-muted-foreground">temperature（空=不覆盖）</div>
        <Input value={ov.temperature === undefined ? "" : String(ov.temperature)}
               className="font-mono text-[12px]" placeholder="0.3"
               onChange={(e) => {
                 const n = Number(e.target.value);
                 set("temperature", e.target.value !== "" && Number.isFinite(n) ? n : undefined);
               }} />
      </div>
      <div>
        <div className="mb-0.5 text-[11px] text-muted-foreground">其余覆盖（JSON：promptmode/prompt/outputformat/notdo/…，空=无）</div>
        <textarea
          className="w-full rounded-control border border-input bg-transparent px-2 py-1 font-mono text-[12px]"
          rows={2}
          value={JSON.stringify(
            Object.fromEntries(Object.entries(ov).filter(([k]) => !["model", "temperature"].includes(k))),
            null, 0)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value || "{}");
              onChange({ ...parsed, ...(ov.model ? { model: ov.model } : {}), ...(ov.temperature !== undefined ? { temperature: ov.temperature } : {}) });
            } catch { /* 非法 JSON 编辑中：不打断输入 */ }
          }}
        />
      </div>
    </div>
  );
}

function NodePanelInner({ node, draft, library, onChange, onSelect }: {
  node: BuilderNode; draft: BuilderDraft; library: LibraryIndex | null;
  onChange: Props["onChange"]; onSelect: (s: Selection) => void;
}) {
  const patch = (p: Partial<BuilderNode>) =>
    onChange((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, ...p } : n)) }));
  // command 覆盖按键设值：单键清空不清掉另一键；全空则整体撤销 overrides
  const setOv = (kv: Record<string, unknown>) => {
    const next = { ...node.overrides, ...kv };
    for (const k of Object.keys(next)) {
      if (next[k] === undefined) delete next[k];
    }
    patch({ overrides: Object.keys(next).length ? next : undefined });
  };
  const refField = NODE_REF_FIELD[node.type];
  const options: string[] =
    node.type === "harness" ? library?.harnesses ?? [] :
    node.type === "script" ? library?.scripts ?? [] :
    node.type === "command" ? library?.commands ?? [] :
    library?.submodules.map((s) => s.name) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <Section title="任务名（Flow 引用名，标识符）">
        <Input value={node.label} className="font-mono"
               onChange={(e) => patch({ label: e.target.value.replace(/\s/g, "_") })} />
      </Section>
      <Section title="组件引用（从组件库选择）">
        <select className={fieldCls} value={String(node[refField] ?? "")}
                onChange={(e) => patch({ [refField]: e.target.value } as Partial<BuilderNode>)}>
          <option value="">（选择 {node.type}）</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <div className="mt-1 text-[11px] text-muted-foreground">
          缺组件？先到左侧组件库{node.type === "script" ? "上传" : "新建"}。
        </div>
      </Section>
      <Section title="流转">
        <div className="flex items-center gap-3 text-[12px]">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={node.is_start} onChange={(e) => patch({ is_start: e.target.checked })} />
            起点节点
          </label>
          <label className="flex items-center gap-1">
            join
            <select className="rounded-control border border-input bg-transparent px-1 py-0.5"
                    value={node.join} onChange={(e) => patch({ join: e.target.value as "AND" | "OR" })}>
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          </label>
        </div>
      </Section>
      <Section title="inputs 映射（字段 ← 上游节点 / {spec.字段} / token）">
        <InputsEditor node={node} draft={draft}
                      onChange={(inputs) => patch({ inputs })} />
      </Section>
      {node.type === "harness" && (
        <Section title="LLM 覆盖参数（留空 = 用库组件值）">
          <OverridesEditor node={node}
                           onChange={(o) => patch({ overrides: o && Object.keys(o).length ? o : undefined })} />
        </Section>
      )}
      {node.type === "command" && (
        <Section title="command 覆盖（留空 = 用库组件值）">
          <div className="flex flex-col gap-1.5">
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground">timeout（秒）</div>
              <Input value={node.overrides?.timeout === undefined ? "" : String(node.overrides.timeout)}
                     className="font-mono text-[12px]"
                     onChange={(e) => {
                       const n = Number(e.target.value);
                       setOv({ timeout: e.target.value !== "" && Number.isFinite(n) ? n : undefined });
                     }} />
            </div>
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground">cwd</div>
              <Input value={String(node.overrides?.cwd ?? "")} className="font-mono text-[12px]"
                     onChange={(e) => setOv({ cwd: e.target.value === "" ? undefined : e.target.value })} />
            </div>
          </div>
        </Section>
      )}
      {node.type === "submodule" && (
        <Section title="outputs 映射（本节点字段 ← 子输出字段，空=全量透出）">
          <div className="flex flex-col gap-1">
            {Object.entries(node.outputs ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1">
                <Input value={k} disabled className="w-24 font-mono text-[12px]" />
                <span className="text-[11px] text-muted-foreground">←</span>
                <Input value={v} className="flex-1 font-mono text-[12px]"
                       onChange={(e) => patch({ outputs: { ...node.outputs, [k]: e.target.value } })} />
                <Button variant="ghost" size="icon" onClick={() => {
                  const next = { ...node.outputs }; delete next[k]; patch({ outputs: next });
                }}>×</Button>
              </div>
            ))}
            <NewOutputRow onAdd={(k) => patch({ outputs: { ...node.outputs, [k]: "" } })} />
          </div>
        </Section>
      )}
      <Section title="危险操作">
        <Button variant="destructive" size="sm"
                onClick={() => {
                  onChange((d) => ({
                    ...d,
                    nodes: d.nodes.filter((n) => n.id !== node.id),
                    edges: d.edges.filter((e) => e.from !== node.id && e.to !== node.id),
                  }));
                  onSelect(null);
                }}>
          删除节点
        </Button>
      </Section>
    </div>
  );
}

function EdgePanelInner({ edge, draft, library, onChange, onSelect }: {
  edge: BuilderEdge; draft: BuilderDraft; library: LibraryIndex | null;
  onChange: Props["onChange"]; onSelect: (s: Selection) => void;
}) {
  const from = draft.nodes.find((n) => n.id === edge.from)?.label ?? edge.from;
  const to = draft.nodes.find((n) => n.id === edge.to)?.label ?? edge.to;
  const patch = (p: Partial<BuilderEdge>) =>
    onChange((d) => ({ ...d, edges: d.edges.map((e) => (e.id === edge.id ? { ...e, ...p } : e)) }));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <Section title={`边：${from} → ${to}`}>
        <div className={labelCls}>guard 条件（guards 库；无 = 无条件边）</div>
        <select className={fieldCls} value={edge.guard ?? ""}
                onChange={(e) => patch({ guard: e.target.value || null })}>
          <option value="">（无条件）</option>
          {(library?.guards ?? []).map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <div className="mt-1 text-[11px] text-muted-foreground">
          XOR 分支（同一节点 ≥2 条带 guard 出边）汇入同一下游须把该下游 join 设为 OR。
        </div>
      </Section>
      <Section title="操作">
        <Button variant="destructive" size="sm"
                onClick={() => {
                  onChange((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) }));
                  onSelect(null);
                }}>
          删除边
        </Button>
      </Section>
    </div>
  );
}

export function NodePanel({ draft, library, selected, onChange, onSelect }: Props & { onSelect: (s: Selection) => void }) {
  if (!selected) {
    return (
      <div className="flex-1 p-3 text-[12px] leading-5 text-muted-foreground">
        点选节点/边编辑配置；拖节点间连线加边；Delete 删除选中。
      </div>
    );
  }
  const node = draft.nodes.find((n) => n.id === selected.id);
  if (selected.kind === "node" && node) {
    return <NodePanelInner node={node} draft={draft} library={library} onChange={onChange} onSelect={onSelect} />;
  }
  const edge = draft.edges.find((e) => e.id === selected.id);
  if (selected.kind === "edge" && edge) {
    return <EdgePanelInner edge={edge} draft={draft} library={library} onChange={onChange} onSelect={onSelect} />;
  }
  return <div className="flex-1 p-3 text-[12px] text-muted-foreground">选中对象已不存在。</div>;
}

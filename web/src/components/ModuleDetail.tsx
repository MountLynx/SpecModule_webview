// 模块详情主区面板：detail_to_dict 全量 + 发起运行表单（原 RunDialog 逻辑内嵌，
// 弹窗退役）。按 name 自取详情；发起成功经 onLaunched 上抛壳层（切运行页签开 run）。
// 壳层契约：须以 key={name} 使用（切模块即重挂载，双保险防串态）。
import { useEffect, useState } from "react";
import { Hammer, Play } from "lucide-react";
import {
  ApiError,
  decompileModule,
  fetchDraft,
  fetchModuleDetail,
  notifyLibraryChanged,
  postLaunch,
  type DecompileResult,
  type LaunchResult,
  type ModuleDetail as ModuleDetailData,
} from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SpecForm } from "./SpecForm";

/** 与 server 缺省生成一致的 6 位 hex（前端预填，可改）。 */
function randHex6(): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/* 与 ModuleList 的 KIND_BADGE 保持同步（List/Detail 两处小映射，暂不提取共享） */
const KIND_BADGE: Record<string, string> = {
  entry: "bg-[var(--ph-running)]",
  packed: "bg-[#7c3aed]",
  pip: "bg-[#0891b2]",
};

interface ModuleDetailProps {
  name: string;
  /** 启动成功（202）回调：壳层切「运行历史」页签并打开新 run */
  onLaunched: (result: LaunchResult) => void;
  /** 编辑（反解完成、用户点「打开构建器」）回调：壳层开 build 页签 */
  onEdit: (name: string) => void;
}

export function ModuleDetail({ name, onLaunched, onEdit }: ModuleDetailProps) {
  const [detail, setDetail] = useState<ModuleDetailData | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  // ── 发起表单状态（与原 RunDialog 相同）──
  const [template, setTemplate] = useState<string>("");
  const [runId, setRunId] = useState<string>("");
  const [maxTicks, setMaxTicks] = useState(100);
  const [mock, setMock] = useState(false);
  // SpecForm 上报：spec = 当前有效对象（null = JSON 非法）；touched = 动过字段
  const [spec, setSpec] = useState<Record<string, unknown> | null>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // ── 编辑（反解）状态：报告面板留在详情页，用户看完再进构建器 ──
  const [decompiling, setDecompiling] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [report, setReport] = useState<DecompileResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailErr(null);
    setErr(null);
    setBusy(false);
    setEditErr(null);
    setReport(null);
    setDecompiling(false);
    setMaxTicks(100);
    setMock(false);
    fetchModuleDetail(name)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setTemplate(d.default_template ?? d.templates[0]?.name ?? "");
        setRunId(`${d.name}_${randHex6()}`);
        setSpec(d.default_spec ? { ...d.default_spec } : {});
        setTouched(false);
      })
      .catch((e) => {
        if (!cancelled) setDetailErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (detailErr) {
    return <div className="p-4 text-[12px] text-destructive">{detailErr}</div>;
  }
  if (!detail) {
    return <div className="p-4 text-[12px] text-muted-foreground">加载中…</div>;
  }

  // 选中模板派生值（per-template 解析对象已含库内回落；?? 仅服务无模板模块）
  const selected = detail.templates.find((t) => t.name === template) ?? null;
  const activeSchema = selected?.spec_schema ?? detail.spec_schema;
  const activeSpec = selected?.default_spec ?? detail.default_spec;
  const specEmpty = spec == null || Object.keys(spec).length === 0;
  const submitDisabled =
    busy ||
    spec == null || // JSON 非法（无效 spec 无从提交）
    (specEmpty && activeSpec == null); // 空且无参考 → CLI 也无米下锅
  const hint =
    spec == null
      ? "spec JSON 非法——修正后才能启动"
      : specEmpty && activeSpec == null
        ? "spec 为空且无参考 spec——请至少填写一个字段"
        : null;

  const submit = async (specOverride?: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      // spec 显式性单点判定：能被 CLI 回落复现（未动过且与 entry 级 default_spec 相同）
      // → 不传（回落语义最准）；否则显式传表单当前值——切到带覆盖声明的模板后 pristine
      // 值与 entry 级不等，自然显式传，所见即所跑（修复 CLI 回落恒指 entry 级的错位）。
      // spec 参考小按钮 → 走 specOverride 显式通道，不受判定影响（见设计（一）/（三））。
      const fallbackEquals =
        !touched && JSON.stringify(spec) === JSON.stringify(detail.default_spec ?? null);
      const r = await postLaunch({
        module: detail.name,
        spec: specOverride ?? (fallbackEquals ? null : spec),
        template: template || null,
        run_id: runId.trim() || null,
        max_ticks: maxTicks,
        mock,
      });
      onLaunched(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runEdit = async (moduleName: string) => {
    if (decompiling) return;
    setDecompiling(true);
    setEditErr(null);
    setReport(null);
    try {
      // 同名草稿已存在 → 反解会覆盖，显式确认；仅 404 视为不存在（其他失败
      // 走报错——静默跳过确认会在服务端故障时直接覆盖）
      const existing = await fetchDraft(moduleName).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
      if (existing && !window.confirm(`已存在同名草稿「${moduleName}」，重新反解将覆盖——继续？`)) {
        return;
      }
      setReport(await decompileModule(moduleName));
      // 反解写了草稿 + 可能导入组件——广播库变更，侧栏在开清单即时刷新
      notifyLibraryChanged();
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDecompiling(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto p-5">
      <div className="max-w-[760px] text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-[16px] font-bold">{detail.name}</span>
          <span
            className={cn(
              "rounded-full px-1.5 text-[11px] leading-4 text-white",
              KIND_BADGE[detail.kind] ?? "bg-muted-foreground",
            )}
          >
            {detail.kind}
          </span>
          {detail.version && (
            <span className="text-[12px] text-muted-foreground">v{detail.version}</span>
          )}
          {detail.kind === "packed" && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={decompiling}
              onClick={() => runEdit(detail.name)}
            >
              <Hammer className="h-3.5 w-3.5" />
              {decompiling ? "反解中…" : "编辑"}
            </Button>
          )}
        </div>
        {detail.description && (
          <div className="mt-1.5 text-muted-foreground">{detail.description}</div>
        )}
        <div className="mt-2 break-all font-mono text-[12px] text-muted-foreground">
          {detail.path}
        </div>
        {editErr && <div className="mt-2 text-[12px] text-destructive">{editErr}</div>}
        {report && (
          <div className="mt-4 rounded-md border p-3 text-[12px]">
            <div className="font-semibold">反解完成：草稿「{report.draft}」</div>
            <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
              {report.report.imported.map((x) => <li key={x}>＋ 导入组件库：{x}</li>)}
              {report.report.existed.map((x) => <li key={x}>＝ 组件库已有（内容一致）：{x}</li>)}
              {report.report.conflicts.map((x) => (
                <li key={x} className="text-[var(--ph-truncated)]">⚠ 同名冲突——沿用组件库版本：{x}</li>
              ))}
              {report.report.warnings.map((x) => (
                <li key={x} className="text-[var(--ph-truncated)]">⚠ {x}</li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setReport(null)}>关闭</Button>
              <Button size="sm" onClick={() => onEdit(report.draft)}>打开构建器</Button>
            </div>
          </div>
        )}

        {detail.submodules.length > 0 && (
          <div className="mt-4">
            <div className="text-[12px] font-semibold">子模块</div>
            <div className="mt-1">{detail.submodules.join("、")}</div>
          </div>
        )}

        <div className="mt-4">
          <div className="text-[12px] font-semibold">模板</div>
          {detail.templates.length ? (
            <>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {detail.templates.map((t) => {
                  const isDefault = t.name === detail.default_template;
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => setTemplate(t.name)}
                      title={isDefault ? "默认模板" : undefined}
                      className={
                        "rounded-md border px-2 py-0.5 text-[11px] transition-colors " +
                        (t.name === template
                          ? "border-transparent bg-primary text-primary-foreground"
                          : "border-border bg-card hover:border-primary/60")
                      }
                    >
                      {t.name}
                      {isDefault ? "（默认）" : ""}
                    </button>
                  );
                })}
              </div>
              {selected?.description && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {selected.description}
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 text-muted-foreground">（无模板——模块自带流程定义）</div>
          )}
        </div>

        {activeSchema && (
          <div className="mt-4">
            <div className="text-[12px] font-semibold">spec 字段</div>
            <table className="mt-1.5 border-collapse text-[12px]">
              <tbody>
                {Object.entries(activeSchema).map(([k, t]) => (
                  <tr key={k}>
                    <td className="border border-border px-2.5 py-0.5 font-mono">{k}</td>
                    <td className="border border-border px-2.5 py-0.5 text-muted-foreground">
                      {t}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4">
          <div className="text-[12px] font-semibold">spec 参考</div>
          {activeSpec != null ? (
            <>
              <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-md border bg-secondary p-2 font-mono text-[12px] leading-relaxed">
                {JSON.stringify(activeSpec, null, 2)}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-1.5"
                disabled={busy}
                title="以参考 spec 直接发起运行（覆盖表单当前 spec）"
                onClick={() => submit({ ...activeSpec })}
              >
                用参考 spec 尝试运行
              </Button>
            </>
          ) : (
            <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-md border bg-secondary p-2 font-mono text-[12px] leading-relaxed">
              （模块未声明参考 spec——留空将使用模板缺省）
            </pre>
          )}
        </div>

        {/* ── 发起运行（原 RunDialog 表单）── */}
        <div className="mt-5 border-t pt-4">
          <div className="text-[12px] font-bold">发起运行</div>
          <div className="mt-3">
            <SpecForm
              key={`${detail.name}:${template}`}
              schema={activeSchema}
              defaultSpec={activeSpec}
              onChange={(s, t) => {
                setSpec(s);
                setTouched(t);
              }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12px]">
              run id
              <Input value={runId} onChange={(e) => setRunId(e.target.value)} className="w-[200px]" />
            </label>
            <label className="flex items-center gap-1.5 text-[12px]">
              max ticks
              <Input
                type="number"
                value={maxTicks}
                min={1}
                onChange={(e) => setMaxTicks(Number(e.target.value) || 100)}
                className="w-[70px]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="checkbox"
                checked={mock}
                onChange={(e) => setMock(e.target.checked)}
              />
              --mock（免 key 冒烟）
            </label>
          </div>
          {hint && <div className="mt-2 text-[12px] text-[var(--ph-truncated)]">{hint}</div>}
          {err && <div className="mt-2 text-[12px] text-destructive">{err}</div>}
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => submit()} disabled={submitDisabled}>
              {busy ? "启动中…" : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  发起运行
                </>
              )}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              202 后自动切到「运行历史」打开新 run
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// 模块详情主区面板：detail_to_dict 全量 + 发起运行表单（原 RunDialog 逻辑内嵌，
// 弹窗退役）。按 name 自取详情；发起成功经 onLaunched 上抛壳层（切运行页签开 run）。
// 壳层契约：须以 key={name} 使用（切模块即重挂载，双保险防串态）。
import { useEffect, useState } from "react";
import {
  fetchModuleDetail,
  postLaunch,
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
}

export function ModuleDetail({ name, onLaunched }: ModuleDetailProps) {
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

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailErr(null);
    setErr(null);
    setBusy(false);
    setMaxTicks(100);
    setMock(false);
    fetchModuleDetail(name)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setTemplate(d.default_template ?? d.templates[0] ?? "");
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
    return <div className="p-4 text-[12.5px] text-destructive">{detailErr}</div>;
  }
  if (!detail) {
    return <div className="p-4 text-[12.5px] text-muted-foreground">加载中…</div>;
  }

  const specEmpty = spec == null || Object.keys(spec).length === 0;
  const submitDisabled =
    busy ||
    spec == null || // JSON 非法（无效 spec 无从提交）
    (specEmpty && detail.default_spec == null); // 空且无缺省 → CLI 也无米下锅
  const hint =
    spec == null
      ? "spec JSON 非法——修正后才能启动"
      : specEmpty && detail.default_spec == null
        ? "spec 为空且模块无 default_spec——请至少填写一个字段"
        : null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await postLaunch({
        module: detail.name,
        // 未动过字段 → 不传 spec（CLI 回落 entry.default_spec，语义最准）
        spec: touched ? spec : null,
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

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto p-5">
      <div className="max-w-[760px] text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-[16px] font-bold">{detail.name}</span>
          <span
            className={cn(
              "rounded-full px-1.5 text-[9.5px] leading-4 text-white",
              KIND_BADGE[detail.kind] ?? "bg-muted-foreground",
            )}
          >
            {detail.kind}
          </span>
          {detail.version && (
            <span className="text-[12px] text-muted-foreground">v{detail.version}</span>
          )}
        </div>
        {detail.description && (
          <div className="mt-1.5 text-muted-foreground">{detail.description}</div>
        )}
        <div className="mt-2 break-all font-mono text-[11.5px] text-muted-foreground">
          {detail.path}
        </div>

        {detail.submodules.length > 0 && (
          <div className="mt-4">
            <div className="text-[12.5px] font-semibold">子模块</div>
            <div className="mt-1">{detail.submodules.join("、")}</div>
          </div>
        )}

        <div className="mt-4">
          <div className="text-[12.5px] font-semibold">模板</div>
          {detail.templates.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.templates.map((t) => (
                <span
                  key={t}
                  className={
                    "rounded-md border px-2 py-0.5 text-[11px] " +
                    (t === detail.default_template
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-border bg-card")
                  }
                  title={t === detail.default_template ? "默认模板" : undefined}
                >
                  {t}
                  {t === detail.default_template ? "（默认）" : ""}
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-muted-foreground">（无模板——模块自带流程定义）</div>
          )}
        </div>

        {detail.spec_schema && (
          <div className="mt-4">
            <div className="text-[12.5px] font-semibold">spec 字段</div>
            <table className="mt-1.5 border-collapse text-[12px]">
              <tbody>
                {Object.entries(detail.spec_schema).map(([k, t]) => (
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
          <div className="text-[12.5px] font-semibold">default_spec</div>
          <pre className="mt-1.5 overflow-x-auto rounded-md border bg-secondary p-2 font-mono text-[11.5px] leading-relaxed">
            {detail.default_spec != null
              ? JSON.stringify(detail.default_spec, null, 2)
              : "（无——运行时留空 spec 将使用模板缺省）"}
          </pre>
        </div>

        {/* ── 发起运行（原 RunDialog 表单）── */}
        <div className="mt-5 border-t pt-4">
          <div className="text-[12.5px] font-bold">发起运行</div>
          {detail.templates.length > 1 && (
            <div className="mt-3">
              <div className="mb-1 text-[12px] font-semibold">模板</div>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-full max-w-[320px] rounded-control border border-input bg-transparent px-2 py-1 text-[13px]"
              >
                {detail.templates.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {t === detail.default_template ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="mt-3">
            <SpecForm
              key={detail.name}
              schema={detail.spec_schema}
              defaultSpec={detail.default_spec}
              onChange={(s, t) => {
                setSpec(s);
                setTouched(t);
              }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12.5px]">
              run id
              <Input value={runId} onChange={(e) => setRunId(e.target.value)} className="w-[200px]" />
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px]">
              max ticks
              <Input
                type="number"
                value={maxTicks}
                min={1}
                onChange={(e) => setMaxTicks(Number(e.target.value) || 100)}
                className="w-[70px]"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px]">
              <input
                type="checkbox"
                checked={mock}
                onChange={(e) => setMock(e.target.checked)}
              />
              --mock（免 key 冒烟）
            </label>
          </div>
          {hint && <div className="mt-2 text-[12px] text-[var(--ph-truncated)]">{hint}</div>}
          {err && <div className="mt-2 text-[12.5px] text-destructive">{err}</div>}
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={submit} disabled={submitDisabled}>
              {busy ? "启动中…" : "▶ 发起运行"}
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

// 运行对话框：选模块 + spec 填表（SpecForm）+ 模板/run_id/max_ticks/mock → POST /api/runs。
// 交互模式镜像 ResumeDialog（overlay 内联错误 + busy 态）。
import { useMemo, useState } from "react";
import { postLaunch, type LaunchResult, type ModuleDetail } from "../api";
import { btnStyle, dialogStyle, fieldLabel, overlayStyle } from "./dialogStyles";
import { SpecForm } from "./SpecForm";

interface RunDialogProps {
  detail: ModuleDetail;
  onClose: () => void;
  onLaunched: (result: LaunchResult) => void;
}

/** 与 server 缺省生成一致的 6 位 hex（前端预填，可改）。 */
function randHex6(): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function RunDialog({ detail, onClose, onLaunched }: RunDialogProps) {
  // 模板：多模板显示 select（default 预选）；单/零模板走 CLI 缺省
  const [template, setTemplate] = useState<string>(
    detail.default_template ?? detail.templates[0] ?? "",
  );
  const [runId, setRunId] = useState<string>(() => `${detail.name}_${randHex6()}`);
  const [maxTicks, setMaxTicks] = useState(100);
  const [mock, setMock] = useState(false);
  // SpecForm 上报：spec = 当前有效对象（null = JSON 非法）；touched = 动过字段
  const [spec, setSpec] = useState<Record<string, unknown> | null>(
    () => (detail.default_spec ? { ...detail.default_spec } : {}),
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const specEmpty = spec == null || Object.keys(spec).length === 0;
  const submitDisabled =
    busy ||
    spec == null || // JSON 非法（无效 spec 无从提交）
    (specEmpty && detail.default_spec == null); // 空且无缺省 → CLI 也无米下锅

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

  const hint = useMemo(() => {
    if (spec == null) return "spec JSON 非法——修正后才能启动";
    if (specEmpty && detail.default_spec == null)
      return "spec 为空且模块无 default_spec——请至少填写一个字段";
    return null;
  }, [spec, specEmpty, detail.default_spec]);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          运行模块：<code>{detail.name}</code>
          {detail.description && (
            <span style={{ fontWeight: 400, color: "#6b7280" }}> — {detail.description}</span>
          )}
        </div>
        {detail.templates.length > 1 && (
          <div>
            <div style={fieldLabel}>模板</div>
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              style={{ width: "100%" }}
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
        <SpecForm
          key={detail.name}
          schema={detail.spec_schema}
          defaultSpec={detail.default_spec}
          onChange={(s, t) => {
            setSpec(s);
            setTouched(t);
          }}
        />
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <label>
            run id{" "}
            <input
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              style={{ width: 200 }}
            />
          </label>
          <label>
            max ticks{" "}
            <input
              type="number"
              value={maxTicks}
              min={1}
              onChange={(e) => setMaxTicks(Number(e.target.value) || 100)}
              style={{ width: 70 }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={mock}
              onChange={(e) => setMock(e.target.checked)}
            />{" "}
            --mock（免 key 冒烟）
          </label>
        </div>
        {hint && <div style={{ color: "#b45309", fontSize: 12 }}>{hint}</div>}
        {err && <div style={{ color: "#b91c1c" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={btnStyle} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button style={btnStyle} onClick={submit} disabled={submitDisabled}>
            {busy ? "启动中…" : "启动运行"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { RunDialog };
export type { RunDialogProps };

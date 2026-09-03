// spec 填表区：spec_schema / default_spec 驱动的类型化表单 ⇄ JSON 双模式。
//
// - 有 schema → 按声明字段渲染（str/int/float/bool/list/dict/any）；未声明字段
//   不出现（JSON 模式可补）
// - 无 schema 有 default_spec → 按 default_spec 键生成表单（值类型按预填值推断）
// - 都无 → 纯 JSON 编辑器（无表单模式可切）
// - 双向同步：表单 → JSON 序列化当前值；JSON → 表单仅在合法对象时放行
//   （非法 JSON 切换被拒，就地示错——避免静默丢用户输入）
// - onChange(spec, touched)：spec 为当前有效对象（可能 {}）；JSON 非法 → null
//   （提交侧禁用）。touched = 用户动过任何字段（未动时提交侧传 null 走 CLI
//   default_spec 回落）。
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { jsonFieldError } from "./dialogStyles";

const labelStyle: CSSProperties = { fontWeight: 600, marginBottom: 2 };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box" };
const monoStyle: CSSProperties = { fontFamily: "monospace" };
const errStyle: CSSProperties = { color: "#b91c1c", fontSize: 12 };
const badOutline: CSSProperties = { outline: "2px solid #dc2626" };

/** schema 类型名 → 归一控件类型（未知类型串按 JSON 子编辑器处理）。 */
function normType(t: string): "str" | "int" | "float" | "bool" | "json" {
  switch (t) {
    case "str":
    case "string":
      return "str";
    case "int":
    case "integer":
      return "int";
    case "float":
    case "number":
      return "float";
    case "bool":
    case "boolean":
      return "bool";
    default:
      return "json"; // list / dict / any / 未知
  }
}

/** 按 typeof 推断控件类型（default_spec 推断通道）。 */
function inferType(v: unknown): "str" | "int" | "float" | "bool" | "json" {
  switch (typeof v) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    default:
      return "json";
  }
}

/** 字段级 JSON 子编辑器：失焦即校验，错误就地显示。 */
function JsonField({
  value,
  onCommit,
}: {
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <textarea
        value={text}
        rows={typeof value === "object" && value != null ? Math.min(8, Math.max(2, text.split("\n").length)) : 2}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const trimmed = text.trim();
          if (!trimmed) {
            setErr(null);
            onCommit(undefined); // 清空 = 移除该字段
            return;
          }
          try {
            onCommit(JSON.parse(trimmed));
            setErr(null);
          } catch {
            setErr("不是合法 JSON");
          }
        }}
        style={{ ...inputStyle, ...monoStyle, ...(err ? badOutline : {}) }}
      />
      {err && <div style={errStyle}>{err}</div>}
    </div>
  );
}

export interface SpecFormProps {
  schema: Record<string, string> | null;
  defaultSpec: Record<string, unknown> | null;
  onChange: (spec: Record<string, unknown> | null, touched: boolean) => void;
}

export function SpecForm({ schema, defaultSpec, onChange }: SpecFormProps) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [values, setValues] = useState<Record<string, unknown>>(
    () => (defaultSpec ? { ...defaultSpec } : {}),
  );
  const [jsonText, setJsonText] = useState(() =>
    JSON.stringify(defaultSpec ?? {}, null, 2),
  );
  const touchedRef = useRef(false);
  // 表单字段重挂载计数：JSON → 表单切换后 values 整体替换，JsonField 内部
  // text 需随新值重建（key 变化强制 remount）
  const [fieldEpoch, setFieldEpoch] = useState(0);

  const hasForm = schema != null || defaultSpec != null;
  const fields = hasForm
    ? Object.entries(
        schema ?? Object.fromEntries(
          Object.entries(defaultSpec ?? {}).map(([k, v]) => [k, String(inferType(v))]),
        ),
      ).map(([key, t]) => ({ key, type: normType(t) }))
    : [];

  const report = (next: Record<string, unknown> | null, touched?: boolean) => {
    onChange(next, touched ?? touchedRef.current);
  };
  // 初值上报（RunDialog 以此驱动提交禁用逻辑）
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!reportedRef.current) {
      reportedRef.current = true;
      report({ ...values });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = (key: string, value: unknown) => {
    touchedRef.current = true;
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setValues(next);
    report(next);
  };

  const switchToJson = () => {
    setJsonText(JSON.stringify(values, null, 2));
    setMode("json");
  };

  const switchToForm = () => {
    const trimmed = jsonText.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      touchedRef.current = true;
      setValues(parsed);
      setFieldEpoch((n) => n + 1);
      setMode("form");
      report(parsed);
    } catch {
      // 非法 JSON：就地已示错，拒绝切换（避免丢输入）
    }
  };

  // JSON 模式即时校验 + 有效即上报
  const jsonErr = jsonFieldError(jsonText, true);
  const onJsonText = (text: string) => {
    setJsonText(text);
    touchedRef.current = true;
    const trimmed = text.trim();
    if (!trimmed) {
      report({});
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      report(
        parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null,
      );
    } catch {
      report(null);
    }
  };

  const modeBtn: CSSProperties = { fontSize: 12, cursor: "pointer" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {hasForm && (
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ fontWeight: 600 }}>spec</span>
          <button
            type="button"
            style={{ ...modeBtn, fontWeight: mode === "form" ? 700 : 400 }}
            onClick={() => mode === "json" && switchToForm()}
            disabled={mode === "form"}
          >
            表单
          </button>
          <button
            type="button"
            style={{ ...modeBtn, fontWeight: mode === "json" ? 700 : 400 }}
            onClick={() => mode === "form" && switchToJson()}
            disabled={mode === "json"}
          >
            JSON
          </button>
        </div>
      )}
      {mode === "form" && hasForm ? (
        fields.map(({ key, type }) => {
          const v = values[key];
          return (
            <div key={`${key}:${fieldEpoch}`}>
              <div style={labelStyle}>
                {key}
                <span style={{ fontWeight: 400, color: "#6b7280" }}>（{type}）</span>
              </div>
              {type === "str" ? (
                typeof v === "string" && (v.length > 60 || v.includes("\n")) ? (
                  <textarea
                    value={v}
                    rows={3}
                    spellCheck={false}
                    onChange={(e) => setField(key, e.target.value)}
                    style={inputStyle}
                  />
                ) : (
                  <input
                    value={v == null ? "" : String(v)}
                    onChange={(e) => setField(key, e.target.value)}
                    style={inputStyle}
                  />
                )
              ) : type === "int" || type === "float" ? (
                <input
                  type="number"
                  step={type === "int" ? 1 : "any"}
                  value={v == null ? "" : String(v)}
                  onChange={(e) => {
                    const text = e.target.value;
                    if (text === "") {
                      setField(key, undefined);
                      return;
                    }
                    const n = type === "int"
                      ? Number.parseInt(text, 10)
                      : Number.parseFloat(text);
                    setField(key, Number.isNaN(n) ? undefined : n);
                  }}
                  style={inputStyle}
                />
              ) : type === "bool" ? (
                <label>
                  <input
                    type="checkbox"
                    checked={v === true}
                    onChange={(e) => setField(key, e.target.checked)}
                  />{" "}
                  {key}
                </label>
              ) : (
                <JsonField value={v} onCommit={(nv) => setField(key, nv)} />
              )}
            </div>
          );
        })
      ) : (
        <div>
          {!hasForm && (
            <div style={labelStyle}>spec（JSON）</div>
          )}
          <textarea
            value={jsonText}
            rows={8}
            spellCheck={false}
            onChange={(e) => onJsonText(e.target.value)}
            style={{ ...inputStyle, ...monoStyle, ...(jsonErr ? badOutline : {}) }}
          />
          {jsonErr && <div style={errStyle}>spec {jsonErr}</div>}
        </div>
      )}
    </div>
  );
}

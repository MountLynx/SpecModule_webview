// 对话框共享内联样式（RunControls 系对话框公用，避免逐文件复制）。
import type { CSSProperties } from "react";

export const btnStyle: CSSProperties = {
  fontSize: 12,
  padding: "3px 10px",
  cursor: "pointer",
};

export const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

export const dialogStyle: CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 16,
  width: 520,
  maxWidth: "92vw",
  maxHeight: "86vh",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontSize: 13,
};

export const fieldLabel: CSSProperties = { fontWeight: 600, marginBottom: 2 };

/** textarea 即时 JSON 校验：返回错误文案或 null（合法/空）。 */
export function jsonFieldError(text: string, mustBeObject: boolean): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (mustBeObject && (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))) {
      return "必须是 JSON 对象";
    }
    return null;
  } catch {
    return "不是合法 JSON";
  }
}

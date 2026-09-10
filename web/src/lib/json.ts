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

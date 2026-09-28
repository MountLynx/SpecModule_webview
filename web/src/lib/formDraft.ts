// 表单对话框在途草稿（localStorage）：编辑中即时持久化——页面刷新/浏览器崩溃后
// 重开对话框自动恢复；保存成功或显式「取消」时 clear 丢弃。
// 持久化由编辑包装器显式调用（persist），服务器回填不落草稿——草稿存在 ⇔ 用户动过。
import { useCallback, useState } from "react";

const PREFIX = "specmodule-webview.form-draft.";

export function loadFormDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function clearFormDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch { /* 隐私模式等：草稿不可用，静默 */ }
}

/** 表单草稿 hook：初值 = 本地草稿 ?? initial；restored 标记本次挂载是否来自草稿恢复 */
export function useFormDraft<T>(key: string, initial: T) {
  const [seed] = useState(() => loadFormDraft<T>(key));
  const [value, setValue] = useState<T>(seed ?? initial);
  const persist = useCallback((v: T) => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(v));
    } catch { /* 同上：草稿失效不打断编辑 */ }
  }, [key]);
  const clear = useCallback(() => clearFormDraft(key), [key]);
  return { value, setValue, persist, clear, restored: seed != null };
}

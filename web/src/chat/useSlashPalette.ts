import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";

/** 斜杠面板候选条目（展示就绪：hook 只做过滤/排序/徽章，不改文本与图标） */
export interface PaletteEntry {
  /** 稳定 id（模式 = mode.key；最近使用按它记录） */
  id: string;
  /** 插入命令全文（含触发符，如 "/grilling"） */
  command: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** 预置徽章（如「当前」）；最近使用徽章由 hook 附加（预置优先） */
  badge?: string;
}

/** 面板条目（输出 = 输入 + 徽章解析完成） */
export type PaletteItem = PaletteEntry;

/**
 * 触发符注册形状（扩展点）：
 * - line-start：仅当输入以触发符开头时唤起（现用于 / 模式补全）
 * - caret：光标处触发符后缀匹配即唤起（未来如 # 节点引用补全；本轮未实装）
 */
export interface SlashTrigger {
  char: string;
  at: "line-start" | "caret";
}

const PALETTE_LIMIT = 8;
const RECENTS_KEY = "treechat.web.slashRecents.v1";
const RECENTS_LIMIT = 5;

function readRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function storeRecents(ids: string[]): void {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(ids));
  } catch {
    // localStorage 不可用（隐私模式等）：仅本次会话内存内生效
  }
}

/**
 * 斜杠面板状态机：触发判定 → 过滤排序 → 选中态 → 关闭/重开 → 最近使用。
 * 纯状态逻辑，不含布局与渲染（见 SlashPalette.tsx）。
 */
export function useSlashPalette(p: {
  triggers: SlashTrigger[];
  text: string;
  entries: PaletteEntry[];
  disabled: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recents, setRecents] = useState<string[]>(readRecents);

  // 查询 = 行首触发符后、首个空白前的 token（已成完整命令交给解析/发送路径，面板不出现）
  const query = useMemo(() => {
    if (p.disabled || dismissed) return null;
    if (!p.triggers.some((t) => t.at === "line-start" && p.text.startsWith(t.char))) return null;
    const partial = p.text.slice(1);
    if (partial.includes(" ")) return null;
    return partial.toLowerCase();
  }, [p.disabled, p.triggers, p.text, dismissed]);

  const items = useMemo<PaletteItem[]>(() => {
    if (query === null) return [];
    const matched = p.entries.filter((e) => {
      if (query === "") return true;
      return [e.command, e.title, e.description].join(" ").toLowerCase().includes(query);
    });
    // 空查询：最近使用排前（其余保持原序）；非空查询：保持原序（nanobot 同款）
    if (query === "") {
      const rank = (id: string) => {
        const i = recents.indexOf(id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      matched.sort((a, b) => rank(a.id) - rank(b.id));
    }
    return matched
      .slice(0, PALETTE_LIMIT)
      .map((e) => ({ ...e, badge: e.badge ?? (recents.includes(e.id) ? "最近" : undefined) }));
  }, [p.entries, query, recents]);

  // 查询变化重置选中；候选缩水时防越界
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);
  useEffect(() => {
    if (items.length > 0 && selectedIndex >= items.length) setSelectedIndex(0);
  }, [items.length, selectedIndex]);

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      setSelectedIndex((i) => (i + delta + items.length) % items.length);
    },
    [items.length],
  );
  const dismiss = useCallback(() => setDismissed(true), []);
  const notifyTextEdited = useCallback(() => setDismissed(false), []);
  const recordRecent = useCallback((id: string) => {
    const next = [id, ...recents.filter((x) => x !== id)].slice(0, RECENTS_LIMIT);
    setRecents(next);
    storeRecents(next);
  }, [recents]);

  return {
    /** 面板是否展示（有查询且有候选） */
    open: items.length > 0,
    items,
    selectedIndex,
    setSelectedIndex,
    /** ↑↓ 循环移动 */
    move,
    /** Escape / form 外点击：关闭面板；继续输入经 notifyTextEdited 重开 */
    dismiss,
    /** textarea onChange 时调用：重置 dismissed */
    notifyTextEdited,
    /** 补全选中后记录最近使用（localStorage 持久化，失败降级内存） */
    recordRecent,
  };
}

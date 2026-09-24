# 斜杠指令面板完整升级实施计划（参考 nanobot）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `web/src/chat/Composer.tsx` 的斜杠模式面板升级到 nanobot 水准：键盘全路径导航（↑↓/Tab/Enter/Escape）、图标+标题+描述+徽章+等宽命令的 listbox 面板、视口自适应 above/below 布局、最近使用持久化、触发符注册扩展点。规格见 `docs/superpowers/specs/2026-09-24-slash-command-palette-design.md`。

**Architecture:** 三个文件各司其职——`useSlashPalette.ts`（纯状态 hook：触发判定/过滤排序/选中态/关闭重开/最近使用）、`SlashPalette.tsx`（纯展示面板：listbox 无障碍 + 视口测量自适应布局 + 选中项滚动跟随）、`Composer.tsx`（保留发送/解析/chip 区，接线 hook 与面板）。后端零改动。

**Tech Stack:** React 18 + TypeScript（strict）+ Tailwind + lucide-react（已核对 Flame/MessageSquare/CircleHelp 可用；已探针验证 lucide 图标可赋 `ComponentType<{className?: string}>`）。参考实现：`../参考/nanobot/webui/src/components/thread/ThreadComposer.tsx`。

**测试适配说明（重要）:** 本仓库前端**无测试框架**（生态惯例，不引入 vitest/jest）；每个任务的验证 = `npm run build`（tsc --noEmit + vite build，类型即门）+ Task 4 的手工验证清单。不含 pytest。

**提交纪律（重要）:** 当前工作树有 10 个未提交修改文件（`roadmap.md`、`treechat/**`、`web/src/App.tsx`、`ChatView.tsx`、`Composer.tsx`、`TreePanel.tsx`、`treelayout.ts`、`tests/treechat/**`）。**Task 0 必须先与用户确认既有改动的处置**；本计划所有 `git add` 只暂存计划明确触碰的文件，绝不 `git add -A` / `git add .`。

---

### Task 0: 工作树隔离检查（阻塞步骤）

**Files:** 无修改；只读检查。

- [ ] **Step 1: 检查工作树状态**

Run: `git status --porcelain`
Expected: 输出非空（已知 10 个修改文件，含本计划要改的 `web/src/chat/Composer.tsx` 与 `roadmap.md`）。

- [ ] **Step 2: 与用户确认既有改动处置，隔离后才开始**

本计划会修改 `web/src/chat/Composer.tsx`（已有未提交改动）并在 Task 4 追加 `roadmap.md`（已有未提交改动）。**若直接提交这两个文件，会把既有在途改动一并卷入**。向用户展示 `git status` 输出，请其选择：
1. 先行提交既有在途改动（推荐，保持历史整洁），或
2. 用户确认把既有改动与本计划改动合并提交（须用户明确许可）。

得到明确答复前不进入 Task 1。若用户选择先行提交，由用户本人或经其确认后代为提交既有改动（提交信息由用户定），确认 `git status --porcelain` 对这两个文件不再输出后才继续。

---

### Task 1: `useSlashPalette.ts` —— 面板状态机 hook

**Files:**
- Create: `web/src/chat/useSlashPalette.ts`

- [ ] **Step 1: 创建 hook 文件（完整内容）**

```ts
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
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENTS_LIMIT);
      storeRecents(next);
      return next;
    });
  }, []);

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
```

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: 退出码 0（tsc + vite 均通过；hook 尚无人引用不影响类型检查——tsconfig include 覆盖全部 src）。

- [ ] **Step 3: 提交（只暂存本文件）**

```bash
git add web/src/chat/useSlashPalette.ts
git commit -m "feat(web): 斜杠面板状态机 hook——触发符注册扩展点/过滤排序/选中态/最近使用"
```

---

### Task 2: `SlashPalette.tsx` —— 纯展示面板（listbox + 自适应布局）

**Files:**
- Create: `web/src/chat/SlashPalette.tsx`

- [ ] **Step 1: 创建面板组件文件（完整内容）**

```tsx
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PaletteItem } from "./useSlashPalette";
import { cn } from "../lib/utils";

const PALETTE_GAP_PX = 8;
const PALETTE_MAX_HEIGHT_PX = 288;
const PALETTE_MIN_HEIGHT_PX = 144;
const PALETTE_CHROME_PX = 12;

/** 沿父链收集滚动容器，求 anchor 相对可视区（visualViewport 回落 window.innerHeight）的上下界 */
function visibleBounds(el: HTMLElement): { top: number; bottom: number } {
  const vv = window.visualViewport;
  const top = vv ? Math.max(0, vv.offsetTop) : 0;
  const bottom = vv ? top + Math.max(0, vv.height) : window.innerHeight;
  let lo = top;
  let hi = bottom;
  let parent = el.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      const rect = parent.getBoundingClientRect();
      lo = Math.max(lo, rect.top);
      hi = Math.min(hi, rect.bottom);
    }
    parent = parent.parentElement;
  }
  return { top: lo, bottom: hi };
}

interface Props {
  items: PaletteItem[];
  selectedIndex: number;
  /** 量度锚（Composer 面板容器） */
  anchorRef: RefObject<HTMLElement>;
  onHover: (index: number) => void;
  onChoose: (item: PaletteItem) => void;
}

/** 斜杠命令面板：listbox 无障碍 + 视口自适应 above/below + 选中项滚动跟随（复刻 nanobot 测量逻辑） */
export function SlashPalette({ items, selectedIndex, anchorRef, onHover, onChoose }: Props) {
  const [layout, setLayout] = useState<{ placement: "above" | "below"; maxHeight: number }>({
    placement: "above",
    maxHeight: PALETTE_MAX_HEIGHT_PX,
  });
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const bounds = visibleBounds(anchor);
      const spaceAbove = Math.max(0, rect.top - bounds.top - PALETTE_GAP_PX);
      const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - PALETTE_GAP_PX);
      const placement: "above" | "below" =
        spaceAbove >= PALETTE_MIN_HEIGHT_PX || spaceAbove >= spaceBelow ? "above" : "below";
      const maxHeight = Math.min(
        PALETTE_MAX_HEIGHT_PX,
        placement === "above" ? spaceAbove : spaceBelow,
      );
      setLayout((cur) =>
        cur.placement === placement && cur.maxHeight === maxHeight
          ? cur
          : { placement, maxHeight },
      );
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  // 选中项滚动跟随（键盘移动时保持可见）
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector(`[data-palette-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div role="listbox" aria-label="斜杠命令"
         style={{ maxHeight: layout.maxHeight }}
         className={cn(
           "absolute left-1/2 z-10 w-[calc(100%-0.5rem)] -translate-x-1/2 rounded-panel border bg-card p-1 shadow-md",
           layout.placement === "above" ? "bottom-full mb-2" : "top-full mt-2",
         )}>
      <div ref={listRef} className="overflow-y-auto"
           style={{ maxHeight: Math.max(0, layout.maxHeight - PALETTE_CHROME_PX) }}>
        {items.map((item, index) => {
          const Icon = item.icon;
          const selected = index === selectedIndex;
          return (
            <button key={item.id} type="button" role="option" data-palette-index={index}
                    aria-selected={selected}
                    onMouseEnter={() => onHover(index)}
                    onMouseDown={(e) => { e.preventDefault(); onChoose(item); }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] transition-colors",
                      selected ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/60",
                    )}>
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate">{item.title}</span>
                <span className="min-w-0 truncate text-[12px] text-muted-foreground">{item.description}</span>
              </span>
              {item.badge && (
                <span className="shrink-0 rounded-full bg-foreground/[0.055] px-1.5 py-px text-[11px] text-muted-foreground">
                  {item.badge}
                </span>
              )}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{item.command}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: 退出码 0。

- [ ] **Step 3: 提交（只暂存本文件）**

```bash
git add web/src/chat/SlashPalette.tsx
git commit -m "feat(web): 斜杠命令展示面板——listbox 无障碍/图标+描述+徽章/视口自适应布局/滚动跟随"
```

---

### Task 3: `Composer.tsx` 接线（保留发送路径，替换旧候选面板）

**Files:**
- Modify: `web/src/chat/Composer.tsx`（整文件替换为下述内容）

- [ ] **Step 1: 整文件替换（完整内容；相对现状的变化：删旧候选面板块、新增 hook/面板/键盘/pointerdown/图标映射/文本间接层、面板容器加 relative+ref，其余逐行保留）**

```tsx
import {
  ChevronDown, CircleHelp, Flame, MessageSquare, SendHorizontal, Slash, Sprout, X,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Mode } from "./types";
import { cn } from "../lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SlashPalette } from "./SlashPalette";
import { useSlashPalette, type PaletteEntry, type PaletteItem } from "./useSlashPalette";

interface Props {
  leafMode: boolean;
  busy: boolean;
  disabled: boolean;
  modes: Mode[];
  /** 当前会话默认模式 key（空 = 直答） */
  category: string;
  onToggleLeaf: () => void;
  /** 切换会话默认模式（写 category 事件） */
  onSwitchMode: (key: string) => void;
  /** module 非空 = 斜杠切换并本轮生效（send 会同时写 category） */
  onSend: (text: string, module?: string) => void;
}

/** 模式匹配：key 全等 > 显示名全等 > key 唯一前缀 */
function matchMode(token: string, modes: Mode[]): Mode | null {
  const t = token.toLowerCase();
  if (!t) return null;
  return (
    modes.find((m) => m.key === t) ??
    modes.find((m) => m.displayName === token) ??
    (() => {
      const byPrefix = modes.filter((m) => m.key.startsWith(t));
      return byPrefix.length === 1 ? byPrefix[0] : null;
    })()
  );
}

/** 模式图标静态映射（未知 key 回落通用图标；lucide-react 已核对可用） */
const MODE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  direct: MessageSquare,
  grilling: Flame,
};

/** 文本间接层（i18n key 层适配）：静态覆盖映射（现为空表）→ 后端 displayName/description 回落；接 i18n 时只换这里 */
const MODE_TEXT_OVERRIDES: Record<string, { title?: string; description?: string }> = {};

/** 输入区：模式 chip（切换会话默认）+ 新起点模式 chip + 斜杠快速切换 + 发送 */
export function Composer(p: Props) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 斜杠判定用原始首字符（trim 后判定会在多行消息第二行以 / 开头时误判）
  const slash = text.startsWith("/");
  const partial = slash ? text.slice(1) : "";
  // 前缀候选：仅供未知命令提示条沿用旧判定（有前缀候选时不提示）
  const candidates = slash && !partial.includes(" ")
    ? p.modes.filter((m) => m.key.startsWith(partial.toLowerCase())
                          || m.displayName.includes(partial))
    : [];
  // 已成完整命令（空白分隔）时的解析结果
  const parsed = slash && partial.includes(" ")
    ? (() => {
        const token = partial.split(/\s+/, 1)[0];
        const rest = text.slice(1 + token.length).trim();
        const hit = matchMode(token, p.modes);
        return { hit, rest, unknown: hit === null };
      })()
    : null;

  const current = p.modes.find((m) => m.key === p.category);

  // 面板条目：图标 + 文本间接层 + 当前会话默认模式徽章
  const entries: PaletteEntry[] = p.modes.map((m) => ({
    id: m.key,
    command: `/${m.key}`,
    title: MODE_TEXT_OVERRIDES[m.key]?.title ?? m.displayName,
    description: MODE_TEXT_OVERRIDES[m.key]?.description ?? m.description,
    icon: MODE_ICONS[m.key] ?? CircleHelp,
    badge: m.key === p.category ? "当前" : undefined,
  }));

  // 面板状态机（触发/过滤/选中/关闭重开/最近使用）；第二触发符（如 # 节点引用）在 triggers 按形状追加
  const palette = useSlashPalette({
    triggers: [{ char: "/", at: "line-start" }],
    text,
    entries,
    disabled: p.busy || p.disabled,
  });

  // 补全：填入 "/key "（含尾随空格 → 查询失效面板关闭）+ 记录最近使用
  const complete = (item: PaletteItem) => {
    palette.recordRecent(item.id);
    setText(`${item.command} `);
    taRef.current?.focus();
  };

  // form 外按下即关面板（document 捕获；面板与输入区都在面板容器内，不受影响）
  useEffect(() => {
    if (!palette.open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      palette.dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [palette.open, palette.dismiss]);

  const send = () => {
    const t = text.trim();
    if (!t || p.busy || p.disabled) return;
    // 斜杠判定与提取用原始 text（与展示路径同基点；trim 后判定会让次行 / 开头的多行消息误判）
    if (text.startsWith("/")) {
      const token = text.slice(1).split(/\s+/, 1)[0];
      const rest = text.slice(1 + token.length).trim();
      const hit = matchMode(token, p.modes);
      if (hit) {
        setText("");
        taRef.current?.focus();
        if (rest) p.onSend(rest, hit.key);   // 切换 + 余文直接作为该轮消息
        else p.onSwitchMode(hit.key);        // 仅切换
        return;
      }
      // 未知命令：提示条已显示，不阻断——原文发出（设计决策）
    }
    p.onSend(t);
    setText("");
    taRef.current?.focus();
  };

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        {(p.leafMode || slash) && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1.5 text-[12px] text-muted-foreground">
            {p.leafMode && (
              <span className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5">
                <Sprout className="h-3 w-3" /> 新起点（无上下文）
                <button title="取消新起点模式" onClick={p.onToggleLeaf}>
                  <X className="h-3 w-3 hover:text-foreground" />
                </button>
              </span>
            )}
            {slash && candidates.length === 0 && (parsed === null || parsed.unknown) && (
              <span className="rounded-full border border-dashed border-destructive/50 px-2 py-0.5 text-destructive">
                未知命令——可用：{p.modes.map((m) => `/${m.key}`).join(" ")}（原文将照常发送）
              </span>
            )}
          </div>
        )}
        <div ref={panelRef}
             className={cn(
               "relative flex items-end gap-2 rounded-panel border bg-card p-2 shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
               p.disabled && "opacity-60",
             )}>
          {/* 斜杠命令面板（键盘导航 + 视口自适应，量度锚 = 本容器） */}
          {palette.open && (
            <SlashPalette items={palette.items} selectedIndex={palette.selectedIndex}
                          anchorRef={panelRef} onHover={palette.setSelectedIndex}
                          onChoose={complete} />
          )}
          {/* 模式 chip：点击下拉切换会话默认模式 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button title="对话模式（会话默认，斜杠可临时切换）" disabled={p.disabled}
                      className="flex h-8 shrink-0 items-center gap-0.5 rounded-control px-2 text-[12px]
                                 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <Slash className="h-3 w-3 opacity-60" />
                {current?.displayName ?? "直答"}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {p.modes.map((m) => (
                <DropdownMenuItem key={m.key}
                                  className={cn(m.key === p.category && "bg-accent")}
                                  onSelect={() => p.onSwitchMode(m.key)}>
                  <span>{m.displayName}</span>
                  <span className="pl-1.5 font-mono text-[11px] text-muted-foreground">/{m.key}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              disabled={p.disabled}
              placeholder={p.disabled ? "先选择或创建一个对话" : "输入消息…（/ 切换模式，Enter 发送，Shift+Enter 换行）"}
              onChange={(e) => {
                setText(e.target.value);
                palette.notifyTextEdited();   // 继续输入即重开面板（Escape 关闭后）
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                // 面板打开：导航/补全优先（IME 组合中不劫持按键）
                if (palette.open && !e.nativeEvent.isComposing) {
                  if (e.key === "ArrowDown") { e.preventDefault(); palette.move(1); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); palette.move(-1); return; }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    complete(palette.items[palette.selectedIndex]);
                    return;
                  }
                  if (e.key === "Escape") { e.preventDefault(); palette.dismiss(); return; }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              className="max-h-40 min-h-[24px] w-full resize-none bg-transparent px-1.5 py-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <button
            title="新起点模式：下一条为无上下文提问"
            onClick={p.onToggleLeaf}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors",
              p.leafMode ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Sprout className="h-4 w-4" />
          </button>
          <button
            title="发送"
            onClick={send}
            disabled={!text.trim() || p.busy || p.disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

行为保留核对表（执行后逐条自查）：
- `send()`、`matchMode`、未知命令提示条（`candidates` 旧判定）、leaf chip、模式 chip 下拉、Sprout/发送按钮——逐行未动
- 删除的只有：旧 `w-56` 候选面板渲染块及其 `candidates` 面板用途（`candidates` 变量保留给提示条）
- 面板打开时 Enter/Tab = 补全（行为变化点，规格已认可）；面板不在时 Enter 照常发送

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: 退出码 0。

- [ ] **Step 3: 提交（只暂存本文件）**

```bash
git add web/src/chat/Composer.tsx
git commit -m "feat(web): Composer 接入斜杠命令面板——键盘导航/补全优先/Escape 重开/当前徽章/图标/文本间接层"
```

---

### Task 4: 回归门 + 手工验证 + roadmap 变更日志

**Files:**
- Modify: `roadmap.md`（变更日志节追加一行）
- Test: 手工验证清单（dev 起服务）

- [ ] **Step 1: 后端套件不回归**

Run: `uv run pytest tests/ -q`
Expected: 全绿（本计划零后端改动）。

- [ ] **Step 2: 起服务手工验证**

后端：`uv run uvicorn server.app:app --port 8000`；前端：`cd web && npm run dev`，浏览器开 `http://localhost:5173`，进入一个 chat 会话，逐条核对：

1. 输入 `/` 唤起面板：两条模式带图标/标题/描述/等宽命令，会话默认模式带「当前」徽章
2. `↑`/`↓` 循环移动选中；`Tab` 或 `Enter` 补全为 `/key ` 且面板关闭；`Escape` 关闭后继续输入重开
3. 鼠标悬停同步选中；点击条目补全
4. `/grilling 继续拷问` 发送 → 本轮消息模式徽章为拷问；`/grilling` 单独发送 → 会话默认切换（chip 文案变）
5. 补全两次后重新输入 `/` → 用过的模式排前且带「最近」徽章；刷新页面仍生效
6. 输入 `/nope xxx` → 虚线提示条「未知命令……原文将照常发送」且发送后原文入会话
7. 多行消息第二行以 `/` 开头发送 → 不误触发模式（原始行首判定保留）
8. 中文 IME 组合中按 Enter → 不误发送不误补全
9. 聊天区高度不足（把会话内容拉满屏）时面板 maxHeight 收缩，不遮住内容

- [ ] **Step 3: roadmap 变更日志追加**

在 `roadmap.md` 的 `## 变更日志` 节**顶部**追加（沿用该节现有条目格式）：

```markdown
- 2026-09-24 斜杠指令面板完整升级（参考 nanobot ThreadComposer）：`web/src/chat/` 新增 `useSlashPalette`（触发符注册扩展点/过滤排序/选中态/最近使用 localStorage）+ `SlashPalette`（listbox 无障碍/图标+描述+徽章/视口自适应 above/below/滚动跟随），Composer 键盘全路径导航（↑↓/Tab/Enter 补全/Escape 重开）、「当前」徽章、静态覆盖文本间接层；指令集不扩展、后端零改动。设计：docs/superpowers/specs/2026-09-24-slash-command-palette-design.md
```

- [ ] **Step 4: 构建门 + 提交（只暂存 roadmap.md）**

```bash
cd web && npm run build && cd ..
git add roadmap.md
git commit -m "docs: roadmap 变更日志——斜杠指令面板完整升级（nanobot 对标）"
```

---

## 自审记录（写计划后自查）

1. **规格覆盖**：键盘导航（Task 3 Step 1 onKeyDown）、Escape 关闭/输入重开（hook dismissed + notifyTextEdited）、悬停同步（onMouseEnter）、form 外点击关闭（Task 3 useEffect）、listbox 无障碍（Task 2 role/aria）、图标/标题/描述/等宽命令（Task 2 渲染 + Task 3 entries）、「当前」徽章（Task 3 badge）、「最近」徽章+排序+持久化（hook recents）、视口测量 above/below/maxHeight（Task 2 useLayoutEffect）、滚动跟随（Task 2 第二个 useLayoutEffect）、8 条截断（PALETTE_LIMIT）、IME 保护（isComposing）、触发符扩展点（SlashTrigger 形状 + 注释）、i18n 间接层（MODE_TEXT_OVERRIDES）、发送路径/未知命令提示保留（Task 3 保留核对表）、验收命令（各 Step 2 + Task 4）——逐条对应，无缺口。
2. **占位符扫描**：无 TBD/TODO/"适当处理"；所有代码步骤含完整代码。
3. **类型一致性**：`PaletteEntry`/`PaletteItem`/`SlashTrigger` 在 Task 1 定义、Task 2/3 引用一致；`palette.move/dismiss/notifyTextEdited/recordRecent/setSelectedIndex/items/selectedIndex/open` hook 返回与 Composer 用法一致；`anchorRef: RefObject<HTMLElement>` 与 `useRef<HTMLDivElement>(null)` 兼容（readonly current 协变）；lucide 图标赋 `ComponentType<{className?: string}>` 已探针验证（tsc exit 0）。

## 实施偏差记录（2026-09-24 执行期，审查驱动）

计划内代码块与落地代码在以下三处有意偏差（均为审查修复、更安全方向），其余逐字一致：

- `useSlashPalette.ts` `recordRecent`：副作用 `storeRecents` 从 setState updater 内移到 updater
  外（React 纯净契约——StrictMode 双调用/concurrent 重放下 updater 必须纯）；`recents` 入
  useCallback 依赖。commit d84cc79
- `SlashPalette.tsx` 测量 useLayoutEffect 依赖补 `items.length`（规格「条数变化时重算」，对齐
  nanobot 参照的 filteredSlashCommands.length）——commit 8b579ae
- `Composer.tsx`：「当前」徽章与下拉高亮以 `effectiveCategory = p.category || "direct"` 归一化
  （空串 = 直答缺省，跨栈约定；否则徽章在默认会话永不显示）——commit 298f613；同 commit 在
  onKeyDown Tab/Enter 补全分支加空项守卫 `if (item)`

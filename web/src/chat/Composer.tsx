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

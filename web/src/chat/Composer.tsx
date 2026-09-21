import { ChevronDown, Leaf, SendHorizontal, Slash, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Mode } from "./types";
import { cn } from "../lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

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

/** 输入区：模式 chip（切换会话默认）+ 叶子模式 chip + 斜杠快速切换 + 发送 */
export function Composer(p: Props) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 斜杠判定用原始首字符（trim 后判定会在多行消息第二行以 / 开头时误判）
  const slash = text.startsWith("/");
  // 候选（命令面板）：斜杠后、未出现空白前的 token 前缀过滤
  const partial = slash ? text.slice(1) : "";
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
                <Leaf className="h-3 w-3" /> 叶子模式（无上下文）
                <button title="取消叶子模式" onClick={p.onToggleLeaf}>
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
        <div className={cn(
          "flex items-end gap-2 rounded-panel border bg-card p-2 shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          p.disabled && "opacity-60",
        )}>
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
            {/* 斜杠命令面板（建议列表，点击补全） */}
            {slash && candidates.length > 0 && (
              <div className="absolute bottom-full left-0 z-10 mb-1 w-56 rounded-panel border bg-card p-1 shadow-md">
                {candidates.map((m) => (
                  <button key={m.key}
                          onClick={() => { setText(`/${m.key} `); taRef.current?.focus(); }}
                          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] hover:bg-accent">
                    <span className="font-mono text-[11px] text-muted-foreground">/{m.key}</span>
                    <span>{m.displayName}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              disabled={p.disabled}
              placeholder={p.disabled ? "先选择或创建一个对话" : "输入消息…（/ 切换模式，Enter 发送，Shift+Enter 换行）"}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              className="max-h-40 min-h-[24px] w-full resize-none bg-transparent px-1.5 py-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <button
            title="叶子模式：下一条为无上下文提问"
            onClick={p.onToggleLeaf}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors",
              p.leafMode ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Leaf className="h-4 w-4" />
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

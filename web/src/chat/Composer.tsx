import { Leaf, SendHorizontal, X } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../lib/utils";

interface Props {
  leafMode: boolean;
  busy: boolean;
  disabled: boolean;
  onToggleLeaf: () => void;
  onSend: (text: string) => void;
}

/** 输入区：叶子模式 chip + 发送。分支 = 点节点/轮末「从此分支」后发送（指针位置见头部） */
export function Composer(p: Props) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const t = text.trim();
    if (!t || p.busy || p.disabled) return;
    p.onSend(t);
    setText("");
    taRef.current?.focus();
  };

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        {p.leafMode && (
          <div className="flex items-center gap-1.5 pb-1.5 text-[12px] text-muted-foreground">
            <span className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5">
              <Leaf className="h-3 w-3" /> 叶子模式（无上下文）
              <button title="取消叶子模式" onClick={p.onToggleLeaf}>
                <X className="h-3 w-3 hover:text-foreground" />
              </button>
            </span>
          </div>
        )}
        <div className={cn(
          "flex items-end gap-2 rounded-panel border bg-card p-2 shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          p.disabled && "opacity-60",
        )}>
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            disabled={p.disabled}
            placeholder={p.disabled ? "先选择或创建一个对话" : "输入消息…（Enter 发送，Shift+Enter 换行）"}
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
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
          />
          <button
            title="叶子模式：下一条为无上下文提问"
            onClick={p.onToggleLeaf}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-control transition-colors",
              p.leafMode ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Leaf className="h-4 w-4" />
          </button>
          <button
            title="发送"
            onClick={send}
            disabled={!text.trim() || p.busy || p.disabled}
            className="flex h-8 w-8 items-center justify-center rounded-control bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

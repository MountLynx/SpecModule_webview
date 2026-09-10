// 顶部页签栏（二期页签制核心）：📦 模块库固定页签永远在首位；每个 chat 会话、
// 每个 run 视图各占一页签，可同时存在。点选激活主区内容，× 关闭（模块库不可关）。
import { Box, MessageSquare, Play, X } from "lucide-react";
import { cn } from "../lib/utils";

export type TabKind = "modules" | "chat" | "run";

export interface TabItem {
  /** "modules" | `chat:${sid}` | `run:${runId}` */
  id: string;
  kind: TabKind;
  label: string;
  closable: boolean;
}

interface Props {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose }: Props) {
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-sidebar">
      {tabs.map((t) => {
        const active = t.id === activeId;
        const Icon = t.kind === "modules" ? Box : t.kind === "chat" ? MessageSquare : Play;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            title={t.label}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-r px-3 text-[12.5px]",
              active ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[160px] truncate">{t.label}</span>
            {t.closable && (
              <button
                title="关闭页签"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                className={cn(
                  "ml-0.5 rounded p-0.5 hover:bg-foreground/10",
                  active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

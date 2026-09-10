// 最左活动栏（VSCode 式，结构移植自 TreeChat webui）：图标 = 侧边栏页签切换。
// 二期页签制语义：chat/tree/cards 中 tree/cards 是「页签配套功能」（内容随激活
// chat 页签切换）；chat/modules/runs/settings 是「全局功能」（不随页签变）。
import type { ComponentType } from "react";
import { Boxes, GitFork, Layers, List, MessageSquare, Settings } from "lucide-react";
import { cn } from "../lib/utils";

export type Tab = "chat" | "tree" | "cards" | "modules" | "runs" | "settings";

const TABS: { key: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: "chat", label: "对话", icon: MessageSquare },
  { key: "tree", label: "对话树（随激活对话页签）", icon: GitFork },
  { key: "cards", label: "卡片（随激活对话页签）", icon: Layers },
  { key: "modules", label: "模块库", icon: Boxes },
  { key: "runs", label: "运行历史", icon: List },
];

interface Props {
  tab: Tab;
  onTab: (t: Tab) => void;
}

export function ActivityBar({ tab, onTab }: Props) {
  const item = (key: Tab, label: string, Icon: ComponentType<{ className?: string }>) => (
    <button
      key={key}
      title={label}
      onClick={() => onTab(key)}
      className={cn(
        "relative flex h-12 w-full items-center justify-center transition-colors",
        tab === key ? "text-foreground" : "text-activitybar-foreground hover:text-foreground",
      )}
    >
      {tab === key && (
        <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-foreground" />
      )}
      <Icon className="h-5 w-5" />
    </button>
  );

  return (
    <nav className="flex h-full w-12 shrink-0 flex-col items-center bg-activitybar text-activitybar-foreground">
      <div className="flex w-full flex-col">{TABS.map((t) => item(t.key, t.label, t.icon))}</div>
      <div className="flex-1" />
      {item("settings", "设置", Settings)}
    </nav>
  );
}

// 最左活动栏（VSCode 式，结构移植自 TreeChat webui）：图标 = 侧边栏页签；
// 底部设置占位。二期对话功能（对话/对话树/卡片）在此之上追加图标。
import type { ComponentType } from "react";
import { Boxes, List, Settings } from "lucide-react";
import { cn } from "../lib/utils";

export type Tab = "modules" | "runs";

const TABS: { key: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
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
      <button
        title="设置（占位）"
        disabled
        className="flex h-12 w-full cursor-default items-center justify-center text-activitybar-foreground/50"
      >
        <Settings className="h-5 w-5" />
      </button>
    </nav>
  );
}

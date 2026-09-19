// 思考块（chat 回合思考行与 run 节点面板共用，视觉同源）：左边框 running 蓝、
// 斜体、muted 文本、240px 滚动上限。展开/收起交互留在消费端（chat 自动收起、
// NodePanel 手动覆盖自动），组件只管视觉；ref 转发供消费端做跟随尾部滚动。
import { forwardRef } from "react";
import { cn } from "../lib/utils";

export const ThinkBlock = forwardRef<HTMLDivElement, { text: string; className?: string }>(
  function ThinkBlock({ text, className }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "max-h-[240px] overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--ph-running-border)] pl-2 text-[11px] italic text-muted-foreground",
          className,
        )}
      >
        {text}
      </div>
    );
  },
);

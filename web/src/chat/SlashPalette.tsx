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
  }, [anchorRef, items.length]);

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

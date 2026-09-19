// 侧栏拖宽：手柄组件 + useResizableWidth hook，左右两侧通用。手柄是夹在侧栏与
// 相邻区之间的细竖条（pointer capture 拖拽，拖动期间 body 禁选中 + 全局
// col-resize 光标，指针滑出手柄仍持续跟踪）；宽度持久化 localStorage（右侧节点
// 面板随节点切换重挂载，靠持久化恢复），双击手柄复位默认宽度。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/utils";

interface ResizableOptions {
  /** localStorage 键（沿用 specmodule-webview.* 前缀） */
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  /** 侧栏方位：left 侧栏拖右增宽，right 侧栏拖左增宽 */
  side: "left" | "right";
}

export function useResizableWidth({ storageKey, initial, min, max, side }: ResizableOptions) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width; // 渲染期同步：拖拽起点与落盘都取最新值
  const startRef = useRef({ x: 0, width: 0 });
  const sign = side === "left" ? 1 : -1;

  const clamp = useCallback(
    (w: number) => Math.min(max, Math.max(min, Math.round(w))),
    [min, max],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, width: widthRef.current };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setWidth(clamp(startRef.current.width + sign * (e.clientX - startRef.current.x)));
    },
    [dragging, clamp, sign],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      localStorage.setItem(storageKey, String(widthRef.current));
    },
    [dragging, storageKey],
  );

  // 双击复位：清持久化回到默认宽度
  const resetWidth = useCallback(() => {
    localStorage.removeItem(storageKey);
    setWidth(initial);
  }, [storageKey, initial]);

  // 拖动期间全局禁选中 + col-resize 光标（指针滑出手柄后体验仍正确）
  useEffect(() => {
    if (!dragging) return;
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
    };
  }, [dragging]);

  return {
    width,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: resetWidth,
    },
  };
}

/** 拖宽手柄：细竖条，悬停/拖拽显色；自身就是 flex 布局项，不遮盖相邻内容 */
export function ResizeHandle({
  dragging,
  className,
  ...rest
}: { dragging: boolean } & ComponentProps<"div">) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "z-10 w-1.5 shrink-0 cursor-col-resize touch-none transition-colors",
        dragging ? "bg-primary/40" : "bg-transparent hover:bg-foreground/10",
        className,
      )}
      {...rest}
    />
  );
}

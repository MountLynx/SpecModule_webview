// 运行态 spinner：running 语义色圆环旋转（reduced-motion 由 index.css 降级为静态）。
import { cn } from "../../lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ph-spin inline-block h-3 w-3 shrink-0 rounded-full border-2 border-[var(--ph-running)] border-t-transparent",
        className,
      )}
    />
  );
}

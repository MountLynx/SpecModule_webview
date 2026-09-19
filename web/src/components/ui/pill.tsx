// 胶囊基件：默认 = 浅描边中性；emphasis = primary 反色（选中/强调，亮色黑底白字）；
// running/done/failed/cancelled/truncated = 状态洗淡色（只表达状态，不表达选中）。
// 消费端禁止再手搓胶囊样式——统一走这里。
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const pillVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-[11px] leading-4",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-muted-foreground",
        emphasis: "border-primary bg-primary text-primary-foreground",
        running:
          "border-[var(--ph-running-border)] bg-[var(--ph-running-bg)] text-[var(--ph-running-text)]",
        done: "border-[var(--ph-done-border)] bg-[var(--ph-done-bg)] text-[var(--ph-done-text)]",
        failed:
          "border-[var(--ph-aborted-border)] bg-[var(--ph-aborted-bg)] text-[var(--ph-aborted-text)]",
        cancelled:
          "border-[var(--ph-cancelled-border)] bg-[var(--ph-cancelled-bg)] text-[var(--ph-cancelled-text)]",
        truncated:
          "border-[var(--ph-truncated-border)] bg-[var(--ph-truncated-bg)] text-[var(--ph-truncated-text)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type PillVariant = NonNullable<VariantProps<typeof pillVariants>["variant"]>;

export interface PillProps extends ComponentProps<"span">, VariantProps<typeof pillVariants> {}

export function Pill({ className, variant, ...props }: PillProps) {
  return <span className={cn(pillVariants({ variant }), className)} {...props} />;
}

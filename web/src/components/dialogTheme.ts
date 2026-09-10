// 对话框共享 Tailwind 类（旧 dialogStyles.ts 内联样式的继任者）。
// overlay/panel 对应旧 overlayStyle/dialogStyle；label 对应 fieldLabel。
export const overlayCls =
  "fixed inset-0 z-[1000] flex items-center justify-center bg-black/45";
export const panelCls =
  "flex max-h-[86vh] w-[520px] max-w-[92vw] flex-col gap-2.5 overflow-auto rounded-lg bg-card p-4 text-[13px] text-card-foreground shadow-xl";
/** 窄面板变体（CheckpointDialog 用） */
export const panelNarrowCls = "w-[420px]";
export const labelCls = "text-[12.5px] font-semibold";
/** 全宽基础输入（select/旧 input 共用；ui/input 的 Input 组件之外的场合） */
export const fieldCls =
  "w-full rounded-control border border-input bg-transparent px-2.5 py-1 text-[13px]";
export const errTextCls = "text-[12px] text-destructive";
export const warnTextCls = "text-[12px] text-[var(--ph-truncated)]";
export const okTextCls = "text-[12px] text-[var(--ph-done)]";
/** textarea 非法 JSON 描红（对应旧 badTextarea） */
export const badOutlineCls = "outline outline-2 outline-destructive";

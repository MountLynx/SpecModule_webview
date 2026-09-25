// 侧栏组件库面板（Task 11 实现完整功能；占位保证壳层可编译）。
interface Props {
  activeDraft: string | null;
  onOpenDraft: (name: string) => void;
  onCreated: (name: string) => void;
  onDeleted: (name: string) => void;
}

export function LibraryPanel(_props: Props) {
  return <div className="flex-1 overflow-auto p-3 text-[12px] text-muted-foreground">组件库加载中…</div>;
}

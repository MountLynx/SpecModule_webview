// 模块创建器主区（Task 12-14 实现完整功能；占位保证壳层可编译）。
interface Props {
  name: string;
  onInstalled: (moduleName: string) => void;
}

export function ModuleBuilder({ name }: Props) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
      创建器加载中：{name}
    </div>
  );
}

// 模块库侧栏列表：store.list_modules 摘要（模块数据归本组件自取）+
// 「扫描来源」尾行。选中项由壳层持有（openModuleName），主区 ModuleDetail 联动。
import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { fetchModules, type ModuleInfo } from "../api";
import { cn } from "../lib/utils";

/** kind 徽章底色（沿用旧 KIND_COLOR 现值） */
/* 与 ModuleDetail 的 KIND_BADGE 保持同步（List/Detail 两处小映射，暂不提取共享） */
const KIND_BADGE: Record<string, string> = {
  entry: "bg-[var(--ph-running)]",
  packed: "bg-[#7c3aed]",
  pip: "bg-[#0891b2]",
};

interface ModuleListProps {
  selected: string | null;
  onSelect: (name: string) => void;
}

export function ModuleList({ selected, onSelect }: ModuleListProps) {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchModules()
      .then((d) => {
        setModules(d.modules);
        setSearchPaths(d.search_paths);
        setLoadErr(null);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3.5 pb-2 pt-2.5 text-[11px] font-semibold text-muted-foreground">
        <Boxes className="h-3.5 w-3.5" />
        模块库
        <span className="font-normal text-muted-foreground">{modules.length} 个</span>
        {loadErr && (
          <span title={loadErr} className="truncate font-normal text-[12px] text-destructive">
            {loadErr}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {modules.map((m) => (
          <div
            key={`${m.kind}:${m.name}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(m.name)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(m.name);
              }
            }}
            className={cn(
              "mb-px cursor-pointer rounded-[7px] px-2.5 py-[7px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              m.name === selected && "bg-sidebar-selected",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[9.5px] leading-4 text-white",
                  KIND_BADGE[m.kind] ?? "bg-muted-foreground",
                )}
              >
                {m.kind}
              </span>
              <span className="truncate text-[12px] font-semibold">{m.name}</span>
              {m.version && (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  v{m.version}
                </span>
              )}
            </div>
            {m.description && (
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {m.description}
              </div>
            )}
          </div>
        ))}
        {!modules.length && !loadErr && (
          <div className="px-3 py-3 text-[12px] text-muted-foreground">未发现模块</div>
        )}
      </div>
      {/* 扫描来源：排查「为什么看不到我的模块」 */}
      <div className="border-t px-3.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <div className="mb-1 font-semibold">扫描来源（优先序）</div>
        {searchPaths.length ? (
          searchPaths.map((p) => (
            <div key={p} className="break-all font-mono">
              {p}
            </div>
          ))
        ) : (
          <div>（无——base_dir/modules、$SPECMODULE_PATH、store/modules 均不存在）</div>
        )}
      </div>
    </div>
  );
}

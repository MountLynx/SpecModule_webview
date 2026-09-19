// 运行历史侧栏列表：紧凑行（phase 色点 + 模块名 + 相对时间 + run_id + tick/
// 错误摘要）+ 行内控制（暂停/继续/取消/恢复/删除）。语义与旧全宽 RunsView
// 一致：整行点击打开 run；删除终态确认、running 提示先取消 + force 二次确认。
import { useState } from "react";
import { Ban, Pause, Play, RotateCcw, RefreshCw, Trash2 } from "lucide-react";
import {
  TERMINAL_PHASES,
  deleteRun,
  type ControlAction,
  type RunSummary,
} from "../api";
import { cn, oneLine, relativeTime } from "../lib/utils";
import { Button } from "./ui/button";

/** phase → 色点类（语义色定义于 index.css :root） */
const PHASE_DOT: Record<string, string> = {
  running: "bg-[var(--ph-running)]",
  done: "bg-[var(--ph-done)]",
  aborted: "bg-[var(--ph-aborted)]",
  cancelled: "bg-[var(--ph-cancelled)]",
  truncated: "bg-[var(--ph-truncated)]",
  unknown: "bg-muted-foreground/60",
};

/** 非英文 phase 的展示标签（其余原样显示） */
const PHASE_LABEL: Record<string, string> = {
  truncated: "已截断",
  unknown: "未知",
};

/** 行内小控制钮统一规格 */
// 不含 rounded：twMerge 不识别自定义 rounded 键，与 size=sm 的 rounded-control 合并不会去重
const ctlBtn = "h-5 px-1.5 text-[10.5px]";

interface RunListProps {
  runs: RunSummary[];
  /** 历史总目录数（尾部只计不展开；> runs.length 时显示提示） */
  total: number;
  current: string | null;
  onSelect: (id: string) => void;
  onControl: (id: string, action: ControlAction) => void;
  onResume: (id: string) => void;
  /** 删除成功回调（壳层刷新列表；删的是当前打开的 run 则清 runId） */
  onDeleted: (runId: string) => void;
  /** 手动刷新（列表不做周期轮询） */
  onRefresh: () => void;
}

export function RunList({
  runs,
  total,
  current,
  onSelect,
  onControl,
  onResume,
  onDeleted,
  onRefresh,
}: RunListProps) {
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const del = async (r: RunSummary) => {
    setErr(null);
    let force = false;
    if (r.phase === "running") {
      const ok = window.confirm(
        `运行 ${r.run_id} 进行中——建议先取消再删除。\n确定强制删除？（不会停止进程，进程可能继续写已被删的目录）`,
      );
      if (!ok) return;
      force = true;
    } else if (!window.confirm(`删除运行 ${r.run_id}？（整个 run 目录，不可恢复）`)) {
      return;
    }
    setBusyId(r.run_id);
    try {
      await deleteRun(r.run_id, force);
      onDeleted(r.run_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3.5 pb-2 pt-2.5 text-[12.5px] font-bold">
        运行历史
        <span className="font-normal text-muted-foreground">{total} 条</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10.5px]"
          onClick={onRefresh}
        >
          <RefreshCw className="h-3 w-3" />
          刷新
        </Button>
        {err && (
          <span title={err} className="min-w-0 truncate font-normal text-[11.5px] text-destructive">
            {err}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {runs.map((r) => {
          const terminal = TERMINAL_PHASES.has(r.phase);
          const moduleName = r.module ?? r.run_id;
          return (
            <div
              key={r.run_id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(r.run_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(r.run_id);
                }
              }}
              className={cn(
                "mb-px cursor-pointer rounded-[7px] px-2.5 py-[7px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                r.run_id === current && "bg-sidebar-selected",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    PHASE_DOT[r.phase] ?? "bg-muted-foreground/60",
                  )}
                />
                <span className="truncate text-[12.5px] font-semibold">{moduleName}</span>
                {r.module == null && (
                  <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                    （启发式）
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                  {relativeTime(r.updated_at * 1000)}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                {r.run_id}
              </div>
              <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                {PHASE_LABEL[r.phase] ?? r.phase}
                {r.paused && <span className="text-[var(--ph-cancelled)]"> · 已暂停</span>}
                {r.tick != null ? ` · tick ${r.tick}` : ""}
                {!r.has_sqlite && " · 无 run.sqlite"}
              </div>
              {r.error && (
                <div className="mt-0.5 text-[10.5px] leading-snug text-destructive">
                  {oneLine(r.error, 80)}
                </div>
              )}
              <div className="mt-[5px] flex gap-1" onClick={(e) => e.stopPropagation()}>
                {r.phase === "running" && !r.paused && (
                  <Button variant="outline" size="sm" className={ctlBtn} title="暂停"
                    onClick={() => onControl(r.run_id, "pause")}>
                    <Pause className="h-3 w-3" />
                    暂停
                  </Button>
                )}
                {r.phase === "running" && r.paused && (
                  <Button variant="outline" size="sm" className={ctlBtn} title="继续"
                    onClick={() => onControl(r.run_id, "unpause")}>
                    <Play className="h-3 w-3" />
                    继续
                  </Button>
                )}
                {r.phase === "running" && (
                  <Button variant="outline" size="sm" className={cn(ctlBtn, "text-destructive")}
                    title="取消"
                    onClick={() => {
                      if (window.confirm(`取消运行 ${r.run_id}？`)) onControl(r.run_id, "cancel");
                    }}>
                    <Ban className="h-3 w-3" />
                    取消
                  </Button>
                )}
                {terminal && (
                  <Button variant="outline" size="sm" className={ctlBtn} title="恢复/回退"
                    onClick={() => onResume(r.run_id)}>
                    <RotateCcw className="h-3 w-3" />
                    恢复
                  </Button>
                )}
                <Button variant="outline" size="sm"
                  className={cn(ctlBtn, "text-destructive")} title="删除该 run 目录"
                  disabled={busyId === r.run_id}
                  onClick={() => del(r)}>
                  <Trash2 className="h-3 w-3" />
                  删除
                </Button>
              </div>
            </div>
          );
        })}
        {total > runs.length && (
          <div className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            共 {total} 条 · 仅展开最近 {runs.length} 条，更早历史用 CLI
            <code className="mx-1 font-mono">specmodule runs</code>
            查看
          </div>
        )}
        {!runs.length && (
          <div className="px-3 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
            暂无运行记录——到「模块库」发起一个运行，或用 CLI 在运行根目录起 run。
          </div>
        )}
      </div>
    </div>
  );
}

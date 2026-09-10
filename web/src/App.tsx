// App 壳层：VSCode 式三段布局（活动栏 + 侧边栏 + 主区）——侧栏导航范式：
// 列表常驻侧边栏，主区内容随选择变化（模块详情/发起、运行图），不再互斥切换。
// 壳层持有跨视图状态：当前页签、打开的模块/run、runs 轮询、恢复对话框请求。
// 不引 router（useState 范式，与 TreeChat webui 一致）。
import { useCallback, useEffect, useState } from "react";
import {
  fetchRuns,
  postControl,
  type ControlAction,
  type LaunchResult,
  type RunSummary,
} from "./api";
import { ActivityBar, type Tab } from "./components/ActivityBar";
import { ModuleDetail } from "./components/ModuleDetail";
import { ModuleList } from "./components/ModuleList";
import { RunList } from "./components/RunList";
import { RunView, type ResumeRequestMsg } from "./components/RunView";

/** 主区空态（两页签同构落点） */
function EmptyState({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
      <div className="text-[34px]">{icon}</div>
      <div className="text-[13.5px]">{title}</div>
      <div className="text-[11.5px] opacity-70">{hint}</div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("runs");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [openModuleName, setOpenModuleName] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // 打开恢复对话框的请求：带目标 runId（避免全局计数器泄漏到无关 run 的切换）+ seq 去重
  const [resumeRequest, setResumeRequest] = useState<ResumeRequestMsg | null>(null);

  const refreshRuns = useCallback(() => {
    fetchRuns()
      .then(setRuns)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRuns();
    const t = setInterval(refreshRuns, 5000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  // 打开 run：主区换内容（侧栏列表常驻，不再切走）
  const openRun = useCallback((id: string) => {
    setOpenRunId(id);
  }, []);

  // RunList 行内 ↻：打开目标 run 并请求恢复对话框（RunControls 按 runId + seq 守卫）
  const handleListResume = useCallback((rid: string) => {
    setTab("runs");
    setOpenRunId(rid);
    setResumeRequest({ runId: rid, seq: Date.now() });
  }, []);

  // 恢复请求已被 RunControls 消费（防 run 切换重挂载后陈旧请求重放误开对话框）
  const consumeResumeRequest = useCallback(() => setResumeRequest(null), []);

  // RunList 行内控制：失败静默——列表 5s 轮询刷新后状态即真相
  const handleListControl = useCallback(
    async (rid: string, action: ControlAction) => {
      try {
        await postControl(rid, action);
      } catch {
        // 行内静默：刷新后状态即真相
      }
      refreshRuns();
    },
    [refreshRuns],
  );

  // 删除成功：刷新列表；删的是当前打开的 run 则清空主区回空态
  const handleDeleted = useCallback(
    (deletedId: string) => {
      refreshRuns();
      setOpenRunId((cur) => (cur === deletedId ? null : cur));
    },
    [refreshRuns],
  );

  // 模块库发起运行成功（202）：切「运行历史」页签并打开新 run
  const handleLaunched = useCallback(
    (r: LaunchResult) => {
      refreshRuns();
      setTab("runs");
      setOpenRunId(r.run_id);
    },
    [refreshRuns],
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ActivityBar tab={tab} onTab={setTab} />

      {/* 侧边栏（页签内容） */}
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r bg-sidebar">
        {tab === "modules" ? (
          <ModuleList selected={openModuleName} onSelect={setOpenModuleName} />
        ) : (
          <RunList
            runs={runs}
            current={openRunId}
            onSelect={openRun}
            onControl={handleListControl}
            onResume={handleListResume}
            onDeleted={handleDeleted}
          />
        )}
      </aside>

      {/* 主区（内容随选择变化） */}
      <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
        {tab === "modules" ? (
          openModuleName ? (
            <ModuleDetail key={openModuleName} name={openModuleName} onLaunched={handleLaunched} />
          ) : (
            <EmptyState icon="📦" title="未选择模块" hint="从左侧模块库选择，查看详情并发起运行" />
          )
        ) : openRunId ? (
          <RunView
            key={openRunId}
            runId={openRunId}
            resumeRequest={resumeRequest}
            onResumeRequestConsumed={consumeResumeRequest}
            onRequestResume={(rid) => setResumeRequest({ runId: rid, seq: Date.now() })}
            onRefreshRuns={refreshRuns}
          />
        ) : (
          <EmptyState
            icon="🧭"
            title="未打开任何 run"
            hint="从左侧运行历史选择，或到「模块库」发起一个运行"
          />
        )}
      </main>
    </div>
  );
}

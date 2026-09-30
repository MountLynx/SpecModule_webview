// 头部控制条：phase 感知的运行控制（暂停/继续/取消/终止恢复进程）+ 存检查点 +
// 终态恢复/回退入口。控制逻辑（含 resumeRequest runId+seq 守卫）不变，仅换皮。
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Bookmark, Pause, Play, RotateCcw, Square } from "lucide-react";
import { postControl, TERMINAL_PHASES, type ControlAction } from "../api";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { ResumeDialog } from "./ResumeDialog";
import { CheckpointDialog } from "./CheckpointDialog";
import { Spinner } from "./ui/spinner";
import { errTextCls } from "./dialogTheme";

interface RunControlsProps {
  runId: string;
  phase: string | null;
  paused: boolean;
  /** control.json 有未消费的 cancel 请求（仍在等 tick 边界）——暂停/取消按钮禁用 + 胶囊反馈 */
  cancelRequested: boolean;
  /** 终止成功且 status 残留 running——进程已死，control.json 无人消费，暂停/取消/继续全部隐藏 */
  terminated: boolean;
  /** 模块选择器当前值（缺省启发式 = runId），恢复对话框的模块名预填 */
  moduleHint: string | null;
  /** 动作成功后的回调（App 据此刷新 run 列表等） */
  onAction: () => void;
  /** 打开恢复对话框的请求（黄条/行内按钮发起；带目标 runId + seq） */
  resumeRequest: { runId: string; seq: number } | null;
  /** 恢复请求已消费（App 据此清空，防重挂载重放） */
  onResumeRequestConsumed?: () => void;
  /** 本 server 拉起的恢复子进程在跑（/process 轮询） */
  procRunning: boolean;
  onTerminate: () => void;
  /** 恢复对话框成功拉起新进程（202）——RunView 据此退出已终止态 */
  onResumeStarted?: () => void;
}

export function RunControls({
  runId,
  phase,
  paused,
  cancelRequested,
  terminated,
  moduleHint,
  onAction,
  resumeRequest,
  onResumeRequestConsumed,
  procRunning,
  onTerminate,
  onResumeStarted,
}: RunControlsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cpOpen, setCpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(
    async (action: ControlAction) => {
      setBusy(true);
      setErr(null);
      try {
        await postControl(runId, action);
        onAction();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [runId, onAction],
  );

  const running = phase === "running";
  const resumable = phase != null && (TERMINAL_PHASES.has(phase) || running);
  // 终止后控制通道已死：control.json 写了也没人消费——暂停/继续/取消/已暂停胶囊一并隐藏
  const controlsDead = terminated && running;
  // 取消已请求、尚未被 tick 边界消费：暂停会覆盖 control.json 里的 cancel（请求丢失），一并禁用
  const cancelPending = cancelRequested && running && !controlsDead;

  // 外部请求打开恢复对话框（ref 记上次已响应的 seq——只响应当前 run 的新请求）
  const lastSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      resumeRequest &&
      resumeRequest.runId === runId &&
      resumeRequest.seq !== lastSeqRef.current
    ) {
      lastSeqRef.current = resumeRequest.seq;
      setDialogOpen(true);
      onResumeRequestConsumed?.();
    }
  }, [resumeRequest, runId, onResumeRequestConsumed]);

  return (
    <div className="ml-auto flex items-center gap-2">
      {paused && !controlsDead && (
        <Pill variant="cancelled">
          <Pause className="h-3 w-3" />
          已暂停
        </Pill>
      )}
      {running && !paused && !controlsDead && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || cancelPending}
          title={cancelPending ? "已有待消费的取消请求" : undefined}
          onClick={() => act("pause")}
        >
          <Pause className="h-3.5 w-3.5" />暂停
        </Button>
      )}
      {running && paused && !controlsDead && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("unpause")}>
          <Play className="h-3.5 w-3.5" />继续
        </Button>
      )}
      {running && !controlsDead && (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={busy || cancelPending}
          onClick={() => {
            if (window.confirm("取消该运行？（已落盘，可稍后恢复/回退）")) act("cancel");
          }}
        >
          <Ban className="h-3.5 w-3.5" />取消
        </Button>
      )}
      {cancelPending && (
        <Pill variant="cancelled">
          <Spinner className="h-2.5 w-2.5 border-[1.5px]" />
          取消已请求，等待当前 tick 结束…
        </Pill>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setCpOpen(true)}>
        <Bookmark className="h-3.5 w-3.5" />存检查点…
      </Button>
      {procRunning && (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm("硬终止恢复子进程？（不写终态，status 停留 running；之后可强制恢复）")) {
              onTerminate();
            }
          }}
        >
          <Square className="h-3.5 w-3.5" />终止进程
        </Button>
      )}
      {resumable && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialogOpen(true)}>
          <RotateCcw className="h-3.5 w-3.5" />恢复 / 回退…
        </Button>
      )}
      {err && <span className={errTextCls}>{err}</span>}
      {dialogOpen && (
        <ResumeDialog
          runId={runId}
          moduleHint={moduleHint}
          phaseRunning={running}
          onClose={() => setDialogOpen(false)}
          onStarted={() => {
            setDialogOpen(false);
            onResumeStarted?.();
            onAction();
          }}
        />
      )}
      {cpOpen && (
        <CheckpointDialog
          runId={runId}
          onClose={() => setCpOpen(false)}
          onCreated={onAction}
        />
      )}
    </div>
  );
}

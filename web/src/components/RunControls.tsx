import { useCallback, useEffect, useRef, useState } from "react";
import { postControl, TERMINAL_PHASES, type ControlAction } from "../api";
import { btnStyle } from "./dialogStyles";
import { ResumeDialog } from "./ResumeDialog";
import { CheckpointDialog } from "./CheckpointDialog";

interface RunControlsProps {
  runId: string;
  phase: string | null;
  paused: boolean;
  /** 模块选择器当前值（缺省启发式 = runId），恢复对话框的模块名预填 */
  moduleHint: string | null;
  /** 动作成功后的回调（App 据此刷新 run 列表等） */
  onAction: () => void;
  /** 打开恢复对话框的请求（黄条/行内按钮发起；带目标 runId + seq） */
  resumeRequest: { runId: string; seq: number } | null;
  /** 本 server 拉起的恢复子进程在跑（/process 轮询） */
  procRunning: boolean;
  onTerminate: () => void;
}

/** 头部控制条：phase 感知的 运行中控制（取消/暂停/继续）+ 终态恢复/回退入口。 */
export function RunControls({
  runId,
  phase,
  paused,
  moduleHint,
  onAction,
  resumeRequest,
  procRunning,
  onTerminate,
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
    }
  }, [resumeRequest, runId]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
      {paused && (
        <span style={{ color: "#b45309", fontWeight: 600 }}>⏸ 已暂停</span>
      )}
      {running && !paused && (
        <button style={btnStyle} disabled={busy} onClick={() => act("pause")}>
          暂停
        </button>
      )}
      {running && paused && (
        <button style={btnStyle} disabled={busy} onClick={() => act("unpause")}>
          继续
        </button>
      )}
      {running && (
        <button
          style={{ ...btnStyle, color: "#b91c1c" }}
          disabled={busy}
          onClick={() => {
            if (window.confirm("取消该运行？（已落盘，可稍后恢复/回退）")) act("cancel");
          }}
        >
          取消
        </button>
      )}
      <button style={btnStyle} disabled={busy} onClick={() => setCpOpen(true)}>
        存检查点…
      </button>
      {procRunning && (
        <button
          style={{ ...btnStyle, color: "#b91c1c" }}
          disabled={busy}
          onClick={() => {
            if (window.confirm("硬终止恢复子进程？（不写终态，status 停留 running；之后可强制恢复）")) {
              onTerminate();
            }
          }}
        >
          终止进程
        </button>
      )}
      {resumable && (
        <button style={btnStyle} disabled={busy} onClick={() => setDialogOpen(true)}>
          恢复 / 回退…
        </button>
      )}
      {err && <span style={{ color: "#b91c1c" }}>{err}</span>}
      {dialogOpen && (
        <ResumeDialog
          runId={runId}
          moduleHint={moduleHint}
          phaseRunning={running}
          onClose={() => setDialogOpen(false)}
          onStarted={() => {
            setDialogOpen(false);
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

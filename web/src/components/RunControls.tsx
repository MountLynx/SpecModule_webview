import { useCallback, useState } from "react";
import { postControl, type ControlAction } from "../api";
import { btnStyle } from "./dialogStyles";
import { ResumeDialog } from "./ResumeDialog";
import { CheckpointDialog } from "./CheckpointDialog";

const TERMINAL_PHASES = new Set(["done", "aborted", "cancelled"]);

interface RunControlsProps {
  runId: string;
  phase: string | null;
  paused: boolean;
  /** 模块选择器当前值（缺省启发式 = runId），恢复对话框的模块名预填 */
  moduleHint: string | null;
  /** 动作成功后的回调（App 据此刷新 run 列表等） */
  onAction: () => void;
}

/** 头部控制条：phase 感知的 运行中控制（取消/暂停/继续）+ 终态恢复/回退入口。 */
export function RunControls({ runId, phase, paused, moduleHint, onAction }: RunControlsProps) {
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

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  fetchCheckpoints,
  fetchInputs,
  postControl,
  postResume,
  type CheckpointTarget,
  type ControlAction,
} from "../api";

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

const btnStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "3px 10px",
  cursor: "pointer",
};

/** 头部控制条：phase 感知的 运行中控制（取消/暂停/继续）+ 终态恢复/回退入口。 */
export function RunControls({ runId, phase, paused, moduleHint, onAction }: RunControlsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
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
    </div>
  );
}

// ------------------------------------------------------------------
// 恢复/回退对话框
// ------------------------------------------------------------------

interface ResumeDialogProps {
  runId: string;
  moduleHint: string | null;
  /** phase=running 时出示强制恢复选项（max_ticks 截断的残留 running 态） */
  phaseRunning: boolean;
  onClose: () => void;
  onStarted: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 16,
  width: 520,
  maxWidth: "92vw",
  maxHeight: "86vh",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontSize: 13,
};

const fieldLabel: React.CSSProperties = { fontWeight: 600, marginBottom: 2 };

function ResumeDialog({ runId, moduleHint, phaseRunning, onClose, onStarted }: ResumeDialogProps) {
  const [targets, setTargets] = useState<CheckpointTarget[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [module, setModule] = useState(moduleHint ?? runId);
  const [specText, setSpecText] = useState<string>("");
  const [specDirty, setSpecDirty] = useState(false);
  const [tasklistFile, setTasklistFile] = useState<{ name: string; data: unknown } | null>(null);
  const [mock, setMock] = useState(false);
  const [force, setForce] = useState(false);
  const [maxTicks, setMaxTicks] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCheckpoints(runId)
      .then((list) => {
        if (!cancelled) setTargets(list);
      })
      .catch(() => {
        if (!cancelled) setTargets([]);
      });
    fetchInputs(runId)
      .then((inputs) => {
        if (cancelled || specDirty) return;
        if (inputs.spec != null) {
          setSpecText(JSON.stringify(inputs.spec, null, 2));
        } else {
          setSpecText("{}");
        }
      })
      .catch(() => {
        if (!cancelled) setSpecText("{}");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const submit = async () => {
    let spec: Record<string, unknown> | null = null;
    const trimmed = specText.trim();
    if (trimmed) {
      try {
        spec = JSON.parse(trimmed);
      } catch {
        setErr("spec 不是合法 JSON");
        return;
      }
      if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
        setErr("spec 必须是 JSON 对象");
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      await postResume(runId, {
        module: module || null,
        target: target || null,
        spec,
        tasklist: tasklistFile ? (tasklistFile.data as Record<string, unknown>) : null,
        max_ticks: maxTicks,
        mock,
        force: phaseRunning && force,
      });
      onStarted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTasklistPick = async (file: File | null) => {
    if (!file) {
      setTasklistFile(null);
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      setTasklistFile({ name: file.name, data });
      setErr(null);
    } catch {
      setErr("tasklist 文件不是合法 JSON");
      setTasklistFile(null);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          恢复 / 回退：<code>{runId}</code>
        </div>
        <div>
          <div style={fieldLabel}>回退目标（缺省 = 最新快照续跑）</div>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">最新快照（续跑）</option>
            {(targets ?? []).map((c) => (
              <option key={c.target} value={c.target}>
                {c.kind === "manual"
                  ? `${c.target}（${c.label ?? "手动检查点"}）`
                  : `tick ${c.target}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div style={fieldLabel}>模块名（须与先前 run 一致）</div>
          <input
            value={module}
            onChange={(e) => setModule(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </div>
        <div>
          <div style={fieldLabel}>
            spec（JSON，可改后重传；留空 = 用模块缺省 spec）
          </div>
          <textarea
            value={specText}
            onChange={(e) => {
              setSpecText(e.target.value);
              setSpecDirty(true);
            }}
            rows={8}
            spellCheck={false}
            style={{ width: "100%", fontFamily: "monospace", boxSizing: "border-box" }}
          />
        </div>
        <div>
          <div style={fieldLabel}>tasklist（可选，替换流程；与模板通道互斥）</div>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => onTasklistPick(e.target.files?.[0] ?? null)}
          />
          {tasklistFile && <span style={{ marginLeft: 8 }}>{tasklistFile.name} ✓</span>}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <label>
            <input
              type="checkbox"
              checked={mock}
              onChange={(e) => setMock(e.target.checked)}
            />{" "}
            --mock（免 key 冒烟）
          </label>
          <label>
            max ticks{" "}
            <input
              type="number"
              value={maxTicks}
              min={1}
              onChange={(e) => setMaxTicks(Number(e.target.value) || 100)}
              style={{ width: 70 }}
            />
          </label>
          {phaseRunning && (
            <label>
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />{" "}
              强制恢复（运行中残留态）
            </label>
          )}
        </div>
        {err && <div style={{ color: "#b91c1c" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={btnStyle} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button style={btnStyle} onClick={submit} disabled={busy}>
            {busy ? "启动中…" : "启动恢复"}
          </button>
        </div>
      </div>
    </div>
  );
}

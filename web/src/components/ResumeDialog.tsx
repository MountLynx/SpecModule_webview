import { useEffect, useState } from "react";
import {
  ApiError,
  fetchCheckpoints,
  fetchInputs,
  postResume,
  type CheckpointTarget,
} from "../api";
import { btnStyle, dialogStyle, fieldLabel, jsonFieldError, overlayStyle } from "./dialogStyles";

interface ResumeDialogProps {
  runId: string;
  moduleHint: string | null;
  /** phase=running 时出示强制恢复选项（max_ticks 截断的残留 running 态） */
  phaseRunning: boolean;
  onClose: () => void;
  onStarted: () => void;
}

function ResumeDialog({ runId, moduleHint, phaseRunning, onClose, onStarted }: ResumeDialogProps) {
  const [targets, setTargets] = useState<CheckpointTarget[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [module, setModule] = useState(moduleHint ?? runId);
  const [specText, setSpecText] = useState<string>("");
  const [specDirty, setSpecDirty] = useState(false);
  const [tasklistText, setTasklistText] = useState<string>("");
  const [tasklistDirty, setTasklistDirty] = useState(false);
  const [mock, setMock] = useState(false);
  const [force, setForce] = useState(false);
  const [maxTicks, setMaxTicks] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const specErr = jsonFieldError(specText, true);
  const tasklistErr = jsonFieldError(tasklistText, true);

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
        if (cancelled) return;
        if (!specDirty) setSpecText(inputs.spec != null ? JSON.stringify(inputs.spec, null, 2) : "{}");
        // ③ tasklist 预填：对齐 spec——归档有值才填，用户改过（dirty）不覆盖
        if (!tasklistDirty && inputs.tasklist != null) {
          setTasklistText(JSON.stringify(inputs.tasklist, null, 2));
        }
      })
      .catch(() => {
        if (!cancelled && !specDirty) setSpecText("{}");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const submit = async () => {
    let spec: Record<string, unknown> | null = null;
    const trimmedSpec = specText.trim();
    if (trimmedSpec) {
      try {
        spec = JSON.parse(trimmedSpec);
      } catch {
        setErr("spec 不是合法 JSON");
        return;
      }
      if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
        setErr("spec 必须是 JSON 对象");
        return;
      }
    }
    let tasklist: Record<string, unknown> | null = null;
    const trimmedTl = tasklistText.trim();
    if (trimmedTl) {
      try {
        tasklist = JSON.parse(trimmedTl);
      } catch {
        setErr("tasklist 不是合法 JSON");
        return;
      }
      if (tasklist == null || typeof tasklist !== "object" || Array.isArray(tasklist)) {
        setErr("tasklist 必须是 JSON 对象");
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
        tasklist,
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

  const onTasklistFile = async (file: File | null) => {
    if (!file) return;
    try {
      // 文件上传 = 载入到编辑区（编辑起点，而非独立提交通道）
      const data = JSON.parse(await file.text());
      setTasklistText(JSON.stringify(data, null, 2));
      setTasklistDirty(true);
      setErr(null);
    } catch {
      setErr("tasklist 文件不是合法 JSON");
    }
  };

  const badTextarea: React.CSSProperties = { outline: "2px solid #dc2626" };

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
            style={{
              width: "100%",
              fontFamily: "monospace",
              boxSizing: "border-box",
              ...(specErr ? badTextarea : {}),
            }}
          />
          {specErr && <div style={{ color: "#b91c1c", fontSize: 12 }}>spec {specErr}</div>}
        </div>
        <div>
          <div style={fieldLabel}>
            tasklist（JSON，可改后重传；留空 = 用归档/模块缺省流程；与模板通道互斥）
          </div>
          <textarea
            value={tasklistText}
            onChange={(e) => {
              setTasklistText(e.target.value);
              setTasklistDirty(true);
            }}
            rows={8}
            spellCheck={false}
            placeholder="留空使用归档 tasklist；或从文件载入"
            style={{
              width: "100%",
              fontFamily: "monospace",
              boxSizing: "border-box",
              ...(tasklistErr ? badTextarea : {}),
            }}
          />
          {tasklistErr && <div style={{ color: "#b91c1c", fontSize: 12 }}>tasklist {tasklistErr}</div>}
          <div style={{ marginTop: 4 }}>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => onTasklistFile(e.target.files?.[0] ?? null)}
            />
          </div>
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

export { ResumeDialog };
export type { ResumeDialogProps };

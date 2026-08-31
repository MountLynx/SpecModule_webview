import { useState } from "react";
import { ApiError, postCheckpoint } from "../api";
import { btnStyle, dialogStyle, fieldLabel, overlayStyle } from "./dialogStyles";

interface CheckpointDialogProps {
  runId: string;
  onClose: () => void;
  /** 创建成功（App 据此刷新 run 列表） */
  onCreated: () => void;
}

function CheckpointDialog({ runId, onClose, onCreated }: CheckpointDialogProps) {
  const [label, setLabel] = useState("");
  const [tickText, setTickText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string; tick: number; overwritten: boolean } | null>(null);

  const submit = async () => {
    if (!label.trim()) {
      setErr("label 必填");
      return;
    }
    const tick = tickText.trim() ? Number(tickText.trim()) : null;
    if (tick != null && (!Number.isInteger(tick) || tick < 0)) {
      setErr("tick 必须是非负整数");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await postCheckpoint(runId, { label: label.trim(), tick });
      setDone(r);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...dialogStyle, width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          存手动检查点：<code>{runId}</code>
        </div>
        {done ? (
          <>
            <div>
              已保存 <code>{done.label}</code>（tick {done.tick}）
              {done.overwritten && "（覆盖同名旧检查点）"}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={btnStyle} onClick={onClose}>关闭</button>
            </div>
          </>
        ) : (
          <>
            <div>
              <div style={fieldLabel}>label（回退目标形如 manual:&lt;label&gt;）</div>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如 before-policy-change"
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <div style={fieldLabel}>tick（缺省 = 最新快照）</div>
              <input
                value={tickText}
                onChange={(e) => setTickText(e.target.value)}
                placeholder="留空 = 最新"
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
            {err && <div style={{ color: "#b91c1c" }}>{err}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={btnStyle} onClick={onClose} disabled={busy}>取消</button>
              <button style={btnStyle} onClick={submit} disabled={busy}>
                {busy ? "保存中…" : "保存检查点"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { CheckpointDialog };

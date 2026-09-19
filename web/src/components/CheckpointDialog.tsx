import { useState } from "react";
import { ApiError, postCheckpoint } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { labelCls, overlayCls, panelCls, panelNarrowCls } from "./dialogTheme";

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
    <div className={overlayCls} onClick={onClose}>
      <div className={cn(panelCls, panelNarrowCls)} onClick={(e) => e.stopPropagation()}>
        <div className="text-[13px] font-bold">
          存手动检查点：<code>{runId}</code>
        </div>
        {done ? (
          <>
            <div>
              已保存 <code>{done.label}</code>（tick {done.tick}）
              {done.overwritten && "（覆盖同名旧检查点）"}
            </div>
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <div className={labelCls}>label（回退目标形如 manual:&lt;label&gt;）</div>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如 before-policy-change"
                className="w-full"
              />
            </div>
            <div>
              <div className={labelCls}>tick（缺省 = 最新快照）</div>
              <input
                value={tickText}
                onChange={(e) => setTickText(e.target.value)}
                placeholder="留空 = 最新"
                className="w-full"
              />
            </div>
            {err && <div className="text-[12px] text-destructive">{err}</div>}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>取消</Button>
              <Button size="sm" onClick={submit} disabled={busy}>
                {busy ? "保存中…" : "保存检查点"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { CheckpointDialog };

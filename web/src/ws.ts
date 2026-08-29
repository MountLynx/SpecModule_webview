// WS 客户端：首连即收当前状态；断线 1s 退避重连；终态后停止重连。
import { useEffect, useRef, useState } from "react";
import type { StatusMsg } from "./api";

const TERMINAL = new Set(["done", "aborted", "cancelled"]);

type WsMsg = StatusMsg | { type: "error"; error: string };

export function useRunStream(runId: string | null): StatusMsg | null {
  const [msg, setMsg] = useState<StatusMsg | null>(null);
  const terminalRef = useRef(false);

  useEffect(() => {
    if (!runId) {
      setMsg(null);
      return;
    }
    terminalRef.current = false;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      if (closed || terminalRef.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(
        `${proto}://${location.host}/api/runs/${encodeURIComponent(runId)}/stream`,
      );
      ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data) as WsMsg;
        if (data.type === "status") {
          setMsg(data);
          if (TERMINAL.has(data.phase)) terminalRef.current = true;
        }
      };
      ws.onclose = () => {
        if (!closed && !terminalRef.current) timer = window.setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [runId]);

  return msg;
}

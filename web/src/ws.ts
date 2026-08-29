// WS 客户端：首连即收当前状态；断线 1s 退避重连；终态后停止重连。
import { useEffect, useRef, useState } from "react";
import type { StatusMsg } from "./api";

const TERMINAL = new Set(["done", "aborted", "cancelled"]);

type WsMsg = StatusMsg | { type: "error"; error: string };

/** 流状态按 runId 打包：StatusMsg 本身无 run_id 字段，消费端据此丢弃切 run 瞬间的陈旧消息。 */
export interface StreamState {
  runId: string;
  msg: StatusMsg;
}

export function useRunStream(runId: string | null): StreamState | null {
  const [state, setState] = useState<StreamState | null>(null);
  const terminalRef = useRef(false);

  useEffect(() => {
    // 切换 run 先清旧消息，避免 header 短暂显示上一个 run 的 phase
    setState(null);
    if (!runId) return;
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
        if (data.type === "error") {
          // 服务端错误关闭（如 run 不存在）→ 停止重连，避免错误-关闭-重连循环
          terminalRef.current = true;
          return;
        }
        if (data.type === "status") {
          setState({ runId, msg: data });
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

  return state;
}

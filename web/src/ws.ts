// WS 客户端：首连即收当前状态；stream 记录按节点累积缓冲（run_start 清缓冲）；
// 断线 1s 退避重连；终态后停止重连。
import { useEffect, useRef, useState } from "react";
import { TERMINAL_PHASES, type StatusMsg, type StreamMsg } from "./api";

type WsMsg = StatusMsg | StreamMsg | { type: "error"; error: string };

/** 流缓冲：按节点累积的流式文本 + 版本号（每批消息自增，驱动订阅方 effect）。 */
export interface StreamBuffer {
  text: Record<string, string>;
  seq: number;
}

/** 流状态按 runId 打包：StatusMsg 本身无 run_id 字段，消费端据此丢弃切 run 瞬间的陈旧消息。 */
export interface StreamState {
  runId: string;
  msg: StatusMsg;
  stream: StreamBuffer;
}

export function useRunStream(
  runId: string | null,
  onTerminal?: () => void,
): StreamState | null {
  const [state, setState] = useState<StreamState | null>(null);
  const terminalRef = useRef(false);
  // 回调经 ref 透传：effect 只依赖 runId，回调换 identity 不触发 WS 重连
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

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
          if (!terminalRef.current) onTerminalRef.current?.();
          terminalRef.current = true;
          return;
        }
        if (data.type === "stream") {
          setState((prev) => {
            if (!prev || prev.runId !== runId) return prev;
            const text = { ...prev.stream.text };
            let seq = prev.stream.seq;
            for (const r of data.records) {
              if (r.type === "run_start") {
                // 新执行边界：清空缓冲（resume 重跑的流从零开始显示）
                for (const k of Object.keys(text)) delete text[k];
                seq += 1;
              } else if (r.type === "token" && r.node) {
                text[r.node] = (text[r.node] ?? "") + (r.chunk ?? "");
                seq += 1;
              }
            }
            return { ...prev, stream: { text, seq } };
          });
          return;
        }
        if (data.type === "status") {
          // 保留流缓冲（status 与 stream 交替到达，互相不重置）
          setState((prev) => ({
            runId,
            msg: data,
            stream: prev?.runId === runId ? prev.stream : { text: {}, seq: 0 },
          }));
          if (TERMINAL_PHASES.has(data.phase) && !terminalRef.current) {
            terminalRef.current = true;
            onTerminalRef.current?.();
          }
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

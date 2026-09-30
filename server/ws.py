# server/ws.py
"""tick 流实时推送：status.json/run.sqlite 签名推送 + stream.log 追尾（不改库）。"""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from module_harness.infra import control, query
from module_harness.infra.query import read_stream
from module_harness.infra.status import query_run_status
from module_harness.infra.stream import stream_log_path
from server.deps import get_base_dir, is_valid_run_id

router = APIRouter()

_TERMINAL = ("done", "aborted", "cancelled", "truncated")
_POLL_SECONDS = 0.2


def _stream_mtime(base_dir, run_id: str) -> float | None:
    try:
        return os.path.getmtime(stream_log_path(run_id, base_dir))
    except OSError:
        return None


@router.websocket("/api/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str) -> None:
    """变化才推：status 按 sig=(phase, tick, updated_at, paused)，推送携带按节点
    累计 node_states（node_run_summary——客户端纯覆盖、免逐 tick 记账）；stream.log
    追尾锚定最后一条 run_start（含，前端以此为清缓冲信号），新记录批量推。
    推送顺序 stream 先于 status；终态（含 truncated）补发最后一批流后
    close(1000)。查询为同步短读（SQLite WAL 跨进程读 + 文件增量读，毫秒级），
    0.2s 拍直接在事件循环内调用（思考流式肉眼连续；status 按 sig 变化才推不变）。receive 竞速轮询间隔：本协议无客户端→服务端
    消息，receive 任务仅为在两次轮询之间察觉客户端断连。
    """
    await websocket.accept()
    if not is_valid_run_id(run_id):
        try:
            await websocket.send_json({"type": "error", "error": f"非法 run_id: {run_id!r}"})
            await websocket.close(code=4400)
        except Exception:
            return
        return
    base_dir = get_base_dir()
    last_sig: tuple | None = None
    stream_offset: int | None = None   # None = 未锚定（锚定后为下一读起点）
    recv_task = asyncio.create_task(websocket.receive())
    try:
        while True:
            st = query_run_status(run_id, base_dir=base_dir)
            if st is None:
                if last_sig is None:
                    try:
                        await websocket.send_json(
                            {"type": "error", "error": "无运行记录", "run_id": run_id}
                        )
                        await websocket.close(code=4404)
                    except Exception:
                        return
                    return
            else:
                # paused 走 control.json（status.json 无此状态）；签名比对含
                # paused——挂起/释放即使 phase/tick 不变也要推，前端换按钮
                req = control.read_control(run_id, base_dir=base_dir)
                paused = bool(req and req.get("action") == "pause")
                # 流追尾：running 起锚定（库侧 run_start 先于 running phase
                # 写入，见到 running 必已存在）；已锚定后每拍增量读
                if st.phase == "running" and stream_offset is None:
                    anchored = read_stream(run_id, offset=0, base_dir=base_dir)
                    if anchored is not None:
                        stream_offset = next(
                            (r["off"] for r in reversed(anchored["records"])
                             if r.get("type") == "run_start"),
                            0,
                        )
                if stream_offset is not None:
                    chunk = read_stream(run_id, offset=stream_offset, base_dir=base_dir)
                    if chunk is not None:
                        stream_offset = chunk["next_offset"]
                        if chunk["records"]:
                            try:
                                await websocket.send_json({
                                    "type": "stream",
                                    "records": [
                                        {k: v for k, v in r.items() if k != "off"}
                                        for r in chunk["records"]
                                    ],
                                })
                            except Exception:
                                return
                sig = (st.phase, st.tick, st.updated_at, paused)
                if sig != last_sig:
                    last_sig = sig
                    # 按节点累计摘要随推送下发：客户端纯覆盖，无需逐 tick 增量
                    # 记账（轮询跳拍/断线重连不丢完成态）；仅推送时计算（firings
                    # 全量读，WAL 毫秒级，tick 节奏下无压力）
                    node_states = query.node_run_summary(run_id, base_dir=base_dir) or {}
                    try:
                        await websocket.send_json({
                            "type": "status",
                            "phase": st.phase,
                            "status": st.status,
                            "tick": st.tick,
                            "fireable": st.fireable,
                            "fired": st.fired,
                            "outputs": st.outputs,
                            "node_states": node_states,
                            "error": st.error,
                            "updated_at": st.updated_at,
                            "paused": paused,
                            "stream_mtime": _stream_mtime(base_dir, run_id),
                        })
                    except Exception:
                        return
                    if st.phase in _TERMINAL:
                        try:
                            await websocket.close(code=1000)
                        except Exception:
                            return
                        return
            done, _ = await asyncio.wait({recv_task}, timeout=_POLL_SECONDS)
            if done:
                recv_task.exception()  # 取回异常（若有），避免 never-retrieved 告警
                return
    except WebSocketDisconnect:
        return
    finally:
        if not recv_task.done():
            recv_task.cancel()

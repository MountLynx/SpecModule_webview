# server/ws.py
"""tick 流实时推送：后端轮询 status.json/run.sqlite（feed 同源，不改库）。"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from module_harness import control
from module_harness.status import query_run_status
from server.deps import get_base_dir, is_valid_run_id

router = APIRouter()

_TERMINAL = ("done", "aborted", "cancelled")
_POLL_SECONDS = 1.0


@router.websocket("/api/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str) -> None:
    """变化才推：sig=(phase, tick, updated_at) 比对；终态推完 close(1000)。

    查询为同步短读（SQLite WAL 跨进程读，毫秒级），v1 直接在事件循环内调用。
    receive 竞速轮询间隔：本协议无客户端→服务端消息，receive 任务仅为在两次
    轮询之间察觉客户端断连（uvicorn 下断连只从 receive 侧暴露，否则泄漏轮询任务）。
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
                sig = (st.phase, st.tick, st.updated_at, paused)
                if sig != last_sig:
                    last_sig = sig
                    try:
                        await websocket.send_json({
                            "type": "status",
                            "phase": st.phase,
                            "status": st.status,
                            "tick": st.tick,
                            "fireable": st.fireable,
                            "fired": st.fired,
                            "outputs": st.outputs,
                            "error": st.error,
                            "updated_at": st.updated_at,
                            "paused": paused,
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

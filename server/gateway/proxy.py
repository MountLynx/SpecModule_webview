"""反代层：HTTP 流式透传（SSE 兼容）+ WS 双向桥。

超时纪律（spec §并发收口 #5）：connect 短、读不限（SSE/长连接）；网关 Cookie 不透传
（后端无会话语义）。WS 桥 = websockets 双向泵 + 关闭传播；后端关闭/客户端断开
任一侧结束即收束整体。
"""
from __future__ import annotations

import asyncio

import httpx
import websockets.asyncio.client
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

_HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "upgrade",
               "proxy-authenticate", "proxy-authorization", "te", "trailer"}


def _forward_headers(headers) -> dict:
    return {k: v for k, v in headers.items()
            if k.lower() not in _HOP_BY_HOP and k.lower() not in ("cookie", "host")}


def _response_headers(headers) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


class BackendProxy:
    """对单个用户后端（127.0.0.1:port）的代理；client 可注入（测试 MockTransport）。"""

    def __init__(self, port: int, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}",
            timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=30.0),
        )

    async def forward(self, request, port: int = 0) -> Response:
        """方法/路径/查询/头/体全转发；流式回传上游（SSE 逐帧不缓冲）。"""
        url = request.url.path
        if request.url.query:
            url = f"{url}?{request.url.query}"
        upstream_req = self._client.build_request(
            request.method, url,
            headers=_forward_headers(request.headers),
            content=request.stream(),
        )
        try:
            resp = await self._client.send(upstream_req, stream=True)
        except httpx.HTTPError:
            return JSONResponse({"error": "后端进程不可达"}, status_code=502)
        return StreamingResponse(
            resp.aiter_raw(),
            status_code=resp.status_code,
            headers=_response_headers(resp.headers),
            background=BackgroundTask(resp.aclose),
        )

    async def bridge_ws(self, websocket: WebSocket, port: int) -> None:
        """WS 双向泵：客户端 ↔ 后端；任一侧断开即收束。"""
        await websocket.accept()
        url = f"ws://127.0.0.1:{port}{websocket.url.path}"

        async def _pump_client_to_backend(upstream) -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        return
                    data = msg.get("bytes") or msg.get("text")
                    if data is None:
                        continue
                    await upstream.send(data)
            except WebSocketDisconnect:
                return

        async def _pump_backend_to_client(upstream) -> None:
            try:
                async for msg in upstream:
                    if isinstance(msg, bytes):
                        await websocket.send_bytes(msg)
                    else:
                        await websocket.send_text(msg)
            except websockets.ConnectionClosed:
                return

        try:
            async with websockets.asyncio.client.connect(url) as upstream:
                await asyncio.gather(_pump_client_to_backend(upstream),
                                     _pump_backend_to_client(upstream))
        except (websockets.InvalidURI, websockets.InvalidHandshake, OSError):
            pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

"""反代层：请求转发形状 / 502 兜底 / 流式透传 / WS 双向桥与关闭传播。"""

from __future__ import annotations

import httpx
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocket
from websockets.sync.server import serve

from server.gateway.proxy import BackendProxy


def _proxy(backend_app) -> BackendProxy:
    """ASGITransport：真流式语义的进程内后端（MockTransport 在 httpx 0.28 返回已缓冲
    响应，与 stream=True + aiter_raw 的生产路径不兼容）。"""
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=backend_app),
                               base_url="http://backend")
    return BackendProxy(0, client=client)


def _starlette_app(proxy, path="/api/x"):
    async def endpoint(request):
        return await proxy.forward(request, 0)

    return Starlette(routes=[Route(path, endpoint, methods=["GET", "POST"])])


class TestForward:
    def test_forwards_method_header_body_drops_cookie(self):
        captured = {}

        async def ep(request):
            captured["method"] = request.method
            captured["cookie"] = request.headers.get("cookie")
            captured["xcustom"] = request.headers.get("xcustom")
            captured["body"] = await request.body()
            return JSONResponse({"ran": True}, headers={"x-up": "1"})

        backend = Starlette(routes=[Route("/api/x", ep, methods=["GET", "POST"])])
        client = TestClient(_starlette_app(_proxy(backend)))
        r = client.request("POST", "/api/x", content=b'{"a":1}',
                           headers={"Cookie": "wv_session=secret", "xcustom": "1"})
        assert r.status_code == 200
        assert r.json() == {"ran": True}
        assert captured["method"] == "POST"
        assert captured["body"] == b'{"a":1}'
        assert captured["cookie"] is None  # 网关 Cookie 不透传
        assert captured["xcustom"] == "1"
        assert r.headers["x-up"] == "1"  # 上游响应头透传

    def test_backend_down_maps_502(self):
        def handler(request):
            raise httpx.ConnectError("down")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                   base_url="http://backend")
        client = TestClient(_starlette_app(BackendProxy(0, client=client)))
        r = client.get("/api/x")
        assert r.status_code == 502
        assert "error" in r.json()


class TestWsBridge:
    def _echo_thread(self):
        """websockets sync echo server（独立线程，临时端口）。"""
        import threading

        holder: dict = {}
        started = threading.Event()

        def _run():
            def handler(ws):
                for msg in ws:
                    ws.send(msg)

            server = serve(handler, "127.0.0.1", 0)
            holder["port"] = server.socket.getsockname()[1]
            started.set()
            server.serve_forever()

        threading.Thread(target=_run, daemon=True).start()
        assert started.wait(5)
        return holder["port"]

    def test_bidirectional_and_close(self):
        port = self._echo_thread()
        proxy = BackendProxy(port)

        async def ws_endpoint(websocket: WebSocket):
            await proxy.bridge_ws(websocket, port)

        app = Starlette(routes=[WebSocketRoute("/api/runs/r1/stream", ws_endpoint)])
        client = TestClient(app)
        with client.websocket_connect("/api/runs/r1/stream") as ws:
            ws.send_text("hello")
            assert ws.receive_text() == "hello"
        # 上下文退出 = 客户端侧关闭；无死锁即关闭传播成立

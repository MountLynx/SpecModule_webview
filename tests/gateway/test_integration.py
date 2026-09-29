"""端到端：真后端子进程（uvicorn spawn + /healthz 就绪）+ 认领 + 反代回环 + WS 错误帧。

唯一允许 spawn 子进程的网关测试面（port_base 9521 避让本机端口）；
env 全部落 tmp 部署根，不碰真实 ~/.specmodule。
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from server.gateway.app import build_gateway_app


@pytest.fixture
def live(gw_root):
    app = build_gateway_app(gw_root, static_dir=None, port_base=9521)
    # with 语法：整个测试共享一个 portal/事件循环——反代 AsyncClient 绑定循环
    # 与请求生命周期一致（生产网关单循环，天然一致；Windows 多循环会炸）
    with TestClient(app) as client:
        yield client
    app.state.gateway.manager.shutdown_all()


def test_claim_proxy_roundtrip(live):
    r = live.post("/claim", json={"name": "tester"})
    assert r.status_code == 200
    # 认领后 Cookie 已在 client 上——ensure_running 真拉起 uvicorn 子进程
    r = live.get("/api/runs")
    assert r.status_code == 200
    assert r.json() == {"runs": [], "total": 0}  # 后端读的是 tmp 用户根（隔离生效）
    r = live.get("/api/modules")
    assert r.status_code == 200


def test_ws_streams_backend_error_frame(live):
    live.post("/claim", json={"name": "tester"})
    # 后端 WS 语义：未知 run → {"type":"error"} + close(4404)，经桥原样中继
    with live.websocket_connect("/api/runs/nope/stream") as ws:
        frame = ws.receive_json()
        assert frame["type"] == "error"

# tests/test_ws.py
"""WS /api/runs/{id}/stream：首推、变化推送、终态关闭、未知 run 拒连。"""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.conftest import seed_run


class TestStream:
    def test_initial_push_on_connect(self, base, client):
        seed_run(base, "ws_run", status={"module_id": "ws_run", "phase": "running", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_run/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            assert msg["phase"] == "running"
            assert msg["outputs"] == {}

    def test_terminal_close(self, base, client):
        seed_run(base, "ws_done", status={"module_id": "ws_done", "phase": "done", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_done/stream") as ws:
            msg = ws.receive_json()
            assert msg["phase"] == "done"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()   # 服务端 close(1000)
            assert exc_info.value.code == 1000

    def test_unknown_run_error_close(self, base, client):
        with client.websocket_connect("/api/runs/ghost/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            assert msg["error"] == "无运行记录"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == 4404

    def test_invalid_run_id(self, base, client):
        with client.websocket_connect("/api/runs/bad..id/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == 4400

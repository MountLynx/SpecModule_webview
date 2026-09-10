# tests/test_ws.py
"""WS /api/runs/{id}/stream：首推、变化推送、终态关闭、未知 run 拒连。"""

from __future__ import annotations

import json

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

    def test_paused_flag_from_control(self, base, client):
        """暂停中（control.json pause 挂起）→ 首推带 paused=True。"""
        from module_harness.infra.control import request_control

        seed_run(base, "ws_paused", status={"module_id": "ws_paused", "phase": "running", "updated_at": 1.0})
        request_control("ws_paused", "pause", base_dir=base)
        with client.websocket_connect("/api/runs/ws_paused/stream") as ws:
            msg = ws.receive_json()
            assert msg["phase"] == "running"
            assert msg["paused"] is True

    def _write_stream_log(self, base, run_id, lines):
        p = base / ".specmodule" / "runs" / run_id / "stream.log"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(lines), encoding="utf-8")
        return p

    def test_stream_anchor_relay_and_truncated(self, base, client):
        """锚定最后一条 run_start（前一执行残留不推）；增量补推；truncated 终态 close(1000)。"""
        run_id = "ws_stream"
        seed_run(base, run_id, status={"module_id": run_id, "phase": "running", "updated_at": 1.0})
        log = self._write_stream_log(base, run_id, [
            json.dumps({"type": "token", "node": "OLD", "chunk": "残留"}) + "\n",
            json.dumps({"type": "run_start", "ts": 1.0, "pid": 1, "max_ticks": 100}) + "\n",
            json.dumps({"type": "token", "node": "A", "chunk": "你好"}) + "\n",
            '{"type": "token", "node": "A", "chu',   # 半行：本轮不推
        ])
        with client.websocket_connect(f"/api/runs/{run_id}/stream") as ws:
            stream_msg = ws.receive_json()
            assert stream_msg["type"] == "stream"
            assert [r["type"] for r in stream_msg["records"]] == ["run_start", "token"]
            assert all("off" not in r for r in stream_msg["records"])
            status_msg = ws.receive_json()
            assert status_msg["type"] == "status"
            assert status_msg["phase"] == "running"
            assert isinstance(status_msg["stream_mtime"], float)
            # 半行补齐 → 下一拍增量推出（追加串须把 "chu" 补成 "chunk"，
            # 否则该行非合法 JSON 会被 read_stream 当坏行跳过）
            with log.open("a", encoding="utf-8") as fh:
                fh.write('nk": "你好"}\n')
            more = ws.receive_json()
            assert more["type"] == "stream"
            assert more["records"][0]["chunk"] == "你好"
            # 截断终态 → 推完 close(1000)
            (base / ".specmodule" / "runs" / run_id / "status.json").write_text(
                json.dumps({
                    "module_id": run_id, "phase": "truncated",
                    "error": "max_ticks=1 截断（可 resume 续跑）", "updated_at": 2.0,
                }, ensure_ascii=False),
                encoding="utf-8",
            )
            final = ws.receive_json()
            assert final["type"] == "status"
            assert final["phase"] == "truncated"
            with pytest.raises(WebSocketDisconnect) as ei:
                ws.receive_json()
            assert ei.value.code == 1000

    def test_stream_mtime_null_without_log(self, base, client):
        seed_run(base, "ws_nomt", status={"module_id": "ws_nomt", "phase": "done", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_nomt/stream") as ws:
            msg = ws.receive_json()
            assert msg["stream_mtime"] is None

    def test_no_stream_without_running(self, base, client):
        """非 running 阶段连接（done 终态）：不锚定流、只推 status 后关闭。"""
        seed_run(base, "ws_nostream", status={"module_id": "ws_nostream", "phase": "done", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_nostream/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()

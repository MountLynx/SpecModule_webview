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

    def test_status_push_carries_cumulative_node_states(self, base, client):
        """status 推送携带按节点累计 node_states——客户端纯覆盖、免逐 tick 记账。

        回归：图上 done 绿标不实时出现。旧协议按相邻推送的 tick 差值 + fired
        名单本地累加，轮询跳拍（两次推送间跨多个 tick）即永久漏计；累计结构
        对跳拍/断线重连免疫。快照 fired 只带最后一拍（tickflow：快照 tick N
        携带 tick N-1 的 firing），恰是旧协议会丢的部分。
        """
        run_id = "ws_nodes"
        seed_run(
            base, run_id,
            firings=[
                {"tick": 1, "node": "A"},
                {"tick": 2, "node": "B"},
                {"tick": 3, "node": "C"},
            ],
            snapshots={4: {"tick": 4, "status": "running", "fired": ["C"], "fireable": ["C"]}},
            status={"module_id": run_id, "phase": "running", "updated_at": 1.0},
        )
        with client.websocket_connect(f"/api/runs/{run_id}/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            assert msg["tick"] == 4
            assert msg["fired"] == ["C"]   # 逐 tick 名单保留（兼容字段）
            assert msg["node_states"] == {
                "A": {"fired_count": 1, "last_status": "ok", "last_tick": 1},
                "B": {"fired_count": 1, "last_status": "ok", "last_tick": 2},
                "C": {"fired_count": 1, "last_status": "ok", "last_tick": 3},
            }

    def test_node_states_absent_without_db(self, base, client):
        """无 run.sqlite（status-only fixture）→ node_states 为空 dict（不缺席键）。"""
        seed_run(base, "ws_nodb", status={"module_id": "ws_nodb", "phase": "running", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_nodb/stream") as ws:
            msg = ws.receive_json()
            assert msg["node_states"] == {}

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

    def test_stream_records_include_thinking(self, base, client):
        """thinking 记录随 stream 消息透传（剥 off；node/chunk 字段原样）。"""
        run_id = "ws_think"
        seed_run(base, run_id, status={"module_id": run_id, "phase": "running", "updated_at": 1.0})
        self._write_stream_log(base, run_id, [
            json.dumps({"type": "run_start", "ts": 1.0, "pid": 1, "max_ticks": 100}) + "\n",
            json.dumps({"type": "thinking", "node": "A", "chunk": "推演"}) + "\n",
            json.dumps({"type": "token", "node": "A", "chunk": "答"}) + "\n",
        ])
        with client.websocket_connect(f"/api/runs/{run_id}/stream") as ws:
            stream_msg = ws.receive_json()
            assert stream_msg["type"] == "stream"
            assert [r["type"] for r in stream_msg["records"]] == ["run_start", "thinking", "token"]
            th = stream_msg["records"][1]
            assert th["node"] == "A" and th["chunk"] == "推演"
            assert all("off" not in r for r in stream_msg["records"])

    def test_status_push_carries_artifacts(self, base, client):
        proj = base / "projects" / "demo"
        proj.mkdir(parents=True)
        (proj / "a.svg").write_text("<svg/>", encoding="utf-8")
        seed_run(
            base, "ws_art",
            firings=[{"tick": 1, "node": "A",
                      "output": {"file": "projects/demo/a.svg"}}],
            status={"module_id": "ws_art", "phase": "running", "updated_at": 1.0},
        )
        with client.websocket_connect("/api/runs/ws_art/stream") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "status"
            assert list(msg["artifacts"]) == ["A"]
            assert msg["artifacts"]["A"][0]["name"] == "a.svg"

    def test_artifacts_key_always_present(self, base, client):
        seed_run(base, "ws_art2",
                 status={"module_id": "ws_art2", "phase": "running", "updated_at": 1.0})
        with client.websocket_connect("/api/runs/ws_art2/stream") as ws:
            msg = ws.receive_json()
            assert msg["artifacts"] == {}

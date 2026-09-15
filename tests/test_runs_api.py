# tests/test_runs_api.py
"""GET /api/runs 与运行读端点：形状 + 错误契约（None → 404）。"""

from __future__ import annotations

import json
import os
import time

from tests.conftest import seed_run


class TestRunsList:
    def test_empty(self, client):
        r = client.get("/api/runs")
        assert r.status_code == 200
        assert r.json() == {"runs": [], "total": 0}

    def test_payload_shape_and_order(self, base, client):
        """新载荷：query.recent_runs 形状（mtime 前 N 条）+ paused 叠加 + total 计数。"""
        seed_run(base, "r_old", status={"module_id": "r_old", "phase": "done", "updated_at": 9.0})
        seed_run(
            base, "r_new",
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"]}},
            status={"module_id": "r_new", "module": "mini_graph", "tick": 1,
                    "phase": "running", "updated_at": 2.0},
        )
        # 仅 status.json 的失败 run（无 run.sqlite）——has_sqlite False
        bare = base / ".specmodule" / "runs" / "r_bare"
        bare.mkdir(parents=True)
        (bare / "status.json").write_text(
            json.dumps({"module_id": "r_bare", "phase": "aborted",
                        "error": "boom", "updated_at": 3.0}),
            encoding="utf-8",
        )
        # mtime 锚定确定性顺序：r_bare > r_new > r_old（列表按 mtime 降序）
        now = time.time()
        for run_id, age in (("r_old", 600), ("r_new", 60), ("r_bare", 5)):
            p = base / ".specmodule" / "runs" / run_id / "status.json"
            os.utime(p, (now - age, now - age))
        r = client.get("/api/runs")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 3
        runs = body["runs"]
        assert [x["run_id"] for x in runs] == ["r_bare", "r_new", "r_old"]
        row = next(x for x in runs if x["run_id"] == "r_new")
        assert set(row) == {
            "run_id", "module", "phase", "tick", "error",
            "updated_at", "has_sqlite", "paused",
        }
        # status.json 溯源字段 → module；sqlite 已落盘 → has_sqlite
        assert row["module"] == "mini_graph"
        assert row["has_sqlite"] is True
        assert row["tick"] == 1
        assert row["paused"] is False
        # 旧 run 无 module 字段 → None（前端回落 run_id 启发式）
        old = next(x for x in runs if x["run_id"] == "r_old")
        assert old["module"] is None
        # 无 sqlite 的失败 run：error 摘要透传 + has_sqlite False
        bare_row = next(x for x in runs if x["run_id"] == "r_bare")
        assert bare_row["has_sqlite"] is False
        assert bare_row["error"] == "boom"
        assert bare_row["tick"] is None

    def test_unknown_phase_run_included(self, base, client):
        """status.json 缺失/损坏的 run 以 phase=unknown 收入不跳过（删除入口对坏目录可用）。"""
        (base / ".specmodule" / "runs" / "junk").mkdir(parents=True)
        r = client.get("/api/runs")
        runs = r.json()["runs"]
        assert [x["run_id"] for x in runs] == ["junk"]
        assert runs[0]["phase"] == "unknown"
        assert runs[0]["module"] is None
        assert runs[0]["updated_at"] == 0.0


class TestRunStatus:
    def test_ok(self, base, client):
        seed_run(
            base, "mod_a",
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_a", "phase": "done", "updated_at": 3.0},
        )
        r = client.get("/api/runs/mod_a/status")
        assert r.status_code == 200
        d = r.json()
        assert d["module_id"] == "mod_a"
        assert d["phase"] == "done"
        assert d["tick"] == 1
        assert d["fired"] == ["A"]
        assert d["outputs"] == {"A": "a1"}

    def test_phase_only_run(self, base, client):
        seed_run(base, "mod_b", status={"module_id": "mod_b", "phase": "aborted",
                                        "error": "boom", "updated_at": 1.0})
        r = client.get("/api/runs/mod_b/status")
        assert r.status_code == 200
        assert r.json()["phase"] == "aborted"
        assert r.json()["error"] == "boom"

    def test_missing_404(self, client):
        r = client.get("/api/runs/ghost/status")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"
        assert r.json()["run_id"] == "ghost"

    def test_bad_run_id_400(self, client):
        # 非法字符（空格走编码原样到达）与含 .. 的 run_id → deps 校验严格 400；
        # 路径穿越（../）在 URL/路由层即被拒绝（404）——两者都不得读到运行数据
        assert client.get("/api/runs/bad%20id/status").status_code == 400
        assert client.get("/api/runs/a..b/status").status_code == 400
        assert client.get("/api/runs/../etc/status").status_code == 404


class TestTimeline:
    def _seed(self, base):
        seed_run(
            base, "mod_t",
            firings=[
                {"tick": 1, "node": "A", "output": "a1"},
                {"tick": 1, "node": "B", "output": "b1", "status": "failed", "error": "boom"},
                {"tick": 2, "node": "A", "output": "a2"},
            ],
            status={"module_id": "mod_t", "phase": "done", "updated_at": 1.0},
        )

    def test_all(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/mod_t/timeline")
        assert r.status_code == 200
        d = r.json()
        assert d["latest_tick"] == 2
        assert len(d["entries"]) == 3

    def test_filter_node(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/mod_t/timeline", params={"node": "A"})
        assert [e["tick"] for e in r.json()["entries"]] == [1, 2]

    def test_filter_failed(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/mod_t/timeline", params={"failed": "true"})
        assert [e["node"] for e in r.json()["entries"]] == ["B"]

    def test_missing_404(self, client):
        assert client.get("/api/runs/ghost/timeline").status_code == 404


class TestCheckpoints:
    def test_list_and_create(self, base, client):
        seed_run(
            base, "mod_c",
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_c", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_c/checkpoints")
        assert r.status_code == 200
        assert r.json()["checkpoints"][0]["target"] == "1"

        r = client.post("/api/runs/mod_c/checkpoints", json={"label": "milestone"})
        assert r.status_code == 200
        assert r.json() == {"label": "manual:milestone", "tick": 1, "overwritten": False}

    def test_create_missing_400(self, base, client):
        seed_run(base, "mod_d", status={"module_id": "mod_d", "phase": "done", "updated_at": 1.0})
        r = client.post("/api/runs/mod_d/checkpoints", json={"label": "x"})
        assert r.status_code == 400
        assert "快照" in r.json()["error"] or "运行" in r.json()["error"]

    def test_missing_404(self, client):
        assert client.get("/api/runs/ghost/checkpoints").status_code == 404


class TestSnapshot:
    def test_latest(self, base, client):
        seed_run(
            base, "mod_s",
            firings=[{"tick": 1, "node": "A", "output": "a1"},
                     {"tick": 2, "node": "A", "output": "a2"}],
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["A"], "fired": []},
                       2: {"tick": 2, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_s", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_s/snapshot")
        assert r.status_code == 200
        assert r.json()["tick"] == 2
        assert r.json()["outputs"] == {"A": "a2"}

    def test_bad_tick_400(self, base, client):
        seed_run(
            base, "mod_s2",
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": []}},
            status={"module_id": "mod_s2", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_s2/snapshot", params={"tick": 9})
        assert r.status_code == 400

    def test_missing_404(self, client):
        assert client.get("/api/runs/ghost/snapshot").status_code == 404


class TestFeed:
    def test_compat_shape(self, base, client):
        seed_run(
            base, "mod_f",
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            snapshots={1: {"tick": 1, "status": "idle", "fireable": [], "fired": ["A"]}},
            status={"module_id": "mod_f", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/mod_f/feed")
        assert r.status_code == 200
        d = r.json()
        # feed.py 兼容：字段名 status/timeline/checkpoints；status 为 None 或精简 dict
        assert set(d) == {"run_id", "status", "timeline", "checkpoints"}
        assert d["status"]["phase"] == "done"
        assert d["timeline"]["entries"][0]["node"] == "A"
        assert d["checkpoints"]["checkpoints"][0]["target"] == "1"

    def test_missing_404(self, client):
        r = client.get("/api/runs/ghost/feed")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"


def test_list_runs_paused_flag(base, client):
    """行内控制按钮的数据支撑：paused 取自 control.json 薄映射。"""
    seed_run(base, "p_run", status={"module_id": "p_run", "phase": "running", "updated_at": 1.0})
    d = client.get("/api/runs").json()
    row = next(r for r in d["runs"] if r["run_id"] == "p_run")
    assert row["paused"] is False
    client.post("/api/runs/p_run/control", json={"action": "pause"})
    d = client.get("/api/runs").json()
    row = next(r for r in d["runs"] if r["run_id"] == "p_run")
    assert row["paused"] is True
    client.post("/api/runs/p_run/control", json={"action": "cancel"})
    d = client.get("/api/runs").json()
    row = next(r for r in d["runs"] if r["run_id"] == "p_run")
    assert row["paused"] is False  # 挂起的 cancel 请求不等于暂停

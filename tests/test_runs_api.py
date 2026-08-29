# tests/test_runs_api.py
"""GET /api/runs 与运行读端点：形状 + 错误契约（None → 404）。"""

from __future__ import annotations

from tests.conftest import seed_run


class TestRunsList:
    def test_empty(self, client):
        r = client.get("/api/runs")
        assert r.status_code == 200
        assert r.json() == {"runs": []}

    def test_sorted_by_updated_at_desc(self, base, client):
        seed_run(base, "r_old", status={"module_id": "r_old", "phase": "done", "updated_at": 1.0})
        seed_run(base, "r_new", status={"module_id": "r_new", "phase": "running", "updated_at": 2.0})
        r = client.get("/api/runs")
        assert r.status_code == 200
        runs = r.json()["runs"]
        assert [x["run_id"] for x in runs] == ["r_new", "r_old"]
        assert runs[0]["phase"] == "running"
        assert runs[0]["tick"] is None      # 无 run.sqlite → tick None

    def test_skips_dirs_without_status(self, base, client):
        (base / ".specmodule" / "runs" / "junk").mkdir(parents=True)
        r = client.get("/api/runs")
        assert r.json() == {"runs": []}


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
        r = client.get("/api/runs/../etc/status")
        assert r.status_code in (400, 404)   # 路径归一化后仍须拒绝


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

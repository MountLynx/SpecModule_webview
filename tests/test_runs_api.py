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

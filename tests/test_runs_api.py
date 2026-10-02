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


class TestRunArtifacts:
    @staticmethod
    def _manifest(run_id, path="x/deck.pptx"):
        return [{"name": "deck", "kind": "deliverable", "path": path,
                 "size": 4, "modified": "2026-09-29T10:00:00"}]

    def test_list_shape(self, base, client):
        seed_run(base, "r_art", artifacts=self._manifest("r_art"))
        r = client.get("/api/runs/r_art/artifacts")
        assert r.status_code == 200
        body = r.json()
        assert body["run_id"] == "r_art"
        a = body["artifacts"][0]
        assert set(a) == {"index", "name", "kind", "path", "size", "modified"}
        assert a["index"] == 0 and a["name"] == "deck"

    def test_list_unknown_run_404(self, client):
        r = client.get("/api/runs/ghost/artifacts")
        assert r.status_code == 404
        # app 层 flatten_http_exception：dict detail 展平为顶层错误体
        assert r.json()["error"] == "无运行记录"

    def test_list_no_manifest_empty(self, base, client):
        seed_run(base, "r_empty", status={"module_id": "r_empty", "phase": "done"})
        r = client.get("/api/runs/r_empty/artifacts")
        assert r.status_code == 200
        assert r.json() == {"run_id": "r_empty", "artifacts": []}

    def test_list_corrupt_manifest_empty(self, base, client):
        run_dir = seed_run(base, "r_bad")
        (run_dir / "artifacts.json").write_text("{broken", encoding="utf-8")
        r = client.get("/api/runs/r_bad/artifacts")
        assert r.status_code == 200
        assert r.json()["artifacts"] == []

    def test_download_streams_file(self, base, client):
        run_dir = seed_run(base, "r_dl")
        f = base / "out" / "deck.pptx"
        f.parent.mkdir(parents=True)
        f.write_bytes(b"PKPK")
        (run_dir / "artifacts.json").write_text(json.dumps({
            "run_id": "r_dl", "artifacts": self._manifest("r_dl", str(f)),
        }, ensure_ascii=False), encoding="utf-8")
        r = client.get("/api/runs/r_dl/artifacts/0")
        assert r.status_code == 200
        assert r.content == b"PKPK"
        assert r.headers["content-disposition"].startswith("attachment")
        assert "deck.pptx" in r.headers["content-disposition"]

    def test_download_index_out_of_range_404(self, base, client):
        seed_run(base, "r_oob", artifacts=self._manifest("r_oob"))
        assert client.get("/api/runs/r_oob/artifacts/5").status_code == 404
        assert client.get("/api/runs/r_oob/artifacts/-1").status_code == 404

    def test_download_file_deleted_410(self, base, client):
        seed_run(base, "r_gone", artifacts=self._manifest("r_gone"))
        r = client.get("/api/runs/r_gone/artifacts/0")
        assert r.status_code == 410

    def test_download_unknown_run_404(self, client):
        assert client.get("/api/runs/ghost/artifacts/0").status_code == 404

    def test_download_non_integer_index_422(self, base, client):
        seed_run(base, "r_nan", artifacts=self._manifest("r_nan"))
        assert client.get("/api/runs/r_nan/artifacts/xyz").status_code == 422

    def test_download_non_ascii_filename_header(self, base, client):
        run_dir = seed_run(base, "r_cn")
        f = base / "out" / "深水 图示.pptx"
        f.parent.mkdir(parents=True)
        f.write_bytes(b"PK")
        (run_dir / "artifacts.json").write_text(json.dumps({
            "run_id": "r_cn", "artifacts": [{"name": "深水", "kind": "deliverable",
                                             "path": str(f), "size": 2,
                                             "modified": "2026-09-29T10:00:00"}],
        }, ensure_ascii=False), encoding="utf-8")
        r = client.get("/api/runs/r_cn/artifacts/0")
        assert r.status_code == 200
        assert "filename*=utf-8''" in r.headers["content-disposition"].lower()


class TestNodeState:
    """GET /nodes/{name}/state：query_value state.<node> 寻址薄映射（LLM 链审计消费面）。"""

    def test_found(self, base, client):
        seed_run(
            base, "r_ns",
            firings=[{"tick": 3, "node": "P01", "output": {"status": "ok"},
                      "mutable_state": {
                          "_prompt": "PROMPT", "_llm_raw": "<svg/>",
                          "_usage": {"total_tokens": 42},
                          "_llm_calls": [{"prompt": "PROMPT", "raw": "<svg/>",
                                          "usage": {"total_tokens": 42}}],
                      }}],
            snapshots={3: {"tick": 3, "status": "idle", "fireable": [], "fired": ["P01"]}},
            status={"module_id": "r_ns", "phase": "done", "updated_at": 1.0},
        )
        r = client.get("/api/runs/r_ns/nodes/P01/state")
        assert r.status_code == 200
        body = r.json()
        assert body["run_id"] == "r_ns"
        assert body["node"] == "P01"
        assert body["path"] == "state.P01"
        assert body["tick"] == 3
        assert body["found"] is True
        assert body["value"]["_prompt"] == "PROMPT"
        assert body["value"]["_llm_raw"] == "<svg/>"
        assert body["value"]["_llm_calls"][0]["usage"] == {"total_tokens": 42}
        assert body["available"] is None

    def test_node_miss_returns_available(self, base, client):
        """未执行节点是常态而非错误：200 found=false + available 节点清单。"""
        seed_run(
            base, "r_miss",
            firings=[{"tick": 1, "node": "Plan", "output": "ok", "mutable_state": {}}],
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["Ghost"], "fired": ["Plan"]}},
            status={"module_id": "r_miss", "phase": "running", "updated_at": 1.0},
        )
        r = client.get("/api/runs/r_miss/nodes/Ghost/state")
        assert r.status_code == 200
        body = r.json()
        assert body["found"] is False
        assert body["value"] is None
        assert body["available"] == ["Plan"]

    def test_bare_status_run_found_false(self, base, client):
        """无 run.sqlite 的失败 run：容忍契约——200 found=false（不 404 不 raise）。"""
        run_dir = base / ".specmodule" / "runs" / "r_bare_ns"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text(
            json.dumps({"module_id": "r_bare_ns", "phase": "aborted",
                        "error": "boom", "updated_at": 1.0}),
            encoding="utf-8",
        )
        r = client.get("/api/runs/r_bare_ns/nodes/P01/state")
        assert r.status_code == 200
        body = r.json()
        assert body["found"] is False
        assert body["available"] == []

    def test_unknown_run_404(self, client):
        r = client.get("/api/runs/ghost/nodes/P01/state")
        assert r.status_code == 404
        # app 级异常处理器把 detail dict 平铺为顶层错误契约
        assert r.json()["error"] == "无运行记录"
        assert r.json()["run_id"] == "ghost"

    def test_bad_run_id_400(self, client):
        # 与 /status 同一 deps 校验：非法字符 / 含 .. → 严格 400
        assert client.get("/api/runs/bad%20id/nodes/P01/state").status_code == 400
        assert client.get("/api/runs/a..b/nodes/P01/state").status_code == 400


class TestNodeArtifactDownload:
    """GET /nodes/{node}/artifacts/{index}：路径永不为客户端输入（overlay 自查）。"""

    def _seed(self, base):
        proj = base / "projects" / "demo"
        proj.mkdir(parents=True, exist_ok=True)
        (proj / "page.svg").write_text("<svg/>", encoding="utf-8")
        seed_run(base, "na_run", firings=[
            {"tick": 1, "node": "P", "output": {"file": "projects/demo/page.svg"}},
        ], status={"module_id": "na_run", "phase": "done", "updated_at": 1.0})
        return proj / "page.svg"

    def test_download_ok(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/na_run/nodes/P/artifacts/0")
        assert r.status_code == 200
        assert r.content == b"<svg/>"
        assert "attachment" in r.headers["content-disposition"]

    def test_unknown_node_404(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/na_run/nodes/NOPE/artifacts/0")
        assert r.status_code == 404

    def test_index_out_of_range_404(self, base, client):
        self._seed(base)
        r = client.get("/api/runs/na_run/nodes/P/artifacts/9")
        assert r.status_code == 404

    def test_deleted_file_gone_404(self, base, client):
        """文件已删 → 404 而非 410：overlay 提取按 isfile 锚定，条目不入 overlay。

        node_artifacts 以存在性为提取锚（非文件字符串天然不命中），删除后
        「节点无产物记录」即可观测契约；端点保留 410 分支仅覆盖「提取后、
        响应前」的竞态窗口（与清单通道同契约），进程内同步请求不可达。
        """
        f = self._seed(base)
        f.unlink()
        r = client.get("/api/runs/na_run/nodes/P/artifacts/0")
        assert r.status_code == 404

    def test_unknown_run_404(self, base, client):
        r = client.get("/api/runs/ghost/nodes/P/artifacts/0")
        assert r.status_code == 404

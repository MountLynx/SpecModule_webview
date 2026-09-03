# tests/test_graph_api.py
"""GET /api/runs/{id}/graph：归档重建 + 节点状态叠加。"""

from __future__ import annotations

from tests.conftest import MINI_TASKLIST, seed_run


def _seed_graph_run(base, **kw):
    """run_id=mini_graph（启发式 module=run_id 命中 tests/modules 的 entry 模块）。"""
    firings = kw.pop("firings", [
        {"tick": 1, "node": "A", "output": "a1"},
        {"tick": 1, "node": "B", "output": "b1"},
    ])
    status = kw.pop("status", {"module_id": "mini_graph", "phase": "done", "updated_at": 2.0})
    return seed_run(
        base, "mini_graph",
        firings=firings, status=status,
        inputs={"spec": {"topic": "demo"}, "tasklist": MINI_TASKLIST},
        **kw,
    )


class TestGraph:
    def test_shape_with_overlay(self, base, client):
        _seed_graph_run(base)
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 200
        d = r.json()
        assert d["run_id"] == "mini_graph"
        assert d["module"] == "mini_graph"
        assert d["phase"] == "done"
        g = d["graph"]
        assert sorted(n["id"] for n in g["nodes"]) == ["A", "B", "C"]
        assert all(n["type"] == "script" for n in g["nodes"])
        guards = [e["guard"] for e in g["edges"]]
        assert "pick_c" in guards
        assert g["starts"] == ["A"]
        ns = d["node_states"]
        assert ns["A"] == {"fired_count": 1, "last_status": "ok", "last_tick": 1, "running": False}
        assert ns["C"]["fired_count"] == 0 and ns["C"]["last_status"] is None

    def test_running_badge_from_fireable(self, base, client):
        _seed_graph_run(
            base,
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            status={"module_id": "mini_graph", "phase": "running", "updated_at": 2.0},
        )
        r = client.get("/api/runs/mini_graph/graph")
        # phase=running 且 B/C 无 firing → running 标记（fireable 需快照，无 DB 快照时
        # fireable 为空——本用例只断言契约字段存在与 False 回退）
        assert r.status_code == 200
        assert all(isinstance(v["running"], bool) for v in r.json()["node_states"].values())

    def test_running_badge_overlay_true(self, base, client):
        # phase=running 且最新快照 fireable 含 B → B.running=True；已 fired 的 A 不在 fireable → False
        _seed_graph_run(
            base,
            firings=[{"tick": 1, "node": "A", "output": "a1"}],
            status={"module_id": "mini_graph", "phase": "running", "updated_at": 2.0},
            snapshots={1: {"tick": 1, "status": "running", "fireable": ["B"], "fired": ["A"]}},
        )
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 200
        assert r.json()["node_states"]["B"]["running"] is True
        assert r.json()["node_states"]["A"]["running"] is False

    def test_module_param_override(self, base, client):
        # run_id ≠ 模块名：?module= 显式指定
        seed_run(
            base, "custom_run",
            status={"module_id": "custom_run", "phase": "done", "updated_at": 1.0},
            inputs={"spec": {}, "tasklist": MINI_TASKLIST},
        )
        r = client.get("/api/runs/custom_run/graph", params={"module": "mini_graph"})
        assert r.status_code == 200
        assert r.json()["module"] == "mini_graph"

    def test_status_module_tracing_resolution(self, base, client):
        """溯源解析序：?module= > status.json module 字段 > run_id 启发式。

        UI 发起的 run_id 形如 {module}_{hex}，启发式永不命中——status.json 的
        module 溯源字段使图视图免手动选模块。
        """
        seed_run(
            base, "mini_graph_abc123",
            status={"module_id": "mini_graph_abc123", "module": "mini_graph",
                    "phase": "done", "updated_at": 1.0},
            inputs={"spec": {}, "tasklist": MINI_TASKLIST},
        )
        r = client.get("/api/runs/mini_graph_abc123/graph")
        assert r.status_code == 200
        assert r.json()["module"] == "mini_graph"   # 溯源字段命中，无需 ?module=
        # 显式参数优先级最高
        r = client.get("/api/runs/mini_graph_abc123/graph", params={"module": "mini_graph"})
        assert r.status_code == 200
        assert r.json()["module"] == "mini_graph"

    def test_module_resolved_via_base_dir_without_env_path(self, base_no_search_env, client):
        """图重建的模块解析锚定 base_dir（src 直通），不依赖 SPECMODULE_PATH。"""
        from tests.test_manage_api import BASE_MODULE_SRC

        mods = base_no_search_env / "modules"
        mods.mkdir()
        # base_mod 无模板——图重建走 module_inputs 归档 tasklist 通道，不需模板
        (mods / "base_mod.py").write_text(BASE_MODULE_SRC, encoding="utf-8")
        seed_run(
            base_no_search_env, "base_mod_run",
            status={"module_id": "base_mod_run", "module": "base_mod",
                    "phase": "done", "updated_at": 1.0},
            inputs={"spec": {"topic": "x"},
                    "tasklist": {"Tasks": {"A": {"type": "script", "script": "A"}},
                                 "Flow": "[A]"}},
        )
        r = client.get("/api/runs/base_mod_run/graph")
        assert r.status_code == 200
        assert r.json()["module"] == "base_mod"

    def test_no_archive_404(self, base, client):
        seed_run(base, "mini_graph", status={"module_id": "mini_graph", "phase": "done", "updated_at": 1.0})
        r = client.get("/api/runs/mini_graph/graph")
        assert r.status_code == 404
        assert r.json()["error"] == "无运行记录"
        assert "code" not in r.json()   # 无归档 ≠ 模块解析失败，不触发前端选择器

    def test_module_unresolvable_404_with_message(self, base, client):
        seed_run(
            base, "orphan_run",
            status={"module_id": "orphan_run", "phase": "done", "updated_at": 1.0},
            inputs={"spec": {}, "tasklist": MINI_TASKLIST},
        )
        r = client.get("/api/runs/orphan_run/graph")   # module=orphan_run 不存在
        assert r.status_code == 404
        assert "未找到" in r.json()["error"]
        assert r.json()["code"] == "module_unresolved"   # 前端选择器契约字段（与错误文本解耦）

    def test_invalid_run_id_400(self, client):
        r = client.get("/api/runs/bad..id/graph")
        assert r.status_code == 400

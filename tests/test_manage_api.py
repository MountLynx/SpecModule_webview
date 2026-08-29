# tests/test_manage_api.py
"""GET /api/modules：store.list_modules 薄映射。"""

from __future__ import annotations


class TestModules:
    def test_lists_fixture_module(self, client):
        r = client.get("/api/modules")
        assert r.status_code == 200
        mods = r.json()["modules"]
        names = [m["name"] for m in mods]
        assert "mini_graph" in names
        mini = next(m for m in mods if m["name"] == "mini_graph")
        assert mini["kind"] == "entry"
        assert mini["path"].endswith("mini_graph.py")

    def test_sorted_and_shaped(self, client):
        r = client.get("/api/modules")
        mods = r.json()["modules"]
        assert mods == sorted(mods, key=lambda m: m["name"])
        for m in mods:
            assert set(m) == {"name", "kind", "version", "description", "path"}

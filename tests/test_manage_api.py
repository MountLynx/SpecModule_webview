# tests/test_manage_api.py
"""GET /api/modules（+search_paths）与 GET /api/modules/{name}：store 薄映射。"""

from __future__ import annotations

import json

# 最小 entry 模块源码：只依赖库自身（可放任意 modules/ 目录被发现）
BASE_MODULE_SRC = '''"""运行根 modules/ 锚定测试模块（零第三方依赖）。"""
from module_harness.entry import ModuleEntry
from module_harness.events import EventBus
from module_harness.registry import HarnessRegistry


def _registry_for(llm_client, template_name, event_bus):
    reg = HarnessRegistry(llm_client=llm_client, event_bus=event_bus or EventBus.null())

    @reg.script("A")
    def a(view):
        return {"done": True}

    return reg


entry = ModuleEntry(
    name="base_mod",
    description="运行根 modules/ 下的锚定测试模块",
    templates={},
    default_spec={"topic": "anchor"},
    spec_schema={"topic": "str"},
    build_registry=_registry_for,
)
'''


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

    def test_payload_carries_search_paths(self, base, client):
        """载荷附实际扫描目录（SPECMODULE_PATH 指向的 tests/modules）。"""
        d = client.get("/api/modules").json()
        assert any(p.endswith("modules") for p in d["search_paths"])
        assert all(isinstance(p, str) for p in d["search_paths"])

    def test_search_anchored_to_base_dir(self, base_no_search_env, client):
        """进程边界修复：base_dir/modules 下的模块不经 SPECMODULE_PATH 即可见。"""
        mods_dir = base_no_search_env / "modules"
        mods_dir.mkdir()
        (mods_dir / "base_mod.py").write_text(BASE_MODULE_SRC, encoding="utf-8")
        d = client.get("/api/modules").json()
        names = [m["name"] for m in d["modules"]]
        assert "base_mod" in names
        assert str(mods_dir) in d["search_paths"]


class TestModuleDetail:
    def test_detail_ok(self, client):
        r = client.get("/api/modules/mini_graph")
        assert r.status_code == 200
        d = r.json()
        # detail_to_dict 出口形状（templates/submodules 排序出名列表）
        assert set(d) == {
            "name", "kind", "path", "version", "description",
            "default_template", "templates", "default_spec",
            "spec_schema", "submodules",
        }
        assert d["name"] == "mini_graph"
        assert d["kind"] == "entry"
        assert d["default_spec"] == {"topic": "demo"}
        assert d["templates"] == []

    def test_detail_schema_roundtrip(self, base_no_search_env, client):
        """spec_schema/default_spec 原样透传（前端填表数据源）。"""
        mods_dir = base_no_search_env / "modules"
        mods_dir.mkdir()
        (mods_dir / "base_mod.py").write_text(BASE_MODULE_SRC, encoding="utf-8")
        d = client.get("/api/modules/base_mod").json()
        assert d["spec_schema"] == {"topic": "str"}
        assert d["default_spec"] == {"topic": "anchor"}

    def test_detail_404(self, client):
        r = client.get("/api/modules/no_such_mod")
        assert r.status_code == 404
        assert r.json()["error"] == "模块 'no_such_mod' 未找到"

    def test_detail_400_load_failure(self, base_no_search_env, client):
        """packed 清单可发现但加载失败（缺 tasklist）→ ValueError → 400。"""
        pack = base_no_search_env / "modules" / "broken_pack"
        pack.mkdir(parents=True)
        (pack / "module.json").write_text(
            json.dumps({"name": "broken_pack", "description": "坏包"}),
            encoding="utf-8",
        )
        r = client.get("/api/modules/broken_pack")
        assert r.status_code == 400
        assert "加载失败" in r.json()["error"]

# tests/test_build_api.py
"""构建面端点：组件库 / 草稿 / 组装安装（SPECMODULE_HOME 隔离，绝不触碰真实 store）。"""

from __future__ import annotations

import json
from pathlib import Path

HARNESS = {"name": "summarize", "prompt_core": "总结：{text}", "temperature": 0.3}


def seed_library(home: Path) -> None:
    """直接在隔离 store home 下种组件库文件。"""
    root = home / "home" / "library"
    (root / "harnesses").mkdir(parents=True, exist_ok=True)
    (root / "harnesses" / "summarize.json").write_text(
        json.dumps(HARNESS, ensure_ascii=False), encoding="utf-8")
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "echo.py").write_text(
        "def echo(view):\n    return {'message': view.field('data')}\n", encoding="utf-8")


def seed_pack_module(home: Path, name: str = "sub_greet") -> Path:
    """隔离 store modules/ 下种最小 packed 模块（submodule 拷贝源夹具）。"""
    p = home / "home" / "modules" / name
    (p / "scripts").mkdir(parents=True)
    (p / "module.json").write_text(json.dumps({
        "name": name, "description": "子模块夹具", "submodule": True,
        "spec_schema": {"input": {}, "output": {}},
        "requires": [], "modules": [],
        "tasklist": {"Tasks": {"Greet": {"type": "script", "script": "greet"}},
                     "Flow": "[Greet]"},
    }, ensure_ascii=False), encoding="utf-8")
    (p / "scripts" / "greet.py").write_text(
        "def greet(view):\n    return {'hi': 1}\n", encoding="utf-8")
    return p


class TestLibraryIndex:
    def test_empty_index(self, client, base):
        r = client.get("/api/library")
        assert r.status_code == 200
        assert r.json() == {
            "harnesses": [], "commands": [], "scripts": [], "guards": [],
            "submodules": [], "drafts": [],
        }

    def test_grouped_listing(self, client, base):
        seed_library(base)
        d = client.get("/api/library").json()
        assert d["harnesses"] == ["summarize"]
        assert d["scripts"] == ["echo"]
        assert d["commands"] == [] and d["guards"] == []


COMMAND = {"name": "run_ls", "command": "ls", "timeout": 30.0}


class TestConfigComponents:
    def test_save_and_index_and_detail(self, client, base):
        r = client.put("/api/library/harnesses/summarize", json=HARNESS)
        assert r.status_code == 200 and r.json()["saved"] is True
        r = client.put("/api/library/commands/run_ls", json=COMMAND)
        assert r.status_code == 200
        d = client.get("/api/library").json()
        assert d["harnesses"] == ["summarize"] and d["commands"] == ["run_ls"]
        # 详情 = 存储 JSON 原样（前端表单回填数据源）
        assert client.get("/api/library/harnesses/summarize").json()["prompt_core"] == "总结：{text}"

    def test_save_invalid_config_400(self, client, base):
        # harness 缺必填 prompt_core；command 缺必填 command
        r = client.put("/api/library/harnesses/bad", json={"name": "bad"})
        assert r.status_code == 400 and "无效" in r.json()["error"]
        r = client.put("/api/library/commands/bad", json={"name": "bad"})
        assert r.status_code == 400

    def test_save_name_mismatch_400(self, client, base):
        r = client.put("/api/library/harnesses/other", json=HARNESS)
        assert r.status_code == 400 and "不一致" in r.json()["error"]

    def test_save_bad_name_400(self, client, base):
        r = client.put("/api/library/harnesses/9bad", json={**HARNESS, "name": "9bad"})
        assert r.status_code == 400

    def test_update_overwrites(self, client, base):
        client.put("/api/library/harnesses/summarize", json=HARNESS)
        client.put("/api/library/harnesses/summarize",
                   json={**HARNESS, "temperature": 0.9})
        assert client.get("/api/library/harnesses/summarize").json()["temperature"] == 0.9

    def test_delete_and_404(self, client, base):
        client.put("/api/library/harnesses/summarize", json=HARNESS)
        assert client.delete("/api/library/harnesses/summarize").json()["deleted"] is True
        assert client.delete("/api/library/harnesses/summarize").status_code == 404


class TestLibraryReads:
    """损坏/不可解码存储文件读防护（查询不抛异常：400 而非 500）+ 错误契约。"""

    def test_corrupt_harness_json_400(self, client, base):
        p = base / "home" / "library" / "harnesses" / "broken.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('"{not json', encoding="utf-8")
        r = client.get("/api/library/harnesses/broken")
        assert r.status_code == 400 and "读取失败" in r.json()["error"]

    def test_non_utf8_script_400(self, client, base):
        p = base / "home" / "library" / "scripts" / "bad.py"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xfe\x00")
        r = client.get("/api/library/scripts/bad")
        assert r.status_code == 400 and "读取失败" in r.json()["error"]

    def test_put_non_dict_json_400(self, client, base):
        r = client.put("/api/library/harnesses/arr", content=b"[1,2]")
        assert r.status_code == 400

    def test_missing_config_404(self, client, base):
        assert client.get("/api/library/harnesses/ghost").status_code == 404

    def test_delete_unknown_kind_404(self, client, base):
        assert client.delete("/api/library/nope/x").status_code == 404


SCRIPT = "def echo(view):\n    return {'message': view.field('data')}\n"
GUARD = "def has_issues(view):\n    return True\n"


class TestCodeComponents:
    def test_save_and_detail(self, client, base):
        r = client.put("/api/library/scripts/echo", content=SCRIPT.encode("utf-8"))
        assert r.status_code == 200 and r.json()["saved"] is True
        r = client.put("/api/library/guards/has_issues", content=GUARD.encode("utf-8"))
        assert r.status_code == 200
        d = client.get("/api/library/scripts/echo").json()
        assert d == {"name": "echo", "code": SCRIPT}
        assert client.get("/api/library").json()["guards"] == ["has_issues"]
        # guards 读端点同形状覆盖
        d2 = client.get("/api/library/guards/has_issues").json()
        assert d2 == {"name": "has_issues", "code": GUARD}

    def test_save_bad_name_400(self, client, base):
        r = client.put("/api/library/scripts/bad-name", content=b"x")
        assert r.status_code == 400

    def test_save_non_utf8_400(self, client, base):
        r = client.put("/api/library/scripts/echo", content=b"\xff\xfe\x00")
        assert r.status_code == 400

    def test_delete_and_404(self, client, base):
        client.put("/api/library/scripts/echo", content=SCRIPT.encode("utf-8"))
        assert client.delete("/api/library/scripts/echo").json()["deleted"] is True
        assert client.delete("/api/library/scripts/echo").status_code == 404


class TestSubmoduleIndex:
    def test_add_list_remove(self, client, base):
        seed_pack_module(base)
        r = client.put("/api/library/submodules/sub_greet")
        assert r.status_code == 200
        d = client.get("/api/library").json()
        assert d["submodules"] == [{"name": "sub_greet", "added_at": d["submodules"][0]["added_at"]}]
        # 重复登记幂等
        client.put("/api/library/submodules/sub_greet")
        assert len(client.get("/api/library").json()["submodules"]) == 1
        assert client.delete("/api/library/submodules/sub_greet").json()["deleted"] is True
        assert client.get("/api/library").json()["submodules"] == []

    def test_add_unknown_module_404(self, client, base):
        assert client.put("/api/library/submodules/nope").status_code == 404

    def test_add_entry_module_400(self, client, base):
        """entry 形态模块不能作 submodule（tests/modules 夹具 mini_graph 是 entry）。"""
        r = client.put("/api/library/submodules/mini_graph")
        assert r.status_code == 400 and "packed" in r.json()["error"]

    def test_detail_of_indexed(self, client, base):
        seed_pack_module(base)
        client.put("/api/library/submodules/sub_greet")
        d = client.get("/api/library/submodules/sub_greet").json()
        assert d["name"] == "sub_greet"

    def test_corrupt_index_tolerated(self, client, base):
        """损坏索引（非 dict 元素 / 缺 name 键）不致 500：读端回落空 + 登记重写干净索引。"""
        seed_pack_module(base)
        p = base / "home" / "library" / "submodules.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        for corrupt in ("[1, 2]", '[{"foo": 1}]'):
            p.write_text(corrupt, encoding="utf-8")
            assert client.get("/api/library").json()["submodules"] == []
            # 损坏在场时增删皆不抛异常
            assert client.put("/api/library/submodules/sub_greet").status_code == 200
            d = client.get("/api/library").json()
            assert d["submodules"] == [
                {"name": "sub_greet", "added_at": d["submodules"][0]["added_at"]}]
            assert client.delete("/api/library/submodules/sub_greet").json()["deleted"] is True
            assert client.get("/api/library").json()["submodules"] == []


def draft_json(name: str = "my_mod", **over) -> dict:
    return {
        "meta": {"name": name, "version": "0.1.0", "description": "测试草稿"},
        "spec_schema": [{"field": "raw_text", "type": "str"}],
        "default_spec": {},
        "nodes": [
            {"id": "n1", "label": "Echo", "type": "script", "script": "echo",
             "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}},
        ],
        "edges": [],
        **over,
    }


class TestDrafts:
    def test_save_load_index_delete(self, client, base):
        r = client.put("/api/library/drafts/my_mod", json=draft_json())
        assert r.status_code == 200
        assert client.get("/api/library").json()["drafts"] == ["my_mod"]
        d = client.get("/api/library/drafts/my_mod").json()
        assert d["meta"]["name"] == "my_mod" and "updated_at" in d
        assert client.delete("/api/library/drafts/my_mod").json()["deleted"] is True
        assert client.get("/api/library/drafts/my_mod").status_code == 404

    def test_name_mismatch_400(self, client, base):
        r = client.put("/api/library/drafts/other", json=draft_json("my_mod"))
        assert r.status_code == 400 and "不一致" in r.json()["error"]

    def test_structural_validation(self, client, base):
        # 节点名非标识符
        bad = draft_json()
        bad["nodes"][0]["label"] = "bad label"
        assert client.put("/api/library/drafts/my_mod", json=bad).status_code == 400
        # 节点名重复
        dup = draft_json()
        dup["nodes"].append(dict(dup["nodes"][0], id="n2"))
        assert client.put("/api/library/drafts/my_mod", json=dup).status_code == 400
        # 节点缺类型引用
        noref = draft_json()
        del noref["nodes"][0]["script"]
        assert client.put("/api/library/drafts/my_mod", json=noref).status_code == 400
        # 边引用不存在节点 id
        badedge = draft_json()
        badedge["edges"] = [{"id": "e1", "from": "ghost", "to": "n1", "guard": None}]
        assert client.put("/api/library/drafts/my_mod", json=badedge).status_code == 400
        # spec_schema 类型非法
        badschema = draft_json()
        badschema["spec_schema"] = [{"field": "x", "type": "long"}]
        assert client.put("/api/library/drafts/my_mod", json=badschema).status_code == 400

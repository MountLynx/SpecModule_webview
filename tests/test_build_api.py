# tests/test_build_api.py
"""构建面端点：组件库 / 草稿 / 组装安装（SPECMODULE_HOME 隔离，绝不触碰真实 store）。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from server.api.build import draft_to_tasklist

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

    def test_dup_node_ids_400(self, client, base):
        # Fix A：id 重复会静默塌图（两节点同 id → Flow 错乱），PUT 侧即拒
        dup = draft_json()
        dup["nodes"].append(dict(dup["nodes"][0], label="Echo2"))
        r = client.put("/api/library/drafts/my_mod", json=dup)
        assert r.status_code == 400 and "id 重复" in r.json()["error"]

    def test_field_shapes_400(self, client, base):
        # Fix B：inputs/overrides/outputs 须为对象——形状逃逸（hand-edit）会让
        # 组装路径 dict()/update() 抛 TypeError，PUT 侧即拒
        over = draft_json()
        over["nodes"][0]["overrides"] = [1]
        r = client.put("/api/library/drafts/my_mod", json=over)
        assert r.status_code == 400 and "overrides" in r.json()["error"]
        sub = draft_json()
        sub["nodes"][0] = {"id": "s", "label": "Sub", "type": "submodule",
                           "submodule": "sub_greet", "is_start": True, "join": "AND",
                           "position": {"x": 0, "y": 0}, "inputs": {}, "outputs": [1]}
        r = client.put("/api/library/drafts/my_mod", json=sub)
        assert r.status_code == 400 and "outputs" in r.json()["error"]


class TestDraftToTasklist:
    def test_flow_dsl_generation(self):
        draft = {
            "meta": {"name": "m", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "a", "label": "Summarize", "type": "harness", "harness": "summarize",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {"text": "{spec.raw_text}"}, "overrides": {"temperature": 0.3}},
                {"id": "b", "label": "Echo", "type": "script", "script": "echo",
                 "is_start": False, "join": "OR", "position": {"x": 0, "y": 0},
                 "inputs": {"data": "Summarize"}},
            ],
            "edges": [{"id": "e1", "from": "a", "to": "b", "guard": "has_issues"}],
        }
        tl = draft_to_tasklist(draft)
        assert tl["Tasks"] == {
            "Summarize": {"type": "harness", "harness": "summarize", "temperature": 0.3,
                          "inputs": {"text": "{spec.raw_text}"}},
            "Echo": {"type": "script", "script": "echo", "inputs": {"data": "Summarize"}},
        }
        assert tl["Flow"] == "[Summarize] --|has_issues|--> Echo\nEcho.join: OR"

    def test_submodule_outputs_and_join_default(self):
        draft = {
            "meta": {"name": "m", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "s", "label": "Sub", "type": "submodule", "submodule": "sub_greet",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {}, "outputs": {"msg": "hi"}},
            ],
            "edges": [],
        }
        tl = draft_to_tasklist(draft)
        assert tl["Tasks"]["Sub"] == {"type": "submodule", "submodule": "sub_greet",
                                      "outputs": {"msg": "hi"}}
        # Fix C：孤立起点（零出边）补 [名] 标记行——单节点模块 Flow 不再为空
        assert tl["Flow"] == "[Sub]"

    def test_isolated_start_marker_line(self):
        """Fix C：带出边的起点照常打 [标记]，孤立起点补 [名] 标记行（裸名整行
        只在单节点 Flow 可解析，[名] 行在混合流中任意位置可解析）。"""
        draft = {
            "meta": {"name": "m", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "x1", "label": "Echo", "type": "script", "script": "echo",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {}},
                {"id": "x2", "label": "Echo2", "type": "script", "script": "echo",
                 "is_start": False, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {"data": "Echo"}},
                {"id": "s", "label": "Sub", "type": "submodule", "submodule": "sub_greet",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {}},
            ],
            "edges": [{"id": "e1", "from": "x1", "to": "x2", "guard": None}],
        }
        tl = draft_to_tasklist(draft)
        assert tl["Flow"] == "[Echo] --> Echo2\n[Sub]"


def seed_builder(client) -> dict:
    """经 API 保存 harness/script/guard + 循环草稿（harness→script，guard 回边）。"""
    assert client.put("/api/library/harnesses/summarize", json=HARNESS).status_code == 200
    assert client.put(
        "/api/library/scripts/echo", content=SCRIPT.encode("utf-8")).status_code == 200
    assert client.put(
        "/api/library/guards/has_issues", content=GUARD.encode("utf-8")).status_code == 200
    draft = {
        "meta": {"name": "loop_mod", "version": "0.2.0", "description": "循环测试"},
        "spec_schema": [{"field": "raw_text", "type": "str"}],
        "default_spec": {"raw_text": "demo"},
        "nodes": [
            {"id": "a", "label": "Summarize", "type": "harness", "harness": "summarize",
             "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
             "inputs": {"text": "{spec.raw_text}"}},
            {"id": "b", "label": "Echo", "type": "script", "script": "echo",
             "is_start": False, "join": "OR", "position": {"x": 0, "y": 0},
             "inputs": {"data": "Summarize"}},
        ],
        "edges": [
            {"id": "e1", "from": "a", "to": "b", "guard": None},
            {"id": "e2", "from": "b", "to": "a", "guard": "has_issues"},
        ],
    }
    assert client.put("/api/library/drafts/loop_mod", json=draft).status_code == 200
    return draft


class TestValidatePack:
    def test_validate_ok_returns_tasklist(self, client, base):
        seed_builder(client)
        r = client.post("/api/modules/packs/validate", json={"draft": "loop_mod"})
        assert r.status_code == 200
        d = r.json()
        assert d["ok"] is True
        assert d["manifest"]["name"] == "loop_mod"
        # 回边 e2 是 b→a（Echo→Summarize）；Echo.join: OR 追加在尾
        assert d["tasklist"]["Flow"] == (
            "[Summarize] --> Echo\nEcho --|has_issues|--> Summarize\nEcho.join: OR")
        # dry-run 不落 store
        assert "loop_mod" not in [m["name"] for m in client.get("/api/modules").json()["modules"]]

    def test_validate_missing_component_400(self, client, base):
        draft = {
            "meta": {"name": "broken", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "n1", "label": "E", "type": "script", "script": "ghost",
                       "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                       "inputs": {}}],
            "edges": [],
        }
        client.put("/api/library/drafts/broken", json=draft)
        r = client.post("/api/modules/packs/validate", json={"draft": "broken"})
        assert r.status_code == 400 and "ghost" in r.json()["error"]

    def test_validate_400_loader_semantics(self, client, base):
        """库校验兜底：script 文件内函数名与 stem 不符 → ModuleLoader 拒绝。"""
        client.put("/api/library/scripts/wrongname", content=b"def other(view):\n    return {}\n")
        draft = {
            "meta": {"name": "wrongfn", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "n1", "label": "E", "type": "script", "script": "wrongname",
                       "is_start": True, "join": "AND", "position": {"x": 0, "y": 0},
                       "inputs": {}}],
            "edges": [],
        }
        client.put("/api/library/drafts/wrongfn", json=draft)
        r = client.post("/api/modules/packs/validate", json={"draft": "wrongfn"})
        assert r.status_code == 400

    def test_validate_unknown_draft_404(self, client, base):
        r = client.post("/api/modules/packs/validate", json={"draft": "ghost_draft"})
        assert r.status_code == 404

    def test_validate_hand_corrupted_draft_400(self, client, base):
        """绕过 PUT 校验的手改草稿文件（nodes: "oops"）也不致 500——形状逃逸
        在组装路径抛 TypeError → 端点兜 400。"""
        p = base / "home" / "library" / "drafts" / "sneaky.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"meta": {"name": "sneaky"}, "nodes": "oops"}),
                     encoding="utf-8")
        r = client.post("/api/modules/packs/validate", json={"draft": "sneaky"})
        assert r.status_code == 400

    def test_validate_with_submodule(self, client, base):
        """组装的 submodule 分支：整包 copytree 进 submodules/，manifest modules
        列表双向一致，经库 validate_pack_dir 全量校验。"""
        seed_pack_module(base)
        assert client.put("/api/library/submodules/sub_greet").status_code == 200
        draft = {
            "meta": {"name": "with_sub", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "s", "label": "Sub", "type": "submodule",
                       "submodule": "sub_greet", "is_start": True, "join": "AND",
                       "position": {"x": 0, "y": 0}, "inputs": {},
                       "outputs": {"msg": "hi"}}],
            "edges": [],
        }
        client.put("/api/library/drafts/with_sub", json=draft)
        r = client.post("/api/modules/packs/validate", json={"draft": "with_sub"})
        assert r.status_code == 200
        d = r.json()
        assert d["ok"] is True
        assert d["manifest"]["modules"] == ["sub_greet"]
        assert d["manifest"]["tasklist"]["Tasks"]["Sub"] == {
            "type": "submodule", "submodule": "sub_greet", "outputs": {"msg": "hi"}}
        # Fix 3 复用 manifest tasklist：与响应顶层 tasklist 同源同形
        assert d["tasklist"] == d["manifest"]["tasklist"]
        assert d["tasklist"]["Flow"] == "[Sub]"
        # dry-run 不落 store
        assert "with_sub" not in [m["name"] for m in client.get("/api/modules").json()["modules"]]


class TestInstallPack:
    def test_install_ok_and_visible(self, client, base):
        seed_builder(client)
        r = client.post("/api/modules/packs", json={"draft": "loop_mod"})
        assert r.status_code == 200
        d = r.json()
        assert d["name"] == "loop_mod" and d["kind"] == "packed"
        # 安装后模块库可见（store/modules 在搜索路径内）
        names = [m["name"] for m in client.get("/api/modules").json()["modules"]]
        assert "loop_mod" in names

    def test_install_duplicate_409(self, client, base):
        seed_builder(client)
        assert client.post("/api/modules/packs", json={"draft": "loop_mod"}).status_code == 200
        r = client.post("/api/modules/packs", json={"draft": "loop_mod"})
        assert r.status_code == 409 and "已存在" in r.json()["error"]

    def test_install_with_submodule(self, client, base):
        """submodule 索引 + 引用节点 → 组装时整包拷进 submodules/<键>/。"""
        seed_pack_module(base)
        client.put("/api/library/submodules/sub_greet")
        client.put("/api/library/scripts/greeter",
                   content=b"def greeter(view):\n    return {'ok': True}\n")
        draft = {
            "meta": {"name": "with_sub", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "g", "label": "Greeter", "type": "script", "script": "greeter",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}},
                {"id": "s", "label": "Sub", "type": "submodule", "submodule": "sub_greet",
                 "is_start": False, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {"x": "Greeter"}},
            ],
            "edges": [{"id": "e1", "from": "g", "to": "s", "guard": None}],
        }
        client.put("/api/library/drafts/with_sub", json=draft)
        r = client.post("/api/modules/packs", json={"draft": "with_sub"})
        assert r.status_code == 200
        d = client.get("/api/modules/with_sub").json()
        assert "sub_greet" in d["submodules"]

    def test_install_missing_submodule_source_400(self, client, base):
        """登记后源包被删 → 组装期报缺失（索引轻、拷贝在组装时刻）。"""
        pack = seed_pack_module(base, "doomed")
        import shutil as _sh
        _sh.rmtree(pack)
        client.put("/api/library/submodules/doomed")
        client.put("/api/library/scripts/greeter",
                   content=b"def greeter(view):\n    return {'ok': True}\n")
        draft = {
            "meta": {"name": "orphan", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [{"id": "s", "label": "Sub", "type": "submodule", "submodule": "doomed",
                       "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}}],
            "edges": [],
        }
        client.put("/api/library/drafts/orphan", json=draft)
        r = client.post("/api/modules/packs", json={"draft": "orphan"})
        assert r.status_code == 400 and "doomed" in r.json()["error"]


class TestSchemaOutputPassthrough:
    """spec_schema.output 透传：外部 pack 的 output 侧经草稿往返不丢。"""

    def test_output_side_roundtrip_via_validate(self, client, base):
        seed_builder(client)
        draft = client.get("/api/library/drafts/loop_mod").json()
        draft["spec_schema_output"] = {"summary": "str"}
        assert client.put("/api/library/drafts/loop_mod", json=draft).status_code == 200
        r = client.post("/api/modules/packs/validate", json={"draft": "loop_mod"})
        assert r.status_code == 200
        assert r.json()["manifest"]["spec_schema"]["output"] == {"summary": "str"}

    def test_output_side_non_dict_400(self, client, base):
        seed_builder(client)
        draft = client.get("/api/library/drafts/loop_mod").json()
        draft["spec_schema_output"] = "oops"
        r = client.put("/api/library/drafts/loop_mod", json=draft)
        assert r.status_code == 400 and "spec_schema_output" in r.json()["error"]

    def test_no_output_side_unchanged(self, client, base):
        """无透传字段的草稿 manifest 形状不变（向后兼容）。"""
        seed_builder(client)
        r = client.post("/api/modules/packs/validate", json={"draft": "loop_mod"})
        assert r.json()["manifest"]["spec_schema"] == {"input": {"raw_text": "str"}}


class TestUpdatePack:
    """同名覆盖更新：校验先行 + apply_update；未安装 404；entry 目标 400。"""

    def _install_loop(self, client) -> None:
        seed_builder(client)
        assert client.post("/api/modules/packs", json={"draft": "loop_mod"}).status_code == 200

    def test_update_roundtrip(self, client, base):
        self._install_loop(client)
        draft = client.get("/api/library/drafts/loop_mod").json()
        draft["meta"]["version"] = "0.3.0"
        draft["meta"]["description"] = "更新后的描述"
        # 结构覆盖（apply_update 生态唯一测试网）：去 guard 回边——全目录替换
        # 应同步收窄包内 Flow，而非只刷 meta
        draft["edges"] = [e for e in draft["edges"] if not e.get("guard")]
        assert client.put("/api/library/drafts/loop_mod", json=draft).status_code == 200
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 200
        assert r.json()["version"] == "0.3.0"
        manifest = json.loads(
            (base / "home" / "manifests" / "loop_mod.json").read_text(encoding="utf-8"))
        assert manifest["version"] == "0.3.0"
        pkg = json.loads(
            (base / "home" / "modules" / "loop_mod" / "module.json").read_text(encoding="utf-8"))
        assert pkg["description"] == "更新后的描述"
        assert "has_issues" not in pkg["tasklist"]["Flow"]

    def test_update_not_installed_404(self, client, base):
        seed_builder(client)  # 只存草稿，未安装
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 404 and "未安装" in r.json()["error"]

    def test_update_entry_target_400(self, client, base):
        # mini_graph（entry 形态，tests/modules 夹具）：造同名草稿命中 entry 解析
        draft = draft_json("mini_graph")
        client.put("/api/library/drafts/mini_graph", json=draft)
        r = client.post("/api/modules/packs/update", json={"draft": "mini_graph"})
        assert r.status_code == 400 and "entry" in r.json()["error"]

    def test_update_validate_fail_store_intact(self, client, base):
        """组装校验失败 → 400 且 store 包内容一个字节不动（校验先于任何写入）。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        before = pkg.read_bytes()
        assert client.delete("/api/library/harnesses/summarize").status_code == 200
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 400
        assert pkg.read_bytes() == before

    def test_update_corrupt_target_400(self, client, base):
        """已装包损坏（module.json 可解析但缺 tasklist → ModuleLoader 拒载）→
        resolve 期 ValueError → 400 而非 500。（注：manifest 整体损坏则库 listing
        直接跳过该目录 → 走「未安装」404 分支，不进本防护。）"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        pkg.write_text(json.dumps({"name": "loop_mod"}), encoding="utf-8")
        r = client.post("/api/modules/packs/update", json={"draft": "loop_mod"})
        assert r.status_code == 400 and "加载失败" in r.json()["error"]


class TestDecompile:
    """已装 packed 模块反解：图 round-trip + 组件导入三态报告 + output 侧保全。"""

    def _install_loop(self, client) -> None:
        seed_builder(client)
        assert client.post("/api/modules/packs", json={"draft": "loop_mod"}).status_code == 200

    def test_round_trip(self, client, base):
        self._install_loop(client)
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 200
        d = r.json()
        assert d["draft"] == "loop_mod"
        # 包内组件与库逐字节同源（copy2 拷入）→ 全部 existed，无冲突无警告
        assert sorted(d["report"]["existed"]) == [
            "guards/has_issues", "harnesses/summarize", "scripts/echo"]
        assert d["report"]["imported"] == [] and d["report"]["conflicts"] == []
        assert d["report"]["warnings"] == []
        draft = client.get("/api/library/drafts/loop_mod").json()
        labels = {n["label"]: n for n in draft["nodes"]}
        assert set(labels) == {"Summarize", "Echo"}
        s = labels["Summarize"]
        assert s["type"] == "harness" and s["harness"] == "summarize"
        assert s["is_start"] is True and s["join"] == "AND"
        assert s["inputs"] == {"text": "{spec.raw_text}"}
        assert s["position"] == {"x": 0, "y": 0}
        e = labels["Echo"]
        assert e["type"] == "script" and e["script"] == "echo"
        assert e["join"] == "OR" and e["is_start"] is False
        assert "overrides" not in e  # 草稿无 overrides 声明 → 不出现该键
        # 边：guard 保留、from/to 指向存在的节点 id
        ids = {n["id"] for n in draft["nodes"]}
        assert len(draft["edges"]) == 2
        assert all(ed["from"] in ids and ed["to"] in ids for ed in draft["edges"])
        assert sorted(ed["guard"] for ed in draft["edges"] if ed["guard"]) == ["has_issues"]
        # spec_schema 反转 + meta 还原
        assert draft["spec_schema"] == [{"field": "raw_text", "type": "str"}]
        assert draft["meta"] == {"name": "loop_mod", "version": "0.2.0", "description": "循环测试"}
        assert draft["default_spec"] == {}  # packed 模块无 default_spec 概念

    def test_import_missing_components(self, client, base):
        """装好后删库组件 → 反解把包内副本重新导入（imported）。"""
        self._install_loop(client)
        for kind, name in [("harnesses", "summarize"), ("scripts", "echo"), ("guards", "has_issues")]:
            assert client.delete(f"/api/library/{kind}/{name}").status_code == 200
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 200
        assert sorted(r.json()["report"]["imported"]) == [
            "guards/has_issues", "harnesses/summarize", "scripts/echo"]
        # 导入内容与包内副本一致（回读比对）
        lib = client.get("/api/library/harnesses/summarize").json()
        assert lib["name"] == "summarize"

    def test_conflict_skip_and_report(self, client, base):
        """同名异内容：跳过包内副本沿用库版本，conflicts 报告且库内容未被改写。"""
        self._install_loop(client)
        changed = {"name": "summarize", "prompt_core": "改过的提示词：{text}", "temperature": 0.9}
        assert client.put("/api/library/harnesses/summarize", json=changed).status_code == 200
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 200
        assert r.json()["report"]["conflicts"] == ["harnesses/summarize"]
        assert client.get("/api/library/harnesses/summarize").json() == changed

    def test_output_side_preserved(self, client, base):
        """手改包 manifest 加 output 侧 → 反解透传 → 更新后新包仍有 output。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        manifest = json.loads(pkg.read_text(encoding="utf-8"))
        manifest["spec_schema"]["output"] = {"summary": "str"}
        pkg.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        assert client.post("/api/modules/loop_mod/decompile").status_code == 200
        draft = client.get("/api/library/drafts/loop_mod").json()
        assert draft["spec_schema_output"] == {"summary": "str"}
        assert client.post("/api/modules/packs/update", json={"draft": "loop_mod"}).status_code == 200
        new_manifest = json.loads(pkg.read_text(encoding="utf-8"))
        assert new_manifest["spec_schema"]["output"] == {"summary": "str"}

    def test_unknown_module_404(self, client, base):
        r = client.post("/api/modules/ghost_mod/decompile")
        assert r.status_code == 404

    def test_entry_module_400(self, client, base):
        r = client.post("/api/modules/mini_graph/decompile")
        assert r.status_code == 400 and "entry" in r.json()["error"]

    def test_decompile_corrupt_target_400(self, client, base):
        """损坏已装包（可解析但缺 tasklist 的 manifest）→ 加载失败 ValueError → 400 非 500。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        pkg.write_text(json.dumps({"name": "loop_mod"}, ensure_ascii=False), encoding="utf-8")
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 400 and "加载失败" in r.json()["error"]

    def test_drift_task_without_flow_400(self, client, base):
        """Tasks 有 Flow 无（外部 pack 漂移）→ 库建图 KeyError → 400 非 500。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        manifest = json.loads(pkg.read_text(encoding="utf-8"))
        manifest["tasklist"]["Tasks"]["Ghost"] = {"type": "script", "script": "echo"}
        pkg.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        assert client.post("/api/modules/loop_mod/decompile").status_code == 400

    def test_drift_flow_without_task_400(self, client, base):
        """Flow 有 Tasks 无 → graph_to_dict 降级 unknown 节点 → 400 非 500。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        manifest = json.loads(pkg.read_text(encoding="utf-8"))
        manifest["tasklist"]["Flow"] = "[Summarize] --> Echo\nSummarize --> Phantom"
        pkg.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        assert client.post("/api/modules/loop_mod/decompile").status_code == 400

    def test_drift_input_side_non_dict_400(self, client, base):
        """spec_schema.input 为非 dict（外部手写）→ 400 非 500。"""
        self._install_loop(client)
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        manifest = json.loads(pkg.read_text(encoding="utf-8"))
        manifest["spec_schema"]["input"] = ["raw_text"]
        pkg.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        assert client.post("/api/modules/loop_mod/decompile").status_code == 400

    def test_validation_failure_before_imports(self, client, base):
        """草稿校验失败（非法 spec 字段名）→ 400 且组件库零导入（校验前置）。"""
        self._install_loop(client)
        for kind, name in [("harnesses", "summarize"), ("scripts", "echo"), ("guards", "has_issues")]:
            assert client.delete(f"/api/library/{kind}/{name}").status_code == 200
        pkg = base / "home" / "modules" / "loop_mod" / "module.json"
        manifest = json.loads(pkg.read_text(encoding="utf-8"))
        manifest["spec_schema"]["input"] = {"raw-text": "str"}  # field 非标识符 → _validate_draft 400
        pkg.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        r = client.post("/api/modules/loop_mod/decompile")
        assert r.status_code == 400
        assert client.get("/api/library").json()["harnesses"] == []  # 未半入库

    def test_submodule_unresolvable_warning(self, client, base):
        """submodule 引用不可解析（store 副本已删）→ warnings 透出且草稿仍落盘。"""
        seed_pack_module(base)
        assert client.put("/api/library/submodules/sub_greet").status_code == 200
        client.put("/api/library/scripts/greeter",
                   content=b"def greeter(view):\n    return {'ok': True}\n")
        draft = {
            "meta": {"name": "with_sub", "version": "0.1.0", "description": ""},
            "spec_schema": [], "default_spec": {},
            "nodes": [
                {"id": "g", "label": "Greeter", "type": "script", "script": "greeter",
                 "is_start": True, "join": "AND", "position": {"x": 0, "y": 0}, "inputs": {}},
                {"id": "s", "label": "Sub", "type": "submodule", "submodule": "sub_greet",
                 "is_start": False, "join": "AND", "position": {"x": 0, "y": 0},
                 "inputs": {"x": "Greeter"}},
            ],
            "edges": [{"id": "e1", "from": "g", "to": "s", "guard": None}],
        }
        client.put("/api/library/drafts/with_sub", json=draft)
        assert client.post("/api/modules/packs", json={"draft": "with_sub"}).status_code == 200
        # 删 store 视角的 sub_greet（父包内嵌 submodules/ 副本不受影响）——
        # ModuleLoader 建图仍成功，仅 store.resolve_module（warnings 探测）扑空
        shutil.rmtree(base / "home" / "modules" / "sub_greet")
        (base / "home" / "manifests" / "sub_greet.json").unlink(missing_ok=True)
        r = client.post("/api/modules/with_sub/decompile")
        assert r.status_code == 200
        report = r.json()["report"]
        assert any("sub_greet" in w and "未安装" in w for w in report["warnings"])
        new_draft = client.get("/api/library/drafts/with_sub").json()
        sub = next(n for n in new_draft["nodes"] if n["label"] == "Sub")
        assert sub["type"] == "submodule" and sub["submodule"] == "sub_greet"

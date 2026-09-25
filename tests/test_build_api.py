# tests/test_build_api.py
"""构建面端点：组件库 / 草稿 / 组装安装（SPECMODULE_HOME 隔离，绝不触碰真实 store）。"""

from __future__ import annotations

import json
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

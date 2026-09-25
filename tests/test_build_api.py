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

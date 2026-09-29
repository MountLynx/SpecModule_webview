"""登记 CLI：list / remove（--purge 破坏性显式）。"""

from __future__ import annotations

import pytest

from server.gateway.cli import main
from server.gateway.identity import Registry, dir_for


@pytest.fixture
def seeded(gw_root):
    reg = Registry(gw_root)
    reg.claim("tester", display="Tester 甲")
    return gw_root


def test_list_prints_entries(seeded, capsys):
    assert main(["--root", str(seeded), "list"]) == 0
    out = capsys.readouterr().out
    assert "Tester 甲" in out and "port=8101" in out


def test_list_empty(gw_root, capsys):
    assert main(["--root", str(gw_root), "list"]) == 0
    assert "空" in capsys.readouterr().out


def test_remove_and_purge(seeded, capsys):
    reg = Registry(seeded)
    entry = reg.get("tester")
    assert main(["--root", str(seeded), "remove", "tester"]) == 0
    assert reg.get("tester") is None
    assert (seeded / "users" / entry.dir).is_dir()  # 默认保留数据
    reg.claim("tester")
    assert main(["--root", str(seeded), "remove", "tester", "--purge"]) == 0
    assert not (seeded / "users" / dir_for("tester")).exists()


def test_remove_missing(seeded, capsys):
    assert main(["--root", str(seeded), "remove", "nobody"]) == 0
    assert "无此用户" in capsys.readouterr().out

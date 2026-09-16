# tests/test_deps.py
"""deps 契约：base_dir 缺省锚 home + env 覆盖 + run_id 校验。"""

from __future__ import annotations

from pathlib import Path

import pytest

from server.deps import get_base_dir, validate_run_id
from fastapi import HTTPException


def test_base_dir_defaults_to_home(monkeypatch):
    """env 未设时缺省用户主目录——数据根统一 ~/.specmodule，不随启动 cwd 漂移。"""
    monkeypatch.delenv("SPECMODULE_BASE", raising=False)
    assert get_base_dir() == Path.home().resolve()


def test_base_dir_env_override(monkeypatch, tmp_path):
    """SPECMODULE_BASE 显式覆盖优先（测试隔离 / 多运行根）。"""
    monkeypatch.setenv("SPECMODULE_BASE", str(tmp_path))
    assert get_base_dir() == tmp_path.resolve()


@pytest.mark.parametrize("bad", ["../escape", "a/b", "a\\b", "", "a b"])
def test_validate_run_id_rejects_unsafe(bad):
    with pytest.raises(HTTPException) as ei:
        validate_run_id(bad)
    assert ei.value.status_code == 400


@pytest.mark.parametrize("ok", ["mod_1234abcd", "academic_writer_c56739", "run.1", "x-y_z"])
def test_validate_run_id_accepts_safe(ok):
    assert validate_run_id(ok) == ok

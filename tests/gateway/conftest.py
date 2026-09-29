"""网关测试夹具：tmp 部署根。"""
from __future__ import annotations

import pytest


@pytest.fixture
def gw_root(tmp_path):
    root = tmp_path / "deploy"
    root.mkdir()
    return root

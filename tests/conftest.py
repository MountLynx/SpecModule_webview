# tests/conftest.py
"""fixture run 构造（隔离模式：只写 tmp_path，绝不触碰真实 ~/.specmodule）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

HERE = Path(__file__).parent
TEST_MODULES = HERE / "modules"

MINI_TASKLIST: dict[str, Any] = {
    "Tasks": {
        "A": {"type": "script", "script": "A"},
        "B": {"type": "script", "script": "B", "inputs": {"value": "A"}},
        "C": {"type": "script", "script": "C"},
    },
    "Flow": "[A] --> B\nA --|pick_c|--> C",
}


def seed_run(
    base: Path,
    run_id: str,
    *,
    firings: list[dict] | None = None,
    snapshots: dict[int, dict] | None = None,
    status: dict | None = None,
    inputs: dict | None = None,
) -> Path:
    """造最小 fixture run：run.sqlite（firings/snapshots/module_inputs）+ status.json。"""
    from module_harness.infra.checkpoint import ModuleInputStore
    from tickflow.persistence import SqliteBackend
    from tickflow.state import NodeState

    run_dir = base / ".specmodule" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    backend = SqliteBackend(run_dir / "run.sqlite")
    for f in firings or []:
        backend.save_firing(run_id, NodeState(**f))
    for tick, snap in (snapshots or {}).items():
        backend.save_snapshot(run_id, tick, snap)
    backend.close()
    if inputs is not None:
        st = ModuleInputStore(run_id, base)
        st.save_module_inputs(inputs["spec"], inputs["tasklist"])
        st.close()
    if status is not None:
        (run_dir / "status.json").write_text(
            json.dumps(status, ensure_ascii=False), encoding="utf-8"
        )
    return run_dir


@pytest.fixture()
def base(tmp_path, monkeypatch):
    monkeypatch.setenv("SPECMODULE_BASE", str(tmp_path))
    monkeypatch.setenv("SPECMODULE_PATH", str(TEST_MODULES))
    # store 发现不再读真实 ~/.specmodule
    monkeypatch.setenv("SPECMODULE_HOME", str(tmp_path / "home"))
    return tmp_path


@pytest.fixture()
def base_no_search_env(tmp_path, monkeypatch):
    """SPECMODULE_PATH 清空的隔离环境：模块发现只可能锚定 base_dir/modules。"""
    monkeypatch.setenv("SPECMODULE_BASE", str(tmp_path))
    monkeypatch.delenv("SPECMODULE_PATH", raising=False)
    monkeypatch.setenv("SPECMODULE_HOME", str(tmp_path / "home"))
    return tmp_path


@pytest.fixture()
def client(base):
    from server.app import app

    return TestClient(app)

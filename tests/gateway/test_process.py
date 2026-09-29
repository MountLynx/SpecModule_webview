"""BackendManager：env 三件套 / 懒启动与自愈 / 就绪超时 / 进程组终止。

不 spawn 真子进程——_spawn 打桩（镜像 runservice 的测试缝隙），真 spawn 端到端
在 test_integration.py 单独覆盖。
"""

from __future__ import annotations

import os

import pytest

from server.gateway.identity import Registry
from server.gateway.process import BackendManager, BackendStartupError, backend_env


class FakePopen:
    def __init__(self, alive: bool = True):
        self.pid = 424242
        self._alive = alive
        self.terminated = False

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.terminated = True
        self._alive = False


@pytest.fixture
def entry(gw_root):
    return Registry(gw_root).claim("tester")[0]


def test_backend_env_three_keys(gw_root, tmp_path):
    user_dir = tmp_path / "users" / "abc"
    env = backend_env(gw_root, user_dir)
    assert env["SPECMODULE_BASE"] == str(user_dir)
    assert env["SPECMODULE_HOME"] == str(user_dir / ".specmodule")
    # 搜索序：用户 store modules 在前、共享在后
    parts = env["SPECMODULE_PATH"].split(os.pathsep)
    assert parts[0] == str(user_dir / ".specmodule" / "modules")
    assert parts[1] == str(gw_root / "shared" / "modules")


class TestEnsureRunning:
    def test_spawns_and_reuses(self, gw_root, entry, monkeypatch):
        mgr = BackendManager(gw_root)
        spawns: list[int] = []

        def fake_spawn(e, user_dir, log_fh):
            spawns.append(e.port)
            return FakePopen(alive=True)

        monkeypatch.setattr(mgr, "_spawn", fake_spawn)
        monkeypatch.setattr("server.gateway.process._probe", lambda port: True)
        user_dir = gw_root / "users" / entry.dir
        assert mgr.ensure_running(entry, user_dir) == entry.port
        assert mgr.ensure_running(entry, user_dir) == entry.port
        assert spawns == [entry.port]  # 第二次复用活进程

    def test_restarts_when_dead(self, gw_root, entry, monkeypatch):
        mgr = BackendManager(gw_root)
        procs = [FakePopen(alive=False), FakePopen(alive=True)]

        def fake_spawn(e, user_dir, log_fh):
            return procs.pop(0)

        monkeypatch.setattr(mgr, "_spawn", fake_spawn)
        monkeypatch.setattr("server.gateway.process._probe", lambda port: True)
        user_dir = gw_root / "users" / entry.dir
        mgr.ensure_running(entry, user_dir)
        mgr.ensure_running(entry, user_dir)  # 死进程 → 重新 spawn（崩溃自愈）
        assert not procs  # 两个都被消费

    def test_ready_timeout_raises(self, gw_root, entry, monkeypatch):
        mgr = BackendManager(gw_root)
        monkeypatch.setattr(mgr, "_spawn", lambda e, d, f: FakePopen(alive=True))
        monkeypatch.setattr("server.gateway.process._probe", lambda port: False)
        monkeypatch.setattr("server.gateway.process._READY_TIMEOUT", 0.5)
        with pytest.raises(BackendStartupError):
            mgr.ensure_running(entry, gw_root / "users" / entry.dir)


class TestShutdown:
    def test_shutdown_all_terminates(self, gw_root, entry, monkeypatch):
        mgr = BackendManager(gw_root)
        proc = FakePopen(alive=True)
        monkeypatch.setattr(mgr, "_spawn", lambda e, d, f: proc)
        monkeypatch.setattr("server.gateway.process._probe", lambda port: True)
        mgr.ensure_running(entry, gw_root / "users" / entry.dir)
        mgr.shutdown_all()
        assert proc.terminated

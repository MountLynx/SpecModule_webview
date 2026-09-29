"""每用户后端进程管理：懒启动 + 就绪探测 + 崩溃自愈 + 进程组终止。

后端 = 现有 server.app:app 原封不动，仅 env 三件套不同
（SPECMODULE_BASE / SPECMODULE_HOME / SPECMODULE_PATH）——隔离随 OS 进程成立。
--workers 1 硬编码：进程内注册表/锁语义依赖单进程（spec §并发收口 #1）。
_spawn 是测试打桩点（镜像 runservice 惯例）；真 spawn 端到端由 test_integration 覆盖。
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

from server.gateway.identity import UserEntry

_READY_TIMEOUT = 15.0
_PROBE_INTERVAL = 0.3


class BackendStartupError(Exception):
    """后端就绪探测超时（端点映射 502）。"""


def backend_env(root: Path, user_dir: Path) -> dict:
    """子进程 env：现进程 env + 用户三件套（模块搜索序：用户 store 在前、共享在后）。"""
    env = dict(os.environ)
    env["SPECMODULE_BASE"] = str(user_dir)
    env["SPECMODULE_HOME"] = str(user_dir / ".specmodule")
    env["SPECMODULE_PATH"] = os.pathsep.join([
        str(user_dir / ".specmodule" / "modules"),
        str(root / "shared" / "modules"),
    ])
    return env


def _probe(port: int) -> bool:
    """就绪探针：GET /healthz。trust_env=False——loopback 探测不走系统/环境代理。"""
    try:
        r = httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=1.0, trust_env=False)
        return r.status_code == 200 and r.json() == {"ok": True}
    except httpx.HTTPError:
        return False


class BackendManager:
    """run_id 单写者语义随每用户进程天然成立；manager 只管进程生命周期。"""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._procs: dict[str, subprocess.Popen] = {}
        self._mu = threading.Lock()  # 只护 _locks 字典本身
        self._locks: dict[str, threading.Lock] = {}

    def _user_lock(self, name: str) -> threading.Lock:
        """每用户一把串行锁：check-and-spawn 原子（同用户并发首启只 spawn 一次，
        不会双 spawn 撞端口）；跨用户互不阻塞（to_thread 下并行启动）。"""
        with self._mu:
            if name not in self._locks:
                self._locks[name] = threading.Lock()
            return self._locks[name]

    def ensure_running(self, entry: UserEntry, user_dir: Path) -> int:
        """活着直接返回端口；死了/未启 → spawn + 就绪探测（崩溃自愈的实体）。"""
        with self._user_lock(entry.name):
            proc = self._procs.get(entry.name)
            if proc is not None and proc.poll() is None:
                return entry.port
            log_path = user_dir / "backend.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_fh = log_path.open("ab")
            try:
                popen = self._spawn(entry, user_dir, log_fh)
            finally:
                log_fh.close()  # 子进程持继承句柄继续写，父进程这份即关
            self._procs[entry.name] = popen
            self._wait_ready(entry.port)
            return entry.port

    def _spawn(self, entry: UserEntry, user_dir: Path, log_fh) -> subprocess.Popen:
        """spawn 每用户后端（测试 monkeypatch 点）。进程组化便于组终止。"""
        argv = [sys.executable, "-m", "uvicorn", "server.app:app",
                "--host", "127.0.0.1", "--port", str(entry.port), "--workers", "1"]
        kwargs: dict = dict(env=backend_env(self.root, user_dir),
                            stdout=log_fh, stderr=subprocess.STDOUT,
                            cwd=str(self.root))
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        return subprocess.Popen(argv, **kwargs)

    def _wait_ready(self, port: int) -> None:
        deadline = time.monotonic() + _READY_TIMEOUT
        while time.monotonic() < deadline:
            if _probe(port):
                return
            time.sleep(_PROBE_INTERVAL)
        raise BackendStartupError(f"后端（端口 {port}）就绪探测超时 {_READY_TIMEOUT}s")

    def shutdown_all(self) -> None:
        """进程组终止（后端 + 其 run 子进程一起走）；Windows 开发机降级 terminate()。

        status 残留 running 由既有「停滞提示 → 强制恢复」语义兜底（spec §关闭语义）。
        """
        for proc in self._procs.values():
            if proc.poll() is not None:
                continue
            try:
                if os.name == "nt":
                    proc.terminate()
                else:
                    os.killpg(proc.pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass

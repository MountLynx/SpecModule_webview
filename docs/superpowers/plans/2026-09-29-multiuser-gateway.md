# 多用户隔离网关实施计划（每用户进程 + 用户名认领）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 边缘网关（认领 + 反代 + 静态托管）+ 每用户一个原封不动的现有后端进程，实现公网参赛部署下的评委数据隔离与生产并发收口。

**Architecture:** 网关按 Cookie 身份在服务端路由到 `127.0.0.1:<port>` 的每用户后端（现有 `server.app:app` 仅 env 不同）；隔离边界 = OS 进程；认证原语 = 用户名认领（无密码，令牌绑定首台浏览器）。Spec：`docs/superpowers/specs/2026-09-29-multiuser-gateway-design.md`。

**Tech Stack:** FastAPI/Starlette + itsdangerous（签名 Cookie）+ httpx（流式反代）+ websockets（WS 桥，uvicorn[standard] 已带 16.0）+ filelock（treechat 跨进程锁）。

**分支：** `feat/multiuser-gateway`（已建，spec 已提交）。

**对 spec 的偏差记录（实施时对齐）：**
- spec 数据布局写 `shared/components/`；实施改为 `shared/library/`——播种源直接用 store 语义（`SPECMODULE_HOME=<root>/shared` 安装共享组件时组件落 `library/`），Task 1 顺带改 spec 一行。

---

## 文件结构

```
server/gateway/
├── __init__.py        # 空
├── identity.py        # 名字规范化 + registry.json + 认领令牌（无密码）
├── process.py         # BackendManager：懒 spawn 后端 + 就绪探测 + 崩溃自愈 + 进程组终止
├── proxy.py           # httpx 流式反代（SSE）+ websockets WS 双向桥
├── app.py             # 网关组装：认领页 + 会话门 + 静态托管 + 路由分发
├── __main__.py        # python -m server.gateway 启动
└── cli.py             # list / remove
server/app.py          # + GET /healthz（现有代码唯一改动）
treechat/core/store.py # + filelock（issue #16）
treechat/webapp/app.py # + 会话删除时清理锁文件
pyproject.toml         # itsdangerous/filelock 入列；httpx dev → 正式
deploy/README.md       # 部署文档
tests/gateway/         # __init__.py + conftest.py + test_identity/process/proxy/app/integration.py
tests/treechat/test_store_cross_process.py
```

**既有事实（写代码前已知，勿重查）：** `websockets==16.0` 已在 venv；`httpx==0.28.1` 现为 dev 依赖；`tests/` 是包（有 `__init__.py`）；`treechat/core/events.py` 有 `UserMsg(parent, text)`；会话删除在 `treechat/webapp/app.py:228` 附近 `path.unlink()`；测试夹具 `base`/`client`/`seed_run` 在 `tests/conftest.py`。

---

### Task 1: 依赖入列 + `/healthz` + spec 对齐

**Files:**
- Modify: `pyproject.toml`（dependencies、dev 组）
- Modify: `server/app.py`（加 /healthz）
- Modify: `docs/superpowers/specs/2026-09-29-multiuser-gateway-design.md`（shared/components → shared/library）
- Test: `tests/test_healthz.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_healthz.py
"""GET /healthz：每用户后端就绪探针契约（网关 spawn 后轮询此端点）。"""

from __future__ import annotations


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_healthz.py -q`
Expected: FAIL（404 Not Found）

- [ ] **Step 3: 改 pyproject 依赖 + 实现 /healthz + 改 spec**

`pyproject.toml` dependencies 行改为：

```toml
dependencies = ["specmodule", "fastapi>=0.110", "uvicorn[standard]>=0.29", "pillow>=10", "openai>=1", "python-pptx>=1", "itsdangerous>=2.1", "filelock>=3.13", "httpx>=0.27"]
```

dev 组删除 `"httpx>=0.27",` 一行（已是正式依赖，保留 pytest/pytest-asyncio/jsonschema）。

`server/app.py` 在 `flatten_http_exception` 之后加：

```python
@app.get("/healthz")
def healthz() -> dict:
    """就绪探针：网关每用户后端 spawn 后轮询此端点等就绪。"""
    return {"ok": True}
```

spec 文件把两处 `shared/components` 改为 `shared/library`（目录树与「播种」段），并在「对 spec 的偏差记录」注记一行：`shared/library 对齐 store 语义（SPECMODULE_HOME=<root>/shared 安装时组件落 library/）`。

- [ ] **Step 4: 同步依赖并跑测试通过**

Run: `uv sync && uv run pytest tests/test_healthz.py -q`
Expected: PASS（1 passed）；`uv.lock` 出现 itsdangerous/filelock、httpx 移入主依赖

- [ ] **Step 5: 全量回归（确认无破坏）**

Run: `uv run pytest tests/ -q`
Expected: 全绿（基线约 133+ 例 + 新增 1 例）

- [ ] **Step 6: 提交**

```bash
git add pyproject.toml uv.lock server/app.py tests/test_healthz.py docs/superpowers/specs/2026-09-29-multiuser-gateway-design.md
git commit -m "feat(server): /healthz 就绪探针 + 网关依赖入列（itsdangerous/filelock，httpx 转正式）"
```

---

### Task 2: identity.py——规范化 + registry + 认领

**Files:**
- Create: `server/gateway/__init__.py`（空文件）、`server/gateway/identity.py`
- Test: `tests/gateway/__init__.py`（空）、`tests/gateway/conftest.py`、`tests/gateway/test_identity.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/gateway/conftest.py
"""网关测试夹具：tmp 部署根。"""
from __future__ import annotations

import pytest


@pytest.fixture
def gw_root(tmp_path):
    root = tmp_path / "deploy"
    root.mkdir()
    return root
```

```python
# tests/gateway/test_identity.py
"""认领身份层：规范化 / registry 读写 / 令牌认领与找回 / 移除。"""

from __future__ import annotations

import json

import pytest

from server.gateway.identity import (
    InvalidNameError,
    NameTakenError,
    Registry,
    dir_for,
    normalize_name,
    token_matches,
)


class TestNormalize:
    def test_cjk_and_case(self):
        assert normalize_name("  评委甲 ") == "评委甲"
        assert normalize_name("Alice") == "alice"

    def test_rejects(self):
        for bad in ["", "a", "x" * 33, "有 空格", "a/b", None if False else ".."]:
            with pytest.raises(InvalidNameError):
                normalize_name(bad)


def test_dir_hash_stable_and_short():
    assert dir_for("评委甲") == dir_for("评委甲")
    assert len(dir_for("评委甲")) == 16
    assert "/" not in dir_for("评委甲") and "\\" not in dir_for("评委甲")


class TestClaim:
    def test_new_allocates_port_and_dirs(self, gw_root):
        reg = Registry(gw_root, port_base=8101)
        entry, token = reg.claim(normalize_name("评委甲"))
        assert entry.port == 8101
        assert entry.dir == dir_for("评委甲")
        assert len(token) >= 32
        assert (gw_root / "users" / entry.dir / ".specmodule" / "runs").is_dir()
        assert token_matches(entry, token) and not token_matches(entry, "wrong")

    def test_port_increments(self, gw_root):
        reg = Registry(gw_root)
        e1, _ = reg.claim("a1")
        e2, _ = reg.claim("b2")
        assert (e1.port, e2.port) == (8101, 8102)

    def test_recover_with_matching_token(self, gw_root):
        reg = Registry(gw_root)
        e1, token = reg.claim("tester")
        e2, token2 = reg.claim("tester", token)
        assert (e2.dir, e2.port, token2) == (e1.dir, e1.port, token)

    def test_name_taken_on_mismatch_or_absent(self, gw_root):
        reg = Registry(gw_root)
        reg.claim("tester")
        with pytest.raises(NameTakenError):
            reg.claim("tester")
        with pytest.raises(NameTakenError):
            reg.claim("tester", "wrong-token")

    def test_display_keeps_raw(self, gw_root):
        reg = Registry(gw_root)
        entry, _ = reg.claim("tester", display="Tester 甲")
        assert entry.name == "tester" and entry.display == "Tester 甲"


class TestPersistence:
    def test_survives_new_instance(self, gw_root):
        reg = Registry(gw_root)
        e1, token = reg.claim("persist")
        reg2 = Registry(gw_root)
        e2 = reg2.get("persist")
        assert e2 is not None and e2.dir == e1.dir
        assert token_matches(e2, token)
        data = json.loads((gw_root / "registry.json").read_text(encoding="utf-8"))
        assert "token" not in json.dumps(data)  # 明文令牌不落盘

    def test_provision_seeds_shared_library(self, gw_root):
        shared = gw_root / "shared" / "library"
        shared.mkdir(parents=True)
        (shared / "h.json").write_text("{}", encoding="utf-8")
        reg = Registry(gw_root)
        entry, _ = reg.claim("seeder")
        assert (gw_root / "users" / entry.dir / ".specmodule" / "library" / "h.json").is_file()


class TestRemove:
    def test_remove_keeps_data_by_default(self, gw_root):
        reg = Registry(gw_root)
        entry, _ = reg.claim("gone")
        assert reg.remove("gone") is True
        assert reg.get("gone") is None
        assert (gw_root / "users" / entry.dir).is_dir()

    def test_purge_removes_data(self, gw_root):
        reg = Registry(gw_root)
        entry, _ = reg.claim("gone")
        assert reg.remove("gone", purge=True) is True
        assert not (gw_root / "users" / entry.dir).exists()

    def test_remove_missing(self, gw_root):
        assert Registry(gw_root).remove("nobody") is False
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/gateway/test_identity.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'server.gateway'`）

- [ ] **Step 3: 实现 identity.py**

```python
# server/gateway/__init__.py
"""边缘网关：认领身份 + 每用户后端进程管理 + 反代（spec: 2026-09-29-multiuser-gateway-design）。"""
```

```python
# server/gateway/identity.py
"""认领身份层：名字规范化 + registry.json 读写 + 认领令牌（无密码）。

登记动态生长（首次认领建档）：{规范化名: {display, token_sha256, port, dir, created_at}}；
端口 port_base 起递增、登记时定死；用户目录名 = sha256("wv-dir:"+名)[:16]（中文名路径安全）。
令牌只存 SHA-256，明文只在认领响应里回给浏览器一次；认领绑定「名字 + 首台浏览器」，
同名异机令牌不匹配 → NameTakenError（evaluator 换名重开即可，spec §风险）。
registry 写入原子（tmp + os.replace）；关键段是微秒级文件改写，threading.Lock 足够
（同时覆盖事件循环与线程池两侧，无需 asyncio.Lock）。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

NAME_RE = re.compile(r"^[\w][\w.-]{1,31}$", re.UNICODE)
COOKIE_NAME = "wv_session"
TOKEN_TTL = 30 * 24 * 3600  # 30d，覆盖赛期全程


class NameTakenError(Exception):
    """名字已被认领且令牌不匹配（同名异机）。"""


class InvalidNameError(Exception):
    """名字不满足规范化规则。"""


@dataclass
class UserEntry:
    """一个已认领用户的登记条目 + 进程锚点。"""

    name: str  # 规范化名（registry 键）
    display: str
    token_sha256: str
    port: int
    dir: str
    created_at: float

    def to_dict(self) -> dict:
        return asdict(self)


def normalize_name(raw: str) -> str:
    """小写化 + 去首尾空白；2~32 字符，\\w（含 CJK）+ 点/连字符。"""
    name = raw.strip().lower()
    if not NAME_RE.fullmatch(name):
        raise InvalidNameError("名字需为 2~32 个字符（字母/数字/下划线/点/连字符/中日韩文字）")
    return name


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dir_for(name: str) -> str:
    """用户目录名：哈希派生（中文名路径安全，同名必同目录）。"""
    return _sha256("wv-dir:" + name)[:16]


def token_matches(entry: UserEntry, token: str) -> bool:
    return hmac.compare_digest(_sha256(token), entry.token_sha256)


class Registry:
    """registry.json 读写 + 认领/移除（部署根内动态生长）。"""

    def __init__(self, root: Path, port_base: int = 8101) -> None:
        self.root = Path(root)
        self.path = self.root / "registry.json"
        self.port_base = port_base
        self._mu = threading.Lock()

    def _load(self) -> dict:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self, data: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def get(self, name: str) -> UserEntry | None:
        with self._mu:
            raw = self._load().get(name)
        return UserEntry(**raw) if raw else None

    def all(self) -> list[UserEntry]:
        with self._mu:
            data = self._load()
        return [UserEntry(**v) for v in data.values()]

    def claim(self, name: str, token: str | None = None, *,
              display: str | None = None) -> tuple[UserEntry, str]:
        """认领：无 token → 新建；token 匹配 → 找回（Cookie 过期后 localStorage 通道）；
        不匹配/缺席 → NameTakenError。返回 (entry, 明文 token)。"""
        with self._mu:
            data = self._load()
            raw = data.get(name)
            if raw is not None:
                entry = UserEntry(**raw)
                if token is not None and token_matches(entry, token):
                    return entry, token
                raise NameTakenError("该名字已被其他设备使用，请换一个名字")
            plain = secrets.token_urlsafe(32)
            ports = [u["port"] for u in data.values()]
            entry = UserEntry(
                name=name,
                display=(display or name).strip() or name,
                token_sha256=_sha256(plain),
                port=(max(ports) + 1) if ports else self.port_base,
                dir=dir_for(name),
                created_at=time.time(),
            )
            data[name] = entry.to_dict()
            self._save(data)
        self._provision(entry)
        return entry, plain

    def _provision(self, entry: UserEntry) -> None:
        """建用户数据目录树 + 共享组件播种（shared/library → 用户 store library）。"""
        user_dir = self.user_dir(entry)
        (user_dir / ".specmodule" / "runs").mkdir(parents=True, exist_ok=True)
        shared_library = self.root / "shared" / "library"
        store_library = user_dir / ".specmodule" / "library"
        if shared_library.is_dir() and not store_library.exists():
            shutil.copytree(shared_library, store_library)

    def user_dir(self, entry: UserEntry) -> Path:
        return self.root / "users" / entry.dir

    def remove(self, name: str, *, purge: bool = False) -> bool:
        """移出登记；purge 才删数据目录（破坏性动作显式）。"""
        with self._mu:
            data = self._load()
            raw = data.pop(name, None)
            if raw is None:
                return False
            self._save(data)
        if purge:
            shutil.rmtree(self.root / "users" / raw["dir"], ignore_errors=True)
        return True
```

- [ ] **Step 4: 跑测试通过**

Run: `uv run pytest tests/gateway/test_identity.py -q`
Expected: PASS（约 12 passed）

- [ ] **Step 5: 提交**

```bash
git add server/gateway/__init__.py server/gateway/identity.py tests/gateway/
git commit -m "feat(gateway): 认领身份层——名字规范化 + registry 原子读写 + 令牌认领/找回"
```

---

### Task 3: process.py——后端进程生命周期

**Files:**
- Create: `server/gateway/process.py`
- Test: `tests/gateway/test_process.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/gateway/test_process.py
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/gateway/test_process.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'server.gateway.process'`）

- [ ] **Step 3: 实现 process.py**

```python
# server/gateway/process.py
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
    """就绪探针：GET /healthz。"""
    try:
        r = httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=1.0)
        return r.status_code == 200 and r.json() == {"ok": True}
    except httpx.HTTPError:
        return False


class BackendManager:
    """run_id 单写者语义随每用户进程天然成立；manager 只管进程生命周期。"""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._procs: dict[str, subprocess.Popen] = {}

    def ensure_running(self, entry: UserEntry, user_dir: Path) -> int:
        """活着直接返回端口；死了/未启 → spawn + 就绪探测（崩溃自愈的实体）。"""
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
```

- [ ] **Step 4: 跑测试通过**

Run: `uv run pytest tests/gateway/test_process.py -q`
Expected: PASS（5 passed）

- [ ] **Step 5: 提交**

```bash
git add server/gateway/process.py tests/gateway/test_process.py
git commit -m "feat(gateway): 后端进程生命周期——env 三件套懒 spawn + 就绪探测 + 崩溃自愈 + 组终止"
```

---

### Task 4: proxy.py——流式反代 + WS 桥

**Files:**
- Create: `server/gateway/proxy.py`
- Test: `tests/gateway/test_proxy.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/gateway/test_proxy.py
"""反代层：请求转发形状 / 502 兜底 / 流式透传 / WS 双向桥与关闭传播。"""

from __future__ import annotations

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.testclient import TestClient
from starlette.websockets import WebSocket, WebSocketDisconnect
from websockets.sync.server import serve

from server.gateway.proxy import BackendProxy, _forward_headers


def _proxy(handler) -> BackendProxy:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                               base_url="http://backend")
    return BackendProxy(0, client=client)


def _starlette_app(proxy, path="/api/x"):
    async def endpoint(request):
        return await proxy.forward(request, 0)

    app = Starlette()
    app.add_route(path, endpoint, methods=["GET", "POST"])
    return app


class TestForward:
    async def _roundtrip(self, method="GET", send_body=b""):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["method"] = request.method
            captured["cookie"] = request.headers.get("cookie")
            captured["xcustom"] = request.headers.get("xcustom")
            captured["body"] = request.read()
            return httpx.Response(200, json={"ran": True}, headers={"x-up": "1"})

        proxy = _proxy(handler)
        client = TestClient(_starlette_app(proxy))
        r = client.request(method, "/api/x", content=send_body or None,
                           headers={"Cookie": "wv_session=secret", "xcustom": "1"})
        return r, captured

    def test_forwards_method_header_body_drops_cookie(self):
        r, captured = self._roundtrip(method="POST", send_body=b'{"a":1}')
        assert r.status_code == 200
        assert r.json() == {"ran": True}
        assert captured["method"] == "POST"
        assert captured["body"] == b'{"a":1}'
        assert captured["cookie"] is None  # 网关 Cookie 不透传
        assert captured["xcustom"] == "1"
        assert r.headers["x-up"] == "1"  # 上游响应头透传

    def test_backend_down_maps_502(self):
        def handler(request):
            raise httpx.ConnectError("down")

        client = TestClient(_starlette_app(_proxy(handler)))
        r = client.get("/api/x")
        assert r.status_code == 502
        assert "error" in r.json()


class TestWsBridge:
    def _echo_thread(self):
        """websockets sync echo server（独立线程，临时端口）。"""
        import threading

        holder: dict = {}
        started = threading.Event()

        def _run():
            def handler(ws):
                for msg in ws:
                    ws.send(msg)

            server = serve(handler, "127.0.0.1", 0)
            holder["port"] = server.socket.getsockname()[1]
            started.set()
            server.serve_forever()

        threading.Thread(target=_run, daemon=True).start()
        assert started.wait(5)
        return holder["port"]

    def test_bidirectional_and_close(self):
        port = self._echo_thread()
        proxy = BackendProxy(port)

        async def ws_endpoint(websocket: WebSocket):
            await proxy.bridge_ws(websocket, port)

        app = Starlette()
        app.add_websocket_route("/api/runs/r1/stream", ws_endpoint)
        client = TestClient(app)
        with client.websocket_connect("/api/runs/r1/stream") as ws:
            ws.send_text("hello")
            assert ws.receive_text() == "hello"
        # 上下文退出 = 客户端侧关闭；无死锁即关闭传播成立
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/gateway/test_proxy.py -q`
Expected: FAIL（`No module named 'server.gateway.proxy'`）

- [ ] **Step 3: 实现 proxy.py**

```python
# server/gateway/proxy.py
"""反代层：HTTP 流式透传（SSE 兼容）+ WS 双向桥。

超时纪律（spec §并发收口 #5）：connect 短、读不限（SSE/长连接）；网关 Cookie 不透传
（后端无会话语义）。WS 桥 = websockets 双向泵 + 关闭传播；后端关闭/客户端断开
任一侧结束即收束整体。
"""
from __future__ import annotations

import asyncio

import httpx
import websockets.asyncio.client
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

_HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "upgrade",
               "proxy-authenticate", "proxy-authorization", "te", "trailer"}


def _forward_headers(headers) -> dict:
    return {k: v for k, v in headers.items()
            if k.lower() not in _HOP_BY_HOP and k.lower() not in ("cookie", "host")}


def _response_headers(headers) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


class BackendProxy:
    """对单个用户后端（127.0.0.1:port）的代理；client 可注入（测试 MockTransport）。"""

    def __init__(self, port: int, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}",
            timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=30.0),
        )

    async def forward(self, request, port: int = 0) -> Response:
        """方法/路径/查询/头/体全转发；流式回传上游（SSE 逐帧不缓冲）。"""
        url = httpx.URL(path=request.url.path, query=request.url.query)
        upstream_req = self._client.build_request(
            request.method, url,
            headers=_forward_headers(request.headers),
            content=request.stream(),
        )
        try:
            resp = await self._client.send(upstream_req, stream=True)
        except httpx.HTTPError:
            return JSONResponse({"error": "后端进程不可达"}, status_code=502)
        return StreamingResponse(
            resp.aiter_raw(),
            status_code=resp.status_code,
            headers=_response_headers(resp.headers),
            background=BackgroundTask(resp.aclose),
        )

    async def bridge_ws(self, websocket: WebSocket, port: int) -> None:
        """WS 双向泵：客户端 ↔ 后端；任一侧断开即收束。"""
        await websocket.accept()
        url = f"ws://127.0.0.1:{port}{websocket.url.path}"

        async def _pump_client_to_backend(upstream) -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        return
                    data = msg.get("bytes") or msg.get("text")
                    if data is None:
                        continue
                    await upstream.send(data)
            except WebSocketDisconnect:
                return

        async def _pump_backend_to_client(upstream) -> None:
            try:
                async for msg in upstream:
                    if isinstance(msg, bytes):
                        await websocket.send_bytes(msg)
                    else:
                        await websocket.send_text(msg)
            except websockets.ConnectionClosed:
                return

        try:
            async with websockets.asyncio.client.connect(url) as upstream:
                await asyncio.gather(_pump_client_to_backend(upstream),
                                     _pump_backend_to_client(upstream))
        except (websockets.InvalidURI, websockets.InvalidHandshake, OSError):
            pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass
```

- [ ] **Step 4: 跑测试通过**

Run: `uv run pytest tests/gateway/test_proxy.py -q`
Expected: PASS（3 passed）

- [ ] **Step 5: 提交**

```bash
git add server/gateway/proxy.py tests/gateway/test_proxy.py
git commit -m "feat(gateway): 反代层——HTTP 流式透传（SSE）+ WS 双向桥与关闭传播"
```

---

### Task 5: app.py——网关组装（认领页 + 会话门 + 静态 + 路由）

**Files:**
- Create: `server/gateway/app.py`
- Test: `tests/gateway/test_app.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/gateway/test_app.py
"""网关组装：认领流 / 会话门（401 vs 307）/ 静态托管 / 反代分发。

后端管理器与反代目标打桩——不 spawn 子进程、不发真 HTTP；
真 spawn 端到端在 test_integration.py。
"""

from __future__ import annotations

import httpx
import pytest
from starlette.responses import JSONResponse
from starlette.testclient import TestClient

from server.gateway.app import build_gateway_app
from server.gateway.identity import COOKIE_NAME, Registry


class FakeManager:
    """不 spawn：直接回登记端口。"""

    def __init__(self):
        self.calls: list[str] = []

    def ensure_running(self, entry, user_dir):
        self.calls.append(entry.name)
        return entry.port

    def shutdown_all(self):
        pass


@pytest.fixture
def gateway(gw_root, monkeypatch):
    app = build_gateway_app(gw_root, static_dir=None, port_base=9101)
    state = app.state.gateway
    fake = FakeManager()
    monkeypatch.setattr(state, "manager", fake)
    # 反代目标：MockTransport 回显（证明分发到了反代层）
    def handler(request: httpx.Request) -> httpx.Response:
        return JSONResponse({"runs": [], "total": 0, "path": request.url.path})

    def proxy_for(entry):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                   base_url="http://backend")
        from server.gateway.proxy import BackendProxy
        return BackendProxy(entry.port, client=client)

    monkeypatch.setattr(state, "proxy_for", proxy_for)
    return app, state, fake


def _client(app) -> TestClient:
    return TestClient(app, follow_redirects=False)


class TestClaim:
    def test_claim_new_sets_cookie(self, gateway):
        app, state, _ = gateway
        c = _client(app)
        r = c.post("/claim", json={"name": "评委甲"})
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True and body["display"] == "评委甲"
        assert len(body["token"]) >= 32
        assert COOKIE_NAME in c.cookies

    def test_claim_rejects_bad_name(self, gateway):
        app, _, _ = gateway
        r = _client(app).post("/claim", json={"name": "x"})
        assert r.status_code == 400

    def test_claim_name_taken(self, gateway):
        app, state, _ = gateway
        c = _client(app)
        first = c.post("/claim", json={"name": "tester"}).json()
        r = c.post("/claim", json={"name": "tester"})
        assert r.status_code == 409
        # 令牌匹配 → 找回（localStorage 通道）
        r = c.post("/claim", json={"name": "tester", "token": first["token"]})
        assert r.status_code == 200

    def test_passcode_gate(self, gw_root, monkeypatch):
        monkeypatch.setenv("GATEWAY_PASSCODE", "contest2026")
        app = build_gateway_app(gw_root, static_dir=None)
        c = TestClient(app)
        assert c.post("/claim", json={"name": "tester"}).status_code == 401
        assert c.post("/claim", json={"name": "tester", "passcode": "wrong"}).status_code == 401
        assert c.post("/claim", json={"name": "tester", "passcode": "contest2026"}).status_code == 200


class TestAuthGate:
    def test_unauthed_api_401(self, gateway):
        app, _, _ = gateway
        r = _client(app).get("/api/runs")
        assert r.status_code == 401
        r = _client(app).get("/treechat/api/modes")
        assert r.status_code == 401

    def test_unauthed_page_redirects_claim(self, gateway):
        app, _, _ = gateway
        r = _client(app).get("/")
        assert r.status_code == 307
        assert r.headers["location"] == "/claim"

    def test_authed_api_proxies(self, gateway):
        app, state, fake = gateway
        c = _client(app)
        c.post("/claim", json={"name": "tester"})
        r = c.get("/api/runs")
        assert r.status_code == 200
        assert r.json() == {"runs": [], "total": 0, "path": "/api/runs"}
        assert fake.calls == ["tester"]  # ensure_running 被走过

    def test_logout_clears(self, gateway):
        app, _, _ = gateway
        c = _client(app)
        c.post("/claim", json={"name": "tester"})
        c.post("/logout")
        assert _client(app).get("/api/runs").status_code == 401  # 新会话无凭据


class TestStatic:
    def test_serves_dist_after_auth(self, gw_root):
        dist = gw_root / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("<html>spa</html>", encoding="utf-8")
        app = build_gateway_app(gw_root, static_dir=dist)
        c = TestClient(app, follow_redirects=False)
        assert c.get("/").status_code == 307  # 未认领 → 认领页
        c.post("/claim", json={"name": "tester"})
        r = c.get("/")
        assert r.status_code == 200 and "spa" in r.text
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/gateway/test_app.py -q`
Expected: FAIL（`No module named 'server.gateway.app'`）

- [ ] **Step 3: 实现 app.py**

```python
# server/gateway/app.py
"""边缘网关组装：认领页 + 会话门 + 静态托管 + 反代路由分发。

唯一认证原语是「用户名认领」（无密码）：首访输入名字即建档领令牌，浏览器
（HttpOnly Cookie + localStorage 双落）此后免登录。路由按 Cookie 身份在服务端
完成、URL 空间不变——SPA 零改动。WS 走独立端点（BaseHTTPMiddleware 不覆盖
websocket），自行读 Cookie 鉴权。
"""
from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, Request
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

from server.gateway.identity import (
    COOKIE_NAME,
    InvalidNameError,
    NameTakenError,
    Registry,
    TOKEN_TTL,
    UserEntry,
    normalize_name,
    token_matches,
)
from server.gateway.process import BackendManager, BackendStartupError
from server.gateway.proxy import BackendProxy

_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

# %PASSCODE% 占位：GATEWAY_PASSCODE 设了才注入口令输入框（网关内联页，无构建步骤）
_CLAIM_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>进入 SpecModule</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;margin:0}
.card{background:#1e293b;padding:2rem 2.5rem;border-radius:12px;min-width:320px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
h2{margin:0 0 1.25rem;font-size:1.15rem}
label{display:block;font-size:.85rem;color:#94a3b8}
input{width:100%;box-sizing:border-box;margin:.4rem 0 1rem;padding:.6rem .75rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:1rem}
input:focus{outline:2px solid #38bdf8;border-color:transparent}
button{width:100%;padding:.65rem;border:0;border-radius:8px;background:#38bdf8;color:#0f172a;font-weight:600;font-size:1rem;cursor:pointer}
button:hover{background:#7dd3fc}
.err{color:#f87171;min-height:1.2em;font-size:.85rem;margin:.25rem 0 .75rem}
</style></head>
<body><form class="card" id="f">
<h2>输入你的名字进入</h2>
<label>名字<input name="name" autofocus autocomplete="off" maxlength="32"></label>
%PASSCODE%
<p class="err" id="err"></p>
<button type="submit">进入</button>
</form>
<script>
const f = document.getElementById('f'), err = document.getElementById('err');
async function tryClaim(payload) {
  const r = await fetch('/claim', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const b = await r.json().catch(() => ({}));
  if (r.ok) {
    localStorage.setItem('wv_name', payload.name.trim());
    localStorage.setItem('wv_token', b.token);
    location.href = '/';
    return true;
  }
  err.textContent = b.error || ('进入失败 (' + r.status + ')');
  return false;
}
f.addEventListener('submit', (e) => {
  e.preventDefault();
  const payload = {name: f.elements['name'].value};
  if (f.elements['passcode']) payload.passcode = f.elements['passcode'].value;
  const n = localStorage.getItem('wv_name'), t = localStorage.getItem('wv_token');
  if (t && n && n === payload.name.trim()) payload.token = t;  // 本机找回通道
  tryClaim(payload);
});
(async () => {  // 已认领过的浏览器：自动进入
  const n = localStorage.getItem('wv_name'), t = localStorage.getItem('wv_token');
  if (n && t) await tryClaim({name: n, token: t});
})();
</script></body></html>"""


def _load_or_create_secret(root: Path) -> str:
    key_path = root / "secret_key"
    if not key_path.exists():
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_text(secrets.token_hex(32), encoding="utf-8")
    return key_path.read_text(encoding="utf-8").strip()


class GatewayState:
    """网关单例状态：registry + 进程管理器 + 签名器 + 每端口反代缓存。"""

    def __init__(self, root: Path, static_dir: Path | None = None,
                 port_base: int = 8101) -> None:
        self.root = Path(root)
        self.registry = Registry(self.root, port_base=port_base)
        self.manager = BackendManager(self.root)
        self.signer = TimestampSigner(_load_or_create_secret(self.root), salt="wv-session")
        self.passcode = os.environ.get("GATEWAY_PASSCODE", "").strip()
        self.secure_cookies = os.environ.get("GATEWAY_SECURE_COOKIES", "").lower() == "on"
        self._proxies: dict[int, BackendProxy] = {}

    def proxy_for(self, entry: UserEntry) -> BackendProxy:
        if entry.port not in self._proxies:
            self._proxies[entry.port] = BackendProxy(entry.port)
        return self._proxies[entry.port]

    def make_cookie(self, name: str, token: str) -> str:
        return self.signer.sign(f"{name}:{token}").decode()

    def read_identity(self, cookies: dict) -> UserEntry | None:
        """Cookie → (registry 校验通过的用户)；缺失/过期/令牌不符 → None。"""
        raw = cookies.get(COOKIE_NAME)
        if not raw:
            return None
        try:
            payload = self.signer.unsign(raw, max_age=TOKEN_TTL).decode()
        except (BadSignature, SignatureExpired):
            return None
        name, _, token = payload.partition(":")
        entry = self.registry.get(name)
        if entry is None or not token_matches(entry, token):
            return None
        return entry


def build_gateway_app(root: Path, static_dir: Path | None = None,
                      port_base: int = 8101) -> FastAPI:
    app = FastAPI(title="SpecModule Gateway", docs_url=None, redoc_url=None,
                  openapi_url=None)
    state = GatewayState(root, static_dir, port_base)
    app.state.gateway = state

    @app.middleware("http")
    async def auth_gate(request: Request, call_next):
        path = request.url.path
        if path in ("/claim", "/_gateway/health"):
            return await call_next(request)
        entry = state.read_identity(request.cookies)
        if entry is None:
            if path.startswith("/api") or path.startswith("/treechat"):
                return JSONResponse({"error": "未认领身份，请先输入名字"}, status_code=401)
            return RedirectResponse("/claim", status_code=307)
        request.state.entry = entry
        return await call_next(request)

    @app.get("/_gateway/health")
    def gateway_health() -> dict:
        return {"ok": True}

    @app.get("/claim")
    def claim_page() -> HTMLResponse:
        if state.passcode:
            page = _CLAIM_PAGE.replace(
                "%PASSCODE%",
                '<label>访问口令<input name="passcode" type="password" autocomplete="off"></label>')
        else:
            page = _CLAIM_PAGE.replace("%PASSCODE%", "")
        return HTMLResponse(page)

    @app.post("/claim")
    async def claim(request: Request) -> JSONResponse:
        body = await request.json()
        if state.passcode and not hmac.compare_digest(
                str(body.get("passcode", "")), state.passcode):
            return JSONResponse({"error": "访问口令不正确"}, status_code=401)
        try:
            norm = normalize_name(str(body.get("name", "")))
        except InvalidNameError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        try:
            entry, token = state.registry.claim(
                norm, body.get("token"), display=str(body.get("name", "")))
        except NameTakenError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        resp = JSONResponse({"ok": True, "display": entry.display, "token": token})
        resp.set_cookie(COOKIE_NAME, state.make_cookie(norm, token), max_age=TOKEN_TTL,
                        httponly=True, samesite="lax", secure=state.secure_cookies,
                        path="/")
        return resp

    @app.post("/logout")
    def logout() -> JSONResponse:
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE_NAME, path="/")
        return resp

    async def _forward(request: Request) -> JSONResponse | Response:
        entry: UserEntry = request.state.entry
        try:
            state.manager.ensure_running(entry, state.registry.user_dir(entry))
        except BackendStartupError as exc:
            return JSONResponse({"error": str(exc)}, status_code=502)
        return await state.proxy_for(entry).forward(request)

    @app.api_route("/api/{rest:path}", methods=_API_METHODS)
    async def proxy_api(request: Request, rest: str):
        return await _forward(request)

    @app.api_route("/treechat/{rest:path}", methods=_API_METHODS)
    async def proxy_treechat(request: Request, rest: str):
        return await _forward(request)

    @app.websocket("/api/runs/{run_id}/stream")
    async def ws_bridge(websocket: WebSocket, run_id: str) -> None:
        entry = state.read_identity(websocket.cookies)
        if entry is None:
            await websocket.close(code=4401)
            return
        try:
            port = state.manager.ensure_running(entry, state.registry.user_dir(entry))
        except BackendStartupError:
            await websocket.close(code=1011)
            return
        await state.proxy_for(entry).bridge_ws(websocket, port)

    if static_dir is not None and Path(static_dir).is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="spa")
    return app
```

- [ ] **Step 4: 跑测试通过**

Run: `uv run pytest tests/gateway/test_app.py -q`
Expected: PASS（约 10 passed）

- [ ] **Step 5: 提交**

```bash
git add server/gateway/app.py tests/gateway/test_app.py
git commit -m "feat(gateway): 网关组装——认领页 + 会话门（401/307）+ 静态托管 + 反代分发"
```

---

### Task 6: __main__.py + cli.py

**Files:**
- Create: `server/gateway/__main__.py`、`server/gateway/cli.py`
- Test: `tests/gateway/test_cli.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/gateway/test_cli.py
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/gateway/test_cli.py -q`
Expected: FAIL（`No module named 'server.gateway.cli'`）

- [ ] **Step 3: 实现 __main__.py + cli.py**

```python
# server/gateway/__main__.py
"""python -m server.gateway 启动边缘网关。

--root 部署根（缺省 ./gateway-data 或 GATEWAY_ROOT）；--static 静态目录
（缺省 web/dist 或 GATEWAY_STATIC，目录缺席则不挂——dev 走 vite 直连不受影响）；
--port-base 用户端口起点（缺省 8101 或 GATEWAY_PORT_BASE）。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from server.gateway.app import build_gateway_app


def main() -> None:
    ap = argparse.ArgumentParser(description="SpecModule 边缘网关（每用户进程 + 认领反代）")
    ap.add_argument("--root", default=os.environ.get("GATEWAY_ROOT", "gateway-data"))
    ap.add_argument("--static", default=os.environ.get("GATEWAY_STATIC", "web/dist"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--port-base", type=int,
                    default=int(os.environ.get("GATEWAY_PORT_BASE", "8101")))
    args = ap.parse_args()
    root = Path(args.root).resolve()
    static = Path(args.static).resolve()
    app = build_gateway_app(root, static_dir=static if static.is_dir() else None,
                            port_base=args.port_base)
    print(f"gateway: root={root} static={'on' if static.is_dir() else 'off'} "
          f"port={args.port} port_base={args.port_base}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
```

```python
# server/gateway/cli.py
"""网关用户登记 CLI：list / remove（无发放——登记由认领动态生长）。"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from server.gateway.identity import Registry, dir_for, normalize_name


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="SpecModule 网关用户登记")
    ap.add_argument("--root", default=os.environ.get("GATEWAY_ROOT", "gateway-data"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_rm = sub.add_parser("remove")
    p_rm.add_argument("name")
    p_rm.add_argument("--purge", action="store_true",
                      help="连同数据目录一起删除（破坏性，默认仅移出登记）")
    args = ap.parse_args(argv)
    registry = Registry(Path(args.root).resolve())
    if args.cmd == "list":
        users = sorted(registry.all(), key=lambda u: u.created_at)
        if not users:
            print("（空——尚无人认领）")
        for u in users:
            stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(u.created_at))
            print(f"{u.display}\tport={u.port}\tdir={u.dir}\t{stamp}")
        return 0
    name = normalize_name(args.name)
    if registry.remove(name, purge=args.purge):
        print(f"已移除 {name}" + ("（含数据目录）" if args.purge else "（数据目录保留，--purge 可删）"))
    else:
        print(f"无此用户: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试通过**

Run: `uv run pytest tests/gateway/test_cli.py -q`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add server/gateway/__main__.py server/gateway/cli.py tests/gateway/test_cli.py
git commit -m "feat(gateway): python -m server.gateway 启动入口 + list/remove 登记 CLI"
```

---

### Task 7: 真后端端到端集成（唯一 spawn 子进程的测试面）

**Files:**
- Test: `tests/gateway/test_integration.py`

- [ ] **Step 1: 写集成测试（无先行实现，直接验证全链路）**

```python
# tests/gateway/test_integration.py
"""端到端：真后端子进程（uvicorn spawn + /healthz 就绪）+ 认领 + 反代回环 + WS 错误帧。

唯一允许 spawn 子进程的网关测试面（port_base 9521 避让本机端口）；
env 全部落 tmp 部署根，不碰真实 ~/.specmodule。
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from server.gateway.app import build_gateway_app


@pytest.fixture
def live(gw_root):
    app = build_gateway_app(gw_root, static_dir=None, port_base=9521)
    client = TestClient(app)
    yield client
    app.state.gateway.manager.shutdown_all()


def test_claim_proxy_roundtrip(live):
    r = live.post("/claim", json={"name": "tester"})
    assert r.status_code == 200
    # 认领后 Cookie 已在 client 上——ensure_running 真拉起 uvicorn 子进程
    r = live.get("/api/runs")
    assert r.status_code == 200
    assert r.json() == {"runs": [], "total": 0}  # 后端读的是 tmp 用户根（隔离生效）
    r = live.get("/api/modules")
    assert r.status_code == 200


def test_ws_streams_backend_error_frame(live):
    live.post("/claim", json={"name": "tester"})
    # 后端 WS 语义：未知 run → {"type":"error"} + close(4404)，经桥原样中继
    with live.websocket_connect("/api/runs/nope/stream") as ws:
        frame = ws.receive_json()
        assert frame["type"] == "error"
```

- [ ] **Step 2: 跑测试通过**

Run: `uv run pytest tests/gateway/test_integration.py -q`
Expected: PASS（2 passed；首次后端 spawn 约 2-4s，就绪探测兜住）

- [ ] **Step 3: 网关全量回归**

Run: `uv run pytest tests/gateway/ -q`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add tests/gateway/test_integration.py
git commit -m "test(gateway): 真后端端到端——spawn/healthz/认领/反代回环/WS 错误帧中继"
```

---

### Task 8: treechat 会话文件锁（issue #16）

**Files:**
- Modify: `treechat/core/store.py`（SessionStore 加 FileLock）
- Modify: `treechat/webapp/app.py:228` 附近（会话删除清锁文件）
- Test: `tests/treechat/test_store_cross_process.py`

- [ ] **Step 1: 写失败测试（双子进程并发 append → seq 连续无重复）**

```python
# tests/treechat/test_store_cross_process.py
"""SessionStore 跨进程文件锁：并发 append 后 seq 连续（issue #16）。

无锁时两个进程各自 load→last=0→seq=1 必撞车（EventFormatError seq 不连续）；
filelock 串行化后 2×N 事件全量可读。
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

from treechat.core.store import SessionStore

_WRITER = textwrap.dedent("""
    import sys
    from pathlib import Path
    sys.path.insert(0, sys.argv[3])
    from treechat.core.store import SessionStore
    from treechat.core.events import UserMsg
    store = SessionStore(Path(sys.argv[1]))
    for i in range(20):
        store.append(UserMsg(parent=None, text=f"{sys.argv[2]}-{i}"))
""")


def _spawn_writer(repo: Path, path: Path, tag: str) -> subprocess.Popen:
    """子进程写手：repo 根注入 sys.path（venv 内 treechat 本可导入，显式更稳）。"""
    return subprocess.Popen([sys.executable, "-c", _WRITER, str(path), tag, str(repo)])


_REPO = Path(__file__).resolve().parents[2]


def test_concurrent_appends_stay_continuous(tmp_path):
    path = tmp_path / "s.jsonl"
    procs = [_spawn_writer(_REPO, path, tag) for tag in ("a", "b")]
    for p in procs:
        assert p.wait(timeout=30) == 0
    store = SessionStore(path)
    events = store.load()
    assert [seq for seq, _ in events] == list(range(1, 41))  # 连续 1..40，无重复无撕裂
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/treechat/test_store_cross_process.py -q`
Expected: FAIL（大概率 `EventFormatError: seq 不连续`——正是 issue #16 描述的互踩）

- [ ] **Step 3: 实现——SessionStore 加锁 + 删除清锁文件**

`treechat/core/store.py`：头部加 `from filelock import FileLock`；`SessionStore.__init__` 加一行 `self._lock = FileLock(str(self.path) + ".lock")`；`load()` 与 `append()` 方法体整体包进 `with self._lock:`（`append` 内部 `self.load()` 为同实例嵌套，filelock 可重入，安全）。类 docstring 「V1 单进程，无文件锁」改为「跨进程写经文件锁串行（issue #16：CLI 与 webapp 互踩）」。

`treechat/webapp/app.py` 删除会话处（`path.unlink()` 之后一行）加：

```python
            Path(str(path) + ".lock").unlink(missing_ok=True)  # 锁文件随会话清理
```

- [ ] **Step 4: 跑测试通过 + treechat 全量回归**

Run: `uv run pytest tests/treechat/test_store_cross_process.py -q && uv run pytest tests/treechat/ -q`
Expected: PASS（新 1 例 + treechat 133 例全绿）

- [ ] **Step 5: 提交并关 issue**

```bash
git add treechat/core/store.py treechat/webapp/app.py tests/treechat/test_store_cross_process.py
git commit -m "fix(treechat): SessionStore 跨进程文件锁——CLI 与 webapp 同会话互踩收口（close #16）"
```

---

### Task 9: 部署文档 + 全量验收

**Files:**
- Create: `deploy/README.md`

- [ ] **Step 1: 写部署文档**

````markdown
# 部署（参赛：公网阿里云 · 月级寿命）

## 形态

```
评委浏览器 → IP:PORT（或 nginx TLS） → 边缘网关（本文件） → 每用户一个后端进程（127.0.0.1:8101+）
```

## 步骤

```bash
# 0. 机器：uv sync（依赖含 itsdangerous/filelock/httpx）
# 1. 前端构建
cd web && npm install && npm run build && cd ..
# 2. 准备共享演示模块（SPECMODULE_HOME 锚到 <root>/shared 安装，组件落 shared/library）
SPECMODULE_HOME=/opt/specmodule-webview/shared uv run python -m module_harness.cli install <pack>
#    （或直接把模块目录拷进 shared/modules）
# 3. 启动网关（systemd 常驻见下）
uv run python -m server.gateway --root /opt/specmodule-webview --static web/dist --port 8000
```

评委侧：浏览器开 `http://<服务器IP>:8000` → 输入名字 → 进入（此后该浏览器免登录）。

## systemd 单元样例

```ini
[Unit]
Description=SpecModule Gateway
After=network.target

[Service]
WorkingDirectory=/opt/specmodule-webview
ExecStart=/opt/specmodule-webview/.venv/bin/python -m server.gateway --root /opt/specmodule-webview --static web/dist --port 8000
Restart=always
Environment=GATEWAY_SECURE_COOKIES=off
# 可选全站口令：Environment=GATEWAY_PASSCODE=***

[Install]
WantedBy=multi-user.target
```

## 可选 nginx TLS（有域名/证书时）

```nginx
server {
    listen 443 ssl;
    server_name <域名>;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WS
        proxy_set_header Connection "upgrade";
        proxy_buffering off;                          # SSE
        proxy_read_timeout 3600s;
    }
}
```
TLS 部署时 systemd 里加 `Environment=GATEWAY_SECURE_COOKIES=on`。

## 运维语义（诚实清单）

- **单 worker 约束**：每用户后端 `--workers 1` 由网关硬编码，勿改——注册表/锁语义依赖单进程。
- **网关/后端重启**：在跑的 run 进程随组终止，status 残留 `running` → UI 停滞提示 → 强制恢复；产物全落盘，重启不丢数据。
- **后端崩溃**：下次请求自动拉起（就绪探测 15s），评委 F5 一次即恢复。
- **用户管理**：`uv run python -m server.gateway.cli --root <root> list` / `remove <名> [--purge]`（无发放——登记由认领动态生长）。
- **令牌不可找回**：评委清 localStorage 且 Cookie 过期 → 该空间失联，换名字重开（月级场景可接受）。
- **内存**：每用户后端约 150-250MB，10 评委满载 ≈ 2.5GB。
````

- [ ] **Step 2: 全量验收（本仓库 + 库基线 + 前端构建）**

Run: `uv run pytest tests/ -q`
Expected: 全绿（基线 + 网关新增约 35 例）

Run: `uv run pytest ../SpecModule/module_harness/tests/ -q -m "not smoke"`
Expected: 库基线全绿

Run: `cd web && npm run build`
Expected: tsc + vite 通过（前端零改动，构建产物存在）

- [ ] **Step 3: 提交**

```bash
git add deploy/README.md
git commit -m "docs(deploy): 参赛部署手册——网关启动/systemd/nginx TLS/运维语义清单"
```

---

## 自审记录（写计划时已核）

1. **Spec 覆盖**：认证（Task 2/5）、进程生命周期（Task 3/7）、并发收口 #1-#7（Task 3 `--workers 1`、Task 8 文件锁、Task 4 超时/桥、Task 2 认领锁）、静态/SPA 零改动（Task 5/9）、部署（Task 9）——无缺口。
2. **占位符扫描**：无 TBD/TODO；Task 6 与 Task 8 测试代码为最终形态（草稿残句已在落盘时修正）。
3. **类型一致性**：`Registry.claim(name, token=None, *, display=None) -> (UserEntry, str)`（Task 2 定义，Task 5/6 消费）；`BackendManager.ensure_running(entry, user_dir) -> int`（Task 3 定义，Task 5/7 消费）；`BackendProxy(port, client=None).forward(request) / .bridge_ws(websocket, port)`（Task 4 定义，Task 5 消费）；`token_matches(entry, token)`（Task 2 定义，Task 5 消费）——一致。

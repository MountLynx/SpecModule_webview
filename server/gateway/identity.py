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

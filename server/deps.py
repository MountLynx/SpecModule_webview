# server/deps.py
"""共享依赖：base_dir 解析（env SPECMODULE_BASE，缺省 cwd）+ run_id 校验。

base_dir 每次请求现读 env（测试可 monkeypatch）；run_id 作为路径段使用，
必须拒绝穿越与分隔符（Module 缺省 mod_<hex> / SubModule <name>_<hex> /
CLI 自定义均落在白名单字符内）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import HTTPException

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")


def get_base_dir() -> Path:
    """运行根目录：env SPECMODULE_BASE，缺省 cwd（服务器进程 cwd ≠ 运行根）。"""
    return Path(os.environ.get("SPECMODULE_BASE") or ".").resolve()


def is_valid_run_id(run_id: str) -> bool:
    return bool(_RUN_ID_RE.fullmatch(run_id)) and ".." not in run_id


def validate_run_id(run_id: str) -> str:
    if not is_valid_run_id(run_id):
        raise HTTPException(status_code=400, detail={"error": f"非法 run_id: {run_id!r}"})
    return run_id

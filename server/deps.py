# server/deps.py
"""共享依赖：base_dir/模块搜索路径解析（env SPECMODULE_BASE，缺省用户主目录）+ run_id 校验。

base_dir 每次请求现读 env（测试可 monkeypatch）；模块搜索路径随 base_dir 派生
（`store.search_paths(base_dir)`，同进程边界纪律——server 模块视图 ≡ spawn 子进程
CLI 视图）；run_id 作为路径段使用，必须拒绝穿越与分隔符（Module 缺省 mod_<hex> /
SubModule <name>_<hex> / CLI 自定义均落在白名单字符内）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import HTTPException

from module_harness import store

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")


def get_base_dir() -> Path:
    """运行根目录：env SPECMODULE_BASE，缺省用户主目录（数据根统一 ~/.specmodule）。

    缺省锚 home 而非 cwd：cwd 随启动目录漂移，会把运行记录散落进各仓库目录
    （曾在 ../SpecModule 积累 5109 条测试 run——2026-09-16 根修）；home 锚定后
    runs（~/.specmodule/runs）与模块 store 同根，本地启动无需再设 env。
    SPECMODULE_BASE 仍可覆盖（测试隔离 / 多运行根）。
    """
    return Path(os.environ.get("SPECMODULE_BASE") or Path.home()).resolve()


def get_search_paths(base_dir: Path | None = None) -> list[Path]:
    """模块搜索路径：随 base_dir 派生（store.search_paths），与 base_dir 同一纪律。

    所有模块枚举/解析调用必须显式传 search=——库的多来源发现默认锚 cwd，而
    server 进程 cwd ≠ 运行根；显式锚定后 server 视图与 spawn 子进程
    （cwd=SPECMODULE_BASE）视图一致。
    """
    return store.search_paths(base_dir if base_dir is not None else get_base_dir())


def is_valid_run_id(run_id: str) -> bool:
    return bool(_RUN_ID_RE.fullmatch(run_id)) and ".." not in run_id


def validate_run_id(run_id: str) -> str:
    if not is_valid_run_id(run_id):
        raise HTTPException(status_code=400, detail={"error": f"非法 run_id: {run_id!r}"})
    return run_id

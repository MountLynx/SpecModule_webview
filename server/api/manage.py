# server/api/manage.py
"""管理面端点：模块枚举 + 模块详情（store.list_modules / resolve_module_full 薄映射）。

搜索路径显式锚定 base_dir（deps.get_search_paths）——server 模块视图
≡ spawn 子进程 CLI 视图；载荷附 search_paths（实际扫描目录）供 UI 透出
「扫描来源」排查「为什么看不到我的模块」。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from module_harness import store
from server.deps import get_base_dir, get_search_paths

router = APIRouter(prefix="/api")


@router.get("/modules")
def list_modules(
    search: list[Path] = Depends(get_search_paths),
    base_dir: Path = Depends(get_base_dir),
) -> dict:
    """模块列表：store.list_modules（显式 search）+ search_paths 载荷附出口。"""
    out = []
    for _name, sources in store.list_modules(search=search).items():
        for s in sources:
            out.append({
                "name": s.name,
                "kind": s.kind,
                "version": s.version,
                "description": s.description,
                "path": str(s.path),
            })
    out.sort(key=lambda m: (m["name"], m["kind"]))
    return {"modules": out, "search_paths": [str(p) for p in search]}


@router.get("/modules/{name}")
def module_detail(name: str, search: list[Path] = Depends(get_search_paths)) -> dict:
    """模块详情：store.resolve_module_full + detail_to_dict（加载归一层薄映射）。

    未找到 → 404；packed 加载失败/entry 入口解析失败（ValueError）→ 400 带 str(e)。
    """
    try:
        resolved = store.resolve_module_full(name, search=search)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e), "module": name})
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail={"error": f"模块 '{name}' 未找到", "module": name},
        )
    return store.detail_to_dict(resolved)

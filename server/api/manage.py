# server/api/manage.py
"""管理面端点：模块枚举（store.list_modules 薄映射）。"""

from __future__ import annotations

from fastapi import APIRouter

from module_harness import store

router = APIRouter(prefix="/api")


@router.get("/modules")
def list_modules() -> dict:
    out = []
    for _name, sources in store.list_modules().items():
        for s in sources:
            out.append({
                "name": s.name,
                "kind": s.kind,
                "version": s.version,
                "description": s.description,
                "path": str(s.path),
            })
    out.sort(key=lambda m: (m["name"], m["kind"]))
    return {"modules": out}

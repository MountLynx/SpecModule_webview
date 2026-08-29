# server/api/runs.py
"""运行时读端点：薄映射 module_harness 查询层（只 import 不实现）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from module_harness.status import query_run_status
from server.deps import get_base_dir, validate_run_id

router = APIRouter(prefix="/api/runs")


def not_found(run_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"error": "无运行记录", "run_id": run_id})


@router.get("")
def list_runs(base_dir: Path = Depends(get_base_dir)) -> dict:
    """运行列表：扫描 runs/ 目录 + query_run_status 摘要（updated_at 降序）。"""
    runs_root = base_dir / ".specmodule" / "runs"
    out: list[dict[str, Any]] = []
    if runs_root.is_dir():
        for d in runs_root.iterdir():
            if not d.is_dir():
                continue
            st = query_run_status(d.name, base_dir=base_dir)
            if st is None:
                continue
            out.append({
                "run_id": st.module_id,
                "phase": st.phase,
                "tick": st.tick,
                "error": st.error,
                "updated_at": st.updated_at,
            })
    out.sort(key=lambda r: r["updated_at"], reverse=True)
    return {"runs": out}

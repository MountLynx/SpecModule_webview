# server/api/runs.py
"""运行时读端点：薄映射 module_harness 查询层（只 import 不实现）。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from module_harness.infra import control, query
from module_harness.infra.status import query_run_status
from server.deps import get_base_dir, validate_run_id

router = APIRouter(prefix="/api/runs")


def not_found(run_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"error": "无运行记录", "run_id": run_id})


@router.get("")
def recent_runs(base_dir: Path = Depends(get_base_dir)) -> dict:
    """运行列表：query.recent_runs（mtime 前 N 条完整行 + total 计数）
    + 逐行 read_control 叠加 paused。

    成本与历史规模解耦——全量枚举不进列表端点（CLI `runs` 保留全量语义），
    更早历史 UI 只透出 total（提示 CLI 查看）；status.json 缺失/损坏的 run
    以 phase="unknown" 收入不跳过（删除入口要对坏目录可用）。
    """
    data = query.recent_runs(base_dir=base_dir)
    rows = []
    for row in data["runs"]:
        req = control.read_control(row["run_id"], base_dir=base_dir)
        rows.append({
            **row,
            "paused": bool(req and req.get("action") == "pause"),
        })
    return {"runs": rows, "total": data["total"]}


class CheckpointBody(BaseModel):
    label: str
    tick: int | None = None


@router.get("/{run_id}/status")
def run_status(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    validate_run_id(run_id)
    st = query_run_status(run_id, base_dir=base_dir)
    if st is None:
        raise not_found(run_id)
    return {
        "module_id": st.module_id,
        "phase": st.phase,
        "status": st.status,
        "tick": st.tick,
        "fireable": st.fireable,
        "fired": st.fired,
        "outputs": st.outputs,
        "node_states": st.node_states,
        "error": st.error,
        "updated_at": st.updated_at,
    }


@router.get("/{run_id}/timeline")
def run_timeline(
    run_id: str,
    node: str | None = None,
    tick: int | None = None,
    failed: bool = False,
    base_dir: Path = Depends(get_base_dir),
) -> dict:
    validate_run_id(run_id)
    tl = query.build_timeline(run_id, base_dir=base_dir)
    if tl is None:
        raise not_found(run_id)
    if failed:
        tl = query.filter_failed(tl)
    if tick is not None:
        tl = query.filter_tick(tl, tick)
    if node is not None:
        tl = query.filter_node(tl, node)
    return query.timeline_to_dict(tl)


@router.get("/{run_id}/checkpoints")
def run_checkpoints(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    validate_run_id(run_id)
    cl = query.build_checkpoints(run_id, base_dir=base_dir)
    if cl is None:
        raise not_found(run_id)
    return query.checkpoints_to_dict(cl)


@router.post("/{run_id}/checkpoints")
def create_checkpoint(
    run_id: str, body: CheckpointBody, base_dir: Path = Depends(get_base_dir)
) -> dict:
    validate_run_id(run_id)
    try:
        return query.create_checkpoint(
            run_id, body.label, tick=body.tick, base_dir=base_dir
        )
    except KeyError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})


@router.get("/{run_id}/snapshot")
def run_snapshot(
    run_id: str, tick: int | None = None, base_dir: Path = Depends(get_base_dir)
) -> dict:
    validate_run_id(run_id)
    try:
        snap = query.load_snapshot_summary(run_id, tick=tick, base_dir=base_dir)
    except KeyError as e:
        raise HTTPException(status_code=400, detail={"error": e.args[0], "run_id": run_id})
    if snap is None:
        raise not_found(run_id)
    return snap


@router.get("/{run_id}/feed")
def run_feed(run_id: str, base_dir: Path = Depends(get_base_dir)) -> dict:
    """feed.py 兼容组合端点（v1 前端契约：status/timeline/checkpoints 字段名不变）。"""
    validate_run_id(run_id)
    st = query_run_status(run_id, base_dir=base_dir)
    tl = query.build_timeline(run_id, base_dir=base_dir)
    cl = query.build_checkpoints(run_id, base_dir=base_dir)
    if st is None and tl is None:
        raise not_found(run_id)
    return {
        "run_id": run_id,
        "status": st and {
            "phase": st.phase,
            "tick": st.tick,
            "fired": st.fired,
            "outputs": st.outputs,
            "error": st.error,
        },
        "timeline": query.timeline_to_dict(tl) if tl else None,
        "checkpoints": query.checkpoints_to_dict(cl) if cl else None,
    }

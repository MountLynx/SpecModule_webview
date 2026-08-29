# server/api/graph.py
"""图端点：module_inputs 归档重建（库共享层）+ 每节点运行摘要叠加。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from module_harness import query
from module_harness.status import query_run_status
from server.deps import get_base_dir, validate_run_id

router = APIRouter(prefix="/api/runs")


@router.get("/{run_id}/graph")
def run_graph(
    run_id: str,
    module: str | None = None,
    base_dir: Path = Depends(get_base_dir),
) -> dict:
    """图结构 + 节点状态叠加。

    module 缺省 = run_id（CLI 缺省 run_id 即模块名的启发式）；解析失败 404 携
    ValueError 消息（前端弹模块选择器）。「运行中」= phase=running 且节点在最新
    快照 fireable 集合（快照 tick N 的 fireable = 第 N+1 个 tick 的 fire 候选）。
    """
    validate_run_id(run_id)
    module_name = module or run_id
    try:
        res = query.build_run_graph(module_name, run_id, base_dir=base_dir)
    except ValueError as e:
        raise HTTPException(
            status_code=404,
            detail={"error": e.args[0], "run_id": run_id, "module": module_name},
        )
    if res is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "无运行记录", "run_id": run_id, "module": module_name},
        )
    graph, tasklist = res
    graph_dict = query.graph_to_dict(graph, tasklist)

    st = query_run_status(run_id, base_dir=base_dir)
    tl = query.build_timeline(run_id, base_dir=base_dir)
    by_node: dict[str, list] = {}
    for e in tl.entries if tl else []:
        by_node.setdefault(e.node, []).append(e)
    node_states = {}
    for n in graph_dict["nodes"]:
        entries = by_node.get(n["id"], [])
        last = entries[-1] if entries else None
        node_states[n["id"]] = {
            "fired_count": len(entries),
            "last_status": last.status if last else None,
            "last_tick": last.tick if last else None,
            "running": bool(
                st is not None
                and st.phase == "running"
                and n["id"] in st.fireable
            ),
        }
    return {
        "run_id": run_id,
        "module": module_name,
        "phase": st.phase if st else None,
        "tick": st.tick if st else None,
        "graph": graph_dict,
        "node_states": node_states,
    }

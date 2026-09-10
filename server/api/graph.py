# server/api/graph.py
"""图端点：module_inputs 归档重建（库共享层）+ 每节点运行摘要叠加。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from module_harness import query, store
from module_harness.infra.status import query_run_status
from server.deps import get_base_dir, get_search_paths, validate_run_id

router = APIRouter(prefix="/api/runs")


@router.get("/{run_id}/graph")
def run_graph(
    run_id: str,
    module: str | None = None,
    base_dir: Path = Depends(get_base_dir),
) -> dict:
    """图结构 + 节点状态叠加。

    模块名解析序：`?module=` 显式参数 > status.json `module` 溯源字段（新 run
    自动携带，UI 发起的 `{module}_{hex}` run_id 由此命中）> run_id 启发式（CLI
    缺省 run_id 即模块名的旧 run）。解析失败 404 携 ValueError 消息（前端弹模块
    选择器）。「运行中」= phase=running 且节点在最新快照 fireable 集合（快照
    tick N 的 fireable = 第 N+1 个 tick 的 fire 候选）。
    """
    validate_run_id(run_id)
    st = query_run_status(run_id, base_dir=base_dir)
    module_name = module or (st.module if st is not None else None) or run_id
    # 显式锚定解析 + src 直通（build_run_graph 内部缺省按 cwd 搜索，进程边界
    # 同一纪律——server 解析视图须与 spawn 子进程一致）
    src = store.resolve_module(module_name, search=get_search_paths(base_dir))
    if src is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"模块 '{module_name}' 未找到（specmodule list 查看全部）",
                "run_id": run_id, "module": module_name,
                "code": "module_unresolved",
            },
        )
    try:
        res = query.build_run_graph(module_name, run_id, base_dir=base_dir, src=src)
    except ValueError as e:
        # code 是前端契约字段（弹模块选择器的依据），error 文本面向用户
        raise HTTPException(
            status_code=404,
            detail={
                "error": e.args[0], "run_id": run_id, "module": module_name,
                "code": "module_unresolved",
            },
        )
    if res is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "无运行记录", "run_id": run_id, "module": module_name},
        )
    graph, tasklist = res
    graph_dict = query.graph_to_dict(graph, tasklist)

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

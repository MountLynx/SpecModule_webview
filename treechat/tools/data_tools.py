# treechat/tools/data_tools.py
"""数据类工具 v1（7 个）：server/api 同构的薄映射。

发起走 server.runservice（spawn 编排共享层——惰性导入：treechat 与 server 同仓库
同 venv，standalone CLI 不触达该导入）；读/控制直调 module_harness。
"""

from __future__ import annotations

from module_harness.infra import control, query, store
from module_harness.infra.status import query_run_status

from .base import ToolContext, ToolDef, register


async def _no_run(run_id: str) -> dict:
    return {"error": "无运行记录", "run_id": run_id}


async def _list_modules(args: dict, ctx: ToolContext) -> dict:
    out = []
    for _name, sources in store.list_modules(search=ctx.search).items():
        for s in sources:
            out.append({"name": s.name, "kind": s.kind, "version": s.version,
                        "description": s.description})
    out.sort(key=lambda m: (m["name"], m["kind"]))
    return {"modules": out}


async def _module_detail(args: dict, ctx: ToolContext) -> dict:
    name = args["name"]
    resolved = store.resolve_module_full(name, search=ctx.search)  # ValueError 原样
    if resolved is None:
        return {"error": f"模块 '{name}' 未找到"}
    return store.detail_to_dict(resolved)


async def _run_module(args: dict, ctx: ToolContext) -> dict:
    from server import runservice  # 惰性：见模块 docstring

    return runservice.launch_run(
        args["module"], spec=args.get("spec"), template=args.get("template"),
        run_id=args.get("run_id"), max_ticks=int(args.get("max_ticks") or 100),
        mock=bool(args.get("mock")), base_dir=ctx.base_dir, search=ctx.search)


async def _run_status(args: dict, ctx: ToolContext) -> dict:
    st = query_run_status(args["run_id"], base_dir=ctx.base_dir)
    if st is None:
        return await _no_run(args["run_id"])
    return {"module_id": st.module_id, "phase": st.phase, "status": st.status,
            "tick": st.tick, "fireable": st.fireable, "fired": st.fired,
            "outputs": st.outputs, "node_states": st.node_states,
            "error": st.error, "updated_at": st.updated_at}


async def _run_snapshot(args: dict, ctx: ToolContext) -> dict:
    # KeyError（非法 tick）由 dispatch 兜底转 error dict
    snap = query.load_snapshot_summary(args["run_id"], tick=args.get("tick"),
                                       base_dir=ctx.base_dir)
    if snap is None:
        return await _no_run(args["run_id"])
    return snap


async def _run_timeline(args: dict, ctx: ToolContext) -> dict:
    tl = query.build_timeline(args["run_id"], base_dir=ctx.base_dir)
    if tl is None:
        return await _no_run(args["run_id"])
    if args.get("failed_only"):
        tl = query.filter_failed(tl)
    if args.get("tick") is not None:
        tl = query.filter_tick(tl, int(args["tick"]))
    if args.get("node"):
        tl = query.filter_node(tl, str(args["node"]))
    return query.timeline_to_dict(tl)


async def _run_control(args: dict, ctx: ToolContext) -> dict:
    run_id = args["run_id"]
    if query_run_status(run_id, base_dir=ctx.base_dir) is None:
        return await _no_run(run_id)
    control.request_control(run_id, args["action"], reason=args.get("reason"),
                            base_dir=ctx.base_dir)  # ValueError（非法 action）原样
    req = control.read_control(run_id, base_dir=ctx.base_dir)
    return {"run_id": run_id, "control": req,
            "paused": bool(req and req.get("action") == "pause")}


register(ToolDef(
    name="list_modules",
    description="列出当前运行根可发现的全部模块（entry/packed/pip），含名称/种类/版本/描述。",
    parameters={"type": "object", "properties": {}},
    handler=_list_modules))

register(ToolDef(
    name="module_detail",
    description=("查询单个模块详情：default_spec、spec_schema（spec 字段与类型——"
                 "完善 spec 的校验锚）、templates、submodules。"),
    parameters={"type": "object",
                "properties": {"name": {"type": "string", "description": "模块名"}},
                "required": ["name"]},
    handler=_module_detail))

register(ToolDef(
    name="run_module",
    description=("发起一次模块运行：spawn 官方 CLI 子进程，立即返回 run_id"
                 "（运行在后台进行，不等待完成；进度用 run_status 查询）。"),
    parameters={"type": "object",
                "properties": {
                    "module": {"type": "string", "description": "模块名"},
                    "spec": {"type": "object",
                             "description": "spec 字典（可选，缺省用模块 default_spec）"},
                    "template": {"type": "string", "description": "模板名（可选）"},
                    "run_id": {"type": "string", "description": "自定义 run_id（可选）"},
                    "max_ticks": {"type": "integer", "description": "tick 上限，缺省 100"},
                    "mock": {"type": "boolean", "description": "mock LLM 试运行"},
                },
                "required": ["module"]},
    handler=_run_module))

register(ToolDef(
    name="run_status",
    description="查询运行状态：phase/tick/fireable/fired/outputs/node_states。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"}},
                "required": ["run_id"]},
    handler=_run_status))

register(ToolDef(
    name="run_snapshot",
    description="检视运行快照摘要（缺省最新，可指定 tick）：各节点最新输出。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"},
                               "tick": {"type": "integer", "description": "可选 tick 号"}},
                "required": ["run_id"]},
    handler=_run_snapshot))

register(ToolDef(
    name="run_timeline",
    description="运行历史时间线：逐 tick 的节点产出/错误；可只看失败项。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"},
                               "failed_only": {"type": "boolean"},
                               "tick": {"type": "integer"},
                               "node": {"type": "string"}},
                "required": ["run_id"]},
    handler=_run_timeline))

register(ToolDef(
    name="run_control",
    description="运行控制：action ∈ cancel（取消）/ pause（暂停）/ unpause（继续）。",
    parameters={"type": "object",
                "properties": {"run_id": {"type": "string"},
                               "action": {"type": "string",
                                          "enum": ["cancel", "pause", "unpause"]},
                               "reason": {"type": "string", "description": "可选原因"}},
                "required": ["run_id", "action"]},
    handler=_run_control))

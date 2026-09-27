# tests/treechat/test_tools.py
"""数据类工具：薄映射契约（fixture run 工件，隔离模式不触真实 ~/.specmodule）。

async 测试沿用本仓库既有模式（tests/treechat/test_session.py）：普通 def +
asyncio.run 包裹（pyproject 无 pytest-asyncio 配置，不引入新插件依赖）。
"""

from __future__ import annotations

import asyncio

import pytest

from server.deps import get_search_paths
from tests.conftest import seed_run
from treechat.tools import ToolContext, ToolDef, all_tools, dispatch_tool, tool_schemas


@pytest.fixture()
def ctx(base):
    """base fixture：SPECMODULE_BASE/SPECMODULE_PATH/SPECMODULE_HOME 隔离。"""
    return ToolContext(base_dir=base, search=get_search_paths(base))


def _tool(name: str):
    return next(t for t in all_tools() if t.name == name)


def _dispatch(name: str, args: dict, ctx: ToolContext, tools=None) -> dict:
    """asyncio.run 包裹（既有模式）；tools 缺省 = 注册表快照。"""
    return asyncio.run(dispatch_tool(tools if tools is not None else all_tools(),
                                     name, args, ctx))


def test_list_modules(ctx):
    out = _dispatch("list_modules", {}, ctx)
    names = [m["name"] for m in out["modules"]]
    assert "mini_graph" in names          # tests/modules/mini_graph.py（SPECMODULE_PATH）
    mini = next(m for m in out["modules"] if m["name"] == "mini_graph")
    assert set(mini) == {"name", "kind", "version", "description"}
    assert mini["kind"] == "entry"


def test_module_detail(ctx):
    out = _dispatch("module_detail", {"name": "mini_graph"}, ctx)
    assert out["name"] == "mini_graph"
    assert out["default_spec"] == {"topic": "demo"}
    assert "spec_schema" in out


def test_module_detail_unknown(ctx):
    out = _dispatch("module_detail", {"name": "ghost"}, ctx)
    assert "error" in out


def test_run_module_spawns_via_runservice(ctx, monkeypatch):
    """run_module 走 runservice.launch_run（spawn 桩）——同一编排层。"""
    from server import runservice

    class FakePopen:
        pid = 4321

        def poll(self):
            return None

    monkeypatch.setattr(runservice, "_spawn", lambda argv, cwd, log_fh: FakePopen())
    out = _dispatch("run_module", {"module": "mini_graph", "mock": True}, ctx)
    assert out["started"] is True
    assert out["run_id"].startswith("mini_graph_")


def test_run_status_of_seeded_run(ctx, base):
    seed_run(base, "ops_r1", firings=[{"tick": 1, "node": "A", "output": "a1"}],
             status={"module_id": "mini_graph", "phase": "done", "updated_at": 2.0})
    out = _dispatch("run_status", {"run_id": "ops_r1"}, ctx)
    assert out["phase"] == "done"
    assert out["module_id"] == "mini_graph"


def test_run_status_unknown(ctx):
    out = _dispatch("run_status", {"run_id": "ghost"}, ctx)
    assert out == {"error": "无运行记录", "run_id": "ghost"}


def test_run_snapshot_and_timeline(ctx, base):
    seed_run(base, "ops_r2",
             firings=[{"tick": 1, "node": "A", "output": "a1"},
                      {"tick": 2, "node": "B", "output": "b1"}],
             snapshots={2: {"tick": 2, "status": "running",
                            "fireable": [], "fired": ["A", "B"]}},
             status={"module_id": "mini_graph", "phase": "done", "updated_at": 3.0})
    snap = _dispatch("run_snapshot", {"run_id": "ops_r2"}, ctx)
    assert snap["tick"] == 2
    tl = _dispatch("run_timeline", {"run_id": "ops_r2"}, ctx)
    assert len(tl["entries"]) == 2
    tl_f = _dispatch("run_timeline", {"run_id": "ops_r2", "failed_only": True}, ctx)
    assert tl_f["entries"] == []


def test_run_control_writes_control_file(ctx, base):
    seed_run(base, "ops_r3",
             status={"module_id": "mini_graph", "phase": "running", "updated_at": 2.0})
    out = _dispatch("run_control", {"run_id": "ops_r3", "action": "pause"}, ctx)
    assert out["paused"] is True
    assert out["control"]["action"] == "pause"


def test_run_snapshot_bad_tick_becomes_error(ctx, base):
    """库对不存在 tick 抛 KeyError（消息带可用清单）→ dispatch 兜底转 error dict。"""
    seed_run(base, "ops_r4",
             firings=[{"tick": 1, "node": "A", "output": "a1"}],
             snapshots={2: {"tick": 2, "status": "running",
                            "fireable": [], "fired": ["A"]}},
             status={"module_id": "mini_graph", "phase": "done", "updated_at": 2.0})
    out = _dispatch("run_snapshot", {"run_id": "ops_r4", "tick": 99999}, ctx)
    assert "error" in out
    assert "99999" in out["error"]


def test_run_control_bad_action_becomes_error(ctx, base):
    """库对非法 action 抛 ValueError → dispatch 兜底转 error dict。"""
    seed_run(base, "ops_r5",
             status={"module_id": "mini_graph", "phase": "running", "updated_at": 2.0})
    out = _dispatch("run_control", {"run_id": "ops_r5", "action": "explode"}, ctx)
    assert "error" in out


def test_run_timeline_tick_and_node_filters(ctx, base):
    seed_run(base, "ops_r6",
             firings=[{"tick": 1, "node": "A", "output": "a1"},
                      {"tick": 2, "node": "B", "output": "b1"}],
             snapshots={2: {"tick": 2, "status": "running",
                            "fireable": [], "fired": ["A", "B"]}},
             status={"module_id": "mini_graph", "phase": "done", "updated_at": 3.0})
    tl_tick = _dispatch("run_timeline", {"run_id": "ops_r6", "tick": 1}, ctx)
    assert [e["tick"] for e in tl_tick["entries"]] == [1]
    tl_node = _dispatch("run_timeline", {"run_id": "ops_r6", "node": "B"}, ctx)
    assert [e["node"] for e in tl_node["entries"]] == ["B"]


def test_unknown_tool(ctx):
    out = _dispatch("nope", {}, ctx)
    assert out == {"error": "未知工具: nope"}


def test_registry_has_seven_data_tools():
    names = {t.name for t in all_tools()}
    assert {"list_modules", "module_detail", "run_module", "run_status",
            "run_snapshot", "run_timeline", "run_control"} <= names


def test_tool_schemas_shape():
    """tool_schemas 出口用 input_schema 键（两后端转换器统一吃该键）。"""
    schemas = {s["name"]: s for s in tool_schemas(all_tools())}
    assert schemas["run_module"]["input_schema"]["required"] == ["module"]
    assert set(schemas["run_module"]) == {"name", "description", "input_schema"}


def test_handler_exception_becomes_error_dict(ctx):
    async def boom(args, ctx):
        raise RuntimeError("炸了")

    tools = list(all_tools()) + [
        ToolDef(name="boom", description="",
                parameters={"type": "object"}, handler=boom)]
    out = _dispatch("boom", {}, ctx, tools=tools)
    assert out == {"error": "炸了"}

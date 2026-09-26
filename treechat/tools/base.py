# treechat/tools/base.py
"""工具箱基座：ToolDef / ToolContext / 注册表 / 分派（D3 两层工具箱）。

数据类工具 = 薄映射（module_harness 查询/控制 + server.runservice 编排）；
能力类工具 = call_harness 无头 module run（refine_spec，见 refine_spec.py）。
两类对 agent 循环无差别：tool = (schema, handler)，handler(args, ctx) -> dict。
成功返回载荷 dict 原样；失败 handler 可抛异常或直接返回 {"error": ...}——
dispatch_tool 统一 catch-all 兜底，工具失败永远喂回模型而不炸回合。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from module_harness.infra import store

Handler = Callable[[dict, "ToolContext"], Awaitable[dict]]


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    parameters: dict
    """JSON Schema（OpenAI function 形）；两后端转换器统一吃 input_schema 键。"""
    handler: Handler


@dataclass(frozen=True)
class ToolContext:
    """工具执行上下文（mount 时装配；standalone 回落 home 锚定缺省）。"""

    base_dir: Path
    search: list[Path]
    """store.search_paths(base_dir)——与 server/deps 同纪律。"""
    client: Any = None
    """能力工具复用会话 LLM 客户端；数据类工具不消费。"""


def default_tool_context() -> ToolContext:
    base_dir = Path(os.environ.get("SPECMODULE_BASE") or Path.home()).resolve()
    return ToolContext(base_dir=base_dir, search=store.search_paths(base_dir))


_REGISTRY: dict[str, ToolDef] = {}


def register(tool: ToolDef) -> ToolDef:
    _REGISTRY[tool.name] = tool
    return tool


def all_tools() -> list[ToolDef]:
    """注册表快照（晚绑定：refine_spec 等后续注册自动入列）。"""
    return list(_REGISTRY.values())


def tool_schemas(tools: list[ToolDef]) -> list[dict]:
    return [{"name": t.name, "description": t.description,
             "input_schema": t.parameters} for t in tools]


async def dispatch_tool(tools: list[ToolDef], name: str, args: dict,
                        ctx: ToolContext) -> dict:
    """按名单分派（agent 循环可传自定义子集）；未知工具/异常 → error dict。"""
    tool = next((t for t in tools if t.name == name), None)
    if tool is None:
        return {"error": f"未知工具: {name}"}
    try:
        return await tool.handler(args, ctx)
    except Exception as exc:  # noqa: BLE001 —— 工具失败喂回模型，不炸回合
        return {"error": str(exc) or type(exc).__name__}

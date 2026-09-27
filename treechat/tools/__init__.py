# treechat/tools/__init__.py
"""treechat 工具箱（spec 2026-09-26 D3 两层工具箱）。"""

from .base import (ToolContext, ToolDef, all_tools, default_tool_context,
                   dispatch_tool, register, tool_schemas)
from . import data_tools  # noqa: F401  —— 副作用注册
from . import refine_spec  # noqa: F401  —— 能力类工具注册

__all__ = ["ToolContext", "ToolDef", "all_tools", "default_tool_context",
           "dispatch_tool", "register", "tool_schemas"]

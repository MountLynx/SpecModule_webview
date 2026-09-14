"""嵌入式对话型模块注册表（spec §4）—— treechat 对 harness 的内部组织，不对外发现。"""
from __future__ import annotations

from .base import ConversationalModule, DocumentDef, FieldStreamShaper
from .direct import DIRECT
from .grilling import GRILLING

__all__ = ["BUILT_IN", "DEFAULT_MODE_MAP", "ConversationalModule", "DocumentDef",
           "FieldStreamShaper", "resolve_module"]

BUILT_IN: dict[str, ConversationalModule] = {"direct": DIRECT, "grilling": GRILLING}
DEFAULT_MODE_MAP: dict[str, str] = {"grilling": "grilling"}


def resolve_module(category: str,
                   mode_modules: dict[str, str] | None = None) -> ConversationalModule:
    """会话 category（模式 key）→ 模块定义。空值/未知值回落直答（spec §4）。"""
    mapping = DEFAULT_MODE_MAP if mode_modules is None else mode_modules
    name = mapping.get(category or "", "direct")
    return BUILT_IN.get(name, DIRECT)

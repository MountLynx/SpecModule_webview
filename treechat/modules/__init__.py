"""嵌入式对话型模块注册表（spec §4）—— treechat 对 harness 的内部组织，不对外发现。"""
from __future__ import annotations

from .agent import AGENT_MODE, AgentMode
from .base import ConversationalModule, DocumentDef, FieldStreamShaper
from .direct import DIRECT
from .grilling import GRILLING

__all__ = ["BUILT_IN", "DEFAULT_MODE_MAP", "AGENT_MODE", "AgentMode",
           "ConversationalModule", "DocumentDef", "FieldStreamShaper",
           "resolve_module"]

BUILT_IN: dict[str, ConversationalModule | AgentMode] = {
    "direct": DIRECT, "grilling": GRILLING, "ops": AGENT_MODE,
}
DEFAULT_MODE_MAP: dict[str, str] = {"grilling": "grilling", "ops": "ops"}


def resolve_module(category: str,
                   mode_modules: dict[str, str] | None = None) -> ConversationalModule | AgentMode:
    """会话 category（模式 key）→ 模式定义。

    内建 key 直查（identity——内建模式不经映射表也能命中，防嵌入方自定义
    mode_modules 覆盖掉 ops）；其余走映射表，未知/缺省回落直答（spec §4）。
    """
    if category in BUILT_IN:
        return BUILT_IN[category]
    mapping = DEFAULT_MODE_MAP if mode_modules is None else mode_modules
    name = mapping.get(category or "", "direct")
    return BUILT_IN.get(name, DIRECT)
